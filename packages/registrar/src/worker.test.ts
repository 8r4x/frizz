import assert from "node:assert/strict"
import test from "node:test"
import { generateAnonymousClaimName, generateClaimIdentity, signClaim } from "@frizz/shared"
import worker, { kvAnonymousBudget, kvClaimStore, type KvNamespace, type RegistrarEnv } from "./worker.ts"

function fakeKv(seed: Record<string, string> = {}): KvNamespace & { rows: Map<string, string>; ttls: Map<string, number | undefined> } {
  const rows = new Map(Object.entries(seed))
  const ttls = new Map<string, number | undefined>()
  return {
    rows,
    ttls,
    async get(key) {
      return rows.get(key) ?? null
    },
    async put(key, value, options) {
      rows.set(key, value)
      ttls.set(key, options?.expirationTtl)
    },
    async delete(key) {
      rows.delete(key)
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...rows.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }
    },
  }
}

function env(kv: KvNamespace): RegistrarEnv {
  return {
    // Deliberately unusable: every test here must be rejected BEFORE anything reaches Cloudflare, so
    // a test that starts making real requests fails loudly rather than quietly calling out.
    CF_API_TOKEN: "not-a-real-token",
    CF_ACCOUNT_ID: "acct",
    CF_ZONE_ID: "zone",
    FRIZZ_ZONE: "frizz.sh",
    CLAIMS: kv,
  }
}

test("only POST /claim is routed", async () => {
  const kv = fakeKv()
  const notFound = await worker.fetch(new Request("https://r.frizz.sh/other", { method: "POST" }), env(kv))
  assert.equal(notFound.status, 404)

  const wrongMethod = await worker.fetch(new Request("https://r.frizz.sh/claim"), env(kv))
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get("allow"), "POST")
})

test("a body that is not JSON is a 400, not a crash", async () => {
  const kv = fakeKv()
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", { method: "POST", body: "{not json" }),
    env(kv)
  )
  assert.equal(response.status, 400)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const body = (await response.json()) as { error: string }
  assert.equal(typeof body.error, "string")
})

test("an unsigned claim is refused without a Cloudflare token ever being used", async () => {
  // The token in env is junk, so if this reached Cloudflare the test would fail on a network error
  // rather than pass. That is the point: rejection has to happen first.
  const kv = fakeKv()
  const identity = await generateClaimIdentity()
  const valid = await signClaim({ name: "colin", port: 9393, issuedAt: Date.now() }, identity)
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      body: JSON.stringify({ ...valid, name: "someone-else" }),
    }),
    env(kv)
  )
  assert.equal(response.status, 400)
  assert.equal(kv.rows.size, 0)
})

test("the KV store round-trips a record", async () => {
  const kv = fakeKv()
  const store = kvClaimStore(kv)
  const record = { pubkey: "k", tunnelId: "t", port: 9393, claimedAt: 1, renewedAt: 2 }
  await store.write("colin", record)
  assert.deepEqual(await store.read("colin"), record)
  await store.remove("colin")
  assert.equal(await store.read("colin"), null)
})

test("an unparseable KV row reads as absent, so one bad row cannot strand a name forever", async () => {
  const store = kvClaimStore(fakeKv({ "claim:colin": "{{{" }))
  assert.equal(await store.read("colin"), null)
})

test("the owner index round-trips under its own prefix", async () => {
  const kv = fakeKv()
  const store = kvClaimStore(kv)
  await store.writeOwner("pubkey-a", "colin")
  assert.equal(await store.readOwner("pubkey-a"), "colin")
  // It must not show up as a claimed NAME, or the sweeper would try to release a public key.
  assert.deepEqual(await store.list(), [])
  await store.removeOwner("pubkey-a")
  assert.equal(await store.readOwner("pubkey-a"), null)
})

test("listing strips the key prefix and ignores anything that is not a claim", async () => {
  // The sweeper works from this list, so a prefix left on a name would build a hostname like
  // `claim:colin.frizz.sh` and delete nothing that exists.
  const store = kvClaimStore(fakeKv({ "claim:colin": "{}", "claim:ada": "{}", "other:thing": "{}" }))
  assert.deepEqual((await store.list()).sort(), ["ada", "colin"])
})

test("an anonymous claim goes through the worker with no GitHub anywhere near it", async () => {
  // The gate is ON in this env (REQUIRE_GITHUB is unset) and relay mode records the name in KV alone,
  // so a 200 here proves the whole auth-free path: shape recognised, gate waived, nothing provisioned.
  const kv = fakeKv()
  const identity = await generateClaimIdentity()
  const name = generateAnonymousClaimName()
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify(await signClaim({ name, port: 9393, issuedAt: Date.now() }, identity)),
    }),
    env(kv)
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as { hostname: string }
  assert.equal(body.hostname, `${name}.frizz.sh`)
  assert.ok(kv.rows.has(`claim:${name}`), "the claim row was written")
  assert.equal(kv.rows.get("anonrl:203.0.113.7:" + Math.floor(Date.now() / 3_600_000)), "1", "the budget was spent")
})

test("the anonymous budget allows ten an hour and then refuses, on a row that expires itself", async () => {
  const kv = fakeKv()
  const budget = kvAnonymousBudget(kv, "203.0.113.7", () => 1_800_000_000_000)
  for (let i = 0; i < 10; i++) assert.equal(await budget(), true, `claim ${i + 1} fits the budget`)
  assert.equal(await budget(), false, "the eleventh does not")
  const key = `anonrl:203.0.113.7:${Math.floor(1_800_000_000_000 / 3_600_000)}`
  assert.equal(kv.rows.get(key), "10")
  assert.equal(kv.ttls.get(key), 7_200, "the counter cleans itself up")
  // A new hour is a new bucket: the budget refreshes without anything sweeping the old row.
  const later = kvAnonymousBudget(kv, "203.0.113.7", () => 1_800_000_000_000 + 3_600_000)
  assert.equal(await later(), true)
})

test("an over-budget anonymous claim is a 429 through the worker, naming the wait", async () => {
  const hour = Math.floor(Date.now() / 3_600_000)
  const kv = fakeKv({ [`anonrl:198.51.100.9:${hour}`]: "10" })
  const identity = await generateClaimIdentity()
  const response = await worker.fetch(
    new Request("https://r.frizz.sh/claim", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify(
        await signClaim({ name: generateAnonymousClaimName(), port: 9393, issuedAt: Date.now() }, identity)
      ),
    }),
    env(kv)
  )
  assert.equal(response.status, 429)
  const body = (await response.json()) as { error: string }
  assert.equal(body.error, "too-many-claims")
  assert.equal([...kv.rows.keys()].filter((k) => k.startsWith("claim:")).length, 0, "nothing was recorded")
})
