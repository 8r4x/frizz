import { test } from "node:test"
import assert from "node:assert/strict"
import { wakeCardTitle, wakeItemAge } from "./githubWakeCard.ts"

test("wakeItemAge is a compact age, and refuses to invent one", () => {
  const now = Date.parse("2026-07-29T16:00:00Z")
  const ago = (ms: number) => wakeItemAge(new Date(now - ms).toISOString(), now)
  assert.equal(ago(0), "just now")
  assert.equal(ago(59_000), "just now")
  assert.equal(ago(60_000), "1m ago")
  assert.equal(ago(59 * 60_000), "59m ago")
  assert.equal(ago(60 * 60_000), "1h ago")
  assert.equal(ago(23 * 3_600_000), "23h ago")
  assert.equal(ago(3 * 86_400_000), "3d ago")
  assert.equal(ago(14 * 86_400_000), "2w ago")
  assert.equal(ago(60 * 86_400_000), "2mo ago")
  assert.equal(ago(400 * 86_400_000), "1y ago")
  // A future timestamp (clock skew between GitHub and this machine) reads as "just now", never as a
  // negative age.
  assert.equal(wakeItemAge(new Date(now + 60_000).toISOString(), now), "just now")
  assert.equal(wakeItemAge(undefined, now), null)
  assert.equal(wakeItemAge("not a date", now), null)
})

test("wakeCardTitle says the whole single event, and counts several", () => {
  assert.equal(wakeCardTitle(1, "comment", "pullfrog[bot]"), "New comment from @pullfrog[bot]")
  assert.equal(wakeCardTitle(1, "change request", "colinhacks"), "New change request from @colinhacks")
  // No actor to name (a burst collapsed to one row, or a shape surprise) still reads as a sentence.
  assert.equal(wakeCardTitle(1, "comment"), "New comment")
  // A count never names an actor, even when one is passed: the burst has several.
  assert.equal(wakeCardTitle(3, "comment", "pullfrog[bot]"), "3 new items")
})

