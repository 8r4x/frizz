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
  awaitingWaitClause,
  reasonSentence,
  awaitingProse,
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
  // The worker's words, verbatim but for the capital every surface that draws it standing alone needs
  // — see reasonSentence, which the rail popover shares.
  assert.equal(
    awaitingHintSentence([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }, { kind: "reason", value: REASON }]),
    "Waiting on the three-platform run before porting the v2 drivers",
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


// THE RAIL'S WAIT CLAUSE. The sidebar row is a TITLE and nothing else (maintainer 2026-08-19), so what
// the fence names is only legible on hover — and it has to READ there. One verb over one conjoined
// list, generated from the hint KINDS, so the same fence always reads the same way and no runtime id
// ever reaches the human.
test("the fence becomes one clause: the PR it watches, then what it counts", () => {
  const hints = [
    { kind: "for" as const, value: "2h" },
    { kind: "agent" as const, value: "agent_7" },
    { kind: "pr" as const, value: "acme/app#391" },
    { kind: "shell" as const, value: "bvg44v4ij" },
    { kind: "reason" as const, value: "the macOS leg is the flaky one" },
    { kind: "shell" as const, value: "k92hs01x2" },
  ]
  assert.equal(awaitingWaitClause(hints), "waiting on acme/app#391, 2 background shells and a sub-agent")
  // The order the worker wrote them in must not change a word of it — the clause keys on KIND.
  assert.equal(awaitingWaitClause([...hints].reverse()), awaitingWaitClause(hints))
  // The reason is the ONE line frizz does not generate, so it is not in here: the popover puts it on
  // its own line, where a human sentence cannot be mistaken for a derived one.
  assert.doesNotMatch(awaitingWaitClause(hints) ?? "", /macOS/)
})

test("a runtime id never reaches the popover — it is counted, not listed", () => {
  assert.equal(awaitingWaitClause([{ kind: "shell", value: "bvg44v4ij" }]), "waiting on a background shell")
  assert.equal(awaitingWaitClause([{ kind: "timer", value: "tmr_a1b2c3" }]), "waiting on a timer")
  assert.equal(
    awaitingWaitClause([
      { kind: "timer", value: "tmr_a1" },
      { kind: "timer", value: "tmr_b2" },
      { kind: "agent", value: "agent_7" },
    ]),
    "waiting on a sub-agent and 2 timers",
  )
  // Two PRs read as two refs, because each one is a THING the human may want to go look at.
  assert.equal(
    awaitingWaitClause([{ kind: "pr", value: "acme/app#391" }, { kind: "pr", value: "acme/app#392" }]),
    "waiting on acme/app#391 and acme/app#392",
  )
})

test("a fence naming nothing yields nothing, so the popover cannot invent a wait", () => {
  assert.equal(awaitingWaitClause([{ kind: "for", value: "2h" }, { kind: "reason", value: "…" }]), null)
  assert.equal(awaitingWaitClause([{ kind: "shell", value: "  " }]), null, "a blank value names nothing")
})

// The MOBILE row keeps one inline caption, because a phone has no hover to move it to.
test("hintGloss is the phone's one line, and it is the PR ref", () => {
  assert.equal(hintGloss([{ kind: "pr", value: "acme/app#391" }, { kind: "reason", value: "…" }]), "PR acme/app#391")
  assert.equal(hintGloss([{ kind: "shell", value: "bvg44v4ij" }]), null)
})


// THE WORKER'S REASON, SET AS A SENTENCE. It stands alone everywhere frizz draws it — its own paragraph
// under the rail popover's sentence, its own line on the card — and it arrives lowercase because the
// shipped contract's example was a fragment (maintainer 2026-08-19: "why is that second sentence
// fucking lowercase?"). The contract now models a sentence; this carries every worker dispatched before
// it, whose prompt is frozen.
test("a lowercase reason is presented as a sentence, and only its first letter is touched", () => {
  assert.equal(
    reasonSentence("the tap submission is queued behind their CI backlog"),
    "The tap submission is queued behind their CI backlog",
  )
  assert.equal(reasonSentence("Already a sentence"), "Already a sentence", "nothing to do")
  // Only the first letter — the rest of the line is the worker's, verbatim, capitals and all.
  assert.equal(reasonSentence("waiting on CI for the v2 drivers"), "Waiting on CI for the v2 drivers")
})

test("a reason that opens on CODE is left exactly as written", () => {
  const cases = [
    "awaitingFragments still returns the old shape", // an identifier: a capital would be a WRONG NAME
    "packages/web has not rebuilt yet", // a path
    "v2.1 is still tagging", // a ref
    "#391 is waiting on a second approval", // an issue number
    "npm test is still running", // lowercase by name, not by accident
    "gh pr checks reports one job queued",
  ]
  for (const reason of cases) assert.equal(reasonSentence(reason), reason, reason)
})


// WHAT THE POPOVER READS, and why it is not `reason:`. An awaiting fence is FRONTMATTER, THEN MARKDOWN
// (2026-08-17): structural lines, a `---`, and below it as much prose as the worker wants — optional
// prose, since what frizz requires is a live item and a `for:`. Reading only `reason:` dropped the
// handoff of every fence written that way, which is exactly what the rail popover did (maintainer
// 2026-08-19: "the actual block content … was all below the triple hyphen, sort of like a front matter
// with Markdown beneath it").
const HINTS = [{ kind: "shell" as const, value: "bzvtnt3ig" }, { kind: "for" as const, value: "2h" }]

test("the popover reads the fence's BODY — the prose below the delimiter", () => {
  const body = "The tap submission is queued behind their CI backlog."
  assert.equal(awaitingProse({ body, hints: HINTS }), body)
})

test("…and falls back to the legacy `reason:` when a fence has no body", () => {
  assert.equal(
    awaitingProse({ body: "", hints: [...HINTS, { kind: "reason", value: "waiting on the release job" }] }),
    "Waiting on the release job",
    "set as a sentence, the same as a body",
  )
})

test("the prose is OPTIONAL — a fence with neither says nothing rather than inventing a wait", () => {
  assert.equal(awaitingProse({ body: "", hints: HINTS }), null)
  assert.equal(awaitingProse({ hints: HINTS }), null, "and an absent body is not a crash")
  assert.equal(awaitingProse({ body: "   \n\n  ", hints: HINTS }), null, "whitespace is not prose")
})

test("only the FIRST paragraph reaches a hover label, flattened onto one line", () => {
  const body = [
    "Waiting on the three-platform run",
    "before porting the v2 drivers.",
    "",
    "- the macOS leg is the one that has been flaky",
    "- if it goes red I will bisect rather than re-run",
  ].join("\n")
  assert.equal(awaitingProse({ body, hints: HINTS }), "Waiting on the three-platform run before porting the v2 drivers.")
})

test("a long lede is cut on a word boundary, not mid-word", () => {
  const body = `The release job ${"keeps timing out on the arm64 leg and ".repeat(6)}so I am waiting`
  const out = awaitingProse({ body, hints: HINTS }) ?? ""
  assert.ok(out.length <= 241, `capped, got ${out.length}`)
  assert.match(out, /…$/, "and says so")
  assert.doesNotMatch(out, /\s…$/, "no dangling space before the ellipsis")
  assert.ok(body.startsWith(out.slice(0, -1)), "the kept text is the worker's own, unaltered")
})
