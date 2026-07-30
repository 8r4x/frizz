import assert from "node:assert/strict"
import test from "node:test"
import { SetThreadSnoozeInput } from "@fray-ui/shared"
import {
  AWAITING_FALLBACK_TITLE,
  AWAITING_PARK_BUTTON,
  awaitingHintSentence,
  awaitingParkAction,
  awaitingPresentationLine,
} from "./awaitingPresentation.ts"

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

test("pr-watch: watcher sentence + a 'PR watcher armed' park action (parks the card until the next PR activity)", () => {
  assert.equal(
    awaitingHintSentence([{ kind: "pr-watch", value: "acme/app#391" }], now),
    "Watch acme/app#391 for new reviews, approvals, or comments",
  )
  assert.deepEqual(awaitingParkAction([{ kind: "pr-watch", value: "acme/app#391" }], now), {
    title: "PR watcher armed",
    explainer: "This will dismiss the card from the queue until PR activity is detected.",
    toastVerb: "Watcher armed",
    timerUntil: null,
  })
})

// A fence watching a SET of PRs carries one `pr-watch:` line per PR and the scheduler polls every one
// of them. Naming only the first read as "this thread watches a single PR" — the exact misreading that
// sent a worker tracking 11 adoption PRs to a 7-day timer sweep instead of a watcher on each, and left
// a real CHANGES_REQUESTED review unreported for a day and a half (burned 2026-07-30).
test("pr-watch: the sentence names EVERY watched PR, not just the first", () => {
  assert.equal(
    awaitingHintSentence([
      { kind: "pr-watch", value: "withastro/astro#17487" },
      { kind: "pr-watch", value: "vitejs/vite#23019" },
    ], now),
    "Watch withastro/astro#17487 and vitejs/vite#23019 for new reviews, approvals, or comments",
  )
  assert.equal(
    awaitingHintSentence([
      { kind: "pr-watch", value: "a/a#1" },
      { kind: "pr-watch", value: "b/b#2" },
      { kind: "pr-watch", value: "c/c#3" },
    ], now),
    "Watch a/a#1, b/b#2 and c/c#3 for new reviews, approvals, or comments",
  )
  // Past three the card's one line stops reading as a sentence, so the tail is counted instead.
  assert.equal(
    awaitingHintSentence([
      { kind: "pr-watch", value: "a/a#1" },
      { kind: "pr-watch", value: "b/b#2" },
      { kind: "pr-watch", value: "c/c#3" },
      { kind: "pr-watch", value: "d/d#4" },
      { kind: "pr-watch", value: "e/e#5" },
    ], now),
    "Watch a/a#1, b/b#2, c/c#3 and 2 more for new reviews, approvals, or comments",
  )
})

// The prompt tells a worker past the 8-hint cap to cover the tail with a `timer:`, so watcher+timer is
// a fence shape that really occurs. Leading with the clock titled it "Scheduled snooze" and dropped the
// watcher from the card entirely — the live wake hidden behind its own backstop.
test("pr-watch outranks a co-declared timer, which becomes the named backstop", () => {
  const hints = [
    { kind: "pr-watch", value: "acme/app#391" },
    { kind: "timer", value: "2026-07-21T21:00:00.000Z" },
  ] as const
  // A semicolon + a fresh verb, never ", or <instant>" — a comma-or tail attaches to the sentence's
  // own or-list and reads as a fourth kind of PR activity (caught reading the rendered card back).
  assert.match(
    awaitingHintSentence([...hints], now) ?? "",
    /^Watch acme\/app#391 for new reviews, approvals, or comments; otherwise resume today at .+$/,
  )
  const park = awaitingParkAction([...hints], now)
  assert.equal(park?.title, "PR watcher armed")
  assert.match(park?.explainer ?? "", /^This will dismiss the card from the queue until PR activity is detected, or until today at .+\.$/)
  // The declared instant still drives the park, so confirming snoozes to the fence's own backstop
  // rather than the user's default preset.
  assert.equal(park?.timerUntil, "2026-07-21T21:00:00.000Z")
})

// The card's HEADING names the wait and the muted explainer names the effect, so the button itself is
// one word for every kind (maintainer 2026-07-24: "Arm watcher" read as a verb when it was a title; the heading is a STATE,
// "PR watcher armed", since 2026-07-29).
// Each explainer must state the real wake, which for pr-watch is ACTIVITY — not the safety timeout.
test("every parkable kind carries a card title and an explainer naming what actually re-surfaces it", () => {
  assert.equal(AWAITING_PARK_BUTTON, "Snooze")
  assert.equal(AWAITING_FALLBACK_TITLE, "Awaiting")
  const timer = awaitingParkAction([{ kind: "timer", value: "2026-07-21T21:00:00Z" }], now)
  assert.equal(timer?.title, "Scheduled snooze")
  assert.match(timer?.explainer ?? "", /^This will dismiss the card from the queue until today at .+\.$/)
  assert.equal(
    awaitingParkAction([{ kind: "human", value: "Alice to approve" }], now)?.explainer,
    "This will dismiss the card from the queue until your default snooze elapses.",
  )
  // No parkable hint → no action at all, so the card falls back to the plain "Awaiting" heading.
  assert.equal(awaitingParkAction([{ kind: "ci", value: "build 9" }], now), null)
})

test("legacy hints degrade to readable text and an empty hint set stays empty", () => {
  assert.equal(awaitingHintSentence([{ kind: "pr", value: "owner/repo#7" }], now), "Wait for PR owner/repo#7")
  assert.equal(awaitingHintSentence([{ kind: "ci", value: "build 9" }], now), "Wait for CI build 9")
  assert.equal(awaitingHintSentence([{ kind: "session", value: "sub-123" }], now), "Wait for session sub-123")
  assert.equal(awaitingHintSentence([], now), null)
})

// The fence grammar is looser than the durable snooze grammar, so the timer park used to POST the
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
    assert.equal(action?.title, "Scheduled snooze", value)
    assert.equal(action?.timerUntil, expected, value)
    assert.equal(SetThreadSnoozeInput.safeParse({ slug: "t", sessionId: "s", until: action?.timerUntil }).success, true, value)
  }
})

test("park kinds without a declared instant defer to the caller's preset, and unparkable hints offer nothing", () => {
  assert.deepEqual(awaitingParkAction([{ kind: "pr-watch", value: "owner/repo#42" }], now), {
    title: "PR watcher armed",
    explainer: "This will dismiss the card from the queue until PR activity is detected.",
    toastVerb: "Watcher armed",
    timerUntil: null,
  })
  assert.deepEqual(awaitingParkAction([{ kind: "human", value: "Alice to approve" }], now), {
    title: "Awaiting human",
    explainer: "This will dismiss the card from the queue until your default snooze elapses.",
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
