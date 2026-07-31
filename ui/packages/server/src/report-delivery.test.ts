import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isModelFacingCarrier, isAgentReport, blockTaskIds, parseReportBlock, repairedTaskIds,
  repairMessage, reportsDueForRepair, REPAIR_MARKER, REPORT_REPAIR_AFTER_MS, type QueuedReport,
} from "./report-delivery.ts"

// Shaped exactly like the real thing (see the corpus quoted in report-delivery.ts).
const block = (over: Partial<{ taskId: string; toolUseId: string; status: string; summary: string; result: string; outputFile: string }> = {}): string => {
  const o = {
    taskId: "aa226fb0780c4cfd3",
    toolUseId: "toolu_01J7HJEZK5ZizYqm3D3ZKkX9",
    status: "completed",
    summary: 'Agent "Verify the published 98% compat figure" finished',
    result: "x".repeat(1234),
    outputFile: "/private/tmp/claude-501/proj/sess/tasks/aa226fb0780c4cfd3.output",
    ...over,
  }
  return [
    "<task-notification>",
    `<task-id>${o.taskId}</task-id>`,
    `<tool-use-id>${o.toolUseId}</tool-use-id>`,
    `<output-file>${o.outputFile}</output-file>`,
    `<status>${o.status}</status>`,
    `<summary>${o.summary}</summary>`,
    `<result>${o.result}</result>`,
    "</task-notification>",
  ].join("\n")
}

test("a queue-operation is NOT model-facing — the whole basis of the fix", () => {
  assert.equal(isModelFacingCarrier("queue-operation"), false)
  assert.equal(isModelFacingCarrier("user"), true)
  assert.equal(isModelFacingCarrier("attachment"), true)
  // Anything else is sidecar bookkeeping and must not count as delivery.
  for (const t of ["assistant", "system", "last-prompt", "pr-link", undefined, null, 7])
    assert.equal(isModelFacingCarrier(t), false, `${String(t)} must not read as delivery`)
})

test("only an AGENT report is repairable — a shell's exit line is not a lost report", () => {
  assert.equal(isAgentReport('Agent "Correctness review of X" finished', "a26ab44059b4cf3db"), true)
  assert.equal(isAgentReport('Background command "Run the clippy gate" completed (exit code 0)', "bqt3teief"), false)
  assert.equal(isAgentReport('Monitor event: "nub CLI build completion"', "bckovggbo"), false)
})

test("with no summary at all (the recovery shape) the task-id LENGTH is the fallback", () => {
  assert.equal(isAgentReport(undefined, "a26ab44059b4cf3db"), true, "17-char agent id")
  assert.equal(isAgentReport(undefined, "bqt3teief"), false, "9-char shell id")
})

test("a summary naming something else is believed over the id shape", () => {
  // Corroboration runs one way only: an explicit non-agent summary wins even on a long id, so a future
  // id-format change cannot silently start repairing shells.
  assert.equal(isAgentReport("Background command \"x\" completed", "aaaaaaaaaaaaaaaaa"), false)
})

test("parseReportBlock pulls the fields a repair needs, and sizes the payload", () => {
  const p = parseReportBlock(block(), "2026-07-30T23:13:11.526Z")
  assert.equal(p.toolUseId, "toolu_01J7HJEZK5ZizYqm3D3ZKkX9")
  assert.equal(p.outputFile, "/private/tmp/claude-501/proj/sess/tasks/aa226fb0780c4cfd3.output")
  assert.equal(p.summary, 'Agent "Verify the published 98% compat figure" finished')
  assert.equal(p.queuedAt, "2026-07-30T23:13:11.526Z")
  assert.equal(p.chars, 1234)
})

test("blockTaskIds reads every id in a recovery block and drops the orphan sentinel", () => {
  const multi = `<task-notification><task-id>a1</task-id><task-id>__orphan_summary__x</task-id><task-id>a2</task-id></task-notification>`
  assert.deepEqual(blockTaskIds(multi), ["a1", "a2"])
})

test("a repair is idempotent through the TRANSCRIPT — its own marker resolves it on re-fold", () => {
  const report: QueuedReport = { taskId: "a26ab44059b4cf3db", chars: 14796, outputFile: "/t/a.output", summary: 'Agent "Impact analysis" finished' }
  const msg = repairMessage(report)
  // This is the load-bearing round-trip: what fray injects must be readable back as delivery evidence
  // for exactly this task-id, or a fray restart repairs the same report forever.
  assert.deepEqual(repairedTaskIds(msg), ["a26ab44059b4cf3db"])
  assert.deepEqual(repairedTaskIds("ordinary prose with no marker"), [])
})

test("the repair names the file and refuses to pretend the agent read anything", () => {
  const msg = repairMessage({ taskId: "a1", chars: 14796, outputFile: "/t/a.output", summary: 'Agent "Impact analysis" finished' })
  assert.ok(msg.includes("/t/a.output"), "must point at the report on disk")
  assert.ok(msg.includes("14,796"), "must state what was lost")
  assert.ok(msg.includes(REPAIR_MARKER))
  // A pointer, never the payload — re-injecting the text would re-feed the runtime the thing it just
  // failed to move, and the file holds more than the truncated excerpt anyway.
  assert.ok(msg.length < 1000, `repair must stay compact, was ${msg.length}`)
})

test("with no output file the repair says so rather than pointing at nothing", () => {
  const msg = repairMessage({ taskId: "a1", chars: 0 })
  assert.ok(!msg.includes("undefined"), msg)
  assert.ok(msg.includes("not recoverable"), msg)
})

test("nothing is repaired while a turn is in flight — the report may still be arriving", () => {
  const now = Date.parse("2026-07-30T12:00:00Z")
  const old: QueuedReport = { taskId: "a1", chars: 10, queuedAt: "2026-07-30T11:00:00Z" }
  assert.deepEqual(reportsDueForRepair([old], { nowMs: now, atRest: false }), [])
  assert.deepEqual(reportsDueForRepair([old], { nowMs: now, atRest: true }).map((r) => r.taskId), ["a1"])
})

test("a freshly queued report is left alone until the age floor passes", () => {
  const now = Date.parse("2026-07-30T12:00:00Z")
  const fresh: QueuedReport = { taskId: "a1", chars: 10, queuedAt: new Date(now - 1_000).toISOString() }
  assert.deepEqual(reportsDueForRepair([fresh], { nowMs: now, atRest: true }), [])
  const ripe: QueuedReport = { taskId: "a2", chars: 10, queuedAt: new Date(now - REPORT_REPAIR_AFTER_MS - 1).toISOString() }
  assert.deepEqual(reportsDueForRepair([ripe], { nowMs: now, atRest: true }).map((r) => r.taskId), ["a2"])
})

test("an unparseable timestamp makes a report due, never eternally un-repairable", () => {
  const now = Date.parse("2026-07-30T12:00:00Z")
  for (const queuedAt of [undefined, "", "not-a-date"]) {
    const r: QueuedReport = { taskId: "a1", chars: 10, queuedAt }
    assert.deepEqual(reportsDueForRepair([r], { nowMs: now, atRest: true }).map((x) => x.taskId), ["a1"], String(queuedAt))
  }
})
