import { test } from "node:test"
import assert from "node:assert/strict"
import { createReceiptBus } from "./receipt-bus.ts"

type R =
  | { type: "a"; n: number }
  | { type: "b"; n: number }

test("waitFor resolves on a matching receipt published after the wait started", async () => {
  const bus = createReceiptBus<R>()
  const waited = bus.waitFor((r) => r.type === "a", { timeoutMs: 500 })
  bus.publish({ type: "b", n: 1 })
  bus.publish({ type: "a", n: 2 })
  assert.deepEqual(await waited, { type: "a", n: 2 })
})

test("a receipt published between the action and the await is still matched via `since`", async () => {
  // The whole reason the backlog exists. Without it this is the classic missed-milestone hang.
  const bus = createReceiptBus<R>()
  const cursor = bus.cursor()
  bus.publish({ type: "a", n: 1 }) // the milestone lands BEFORE anyone awaits it
  const got = await bus.waitFor((r) => r.type === "a", { since: cursor, timeoutMs: 500 })
  assert.deepEqual(got, { type: "a", n: 1 })
})

test("waitFor defaults to future-only, so a stale receipt cannot satisfy a later wait", async () => {
  const bus = createReceiptBus<R>()
  bus.publish({ type: "a", n: 1 }) // an earlier phase's receipt
  await assert.rejects(
    () => bus.waitFor((r) => r.type === "a", { timeoutMs: 60, label: "a" }),
    /timed out after 60ms waiting for a/,
  )
})

test("the timeout error names what did arrive", async () => {
  const bus = createReceiptBus<R>()
  const pending = bus.waitFor((r) => r.type === "a", { timeoutMs: 80, label: "an `a`" })
  bus.publish({ type: "b", n: 1 })
  bus.publish({ type: "b", n: 2 })
  await assert.rejects(() => pending, (err: Error) => {
    assert.match(err.message, /waiting for an `a`/)
    assert.match(err.message, /\[b, b\]/)
    return true
  })
})

test("waitForType narrows and matches by type", async () => {
  const bus = createReceiptBus<R>()
  const waited = bus.waitForType("b", { timeoutMs: 500 })
  bus.publish({ type: "a", n: 1 })
  bus.publish({ type: "b", n: 7 })
  const got = await waited
  assert.equal(got.n, 7)
})

test("subscribe sees every receipt with a monotonic sequence, and unsubscribe stops it", () => {
  const bus = createReceiptBus<R>()
  const seen: Array<[string, number]> = []
  const off = bus.subscribe((r, seq) => seen.push([r.type, seq]))
  bus.publish({ type: "a", n: 1 })
  bus.publish({ type: "b", n: 2 })
  off()
  bus.publish({ type: "a", n: 3 })
  assert.deepEqual(seen, [["a", 1], ["b", 2]])
  assert.equal(bus.cursor(), 3)
})

test("a throwing listener never destabilizes the publisher or the other listeners", () => {
  const bus = createReceiptBus<R>()
  const seen: string[] = []
  bus.subscribe(() => { throw new Error("listener blew up") })
  bus.subscribe((r) => seen.push(r.type))
  assert.doesNotThrow(() => bus.publish({ type: "a", n: 1 }))
  assert.deepEqual(seen, ["a"])
})

test("the backlog is bounded and drops oldest first", () => {
  const bus = createReceiptBus<R>({ backlog: 3 })
  for (let n = 1; n <= 5; n++) bus.publish({ type: "a", n })
  assert.deepEqual(bus.recent().map((e) => (e.receipt as { n: number }).n), [3, 4, 5])
})

test("close rejects a fresh wait rather than hanging it forever", async () => {
  const bus = createReceiptBus<R>()
  bus.close()
  await assert.rejects(() => bus.waitFor(() => true, { timeoutMs: 500 }), /receipt bus closed/)
})
