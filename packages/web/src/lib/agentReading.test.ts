import assert from "node:assert/strict"
import test from "node:test"
import { agentReading } from "./agentReading.ts"

// The eight readings a dispatch card can show, asserted as ONE matrix. They shipped as two renderers
// chosen by whether a live child record survived, and drifted into two typographic systems, four
// saturations, two duration formatters and two separators — for what is, to a reader, one kind of
// reading. These tests pin the vocabulary and the tone; agentRowIndicators.e2e.test.ts pins that they
// all render through one treatment in a real browser.

const MIN = 60_000

test("a resolved child reports its outcome verb, and a nominal one reports none", () => {
  assert.deepEqual(
    agentReading({ agentStatus: "completed", agentElapsedMs: 3 * MIN }),
    { label: undefined, duration: "3 min", tone: "muted", title: "Ran for 3 min" },
  )
  assert.deepEqual(
    agentReading({ agentStatus: "killed", agentElapsedMs: 41 * MIN }),
    { label: "stopped", duration: "41 min", tone: "muted", title: "Stopped after 41 min" },
  )
  assert.deepEqual(
    agentReading({ agentStatus: "failed", agentElapsedMs: 12 * MIN }),
    { label: "failed", duration: "12 min", tone: "failed", title: "Failed after 12 min" },
  )
})

test("a tracked child reads a BARE runtime — the mark on its left is what says running", () => {
  for (const liveState of ["running", "stale", "rested"] as const) {
    const reading = agentReading({ liveState, liveElapsedMs: 4 * MIN })!
    assert.equal(reading.label, undefined, `${liveState}: no verb — the mark carries the state`)
    assert.equal(reading.duration, "4 min")
    assert.equal(reading.tone, "muted")
  }
  // Only a RUNNING child is "working": a tooltip must never contradict the mark beside it.
  assert.match(agentReading({ liveState: "running", liveElapsedMs: 4 * MIN })!.title, /^Working for/)
  assert.match(agentReading({ liveState: "stale", liveElapsedMs: 4 * MIN })!.title, /^Dispatched/)
  assert.match(agentReading({ liveState: "rested", liveElapsedMs: 4 * MIN })!.title, /^Dispatched/)
})

// A failed/cancelled dispatch has no child runtime to overlay, but its terminal words and tone still
// match the corresponding child outcome. This is what "cancelled" in amber beside "stopped" in gray
// was violating.
test("terminal failures keep the same words and tone when no child record exists", () => {
  const tracked = agentReading({ agentStatus: "killed", agentElapsedMs: 41 * MIN })!
  const orphaned = agentReading({ status: "cancelled", durationMs: 41 * MIN })!
  assert.equal(orphaned.label, tracked.label, "an interrupted dispatch says 'stopped' with or without a child record")
  assert.equal(orphaned.tone, tracked.tone)
  assert.equal(orphaned.duration, tracked.duration)

  const failedChild = agentReading({ agentStatus: "failed", agentElapsedMs: 12 * MIN })!
  const failedCall = agentReading({ status: "failed", durationMs: 12 * MIN })!
  assert.equal(failedCall.label, failedChild.label)
  assert.equal(failedCall.tone, failedChild.tone)
})

test("only a genuine failure is toned as one", () => {
  const failures = [{ agentStatus: "failed" as const }, { status: "failed" as const, durationMs: 1 }]
  // `{ status: "pending" }` is deliberately absent: an untracked pending dispatch has no reading at all
  // any more, so it has no tone to check (see the liveness-claim test below).
  const rest = [
    { agentStatus: "completed" as const }, { agentStatus: "killed" as const },
    { status: "cancelled" as const, durationMs: 1 },
    { liveState: "running" as const, liveElapsedMs: 1 },
  ]
  for (const input of failures) assert.equal(agentReading(input)!.tone, "failed", JSON.stringify(input))
  for (const input of rest) assert.equal(agentReading(input)!.tone, "muted", JSON.stringify(input))
})

// THE READING MAY NEVER CLAIM LIVENESS. An untracked pending dispatch used to render "running" beside a
// spinner here, on the theory that "we have no record of this child" is the one thing elapsed time
// cannot speak for. But `pending` is not evidence of life: the server holds an Agent launch pending
// until a task-notification correlates to it, so a dispatch whose terminal signal never arrived stays
// pending forever and that spinner advertised a child dead for hours (maintainer 2026-08-01: it "should
// not show up under any circumstances"). Liveness now lives in exactly one place — the left-hand mark,
// which requires an OBSERVED live child record.
test("an untracked pending dispatch claims nothing at all", () => {
  assert.equal(agentReading({ status: "pending" }), null)
  // A TRACKED child still reads its runtime; the mark beside it is what says it is running.
  assert.deepEqual(
    agentReading({ status: "pending", liveState: "running", liveElapsedMs: MIN }),
    { label: undefined, duration: "1 min", tone: "muted", title: "Working for 1 min" },
  )
})

test("durations are the spelled-out minute-resolution form, with the precise value in the tooltip", () => {
  // The house rule in durationLabels.ts: spell units out in a small-caps status row. No "41m" anywhere.
  assert.equal(agentReading({ agentStatus: "killed", agentElapsedMs: 65 * MIN })!.duration, "1 hr 5 min")
  assert.equal(agentReading({ agentStatus: "completed", agentElapsedMs: 38_000 })!.duration, "<1 min")
  // …and the seconds the reading rounds away are still one hover from the reader.
  assert.equal(agentReading({ agentStatus: "completed", agentElapsedMs: 38_000 })!.title, "Ran for 38 sec")
  assert.equal(agentReading({ status: "failed", durationMs: 12_000 })!.title, "Failed after 12 sec")
})

test("nothing to report renders nothing, never a fabricated reading", () => {
  assert.equal(agentReading({}), null)
  assert.equal(agentReading({ status: undefined, durationMs: undefined }), null)
  assert.equal(agentReading({ status: "completed", durationMs: 533 }), null, "a spawn call's latency is not the child runtime")
  assert.equal(agentReading({ durationMs: 533 }), null, "legacy status-less call timing is equally insufficient")
  // A resolved child with no elapsed still reports its outcome — the verb is the load-bearing part.
  assert.deepEqual(agentReading({ agentStatus: "killed" }), { label: "stopped", duration: undefined, tone: "muted", title: "Stopped after an unknown time" })
})
