import { test } from "node:test"
import assert from "node:assert/strict"
import { beginEagerSubmission, enqueueThreadSend } from "./eagerComposerSubmission.ts"

test("eager composer submission clears and paints before its request settles", async () => {
  const order: string[] = []
  let resolve!: () => void
  const request = new Promise<void>((done) => { resolve = done })
  beginEagerSubmission({
    optimistic: () => order.push("cleared-and-queued"),
    request: () => { order.push("request-started"); return request },
    success: () => order.push("success"),
    failure: () => order.push("failure"),
  })
  assert.deepEqual(order, ["cleared-and-queued", "request-started"])
  resolve()
  await request
  await Promise.resolve()
  assert.deepEqual(order, ["cleared-and-queued", "request-started", "success"])
})

test("eager composer submission rolls back after a rejected request", async () => {
  const order: string[] = []
  beginEagerSubmission({
    optimistic: () => order.push("cleared-and-queued"),
    request: async () => { throw new Error("offline") },
    failure: (error) => order.push(`rolled-back:${error.message}`),
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(order, ["cleared-and-queued", "rolled-back:offline"])
})

// The composer no longer locks during a send, so nothing in the UI stops a second steer landing
// mid-flight. These pin the invariant that replaced the lock: one request at a time per thread, in
// the order the human committed them.
test("thread sends run one at a time, in submission order", async () => {
  const events: string[] = []
  const gates: Array<() => void> = []
  const start = (label: string) => enqueueThreadSend("alpha", () => {
    events.push(`start:${label}`)
    return new Promise<void>((resolve) => gates.push(() => { events.push(`end:${label}`); resolve() }))
  })

  const first = start("one")
  const second = start("two")
  const third = start("three")
  await Promise.resolve()
  // Only the head is in flight: the two behind it have not touched the network.
  assert.deepEqual(events, ["start:one"])

  gates[0]()
  await first
  await Promise.resolve()
  assert.deepEqual(events, ["start:one", "end:one", "start:two"])

  gates[1]()
  await second
  await Promise.resolve()
  gates[2]()
  await third
  assert.deepEqual(events, ["start:one", "end:one", "start:two", "end:two", "start:three", "end:three"])
})

test("a failed send rejects to its own caller without stranding the sends behind it", async () => {
  const delivered: string[] = []
  const failing = enqueueThreadSend("beta", async () => { throw new Error("runtime control busy") })
  const following = enqueueThreadSend("beta", async () => { delivered.push("after") })

  await assert.rejects(failing, /runtime control busy/)
  await following
  assert.deepEqual(delivered, ["after"])
})

test("separate threads do not queue behind each other", async () => {
  const events: string[] = []
  let releaseAlpha!: () => void
  const alpha = enqueueThreadSend("gamma", () => new Promise<void>((resolve) => {
    events.push("gamma-start")
    releaseAlpha = () => { resolve() }
  }))
  const beta = enqueueThreadSend("delta", async () => { events.push("delta-done") })

  await beta
  // delta finished while gamma is still in flight — one blocked thread must not stall the board.
  assert.deepEqual(events, ["gamma-start", "delta-done"])
  releaseAlpha()
  await alpha
})
