import { test } from "node:test"
import assert from "node:assert/strict"
import { createReceiptBus } from "@fray-ui/shared"
import { createClaudeRuntimeIngest, resolveRuntimeTurn, type ClaudeRuntimeReceipt } from "./claude-runtime-ingest.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

// ---- resolveRuntimeTurn: the invariant, in isolation --------------------------------------------
// This function is the entire licence the provider's turn reading has to affect the board. Every case
// is enumerated here because the ones that must NOT change anything are as load-bearing as the ones
// that must.

test("resolveRuntimeTurn: no runtime signal changes nothing, ever", () => {
  assert.equal(resolveRuntimeTurn("idle", false, undefined), "idle")
  assert.equal(resolveRuntimeTurn("in-flight", false, undefined), "in-flight")
  assert.equal(resolveRuntimeTurn("in-flight", true, undefined), "in-flight")
})

test("resolveRuntimeTurn: `running` pulls a folded idle forward to in-flight", () => {
  // Safe in the only direction that matters — it can never fire a premature turn-done.
  assert.equal(resolveRuntimeTurn("idle", false, "running"), "in-flight")
})

test("resolveRuntimeTurn: `settled` short-circuits ONLY the backstop guess", () => {
  assert.equal(resolveRuntimeTurn("in-flight", true, "settled"), "idle")
})

test("resolveRuntimeTurn: `settled` NEVER overrides folded evidence", () => {
  // The fold reading in-flight on real evidence (an unresolved tool_use, or a trailing user record)
  // means the SDK is simply ahead of the disk. Trusting it here would queue the thread before its
  // final message — and its signal fence — had been folded.
  assert.equal(resolveRuntimeTurn("in-flight", false, "settled"), "in-flight")
})

test("resolveRuntimeTurn: `running` never un-settles a folded idle... except to in-flight", () => {
  // Exhaustive over the remaining pairs, so a future edit that widens the rule fails here first.
  assert.equal(resolveRuntimeTurn("idle", false, "settled"), "idle")
  assert.equal(resolveRuntimeTurn("in-flight", true, "running"), "in-flight")
})

// ---- the ingest itself ---------------------------------------------------------------------------

const sessionId = "s1"
const ev = {
  init: { kind: "init", protocolVersion: 1, sessionId, messageId: "i", claudeCodeVersion: "x", cwd: "/", model: "m", permissionMode: "default", tools: [], mcpServers: [], slashCommands: [], skills: [], plugins: [], capabilities: [] },
  assistant: { kind: "assistant", sessionId, messageId: "a", text: ["hi"], toolUses: [], supersedes: [] },
  user: { kind: "user", sessionId, messageId: "u", text: ["go"], toolResultIds: [], synthetic: false },
  // The same two events as a background CHILD emits them: addressed to the dispatch that started it.
  childAssistant: { kind: "assistant", sessionId, messageId: "ca", parentToolUseId: "toolu_child", text: ["working"], toolUses: [], supersedes: [] },
  childUser: { kind: "user", sessionId, messageId: "cu", parentToolUseId: "toolu_child", text: ["result"], toolResultIds: ["toolu_x"], synthetic: false },
  result: { kind: "result", sessionId, messageId: "r", subtype: "success", isError: false, errors: [] },
  resultError: { kind: "result", sessionId, messageId: "r", subtype: "error_during_execution", isError: true, errors: ["boom"] },
  other: { kind: "other", type: "system", sessionId },
} satisfies Record<string, ClaudeQueryEvent>

test("ingest: every event nudges — including the ones that carry no turn meaning", async () => {
  const nudged: string[] = []
  const ingest = createClaudeRuntimeIngest({ nudge: (slug) => nudged.push(slug) })
  ingest.onEvent("t", sessionId, ev.init)
  ingest.onEvent("t", sessionId, ev.other)
  await ingest.drain()
  assert.deepEqual(nudged, ["t", "t"], "an `other` event still means a record just hit disk")
  ingest.close()
})

test("ingest: assistant/user mean running, result means settled", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.user)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running")

  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled")

  ingest.onEvent("t", sessionId, ev.assistant)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running", "a new turn re-opens it")
  ingest.close()
})

// The resting-fleet-parent regression (reported 2026-07-30, reproduced live by _live_bg_rest_turn.mts).
// A worker that dispatches with `run_in_background: true` and rests keeps receiving its CHILD's events
// for as long as the child lives — 18 of them over two minutes in the live run. Folding those as the
// PARENT's turn held the board at in-flight for the child's whole lifetime, so the turn never settled,
// deriveAwaitingBackground (turn-idle only) could never fire, and a thread at rest for an hour rendered
// the "Working…" shimmer.
test("ingest: a CHILD's events say nothing about the PARENT's turn", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled", "the parent rested")

  ingest.onEvent("t", sessionId, ev.childAssistant)
  ingest.onEvent("t", sessionId, ev.childUser)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled", "the child's chatter must not un-rest it")
  assert.equal(ingest.liveness(sessionId)?.events, 4, "…but it is still counted, and still nudges")

  // The parent's OWN next record — the child's task-notification re-invoking it — does re-open the turn.
  ingest.onEvent("t", sessionId, ev.user)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running")
  ingest.close()
})

test("ingest: a child event fires no turn-started receipt", async () => {
  const receipts = createReceiptBus<ClaudeRuntimeReceipt>()
  const ingest = createClaudeRuntimeIngest({ nudge: () => {}, receipts })
  const cursor = receipts.cursor()
  ingest.onEvent("t", sessionId, ev.result)
  ingest.onEvent("t", sessionId, ev.childAssistant)
  await ingest.drain()
  const kinds = receipts.recent().filter((e) => e.seq > cursor).map((e) => e.receipt.type)
  assert.equal(kinds.filter((k) => k === "claude.runtime.turn.started").length, 0)
  ingest.close()
  receipts.close()
})

test("ingest: a turn-neutral event leaves the reading alone rather than resetting it", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.result)
  ingest.onEvent("t", sessionId, ev.other)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "settled")
  assert.equal(ingest.liveness(sessionId)?.events, 2)
  ingest.close()
})

test("ingest: receipts fire on the EDGE, not on every event", async () => {
  const receipts = createReceiptBus<ClaudeRuntimeReceipt>()
  const ingest = createClaudeRuntimeIngest({ nudge: () => {}, receipts })
  const cursor = receipts.cursor()
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  const kinds = receipts.recent().filter((e) => e.seq > cursor).map((e) => e.receipt.type)
  assert.equal(kinds.filter((k) => k === "claude.runtime.turn.started").length, 1, "two assistant events, one start")
  assert.equal(kinds.filter((k) => k === "claude.runtime.turn.settled").length, 1)
  ingest.close()
  receipts.close()
})

test("ingest: a failed turn's settled receipt carries isError", async () => {
  const receipts = createReceiptBus<ClaudeRuntimeReceipt>()
  const ingest = createClaudeRuntimeIngest({ nudge: () => {}, receipts })
  const cursor = receipts.cursor()
  ingest.onEvent("t", sessionId, ev.resultError)
  await ingest.drain()
  const settled = await receipts.waitFor((r) => r.type === "claude.runtime.turn.settled", { since: cursor })
  assert.equal(settled.type === "claude.runtime.turn.settled" && settled.isError, true)
  ingest.close()
  receipts.close()
})

test("ingest: release forgets the session so a replacement never inherits its reading", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.assistant)
  await ingest.drain()
  assert.equal(ingest.liveness(sessionId)?.turn, "running")
  ingest.release(sessionId)
  assert.equal(ingest.liveness(sessionId), undefined)
  ingest.close()
})

test("ingest: sessions are tracked independently", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("a", "sa", { ...ev.assistant, sessionId: "sa" })
  ingest.onEvent("b", "sb", { ...ev.result, sessionId: "sb" })
  await ingest.drain()
  assert.equal(ingest.liveness("sa")?.turn, "running")
  assert.equal(ingest.liveness("sb")?.turn, "settled")
  ingest.close()
})

test("ingest: a throwing nudge cannot wedge the queue", async () => {
  // The nudge runs the tailer's tick. A tick that throws must not stop the next event being folded.
  let calls = 0
  const ingest = createClaudeRuntimeIngest({
    nudge: () => { calls++; if (calls === 1) throw new Error("tick blew up") },
  })
  ingest.onEvent("t", sessionId, ev.assistant)
  ingest.onEvent("t", sessionId, ev.result)
  await ingest.drain()
  assert.equal(calls, 2)
  assert.equal(ingest.liveness(sessionId)?.turn, "settled")
  ingest.close()
})

// ---- task lifecycle: the payload the protocol used to discard --------------------------------------
// The tailer's whole sub-agent derivation was regex archaeology over English prose because these
// events arrived as `{kind:"other", type:"system", subtype:"task_started"}` and nothing else. Each
// test below pins one rule of the fold that replaced it.

const task = (over: Partial<Extract<ClaudeQueryEvent, { kind: "task" }>>): ClaudeQueryEvent =>
  ({ kind: "task", phase: "progress", sessionId, ...over }) as ClaudeQueryEvent

test("tasks: a session with no task events reports an empty set", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, ev.assistant)
  await ingest.drain()
  assert.deepEqual(ingest.tasks(sessionId), [])
  ingest.close()
})

test("tasks: started → progress accumulates what the child is doing", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k1", toolUseId: "toolu_1", description: "Audit the fold", subagentType: "fray:opus-high" }))
  ingest.onEvent("t", sessionId, task({ phase: "progress", taskId: "k1", lastToolName: "Bash", summary: "running the harness", usage: { totalTokens: 1234, toolUses: 7, durationMs: 9000 } }))
  await ingest.drain()
  const [entry] = ingest.tasks(sessionId)
  assert.equal(entry?.toolUseId, "toolu_1")
  assert.equal(entry?.description, "Audit the fold")
  assert.equal(entry?.subagentType, "fray:opus-high")
  assert.equal(entry?.lastToolName, "Bash")
  assert.equal(entry?.summary, "running the harness")
  assert.equal(entry?.toolUses, 7)
  assert.equal(entry?.totalTokens, 1234)
  assert.equal(entry?.terminal, false)
  ingest.close()
})

test("tasks: a notification is terminal, and its outcome is normalized", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "done", toolUseId: "toolu_done" }))
  ingest.onEvent("t", sessionId, task({ phase: "notification", taskId: "done", status: "completed", summary: "all green", outputFile: "/tmp/child.jsonl" }))
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "bad" }))
  ingest.onEvent("t", sessionId, task({ phase: "notification", taskId: "bad", status: "failed" }))
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "gone" }))
  ingest.onEvent("t", sessionId, task({ phase: "updated", taskId: "gone", status: "stopped" }))
  await ingest.drain()
  const byId = new Map(ingest.tasks(sessionId).map((entry) => [entry.taskId, entry]))
  assert.deepEqual([byId.get("done")?.terminal, byId.get("done")?.outcome], [true, "completed"])
  assert.equal(byId.get("done")?.outputFile, "/tmp/child.jsonl")
  assert.deepEqual([byId.get("bad")?.terminal, byId.get("bad")?.outcome], [true, "failed"])
  assert.deepEqual([byId.get("gone")?.terminal, byId.get("gone")?.outcome], [true, "killed"])
  ingest.close()
})

test("tasks: an UNKNOWN status is never terminal", async () => {
  // A status fray has never seen must not retire a live child. The whole point of this signal is to
  // remove phantoms, and "retire on anything unfamiliar" would manufacture the opposite failure —
  // the board reporting done while the work continues.
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k" }))
  ingest.onEvent("t", sessionId, task({ phase: "updated", taskId: "k", status: "hibernating" }))
  await ingest.drain()
  assert.equal(ingest.tasks(sessionId)[0]?.terminal, false)
  assert.equal(ingest.tasks(sessionId)[0]?.status, "hibernating")
  ingest.close()
})

test("tasks: the level signal retires a task that DROPS OUT of the live set", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "level", tasks: [{ taskId: "a" }, { taskId: "b" }] }))
  ingest.onEvent("t", sessionId, task({ phase: "level", tasks: [{ taskId: "a" }] }))
  await ingest.drain()
  const byId = new Map(ingest.tasks(sessionId).map((entry) => [entry.taskId, entry]))
  assert.equal(byId.get("a")?.terminal, false)
  assert.equal(byId.get("b")?.terminal, true, "b left the live set, so it is over")
  ingest.close()
})

test("tasks: the level sweep NEVER retires a task it has not first seen in a level payload", async () => {
  // The ordering of the level signal relative to the start/stop edges is documented as unspecified, so
  // a task_started that races ahead of the next level payload would otherwise read as "disappeared" —
  // retiring a child that is very much alive. Present-then-absent is the only edge that counts.
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "fresh" }))
  ingest.onEvent("t", sessionId, task({ phase: "level", tasks: [{ taskId: "other" }] }))
  await ingest.drain()
  const byId = new Map(ingest.tasks(sessionId).map((entry) => [entry.taskId, entry]))
  assert.equal(byId.get("fresh")?.terminal, false, "a never-levelled task is not swept")
  ingest.close()
})

test("tasks: release drops the table with the session", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k" }))
  await ingest.drain()
  assert.equal(ingest.tasks(sessionId).length, 1)
  ingest.release(sessionId)
  assert.deepEqual(ingest.tasks(sessionId), [])
  ingest.close()
})

test("tasks: a task event with no id folds nothing and wedges nothing", async () => {
  const nudged: string[] = []
  const ingest = createClaudeRuntimeIngest({ nudge: (slug) => nudged.push(slug) })
  ingest.onEvent("t", sessionId, task({ phase: "progress", lastToolName: "Bash" }))
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "k" }))
  await ingest.drain()
  assert.deepEqual(ingest.tasks(sessionId).map((entry) => entry.taskId), ["k"])
  assert.equal(nudged.length, 2, "the un-foldable event still nudged")
  ingest.close()
})

test("tasks: the per-session table is bounded, evicting FINISHED tasks first", async () => {
  const ingest = createClaudeRuntimeIngest({ nudge: () => {} })
  // One live task, then far more than the cap of finished ones.
  ingest.onEvent("t", sessionId, task({ phase: "started", taskId: "keep-me" }))
  for (let i = 0; i < 400; i++) {
    ingest.onEvent("t", sessionId, task({ phase: "started", taskId: `k${i}` }))
    ingest.onEvent("t", sessionId, task({ phase: "notification", taskId: `k${i}`, status: "completed" }))
  }
  await ingest.drain()
  const all = ingest.tasks(sessionId)
  assert.ok(all.length <= 256, `table grew to ${all.length}`)
  assert.ok(all.some((entry) => entry.taskId === "keep-me"), "the still-running task survived the eviction")
  ingest.close()
})
