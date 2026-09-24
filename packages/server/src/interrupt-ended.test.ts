import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isInterruptEndedWake } from "@frizz/shared"
import { createStorage, type Storage } from "./storage.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"
import type { SessionTelemetry, SubAgentView } from "./tailer.ts"
import { noteSubAgentsEndedByInterrupt, runningSubAgentsOf } from "./interrupt-ended.ts"

function tmpStorage(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "frizz-intr-")), "ui.db"), "p")
}

const child = (id: string, over: Partial<SubAgentView> = {}): SubAgentView => ({
  id, label: `child ${id}`, startedAt: "2026-09-24T03:00:00.000Z", state: "running", taskId: `a-${id}`, ...over,
})
const tele = (subAgents: SubAgentView[]): SessionTelemetry =>
  ({ turn: "in-flight", permPrompt: false, subAgents, bgShells: [], pendingQuestion: false }) as SessionTelemetry

// The snapshot is the set the interrupt can kill: running children only, by the dispatch id the tailer
// keys on, carrying the runtime id the WORKER knows them by (the one it writes in an `agents:` line).
test("runningSubAgentsOf keeps running children only, with the runtime id the worker was shown", () => {
  const got = runningSubAgentsOf(tele([child("t1"), child("t2", { state: "rested" }), child("t3", { state: "stale" }), child("t4", { taskId: undefined })]))
  assert.deepEqual(got, [{ id: "t1", taskId: "a-t1", label: "child t1" }, { id: "t4", label: "child t4" }])
  assert.deepEqual(runningSubAgentsOf(undefined), [])
})

// THE CASE FROM THE NUB THREAD: the child is listed the instant before the interrupt, the tailer drops it
// a moment later, and the worker is handed one note naming that child by the id it would have parked on.
test("a child the tailer stops listing after the interrupt is named in one queued note", async () => {
  const storage = tmpStorage()
  const reads: SessionTelemetry[] = [tele([child("t1")]), tele([child("t1")]), tele([])]
  const tailer = { get: () => reads.length > 1 ? reads.shift()! : reads[0] }
  const before = runningSubAgentsOf(tele([child("t1")]))
  await noteSubAgentsEndedByInterrupt({ tailer, storage, pollMs: 1 }, { slug: "s", sessionId: "sid", before, interruptedAtMs: 1_000 })
  const rows = createWakeDeliveryStore(storage.scope).list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].fenceId, "interrupt-ended:1000")
  assert.ok(isInterruptEndedWake(rows[0].message))
  assert.match(rows[0].message, /- `a-t1` — child t1/)
  assert.match(rows[0].message, /refused as NOT RUNNING/)
  storage.close()
})

// A child the tailer STILL shows running when the wait runs out is not reported: the note names what
// frizz saw end, never what it presumed. The one that did end is still reported.
test("only the children that actually ended are named; a survivor is left out", async () => {
  const storage = tmpStorage()
  let ms = 0
  const tailer = { get: () => tele([child("survivor")]) }
  const before = runningSubAgentsOf(tele([child("survivor"), child("victim")]))
  await noteSubAgentsEndedByInterrupt(
    { tailer, storage, pollMs: 1, maxWaitMs: 5, now: () => (ms += 3) },
    { slug: "s", sessionId: "sid", before, interruptedAtMs: 7 },
  )
  const rows = createWakeDeliveryStore(storage.scope).list()
  assert.equal(rows.length, 1)
  assert.match(rows[0].message, /- `a-victim` — child victim/)
  assert.doesNotMatch(rows[0].message, /survivor/)
  storage.close()
})

test("nothing is queued when no child was running, or when every child survived", async () => {
  const storage = tmpStorage()
  let ms = 0
  const tailer = { get: () => tele([child("t1")]) }
  await noteSubAgentsEndedByInterrupt({ tailer, storage }, { slug: "s", sessionId: "sid", before: [], interruptedAtMs: 1 })
  await noteSubAgentsEndedByInterrupt(
    { tailer, storage, pollMs: 1, maxWaitMs: 2, now: () => (ms += 5) },
    { slug: "s", sessionId: "sid", before: runningSubAgentsOf(tele([child("t1")])), interruptedAtMs: 2 },
  )
  assert.deepEqual(createWakeDeliveryStore(storage.scope).list(), [])
  storage.close()
})

// One interrupt, one note: the fence id is the interrupt's instant, so a second enqueue for the same
// interrupt (a retry, a double call) lands on the existing row.
test("the same interrupt never queues two notes", async () => {
  const storage = tmpStorage()
  const tailer = { get: () => tele([]) }
  const before = runningSubAgentsOf(tele([child("t1")]))
  for (let i = 0; i < 2; i++) {
    await noteSubAgentsEndedByInterrupt({ tailer, storage }, { slug: "s", sessionId: "sid", before, interruptedAtMs: 42 })
  }
  assert.equal(createWakeDeliveryStore(storage.scope).list().length, 1)
  storage.close()
})
