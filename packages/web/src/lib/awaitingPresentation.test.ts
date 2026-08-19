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
  awaitingItemLabels,
  awaitingForLabel,
  awaitingFragments,
  hintGloss,
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
// THE BODY NO LONGER JOINS THE SENTENCE, so the punctuation rule this pinned has nothing left to join.
// It existed because a fence carried BOTH free prose and a synthesized action line, and gluing them
// needed a separator that did not read as a typo. The structural grammar has one prose field: the body
// is only ever a line the parser did not recognise, and printing that at a human is the bug the tests
// above now cover.

// RAW FENCE SYNTAX MUST NEVER REACH THE READER (maintainer 2026-08-16, with a screenshot of a card
// reading "watch: bvg44v4ij / for: 40m / reason: CI on #1227 is running…" — "why the fuck is the
// awaiting block looking like this? We had a bunch of special rendering here, did we not?").
//
// Under the structural grammar the fence is six known line kinds, so anything left in `body` is a line
// the parser did NOT recognise — a worker still writing the deleted `watch:`, or a typo. It is a
// malformed declaration, not prose: the worker is bumped for it (scheduler SOURCE 12), and the card
// shows what it can instead of showing the machinery.
test("the card's prose is the reason, and an unrecognized line never becomes prose", () => {
  const REASON = "CI on acme/app#1227 is running the upgraded fixture."
  // The exact shape from the screenshot: a stale `watch:` fell into the body beside a real reason.
  assert.equal(awaitingPresentationLine("watch: bvg44v4ij", REASON), REASON)
  assert.doesNotMatch(awaitingPresentationLine("watch: bvg44v4ij", REASON), /watch:/)
})

// …but an OLD fence, written before the grammar had a `reason:`, put its whole handoff in the body. Those
// threads must not card as blank, so the body is still the fallback when there is nothing better.
test("a fence with no reason still shows its body rather than carding blank", () => {
  assert.equal(awaitingPresentationLine("PR is open and CI is green.", null), "PR is open and CI is green.")
  assert.equal(awaitingPresentationLine("", null), "Waiting for an external update.")
})

test("the items and the duration render as labels, and PRs are left to their own links", () => {
  const hints = [
    { kind: "shell" as const, value: "bvg44v4ij" },
    { kind: "agent" as const, value: "agent_7" },
    { kind: "timer" as const, value: "tmr_a1b2c3" },
    { kind: "pr" as const, value: "acme/app#391" },
    { kind: "for" as const, value: "40m" },
    { kind: "reason" as const, value: "…" },
  ]
  // A PR is deliberately absent: it gets a real LINK of its own (prWatchRefs), and listing it here too
  // is the duplication this card has been trimmed for twice already.
  assert.deepEqual(awaitingItemLabels(hints), ["shell bvg44v4ij", "sub-agent agent_7", "a timer"])
  assert.equal(awaitingForLabel(hints), "for 40m")
  // No `for:` is a MALFORMED park rather than an unbounded one — frizz refuses it, so the card must not
  // imply a wait is running by inventing a duration.
  assert.equal(awaitingForLabel([{ kind: "shell", value: "b1" }]), null)
})


// THE RAIL'S POPOVER FRAGMENTS. The sidebar row is a TITLE and nothing else (maintainer 2026-08-19), so
// what the fence names is only legible on hover — and it is GENERATED there, never prose, which is what
// these pin: the same items in any order read the same way, and the ids never reach the human.
test("the fence becomes two ordered fragments: the PR it watches, then what it counts", () => {
  const hints = [
    { kind: "for" as const, value: "2h" },
    { kind: "agent" as const, value: "agent_7" },
    { kind: "pr" as const, value: "acme/app#391" },
    { kind: "shell" as const, value: "bvg44v4ij" },
    { kind: "reason" as const, value: "the macOS leg is the flaky one" },
    { kind: "shell" as const, value: "k92hs01x2" },
  ]
  assert.deepEqual(awaitingFragments(hints), [
    "Watching acme/app#391 — new activity wakes it",
    "Waiting on 2 background shells and a sub-agent",
  ])
  // The order the worker wrote them in must not change a word of it — the fragments key on KIND.
  assert.deepEqual(awaitingFragments([...hints].reverse()), awaitingFragments(hints))
  // The reason is the ONE line frizz does not generate, so it is not one of these: the popover appends
  // it itself, last, where a human sentence cannot be mistaken for a derived one.
  assert.doesNotMatch(awaitingFragments(hints).join("\n"), /macOS/)
})

test("a runtime id never reaches the popover — it is counted, not listed", () => {
  assert.deepEqual(awaitingFragments([{ kind: "shell", value: "bvg44v4ij" }]), ["Waiting on a background shell"])
  assert.deepEqual(awaitingFragments([{ kind: "timer", value: "tmr_a1b2c3" }]), ["Waiting on a timer"])
  assert.deepEqual(awaitingFragments([
    { kind: "timer", value: "tmr_a1" },
    { kind: "timer", value: "tmr_b2" },
    { kind: "agent", value: "agent_7" },
  ]), ["Waiting on a sub-agent and 2 timers"])
  // Three PRs read as a list, because each one is a THING the human may want to go look at.
  assert.deepEqual(awaitingFragments([
    { kind: "pr", value: "acme/app#391" },
    { kind: "pr", value: "acme/app#392" },
  ]), ["Watching acme/app#391 and acme/app#392 — new activity wakes it"])
})

test("a fence naming nothing yields nothing, so the popover cannot invent a wait", () => {
  assert.deepEqual(awaitingFragments([{ kind: "for", value: "2h" }, { kind: "reason", value: "…" }]), [])
  assert.deepEqual(awaitingFragments([{ kind: "shell", value: "  " }]), [], "a blank value names nothing")
})

// The MOBILE row keeps one inline caption, because a phone has no hover to move it to.
test("hintGloss is the phone's one line, and it is the PR ref", () => {
  assert.equal(hintGloss([{ kind: "pr", value: "acme/app#391" }, { kind: "reason", value: "…" }]), "PR acme/app#391")
  assert.equal(hintGloss([{ kind: "shell", value: "bvg44v4ij" }]), null)
})
