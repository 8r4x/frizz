// THE WATCHED-PR ROWS on the resting card. GitHub's merge box in one line per PR, in GitHub's own
// words — the human has just come from there, and a second set of words for one fact is a second thing
// to learn (maintainer 2026-08-14: "We should basically have it evoke the GitHub UI that shows up for
// running versus completed checks").
import { test } from "node:test"
import assert from "node:assert/strict"
import type { GithubWatchStatus } from "@frizz/shared"
import { checkCountLine, checksHeadline, showsRestingCard } from "./AwaitingBackgroundCard.tsx"

const status = (over: Partial<GithubWatchStatus> = {}): GithubWatchStatus => ({
  checks: "running", running: 0, passed: 0, failed: 0, failing: [], merge: "unknown", state: "open",
  polledAt: "2026-08-14T00:00:00.000Z", ...over,
})

test("the counts read as GitHub's, and a zero is left out rather than printed", () => {
  assert.equal(checkCountLine(status({ running: 3, passed: 12 })), "3 in progress, 12 successful")
  assert.equal(checkCountLine(status({ passed: 15 })), "15 successful")
  assert.equal(checkCountLine(status({ running: 1, passed: 9, failed: 2 })), "1 in progress, 9 successful, 2 failing")
  assert.equal(checkCountLine(status()), "", "no checks, no count line — a row of zeroes is noise")
})

// AN UNPOLLED PR AND A PR WITH NO CI ARE DIFFERENT FACTS, and only the second means the wait is nearly
// over. The same distinction decides the queue rule server-side, where not-knowing never parks a thread.
test("an unpolled PR says it is being checked, never that it has no checks", () => {
  assert.equal(checksHeadline(undefined), "Checking…")
  assert.equal(checksHeadline(status({ checks: "none" })), "No checks reported")
})

test("each check verdict says what GitHub's merge box says", () => {
  assert.equal(checksHeadline(status({ checks: "running" })), "Some checks haven’t completed yet")
  assert.equal(checksHeadline(status({ checks: "passing" })), "All checks have passed")
  assert.equal(checksHeadline(status({ checks: "failing" })), "Some checks were not successful")
})

// A merged PR's CI is history: whatever the checks say, the thing the human needs to read is that it
// landed. Same for closed.
test("merged and closed outrank the checks", () => {
  assert.equal(checksHeadline(status({ checks: "running", state: "merged" })), "Merged")
  assert.equal(checksHeadline(status({ checks: "failing", state: "closed" })), "Closed")
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
