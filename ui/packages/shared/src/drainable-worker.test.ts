import { test } from "node:test"
import assert from "node:assert/strict"
import { createDrainableWorker } from "./drainable-worker.ts"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

test("drain resolves immediately when nothing was ever enqueued", async () => {
  const worker = createDrainableWorker<number>(() => {})
  await worker.drain()
  assert.equal(worker.outstanding(), 0)
})

test("drain waits for the queue AND the in-flight item", async () => {
  const seen: number[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const worker = createDrainableWorker<number>(async (n) => {
    if (n === 1) await gate
    seen.push(n)
  })

  worker.enqueue(1)
  worker.enqueue(2)
  assert.equal(worker.outstanding(), 2)

  let drained = false
  const drain = worker.drain().then(() => { drained = true })
  await tick()
  // Item 1 is in flight and item 2 is queued — drain must not have resolved.
  assert.equal(drained, false)
  assert.deepEqual(seen, [])

  release()
  await drain
  assert.deepEqual(seen, [1, 2])
  assert.equal(worker.outstanding(), 0)
})

test("outstanding is counted at enqueue, before the pump can see the item", async () => {
  // The invariant that makes drain trustworthy: there is no window in which an item is queued but
  // uncounted, so a drain() taken at any moment covers everything enqueued before it.
  const worker = createDrainableWorker<number>(async () => { await tick() })
  worker.enqueue(1)
  assert.equal(worker.outstanding(), 1)
  worker.enqueue(2)
  assert.equal(worker.outstanding(), 2)
  await worker.drain()
  assert.equal(worker.outstanding(), 0)
})

test("items process serially, in order", async () => {
  const order: string[] = []
  const worker = createDrainableWorker<string>(async (s) => {
    order.push(`start:${s}`)
    await tick()
    order.push(`end:${s}`)
  })
  worker.enqueue("a")
  worker.enqueue("b")
  await worker.drain()
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"])
})

test("a rejected item is reported and never stalls the pump", async () => {
  const errors: unknown[] = []
  const seen: number[] = []
  const worker = createDrainableWorker<number>(
    async (n) => { if (n === 1) throw new Error("boom"); seen.push(n) },
    { onError: (e) => errors.push(e) },
  )
  worker.enqueue(1)
  worker.enqueue(2)
  await worker.drain()
  assert.equal(errors.length, 1)
  assert.equal((errors[0] as Error).message, "boom")
  assert.deepEqual(seen, [2])
})

test("a throwing item with no onError is swallowed, not surfaced as an unhandled rejection", async () => {
  const seen: number[] = []
  const worker = createDrainableWorker<number>((n) => { if (n === 1) throw new Error("boom"); seen.push(n) })
  worker.enqueue(1)
  worker.enqueue(2)
  await worker.drain()
  assert.deepEqual(seen, [2])
})

test("enqueue during processing is picked up by the same drain", async () => {
  const seen: number[] = []
  let worker: ReturnType<typeof createDrainableWorker<number>>
  worker = createDrainableWorker<number>(async (n) => {
    seen.push(n)
    if (n === 1) worker.enqueue(2)
  })
  worker.enqueue(1)
  await worker.drain()
  assert.deepEqual(seen, [1, 2])
})

test("close discards the queue, resolves waiters, and ignores later enqueues", async () => {
  const seen: number[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const worker = createDrainableWorker<number>(async (n) => { if (n === 1) await gate; seen.push(n) })
  worker.enqueue(1)
  worker.enqueue(2)
  const drain = worker.drain()
  worker.close()
  await drain // resolves despite item 1 still being in flight — nothing more will ever run
  worker.enqueue(3)
  release()
  await tick()
  await tick()
  assert.equal(seen.includes(2), false, "queued item discarded by close")
  assert.equal(seen.includes(3), false, "enqueue after close ignored")
})
