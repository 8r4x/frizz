import { test } from "node:test"
import assert from "node:assert/strict"
import { wakeCardTitle, wakeItemAge, wakeRefUrl } from "./githubWakeCard.ts"

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

test("wakeCardTitle names one item and counts several", () => {
  assert.equal(wakeCardTitle(1, "comment"), "New comment")
  assert.equal(wakeCardTitle(1, "change request"), "New change request")
  assert.equal(wakeCardTitle(3, "comment"), "3 new items")
})

test("wakeRefUrl builds the PR link, and returns null rather than a broken one", () => {
  assert.equal(wakeRefUrl("nubjs/nub#587"), "https://github.com/nubjs/nub/pull/587")
  assert.equal(wakeRefUrl("acme/app.js#12"), "https://github.com/acme/app.js/pull/12")
  for (const bad of ["nubjs/nub", "#587", "", "not a ref", "nubjs/nub#abc"]) {
    assert.equal(wakeRefUrl(bad), null, bad)
  }
})
