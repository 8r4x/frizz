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

// THE CARD'S COPY, for a fence that is now PURE STRUCTURE.
//
// What these replaced was a matrix: every hint kind had a park action ("Scheduled snooze", "Awaiting
// human"), a synthesized sentence ("Wait for Alice", "Scheduled for tomorrow at 9"), and a snooze target
// derived from whatever instant the worker had typed. All of it is gone with the kinds — a worker no
// longer describes its wait in prose frizz has to parse back, it NAMES things frizz can look up, and it
// writes exactly one line for a human. So there is nothing left to synthesize and nothing to get wrong.

test("no fence offers a park action any more — the worker's own tools own the wait", () => {
  // `timer:` used to become "Scheduled snooze" and `human:` "Awaiting human". Both kinds are deleted:
  // nothing ever fired a human gate, and a timer is a row set through `mcp__frizz__timer`. The human's
  // lever is the ordinary Snooze on the resting card, which never depended on a fence.
  for (const hints of [
    [{ kind: "timer" as const, value: "tmr_a1b2c3" }, { kind: "for" as const, value: "2h" }],
    [{ kind: "shell" as const, value: "bzvtnt3ig" }, { kind: "for" as const, value: "2h" }],
    [{ kind: "pr" as const, value: "acme/app#391" }, { kind: "for" as const, value: "2h" }],
    [],
  ]) {
    assert.equal(awaitingParkAction(hints), null, `${JSON.stringify(hints)} must offer no park button`)
  }
})

test("the card's sentence is the worker's own `reason:`, and nothing else", () => {
  const REASON = "waiting on the three-platform run before porting the v2 drivers"
  assert.equal(
    awaitingHintSentence([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }, { kind: "reason", value: REASON }]),
    REASON,
  )
  // No reason ⇒ nothing. A card that invents a sentence from ids is worse than one that shows the rows.
  assert.equal(awaitingHintSentence([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }]), null)
  assert.equal(awaitingHintSentence([{ kind: "reason", value: "   " }]), null, "whitespace is not a sentence")
  assert.equal(awaitingHintSentence([]), null)
})

test("prWatchRefs surfaces every watched PR as a link target, in fence order", () => {
  const refs = prWatchRefs([
    { kind: "pr", value: "acme/app#391" },
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "pr", value: "acme/app#12" },
    { kind: "pr", value: "acme/app#391" },
    { kind: "for", value: "2h" },
  ])
  assert.deepEqual(refs.map((r) => r.ref), ["acme/app#391", "acme/app#12"], "fence order, deduped")
  assert.ok(refs[0].url?.includes("acme/app"), "a parseable ref is a link")
  // A malformed ref still names what the worker meant, so the card shows it as plain text rather than
  // hiding it or offering a broken link — and the server refuses to park on it either way.
  const bogus = prWatchRefs([{ kind: "pr", value: "the auth PR" }])
  assert.deepEqual(bogus.map((r) => r.ref), ["the auth PR"])
  assert.equal(bogus[0].url, null)
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
