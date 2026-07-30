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
    { label: undefined, duration: "3 min", tone: "muted", title: "Ran for 3 min", showSpinner: false },
  )
  assert.deepEqual(
    agentReading({ agentStatus: "killed", agentElapsedMs: 41 * MIN }),
    { label: "stopped", duration: "41 min", tone: "muted", title: "Stopped after 41 min", showSpinner: false },
  )
  assert.deepEqual(
    agentReading({ agentStatus: "failed", agentElapsedMs: 12 * MIN }),
    { label: "failed", duration: "12 min", tone: "failed", title: "Failed after 12 min", showSpinner: false },
  )
})

test("a tracked child reads a BARE runtime — the mark on its left is what says running", () => {
  for (const liveState of ["running", "stale", "rested"] as const) {
    const reading = agentReading({ liveState, liveElapsedMs: 4 * MIN })!
    assert.equal(reading.label, undefined, `${liveState}: no verb — the mark carries the state`)
    assert.equal(reading.duration, "4 min")
    assert.equal(reading.tone, "muted")
    assert.equal(reading.showSpinner, false)
  }
  // Only a RUNNING child is "working": a tooltip must never contradict the mark beside it.
  assert.match(agentReading({ liveState: "running", liveElapsedMs: 4 * MIN })!.title, /^Working for/)
  assert.match(agentReading({ liveState: "stale", liveElapsedMs: 4 * MIN })!.title, /^Dispatched/)
  assert.match(agentReading({ liveState: "rested", liveElapsedMs: 4 * MIN })!.title, /^Dispatched/)
})

// THE CORE INVARIANT. Losing the correlation to a child is fray's problem, not the reader's: the same
// event must produce the same word and the same tone either way. This is what "cancelled" in amber
// beside "stopped" in gray was violating.
test("whether a child record survived never changes the words or the tone", () => {
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
  const rest = [
    { agentStatus: "completed" as const }, { agentStatus: "killed" as const },
    { status: "completed" as const, durationMs: 1 }, { status: "cancelled" as const, durationMs: 1 },
    { status: "pending" as const }, { liveState: "running" as const, liveElapsedMs: 1 },
  ]
  for (const input of failures) assert.equal(agentReading(input)!.tone, "failed", JSON.stringify(input))
  for (const input of rest) assert.equal(agentReading(input)!.tone, "muted", JSON.stringify(input))
})

test("an untracked pending dispatch carries the row's only motion, as a neutral spinner", () => {
  assert.deepEqual(agentReading({ status: "pending" }), { label: "running", tone: "muted", title: "Running", showSpinner: true })
  // A TRACKED running child must not also spin: its left-hand mark is the one indicator.
  assert.equal(agentReading({ status: "pending", liveState: "running", liveElapsedMs: MIN })!.showSpinner, false)
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
  // A resolved child with no elapsed still reports its outcome — the verb is the load-bearing part.
  assert.deepEqual(agentReading({ agentStatus: "killed" }), { label: "stopped", duration: undefined, tone: "muted", title: "Stopped after an unknown time", showSpinner: false })
})
