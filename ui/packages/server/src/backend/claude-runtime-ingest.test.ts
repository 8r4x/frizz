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
