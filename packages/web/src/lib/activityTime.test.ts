import { test } from "node:test"
import assert from "node:assert/strict"
import { activityTimestamp, ageSpan, formatLastActive } from "./activityTime.ts"

const now = Date.parse("2026-07-13T12:00:00.000Z")
const at = (offsetMs: number) => new Date(now - offsetMs).toISOString()

test("formatLastActive uses readable relative units with the required label", () => {
  assert.equal(formatLastActive(at(0), now), "Last active just now")
  assert.equal(formatLastActive(at(1_000), now), "Last active 1 second ago")
  assert.equal(formatLastActive(at(32_000), now), "Last active 32 seconds ago")
  assert.equal(formatLastActive(at(60_000), now), "Last active 1 minute ago")
  assert.equal(formatLastActive(at(3 * 60 * 60 * 1_000), now), "Last active 3 hours ago")
  assert.equal(formatLastActive(at(2 * 24 * 60 * 60 * 1_000), now), "Last active 2 days ago")
})

test("formatLastActive hides absent and invalid timestamps", () => {
  assert.equal(formatLastActive(undefined, now), null)
  assert.equal(formatLastActive("not-a-date", now), null)
})

// The rail's rest-time column prints the SPAN alone — the column position carries the "ago" that a
// standalone prose reading has to spell. Same vocabulary either way: relativeAge is this plus the word.
test("ageSpan is relativeAge without the ago, and keeps just now intact", () => {
  assert.equal(ageSpan(at(0), now), "just now")
  assert.equal(ageSpan(at(1_000), now), "1 second")
  assert.equal(ageSpan(at(12 * 60_000), now), "12 minutes")
  assert.equal(ageSpan(at(3 * 60 * 60 * 1_000), now), "3 hours")
  assert.equal(ageSpan(at(9 * 24 * 60 * 60 * 1_000), now), "1 week")
  assert.equal(ageSpan(undefined, now), null)
  assert.equal(ageSpan("not-a-date", now), null)
})

test("activityTimestamp prefers tailer activity and falls back to a valid launch timestamp", () => {
  const activity = "2026-07-13T11:00:00.000Z"
  const spawned = "2026-07-13T10:00:00.000Z"
  assert.equal(activityTimestamp(activity, spawned), activity)
  assert.equal(activityTimestamp(undefined, spawned), spawned)
  assert.equal(activityTimestamp("not-a-date", spawned), spawned)
  assert.equal(activityTimestamp("not-a-date", "also-not-a-date"), undefined)
})
