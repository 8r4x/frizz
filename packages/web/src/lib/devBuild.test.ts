import assert from "node:assert/strict"
import { test } from "node:test"
import { probeDevFrizzBuild, resetDevFrizzBuildProbe } from "./devBuild.ts"

// The probe backs a THREAD-FOOTER verb, and the queue renders one footer per card. A per-caller fetch
// would put a request on the wire for every card on screen, so the sharing below is the contract, not
// an optimisation detail.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

function stubFetch(handler: () => Promise<Response>): () => number {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; return handler() }) as typeof fetch
  test.after(() => { globalThis.fetch = original })
  return () => calls
}

test("every caller shares ONE supervisor request, and later callers get the cached answer", async () => {
  resetDevFrizzBuildProbe()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls = stubFetch(async () => { await gate; return json({ protocol: 1, state: "ready", dev: true }) })

  // Concurrent callers — the shape when a queue of cards mounts together.
  const concurrent = Promise.all([probeDevFrizzBuild(), probeDevFrizzBuild(), probeDevFrizzBuild()])
  release()
  assert.deepEqual(await concurrent, [true, true, true])
  assert.equal(calls(), 1, "three simultaneous footers must not make three requests")

  // A card that mounts later still asks, and must be answered without another round trip.
  assert.equal(await probeDevFrizzBuild(), true)
  assert.equal(calls(), 1, "the resolved answer is cached for components mounting afterwards")
})

// A failure must not be cached as "not a dev build": the supervisor is legitimately unreachable while
// it is restarting, and that window would otherwise hide the verb for the rest of the page's life.
test("an unreachable supervisor reads as not-dev, and is asked again next time", async () => {
  resetDevFrizzBuildProbe()
  let down = true
  const calls = stubFetch(async () => {
    if (down) throw new Error("supervisor restarting")
    return json({ protocol: 1, state: "ready", dev: true })
  })

  assert.equal(await probeDevFrizzBuild(), false, "never show a dev-only verb on no evidence")
  assert.equal(calls(), 1)

  down = false
  assert.equal(await probeDevFrizzBuild(), true, "the next mount re-probes rather than trusting a failure")
  assert.equal(calls(), 2)
})

test("a published Frizz, which omits the field entirely, is cached as not a dev build", async () => {
  resetDevFrizzBuildProbe()
  const calls = stubFetch(async () => json({ protocol: 1, state: "ready", updateRestart: true }))

  assert.equal(await probeDevFrizzBuild(), false)
  assert.equal(await probeDevFrizzBuild(), false)
  assert.equal(calls(), 1, "a definite NO is an answer too — it must not re-probe on every card")
})
