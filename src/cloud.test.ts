import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudConfigPath,
  establishCloudConfig,
  normalizeHostname,
  promptForCloudName,
  readCloudConfig,
  readTunnelToken,
  resolveRunToken,
  resolveTunnelConfigPath,
  startTunnel,
  tunnelTokenPath,
  writeCloudConfig,
} from "./cloud.ts";

/** A registrar that answers every claim, so the CLI side can be driven without one deployed. */
async function claimServer() {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ hostname: "colin.frizz.sh", token: "run-token", leaseExpiresAt: 0, renewed: false })
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "frizz-cloud-"));
}

test("a pasted URL, a trailing slash or a stray dot all resolve to the same hostname", () => {
  // People paste the address bar. Refusing that would be a pointless second question.
  for (const raw of ["colin.frizz.sh", "https://colin.frizz.sh", "https://colin.frizz.sh/", "COLIN.Frizz.SH", "colin.frizz.sh."]) {
    assert.equal(normalizeHostname(raw), "colin.frizz.sh", raw);
  }
  assert.equal(normalizeHostname("  https://colin.frizz.sh/board  "), "colin.frizz.sh");
});

test("something that is not a hostname is refused at the prompt, not at the 403", () => {
  // A bare word would produce `https://laptop`, which fails later as an opaque origin mismatch.
  for (const raw of ["", "   ", "laptop", "https://"]) {
    assert.throws(() => normalizeHostname(raw), /invalid hostname/, JSON.stringify(raw));
  }
});

test("the config round-trips, so the second run of --cloud asks nothing", () => {
  const home = tempHome();
  try {
    assert.equal(readCloudConfig(home), null, "no config means first run");
    writeCloudConfig({ hostname: "colin.frizz.sh", tunnel: "colin" }, home);
    assert.deepEqual(readCloudConfig(home), { hostname: "colin.frizz.sh", tunnel: "colin" });
    assert.ok(readFileSync(cloudConfigPath(home), "utf8").endsWith("\n"), "written as a normal text file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt or half-written config reads as absent rather than throwing", () => {
  // The failure mode this avoids is a launcher that cannot start at all because a JSON file got
  // truncated — falling back to the prompt is always recoverable.
  const home = tempHome();
  try {
    mkdirSync(join(home, ".frizz"), { recursive: true });
    for (const bad of ["", "{", "null", '{"hostname":"x.dev"}', '{"tunnel":"t"}', '{"hostname":"","tunnel":"t"}']) {
      writeFileSync(cloudConfigPath(home), bad);
      assert.equal(readCloudConfig(home), null, JSON.stringify(bad));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit cloudflared config wins; otherwise it is found or reported missing", () => {
  const home = tempHome();
  try {
    const base = { hostname: "colin.frizz.sh", tunnel: "colin" };
    assert.equal(resolveTunnelConfigPath(base, home), null, "absent means let cloudflared use its own default");

    mkdirSync(join(home, ".cloudflared"), { recursive: true });
    writeFileSync(join(home, ".cloudflared", "frizz.yml"), "tunnel: colin\n");
    assert.equal(resolveTunnelConfigPath(base, home), join(home, ".cloudflared", "frizz.yml"));

    assert.equal(resolveTunnelConfigPath({ ...base, config: "/somewhere/else.yml" }, home), "/somewhere/else.yml");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a --cloud launch with no terminal refuses rather than blocking on stdin forever", async () => {
  // Update & Restart re-execs the launcher with --cloud and no TTY. A prompt there would hang on a
  // stdin nobody can reach, and the board would never come back at all.
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    await assert.rejects(promptForCloudName(), /needs a saved name/);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
  }
});

test("a bare word claims a name; anything with a dot keeps the bring-your-own path", async () => {
  // One question instead of two. The dot is the whole discriminator, so it is worth pinning that a
  // hostname never accidentally becomes a claim (which would talk to the registrar) and vice versa.
  const home = tempHome();
  try {
    const byo = await establishCloudConfig("board.example.com", 9393, home);
    assert.deepEqual(byo, { hostname: "board.example.com", tunnel: "board" });
    assert.equal(readTunnelToken(home), null, "a hostname you own needs no run token");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a name that cannot be claimed says WHY, before any network call", async () => {
  const home = tempHome();
  try {
    // No registrar is running, so reaching one would surface as a connection error rather than these.
    await assert.rejects(establishCloudConfig("www", 9393, home), /reserved/);
    await assert.rejects(establishCloudConfig("ab", 9393, home), /3-63 characters/);
    await assert.rejects(establishCloudConfig("has space", 9393, home), /letters, digits and hyphens/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a claimed name stores the token at 0600, apart from the world-readable config", async () => {
  const home = tempHome();
  const server = await claimServer();
  try {
    const config = await establishCloudConfig("colin", 9393, home, server.origin);
    assert.deepEqual(config, { hostname: "colin.frizz.sh", claim: "colin" });
    assert.equal(readTunnelToken(home), "run-token");
    assert.equal(statSync(tunnelTokenPath(home)).mode & 0o777, 0o600, "a run token is a credential");
    // The config file is NOT where the secret goes — it predates this feature and is world-readable
    // on machines that already have one. The launcher writes it, so write it the same way here.
    writeCloudConfig(config, home);
    assert.equal(readFileSync(cloudConfigPath(home), "utf8").includes("run-token"), false);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a launch renews the lease, and falls back to the cached token when the registrar is down", async () => {
  // The registrar is not on the data plane. A board that could not start because a signup service was
  // down would quietly make it one.
  const home = tempHome();
  const server = await claimServer();
  try {
    await establishCloudConfig("colin", 9393, home, server.origin);
    const config = { hostname: "colin.frizz.sh", claim: "colin" };

    const renewed = await resolveRunToken(config, 9393, home, undefined, server.origin);
    assert.equal(renewed, "run-token");

    const warnings: string[] = [];
    const offline = await resolveRunToken(config, 9393, home, (m) => warnings.push(m), "http://127.0.0.1:1");
    assert.equal(offline, "run-token", "the cached token carries the launch");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /could not reach the Frizz registrar/);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a bring-your-own config needs no token at all", async () => {
  const home = tempHome();
  try {
    assert.equal(await resolveRunToken({ hostname: "board.example.com", tunnel: "board" }, 9393, home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a claimed tunnel runs from its token; a hand-made one runs by name", () => {
  // cloudflared takes an entirely different command line for the two. Getting it wrong means the
  // tunnel never connects and the hostname serves a Cloudflare error with nothing to explain it.
  const claimed = startTunnel({ hostname: "colin.frizz.sh", claim: "colin" }, () => {}, () => {}, "/nowhere", "tok");
  const spawnArgs = claimed.child.spawnargs;
  claimed.stop();
  assert.deepEqual(spawnArgs.slice(1), ["tunnel", "--no-autoupdate", "run", "--token", "tok"]);

  const byo = startTunnel({ hostname: "board.example.com", tunnel: "board" }, () => {}, () => {}, "/nowhere");
  const byoArgs = byo.child.spawnargs;
  byo.stop();
  assert.deepEqual(byoArgs.slice(1), ["tunnel", "--no-autoupdate", "run", "board"]);
});

test("a config naming neither a tunnel nor a claim reads as absent", () => {
  // It describes a hostname nothing can serve, and acting on it would arm the origin gate for an
  // address with no tunnel behind it — a board that answers Forbidden with no way to tell why.
  const home = tempHome();
  try {
    mkdirSync(join(home, ".frizz"), { recursive: true });
    writeFileSync(cloudConfigPath(home), JSON.stringify({ hostname: "colin.frizz.sh" }));
    assert.equal(readCloudConfig(home), null);
    writeFileSync(cloudConfigPath(home), JSON.stringify({ hostname: "colin.frizz.sh", claim: "colin" }));
    assert.deepEqual(readCloudConfig(home), { hostname: "colin.frizz.sh", claim: "colin" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a first claim that cannot reach the registrar points at the path that works without it", async () => {
  // A renewal falls back to its cached token; a FIRST claim has nothing to fall back to, so the
  // operator is left with a network error for a service they have never heard of.
  const home = tempHome();
  try {
    await assert.rejects(
      establishCloudConfig("colin", 9393, home, "http://127.0.0.1:1"),
      /could not reach the Frizz registrar[\s\S]*tunnel of your own/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
