#!/usr/bin/env nub
/**
 * The whole claim loop, over a real socket: CLI client → HTTP → the real Worker handler → Cloudflare.
 *
 * Both halves are unit-tested against fakes, which proves each of them and nothing about the seam
 * between them — and the seam is where this would break, because it is the only place the two agree
 * on a wire format instead of on a function signature. So the client here is the real client, the
 * request really is serialized and sent, and the handler answering it is the real handler.
 *
 * The one thing still faked is Cloudflare itself, deliberately: provisioning a tunnel needs a zone
 * token, and this must be runnable by anyone, on any machine, without one. What the fake cannot tell
 * us is whether packages/registrar/src/cloudflare.ts speaks the real API correctly — that file says so
 * at the top and is the piece still owed a live run.
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { CLAIM_LEASE_MS } from "@frizz/shared";
import { handleClaim } from "../packages/registrar/src/claim-handler.ts";
import { loadOrCreateClaimIdentity } from "../src/identity.ts";
import { claimName, ClaimError } from "../src/registrar-client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Cloudflare's part, in memory. Records the calls so the DNS target can be asserted. */
function fakeCloudflare() {
  const tunnels = new Map();
  const dns = new Map();
  let next = 1;
  return {
    tunnels,
    dns,
    api: {
      async createTunnel(name) {
        const id = `tunnel-${next++}`;
        tunnels.set(id, name);
        return { id, token: `run-token-${id}` };
      },
      async tunnelToken(id) {
        return `run-token-${id}`;
      },
      async setTunnelIngress() {},
      async upsertDnsRecord(hostname, target) {
        dns.set(hostname, target);
      },
      async deleteTunnel(id) {
        tunnels.delete(id);
      },
      async deleteDnsRecord(hostname) {
        dns.delete(hostname);
      },
    },
  };
}

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    store: {
      async read(name) {
        return rows.get(name) ?? null;
      },
      async write(name, record) {
        rows.set(name, record);
      },
      async remove(name) {
        rows.delete(name);
      },
    },
  };
}

const home = mkdtempSync(join(tmpdir(), "frizz-claim-e2e-"));
const cf = fakeCloudflare();
const st = memoryStore();
let clock = 1_800_000_000_000;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      body = null;
    }
    const outcome = await handleClaim(body, {
      api: cf.api,
      store: st.store,
      zone: "frizz.sh",
      now: () => clock,
    });
    res.writeHead(outcome.status, { "content-type": "application/json" });
    res.end(JSON.stringify(outcome.body));
  });
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  // 1. A real identity from a real key file, exactly as a launch would load it.
  const identity = await loadOrCreateClaimIdentity(home);

  const first = await claimName({ name: "colin", port: 9393, identity, origin, now: () => clock });
  check("a name is claimed end to end", first.hostname === "colin.frizz.sh", first.hostname);
  check("a run token comes back", typeof first.token === "string" && first.token.length > 0, first.token);
  check("the first claim is not a renewal", first.renewed === false);
  check(
    "the DNS record points at the tunnel",
    cf.dns.get("colin.frizz.sh") === "tunnel-1.cfargotunnel.com",
    cf.dns.get("colin.frizz.sh") ?? "(none)"
  );
  check("the lease runs 30 days", first.leaseExpiresAt === clock + CLAIM_LEASE_MS);

  // 2. THE PROPERTY THAT PROTECTS THE ACCOUNT CAP. Every launch re-claims; none may provision again.
  clock += 60_000;
  const renewed = await claimName({ name: "colin", port: 9393, identity, origin, now: () => clock });
  check("a second launch renews rather than provisioning", renewed.renewed === true);
  check("no second tunnel was created", cf.tunnels.size === 1, `${cf.tunnels.size} tunnels`);

  // 3. A DIFFERENT machine — a different key — cannot take the name.
  const otherHome = mkdtempSync(join(tmpdir(), "frizz-claim-e2e-other-"));
  try {
    const stranger = await loadOrCreateClaimIdentity(otherHome);
    let refused = null;
    try {
      await claimName({ name: "colin", port: 9393, identity: stranger, origin, now: () => clock });
    } catch (error) {
      refused = error;
    }
    check(
      "another key is refused the name",
      refused instanceof ClaimError && refused.code === "name-taken",
      refused ? `${refused.code}: ${refused.message}` : "it was ALLOWED"
    );
    check("the owner still owns it", st.rows.get("colin")?.pubkey === (await (async () => {
      const { exportClaimPublicKey } = await import("@frizz/shared");
      return exportClaimPublicKey(identity.publicKey);
    })()));

    // 4. Once the lease lapses, the same stranger CAN take it, and the old tunnel is gone.
    clock += CLAIM_LEASE_MS + 1;
    const takenOver = await claimName({ name: "colin", port: 4321, identity: stranger, origin, now: () => clock });
    check("a lapsed name is reclaimable", takenOver.renewed === false && takenOver.hostname === "colin.frizz.sh");
    check("the abandoned tunnel was torn down", cf.tunnels.has("tunnel-1") === false);
    check("exactly one tunnel remains", cf.tunnels.size === 1, `${cf.tunnels.size} tunnels`);
  } finally {
    rmSync(otherHome, { recursive: true, force: true });
  }

  // 5. A name that cannot be a hostname never reaches Cloudflare.
  let rejected = null;
  try {
    await claimName({ name: "www", port: 9393, identity, origin, now: () => clock });
  } catch (error) {
    rejected = error;
  }
  check("a reserved name is refused before provisioning", rejected !== null, rejected?.message ?? "it was ALLOWED");
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  server.close();
  await once(server, "close").catch(() => {});
  rmSync(home, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
