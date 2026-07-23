import assert from "node:assert/strict"
import test from "node:test"
import { SetThreadSnoozeInput } from "@fray-ui/shared"
import { awaitingHintSentence, awaitingParkAction, awaitingPresentationLine } from "./awaitingPresentation.ts"

const now = Date.parse("2026-07-21T18:00:00.000Z")

test("awaiting hints become one compact plain-English action", () => {
  assert.match(
    awaitingHintSentence([{ kind: "timer", value: "2026-07-21T21:00:00.000Z" }], now) ?? "",
    /^Snooze until /,
  )
  assert.equal(
    awaitingHintSentence([{ kind: "pr-watch", value: "owner/repo#42" }], now),
    "Watch owner/repo#42 for new reviews, approvals, or comments",
  )
  assert.equal(
    awaitingHintSentence([{ kind: "human", value: "Alice to approve the API shape" }], now),
    "Wait for Alice to approve the API shape",
  )
})

test("actionable hints win and elapsed timers remain stable instead of becoming a live status", () => {
  assert.equal(
    awaitingHintSentence([
      { kind: "timer", value: "not-a-time" },
      { kind: "pr-watch", value: "owner/repo#42" },
    ], now),
    "Watch owner/repo#42 for new reviews, approvals, or comments",
  )
  assert.match(
    awaitingHintSentence([{ kind: "timer", value: "2026-07-21T17:00:00.000Z" }], now) ?? "",
    /^Scheduled for /,
  )
  assert.equal(awaitingHintSentence([{ kind: "timer", value: "not-a-time" }], now), "Snooze schedule unavailable")
})

test("pr-watch: watcher sentence + a 'Snooze until activity' park action (holds until the next PR activity)", () => {
  assert.equal(
    awaitingHintSentence([{ kind: "pr-watch", value: "acme/app#391" }], now),
    "Watch acme/app#391 for new reviews, approvals, or comments",
  )
  assert.deepEqual(awaitingParkAction([{ kind: "pr-watch", value: "acme/app#391" }], now), {
    label: "Snooze until activity",
    toastVerb: "Holding until PR activity",
    timerUntil: null,
  })
})

test("legacy hints degrade to readable text and an empty hint set stays empty", () => {
  assert.equal(awaitingHintSentence([{ kind: "pr", value: "owner/repo#7" }], now), "Wait for PR owner/repo#7")
  assert.equal(awaitingHintSentence([{ kind: "ci", value: "build 9" }], now), "Wait for CI build 9")
  assert.equal(awaitingHintSentence([{ kind: "session", value: "sub-123" }], now), "Wait for session sub-123")
  assert.equal(awaitingHintSentence([], now), null)
})

// The fence grammar is looser than the durable snooze grammar, so "Confirm snooze" used to POST the
// raw hint and get a zod 400 back for every timer written the way the worker contract documents it
// (`2026-07-24T17:00:00Z`, no milliseconds). Each park target is checked against the real RPC schema.
test("a park target is always an instant setThreadSnooze accepts, whatever shape the fence used", () => {
  const canonical = "2026-07-21T21:00:00.000Z"
  for (const [value, expected] of [
    ["2026-07-21T21:00:00.000Z", canonical], // already canonical
    ["2026-07-21T21:00:00Z", canonical], // no milliseconds — the contract's own documented form
    ["2026-07-21T21:00Z", canonical], // no seconds
    ["2026-07-21T23:00:00+02:00", canonical], // an explicit numeric offset
    ["2026-07-21T21:00:00.123456789Z", "2026-07-21T21:00:00.123Z"], // sub-ms precision truncates
  ]) {
    const action = awaitingParkAction([{ kind: "timer", value }], now)
    assert.equal(action?.label, "Confirm snooze", value)
    assert.equal(action?.timerUntil, expected, value)
    assert.equal(SetThreadSnoozeInput.safeParse({ slug: "t", until: action?.timerUntil }).success, true, value)
  }
})

test("park kinds without a declared instant defer to the caller's preset, and unparkable hints offer nothing", () => {
  assert.deepEqual(awaitingParkAction([{ kind: "pr-watch", value: "owner/repo#42" }], now), {
    label: "Snooze until activity",
    toastVerb: "Holding until PR activity",
    timerUntil: null,
  })
  assert.deepEqual(awaitingParkAction([{ kind: "human", value: "Alice to approve" }], now), {
    label: "Confirm snooze",
    toastVerb: "Snoozed",
    timerUntil: null,
  })
  // An elapsed or malformed timer is not parkable on its own, but must not mask a parkable sibling.
  assert.equal(awaitingParkAction([{ kind: "timer", value: "2026-07-21T17:00:00Z" }], now), null)
  assert.equal(awaitingParkAction([{ kind: "timer", value: "not-a-time" }], now), null)
  assert.equal(awaitingParkAction([{ kind: "pr", value: "owner/repo#7" }], now), null)
  assert.equal(awaitingParkAction([], now), null)
  assert.equal(
    awaitingParkAction([{ kind: "timer", value: "not-a-time" }, { kind: "timer", value: "2026-07-21T21:00:00Z" }], now)?.timerUntil,
    "2026-07-21T21:00:00.000Z",
  )
})

test("body and action join as clean prose without period-dash punctuation", () => {
  assert.equal(
    awaitingPresentationLine("Park until the checkpoint.", "Snooze until today at 2:00 PM"),
    "Park until the checkpoint. Snooze until today at 2:00 PM",
  )
  assert.equal(
    awaitingPresentationLine("Park until the checkpoint", "Snooze until today at 2:00 PM"),
    "Park until the checkpoint — Snooze until today at 2:00 PM",
  )
  assert.equal(awaitingPresentationLine("", null), "Waiting for an external update.")
})
