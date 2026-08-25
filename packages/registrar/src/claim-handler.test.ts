import assert from "node:assert/strict"
import test from "node:test"
import { CLAIM_LEASE_MS, generateClaimIdentity, signClaim } from "@frizz/shared"
import { handleClaim, type ClaimDeps, type ClaimRecord } from "./claim-handler.ts"

const NOW = 1_800_000_000_000
const ZONE = "frizz.sh"

/** A Cloudflare that records what it was asked to do, and can be told to fail any single step. */
function fakeCloudflare(failAt?: "createTunnel" | "setTunnelIngress" | "upsertDnsRecord" | "tunnelToken") {
  const calls: string[] = []
  const tunnels = new Map<string, string>()
  const dns = new Map<string, string>()
  let nextId = 1
  const maybeFail = (step: string) => {
    calls.push(step)
    if (failAt && step.startsWith(failAt)) throw new Error(`${step} failed`)
  }
  return {
    calls,
    tunnels,
    dns,
    api: {
      async createTunnel(name: string) {
        maybeFail(`createTunnel:${name}`)
        const id = `tunnel-${nextId++}`
        tunnels.set(id, name)
        return { id, token: `run-token-for-${id}` }
      },
      async tunnelToken(id: string) {
        maybeFail(`tunnelToken:${id}`)
        return `run-token-for-${id}`
      },
      async setTunnelIngress(id: string, hostname: string, service: string) {
        maybeFail(`setTunnelIngress:${id}:${hostname}:${service}`)
      },
      async upsertDnsRecord(hostname: string, target: string) {
        maybeFail(`upsertDnsRecord:${hostname}:${target}`)
        dns.set(hostname, target)
      },
      async deleteTunnel(id: string) {
        calls.push(`deleteTunnel:${id}`)
        tunnels.delete(id)
      },
      async deleteDnsRecord(hostname: string) {
        calls.push(`deleteDnsRecord:${hostname}`)
        dns.delete(hostname)
      },
    },
  }
}

function fakeStore(seed: Record<string, ClaimRecord> = {}) {
  const rows = new Map<string, ClaimRecord>(Object.entries(seed))
  return {
    rows,
    store: {
      async read(name: string) {
        return rows.get(name) ?? null
      },
      async write(name: string, record: ClaimRecord) {
        rows.set(name, record)
      },
      async remove(name: string) {
        rows.delete(name)
      },
    },
  }
}

function deps(overrides: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    api: fakeCloudflare().api,
    store: fakeStore().store,
    zone: ZONE,
    now: () => NOW,
    ...overrides,
  }
}

async function claimFor(identity: CryptoKeyPair, name = "colin", port = 9393, issuedAt = NOW) {
  return signClaim({ name, port, issuedAt }, identity)
}

test("a first claim provisions the tunnel, the ingress and the DNS record, and returns only the run token", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const result = await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))

  assert.equal(result.status, 200)
  assert.ok("token" in result.body)
  assert.equal(result.body.hostname, "colin.frizz.sh")
  assert.equal(result.body.renewed, false)
  assert.equal(result.body.leaseExpiresAt, NOW + CLAIM_LEASE_MS)

  assert.deepEqual(cf.calls, [
    "createTunnel:u-colin",
    "setTunnelIngress:tunnel-1:colin.frizz.sh:http://localhost:9393",
    "upsertDnsRecord:colin.frizz.sh:tunnel-1.cfargotunnel.com",
  ])
  assert.equal(cf.dns.get("colin.frizz.sh"), "tunnel-1.cfargotunnel.com")
  assert.equal(st.rows.get("colin")?.tunnelId, "tunnel-1")
})

test("the same key claiming again RENEWS rather than provisioning a second tunnel", async () => {
  // The CLI calls this on every launch. If it created a tunnel each time, the 1,000-tunnel account cap
  // would be reached by a single enthusiastic user.
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store })

  await handleClaim(await claimFor(identity), d)
  const before = cf.tunnels.size
  const again = await handleClaim(await claimFor(identity, "colin", 9393, NOW + 1000), {
    ...d,
    now: () => NOW + 1000,
  })

  assert.equal(again.status, 200)
  assert.ok("renewed" in again.body && again.body.renewed)
  assert.equal(cf.tunnels.size, before, "no second tunnel")
  assert.equal(st.rows.get("colin")?.renewedAt, NOW + 1000, "the lease moved forward")
  assert.equal(st.rows.get("colin")?.claimedAt, NOW, "but the original claim date did not")
})

test("a renewal on a new port re-points the ingress", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store })

  await handleClaim(await claimFor(identity), d)
  cf.calls.length = 0
  await handleClaim(await claimFor(identity, "colin", 4321), d)

  assert.ok(
    cf.calls.includes("setTunnelIngress:tunnel-1:colin.frizz.sh:http://localhost:4321"),
    `ingress was not re-pointed: ${cf.calls.join(", ")}`
  )
  assert.equal(st.rows.get("colin")?.port, 4321)
})

test("a different key cannot take a name whose lease is still live", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const owner = await generateClaimIdentity()
  const d = deps({ api: cf.api, store: st.store })
  await handleClaim(await claimFor(owner), d)

  const attacker = await generateClaimIdentity()
  const stolen = await handleClaim(await claimFor(attacker), d)
  assert.equal(stolen.status, 409)
  assert.deepEqual(stolen.body, {
    error: "name-taken",
    message: "that name belongs to someone else",
  })
  assert.equal(st.rows.get("colin")?.pubkey, (await claimFor(owner)).pubkey, "the owner is unchanged")
})

test("a lapsed lease returns the name to the pool, tearing the old one down first", async () => {
  const cf = fakeCloudflare()
  const st = fakeStore()
  const owner = await generateClaimIdentity()
  await handleClaim(await claimFor(owner), deps({ api: cf.api, store: st.store }))

  const later = NOW + CLAIM_LEASE_MS + 1
  const newcomer = await generateClaimIdentity()
  cf.calls.length = 0
  const taken = await handleClaim(
    await claimFor(newcomer, "colin", 9393, later),
    deps({ api: cf.api, store: st.store, now: () => later })
  )

  assert.equal(taken.status, 200)
  // The old tunnel and record must go BEFORE the new ones, or the account leaks a tunnel per handover.
  assert.ok(cf.calls.includes("deleteTunnel:tunnel-1"), `old tunnel not removed: ${cf.calls.join(", ")}`)
  assert.ok(cf.calls.includes("deleteDnsRecord:colin.frizz.sh"))
  assert.equal(cf.tunnels.has("tunnel-1"), false)
  assert.equal(st.rows.get("colin")?.pubkey, (await claimFor(newcomer)).pubkey)
})

test("a failure midway through provisioning leaves NOTHING behind", async () => {
  // Tunnels are capped at 1,000 per account, so leaking one on every failed claim is a countdown to
  // the product stopping. Each step is failed in turn and the account must come back clean.
  for (const step of ["setTunnelIngress", "upsertDnsRecord"] as const) {
    const cf = fakeCloudflare(step)
    const st = fakeStore()
    const identity = await generateClaimIdentity()
    const result = await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))

    assert.equal(result.status, 502, step)
    assert.deepEqual(result.body, {
      error: "provisioning-failed",
      message: "the name could not be provisioned; nothing was left behind",
    })
    assert.equal(cf.tunnels.size, 0, `${step} leaked a tunnel`)
    assert.equal(cf.dns.size, 0, `${step} leaked a DNS record`)
    assert.equal(st.rows.size, 0, `${step} leaked a registry row`)
  }
})

test("a tunnel that cannot even be created reports failure without touching the registry", async () => {
  const cf = fakeCloudflare("createTunnel")
  const st = fakeStore()
  const identity = await generateClaimIdentity()
  const result = await handleClaim(await claimFor(identity), deps({ api: cf.api, store: st.store }))
  assert.equal(result.status, 502)
  assert.equal(st.rows.size, 0)
  assert.equal(cf.calls.filter((c) => c.startsWith("deleteTunnel")).length, 0, "nothing to unwind")
})

test("an unsigned, tampered or malformed body never reaches Cloudflare", async () => {
  // The handler is the only thing between an open endpoint and an API token that can write the zone.
  const identity = await generateClaimIdentity()
  const valid = await claimFor(identity)
  for (const body of [
    null,
    "nonsense",
    {},
    { ...valid, name: "someone-else" },
    { ...valid, sig: `${valid.sig.slice(0, -4)}AAAA` },
    { ...valid, port: 0 },
    { ...valid, issuedAt: NOW - CLAIM_LEASE_MS },
  ]) {
    const cf = fakeCloudflare()
    const st = fakeStore()
    const result = await handleClaim(body, deps({ api: cf.api, store: st.store }))
    assert.notEqual(result.status, 200, JSON.stringify(body)?.slice(0, 50))
    assert.deepEqual(cf.calls, [], "a rejected claim must not call Cloudflare at all")
    assert.equal(st.rows.size, 0)
  }
})

test("a renewal whose token cannot be re-read fails without disturbing the record", async () => {
  const st = fakeStore({
    colin: { pubkey: "", tunnelId: "tunnel-9", port: 9393, claimedAt: NOW, renewedAt: NOW },
  })
  const identity = await generateClaimIdentity()
  const request = await claimFor(identity)
  st.rows.set("colin", { ...st.rows.get("colin")!, pubkey: request.pubkey })

  const cf = fakeCloudflare("tunnelToken")
  const result = await handleClaim(request, deps({ api: cf.api, store: st.store }))

  assert.equal(result.status, 502)
  assert.equal(st.rows.get("colin")?.renewedAt, NOW, "the lease was not advanced by a failed renewal")
})
