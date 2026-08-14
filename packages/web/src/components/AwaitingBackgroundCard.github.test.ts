// THE WATCHED-PR ROWS on the resting card. GitHub's merge box in one line per PR, in GitHub's own
// words — the human has just come from there, and a second set of words for one fact is a second thing
// to learn (maintainer 2026-08-14: "We should basically have it evoke the GitHub UI that shows up for
// running versus completed checks").
import { test } from "node:test"
import assert from "node:assert/strict"
import type { GithubWatchStatus } from "@frizz/shared"
import { checkCountLine, checksHeadline } from "./AwaitingBackgroundCard.tsx"

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
