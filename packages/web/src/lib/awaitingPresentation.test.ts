import assert from "node:assert/strict"
import test from "node:test"
import { SetThreadSnoozeInput } from "@frizz/shared"
import {
  AWAITING_FALLBACK_TITLE,
  AWAITING_PARK_BUTTON,
  awaitingHintSentence,
  awaitingParkAction,
  awaitingPresentationLine,
  prWatchRefs,
} from "./awaitingPresentation.ts"

const now = Date.parse("2026-07-21T18:00:00.000Z")

test("awaiting hints become one compact plain-English action", () => {
  assert.match(
    awaitingHintSentence([{ kind: "timer", value: "2026-07-21T21:00:00.000Z" }], now) ?? "",
    /^Snooze until /,
  )
  assert.equal(
    awaitingHintSentence([{ kind: "pr", value: "owner/repo#42" }], now),
    null,
  )
  assert.equal(
    awaitingHintSentence([{ kind: "shell", value: "Alice to approve the API shape" }], now),
    "Wait for Alice to approve the API shape",
  )
})

test("actionable hints win and elapsed timers remain stable instead of becoming a live status", () => {
  assert.equal(
    awaitingHintSentence([
      { kind: "timer", value: "not-a-time" },
      { kind: "pr", value: "owner/repo#42" },
    ], now),
    null,
  )
  assert.match(
    awaitingHintSentence([{ kind: "timer", value: "2026-07-21T17:00:00.000Z" }], now) ?? "",
    /^Scheduled for /,
  )
  assert.equal(awaitingHintSentence([{ kind: "timer", value: "not-a-time" }], now), "Snooze schedule unavailable")
})

// A pr-watch fence OFFERS NOTHING HERE any more (2026-08-13). Its park control and its "PR watcher
// armed" heading both moved to the generic resting card, whose event-snooze already covers every other
// background wait — the maintainer chose that consolidation over a second, kind-specific control:
// "the user can just use the generic snooze card that shows up any time an agent rests while there are
// background tasks like shells or subagents, and now GitHub watchers can be included in the ranks of
// those." So the fence card falls back to the plain heading and no button.
test("pr-watch alone offers no park action — the resting card carries it now", () => {
  assert.equal(awaitingHintSentence([{ kind: "pr", value: "acme/app#391" }], now), null)
  assert.equal(awaitingParkAction([{ kind: "pr", value: "acme/app#391" }], now), null)
})

// A timer co-declared as a watcher's safety backstop is scheduler input too, so neither parsed hint
// becomes a second set of instructions under the worker-authored status. The INSTANT still parks,
// though: it is a real declared wait and nothing else offers it.
test("a co-declared timer still parks, and now titles the card on its own terms", () => {
  const hints = [
    { kind: "pr", value: "acme/app#391" },
    { kind: "timer", value: "2026-07-21T21:00:00.000Z" },
  ] as const
  assert.equal(awaitingHintSentence([...hints], now), null)
  const park = awaitingParkAction([...hints], now)
  assert.equal(park?.title, "Scheduled snooze")
  assert.match(park?.explainer ?? "", /^This will dismiss the card from the queue until today at .+\.$/)
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
    awaitingParkAction([{ kind: "shell", value: "Alice to approve" }], now)?.explainer,
    "This will dismiss the card from the queue until your default snooze elapses.",
  )
  // No parkable hint → no action at all, so the card falls back to the plain "Awaiting" heading.
  assert.equal(awaitingParkAction([{ kind: "shell", value: "build 9" }], now), null)
})

test("legacy hints degrade to readable text and an empty hint set stays empty", () => {
  assert.equal(awaitingHintSentence([{ kind: "pr", value: "owner/repo#7" }], now), "Wait for PR owner/repo#7")
  assert.equal(awaitingHintSentence([{ kind: "shell", value: "build 9" }], now), "Wait for CI build 9")
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
  // `pr-watch` is no longer one of them — see the dedicated test above.
  assert.equal(awaitingParkAction([{ kind: "pr", value: "owner/repo#42" }], now), null)
  assert.deepEqual(awaitingParkAction([{ kind: "shell", value: "Alice to approve" }], now), {
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

// The hint is the ONLY place the watched PR exists — awaitingHintSentence keeps pr-watch out of the
// prose on purpose — so the card's link has to come from here, in fence order and deduped.
test("prWatchRefs surfaces every watched PR as a link target, in fence order", () => {
  assert.deepEqual(prWatchRefs([{ kind: "pr", value: "dependabot/dependabot-core#15524" }]), [
    { ref: "dependabot/dependabot-core#15524", url: "https://github.com/dependabot/dependabot-core/pull/15524" },
  ])
  // Several watches across several repos keep the order the worker declared them in.
  assert.deepEqual(
    prWatchRefs([
      { kind: "pr", value: "withastro/astro#17487" },
      { kind: "timer", value: "2026-07-21T21:00:00Z" },
      { kind: "pr", value: "vitejs/vite#23019" },
    ]).map((w) => w.ref),
    ["withastro/astro#17487", "vitejs/vite#23019"],
  )
  // A repeated line is one PR, not two chips pointing at the same place.
  assert.deepEqual(
    prWatchRefs([
      { kind: "pr", value: "acme/app#7" },
      { kind: "pr", value: " acme/app#7 " },
    ]).length,
    1,
  )
  // A hand-written value that isn't `owner/repo#N` still NAMES what is watched, so it survives with a
  // null url and the card renders it as plain text rather than as a broken link.
  assert.deepEqual(prWatchRefs([{ kind: "pr", value: "the release PR" }]), [{ ref: "the release PR", url: null }])
  // Nothing to link on any other fence — including the legacy `pr` kind, which is not a watcher.
  assert.deepEqual(prWatchRefs([]), [])
  assert.deepEqual(prWatchRefs([{ kind: "pr", value: "owner/repo#7" }, { kind: "shell", value: "Alice" }]), [])
  assert.deepEqual(prWatchRefs([{ kind: "pr", value: "   " }]), [])
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
  assert.equal(
    awaitingPresentationLine(
      "PR watcher armed — wakes on any review, approval, or comment on #15524 (plus merge/close).",
      awaitingHintSentence([
        { kind: "pr", value: "dependabot/dependabot-core#15524" },
        { kind: "timer", value: "2026-08-12T17:00:00Z" },
      ], now),
    ),
    "PR watcher armed — wakes on any review, approval, or comment on #15524 (plus merge/close).",
  )
})
