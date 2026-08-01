import assert from "node:assert/strict"
import test from "node:test"
import { parseStoredPrefs } from "./prefs.ts"

test("client preferences persist a validated snooze preset across reloads", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "3d", diffsRedefaulted: true })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ compactDiffs: true, snoozePreset: "tomorrow", diffsRedefaulted: true })).snoozePreset, "tomorrow")
})

test("missing, malformed, and stale snooze preferences fall back to one day", () => {
  assert.equal(parseStoredPrefs(null).snoozePreset, "1d")
  assert.equal(parseStoredPrefs("not-json").snoozePreset, "1d")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "custom", diffsRedefaulted: true })).snoozePreset, "1d")
})

const settled = (extra: Record<string, unknown>) => JSON.stringify({ diffsRedefaulted: true, stickyRedefaulted: true, ...extra })

test("sticky user message defaults OFF and coerces stored values to a boolean", () => {
  // Default (nothing stored / malformed) → off.
  assert.equal(parseStoredPrefs(null).stickyUserMessage, false)
  assert.equal(parseStoredPrefs("not-json").stickyUserMessage, false)
  // Boolean round-trips once the re-default has been marked.
  assert.equal(parseStoredPrefs(settled({ stickyUserMessage: false })).stickyUserMessage, false)
  assert.equal(parseStoredPrefs(settled({ stickyUserMessage: true })).stickyUserMessage, true)
  // The short-lived earlier enum coerces: "off" → false; "compact"/"full" → true.
  assert.equal(parseStoredPrefs(settled({ stickyUserMessage: "off" })).stickyUserMessage, false)
  assert.equal(parseStoredPrefs(settled({ stickyUserMessage: "compact" })).stickyUserMessage, true)
})

test("the sticky re-default fires once, then a deliberate opt-in sticks", () => {
  // A browser carrying the OLD default (or the older enum spelling of it) is re-defaulted off once…
  assert.equal(parseStoredPrefs(JSON.stringify({ stickyUserMessage: true, diffsRedefaulted: true })).stickyUserMessage, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ stickyUserMessage: "compact", diffsRedefaulted: true })).stickyUserMessage, false)
  // …and the marker rides back out in the parsed blob, so the write-back records that it has run.
  const migrated = parseStoredPrefs(JSON.stringify({ stickyUserMessage: true, diffsRedefaulted: true })) as Record<string, unknown>
  assert.equal(migrated.stickyRedefaulted, true)
  // Re-parsing that write-back leaves a subsequent deliberate opt-in alone, forever.
  assert.equal(parseStoredPrefs(JSON.stringify({ ...migrated, stickyUserMessage: true })).stickyUserMessage, true)
  // A FRESH browser is handed the marker too, so its first opt-in survives the next load.
  const fresh = parseStoredPrefs(null) as Record<string, unknown>
  assert.equal(fresh.stickyRedefaulted, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ ...fresh, stickyUserMessage: true })).stickyUserMessage, true)
})

test("queue order defaults to FIFO and only accepts fifo/lifo", () => {
  // Default (nothing stored / malformed) → fifo.
  assert.equal(parseStoredPrefs(null).queueOrder, "fifo")
  assert.equal(parseStoredPrefs("not-json").queueOrder, "fifo")
  // Both valid values round-trip; anything else falls back to fifo.
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "lifo", diffsRedefaulted: true })).queueOrder, "lifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "fifo", diffsRedefaulted: true })).queueOrder, "fifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "sideways", diffsRedefaulted: true })).queueOrder, "fifo")
})
