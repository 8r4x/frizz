// THE WATCHED-PR ROWS on the resting card. GitHub's merge box on ONE line per PR, in GitHub's own count
// words — the human has just come from there, and a second set of words for one fact is a second thing
// to learn (maintainer 2026-08-14: "We should basically have it evoke the GitHub UI that shows up for
// running versus completed checks").
//
// WHAT THESE NOW PIN IS THE ABSENCE OF DOUBLING. The row used to state green three ways — a prose
// verdict, the same verdict as counts, and a merge sentence beneath — so four PRs filled eleven lines
// (maintainer 2026-08-14: "this looks busy and shitty"). The glyph carries the verdict; the words carry
// only what the glyph cannot.
import { test } from "node:test"
import assert from "node:assert/strict"
import type { GithubWatchStatus } from "@frizz/shared"
import { checkCountLine, showsRestingCard, watchStatusLine } from "./AwaitingBackgroundCard.tsx"

const status = (over: Partial<GithubWatchStatus> = {}): GithubWatchStatus => ({
  checks: "running", running: 0, passed: 0, failed: 0, failing: [], merge: "unknown", state: "open",
  polledAt: "2026-08-14T00:00:00.000Z", ...over,
})

// SEVERITY FIRST and the order fixed, so a reader scanning four rows finds the failing count in the same
// place on every one of them.
test("the counts read as GitHub's, worst first, and a zero is left out rather than printed", () => {
  assert.equal(checkCountLine(status({ running: 3, passed: 12 })), "3 in progress, 12 successful")
  assert.equal(checkCountLine(status({ passed: 15 })), "15 successful")
  assert.equal(checkCountLine(status({ running: 1, passed: 9, failed: 2 })), "2 failing, 1 in progress, 9 successful")
  assert.equal(checkCountLine(status()), "", "no checks, no count line — a row of zeroes is noise")
})

// AN UNPOLLED PR AND A PR WITH NO CI ARE DIFFERENT FACTS, and only the second means the wait is nearly
// over. The same distinction decides the queue rule server-side, where not-knowing never parks a thread.
test("an unpolled PR says it is being checked, never that it has no checks", () => {
  assert.equal(watchStatusLine(undefined), "Checking…")
  assert.equal(watchStatusLine(status({ checks: "none" })), "No checks")
})

// THE LINE IS THE COUNTS, NOT A VERDICT: the glyph beside it already says pass/fail/running, and saying
// it again in prose is what made the card busy.
test("the row says the numbers once, and never restates the glyph in prose", () => {
  assert.equal(watchStatusLine(status({ checks: "running", running: 3, passed: 12 })), "3 in progress, 12 successful")
  assert.equal(watchStatusLine(status({ checks: "passing", passed: 15 })), "15 successful")
  assert.equal(watchStatusLine(status({ checks: "failing", failed: 2, passed: 9 })), "2 failing, 9 successful")
  for (const line of ["haven’t completed", "have passed", "were not successful", "reported"]) {
    assert.doesNotMatch(watchStatusLine(status({ checks: "passing", passed: 1 })), new RegExp(line))
  }
})

// THE MERGE VERDICT JOINS THE SAME LINE, and only when it is not already implied. It cost a whole
// dimmed sub-line per PR ("This branch has no conflicts with the base branch") for one bit of state.
test("the merge verdict rides the counts, and stays silent when the checks already say it", () => {
  assert.equal(watchStatusLine(status({ checks: "passing", passed: 7, merge: "mergeable" })), "7 successful · no conflicts")
  assert.equal(watchStatusLine(status({ checks: "failing", failed: 1, merge: "conflicting" })), "1 failing · has conflicts")
  // GREEN BUT BLOCKED is the one case "blocked" is worth printing: CI is done, so something else — a
  // review, a required branch — is what holds it.
  assert.equal(watchStatusLine(status({ checks: "passing", passed: 7, merge: "blocked" })), "7 successful · merge blocked")
  // …while blocked BECAUSE the checks are red or still running is just the counts restated.
  assert.equal(watchStatusLine(status({ checks: "running", running: 3, passed: 12, merge: "blocked" })), "3 in progress, 12 successful")
  assert.equal(watchStatusLine(status({ checks: "failing", failed: 2, passed: 9, merge: "blocked" })), "2 failing, 9 successful")
  // UNKNOWN IS SILENT: GitHub computes mergeability asynchronously, so a phrase for it would read as a
  // verdict when it only means "frizz has not heard back".
  assert.equal(watchStatusLine(status({ checks: "passing", passed: 7, merge: "unknown" })), "7 successful")
})

// A merged PR's CI is history: whatever the checks say, the thing the human needs to read is that it
// landed. Same for closed — and neither carries a merge verdict.
test("merged and closed outrank the checks", () => {
  assert.equal(watchStatusLine(status({ checks: "running", running: 4, state: "merged" })), "Merged")
  assert.equal(watchStatusLine(status({ checks: "failing", failed: 2, state: "closed" })), "Closed")
})

// ---- WHERE THE CHAT SHOWS THIS CARD AT ALL ----------------------------------------------------------
// Maintainer 2026-08-14: "this snooze card only shows up at the bottom of a rendered chat thread inside
// of an agent that has actually come to rest. Doesn't make sense for it to be showing up in a currently
// running thread. Or a thread that is currently snoozed."
const chat = (over: Record<string, unknown> = {}) =>
  ({ awaitingBackground: true, runtime: "turn-idle", ...over }) as Parameters<typeof showsRestingCard>[0]

test("the chat shows the resting card only for a thread that has ACTUALLY come to rest", () => {
  assert.equal(showsRestingCard(chat()), true)
  // The card's slot already loses to the working indicator — but that keys on running/spawning alone,
  // so every OTHER non-resting runtime fell through to a card claiming a rest that is not happening.
  for (const runtime of ["running", "spawning", "perm-prompt", "exited", "none"] as const) {
    assert.equal(showsRestingCard(chat({ runtime })), false, `${runtime} is not a rest`)
  }
})

test("an event-snoozed thread does not show it again in the chat", () => {
  assert.equal(showsRestingCard(chat({ bgSnoozed: true })), false)
  // …and an older server that does not send the flag behaves exactly as it did before.
  assert.equal(showsRestingCard(chat({ bgSnoozed: undefined })), true)
})

test("no wait, no card — whatever else is true", () => {
  assert.equal(showsRestingCard(chat({ awaitingBackground: false })), false)
  assert.equal(showsRestingCard(chat({ awaitingBackground: undefined })), false)
  assert.equal(showsRestingCard(undefined), false)
})
