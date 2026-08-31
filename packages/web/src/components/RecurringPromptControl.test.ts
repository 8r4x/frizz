import assert from "node:assert/strict"
import test from "node:test"
import type { ThreadView } from "@frizz/shared"
import { draftIntervalSeconds, seedsDefaults } from "./RecurringPromptControl.tsx"

// The Goal panel batches: nothing writes until Save (2026-08-31 — checking a trigger used to arm it
// instantly, and the stop hook bumped the thread before the operator finished configuring). The draft is
// still read at instants that never blur the minutes field — Enter in the textarea saves, Escape stashes
// the unsaved draft after tearing the input out of the DOM — so the draft resolves the cadence from the
// STRING the operator can see rather than from the last committed number, and this pins that resolution:
// it is where the original bug lived (type 55 over a 25-minute schedule, press Escape, reopen ⇒ 25).

test("a typed cadence wins over the last committed one", () => {
  assert.equal(draftIntervalSeconds("55", 1500), 55 * 60)
  assert.equal(draftIntervalSeconds("1", 600), 60)
  assert.equal(draftIntervalSeconds("1440", 600), 1440 * 60)
})

test("an unusable field falls back to what is already stored", () => {
  // Half-typed, cleared, or nonsense — none of these may overwrite a working schedule on a dismiss.
  for (const raw of ["", " ", "abc", "0", "-5", "NaN"]) {
    assert.equal(draftIntervalSeconds(raw, 1500), 1500, `"${raw}" should not disturb the stored cadence`)
  }
})

test("an out-of-range number is clamped to the schema's bounds, not rejected", () => {
  assert.equal(draftIntervalSeconds("9999", 600), 1440 * 60)
  assert.equal(draftIntervalSeconds("0.4", 600), 600) // rounds to 0, which is not a cadence
  assert.equal(draftIntervalSeconds("1.4", 600), 60)
})

test("a cadence the field can only round is left exactly as stored", () => {
  // A worker can arm 90 seconds through the MCP tool; the minutes field can only render "2". Resolving
  // that string back would rewrite 90s to 120s on every open-and-dismiss, so the canonical spelling of
  // the stored value means "unchanged" — the panel writes nothing when the operator touched nothing.
  assert.equal(draftIntervalSeconds("2", 90), 90)
  assert.equal(draftIntervalSeconds("10", 600), 600)
})

// ---- The pre-filled default -----------------------------------------------------------------------
// The panel opens on the standard sentence with EVERY TRIGGER OFF, so accepting it costs one switch plus
// Save, and merely reading it costs nothing: an untouched open matches what `sent` was seeded with, so
// the Save button stays dimmed with nothing to write (maintainer 2026-08-16 — "it should not
// automatically arm anything"). It used to seed the stop hook on as well, which made simply opening the
// panel arm the thread.
//
// The seed is still withheld on an ARCHIVED thread, and that branch outlived the change: the operator can
// still EDIT the text there, and the Save that edit invites is the one the server refuses. All three
// branches are driven in a real browser too; these pin them where a boot is not worth the cycle.
const view = (over: Partial<ThreadView>) => ({ archived: false, ...over }) as ThreadView

test("an unarmed, open thread opens pre-filled", () => {
  assert.equal(seedsDefaults(view({}), undefined), true)
})

test("an ARMED thread shows its own words, never the default", () => {
  const armed = { prompt: "keep checking the deploy" } as ThreadView["recurringPrompt"]
  assert.equal(seedsDefaults(view({}), armed), false)
  // Including one whose triggers are all off — the text is parked, and parked text is still the row's.
  assert.equal(seedsDefaults(view({}), { ...armed, stopHook: false } as ThreadView["recurringPrompt"]), false)
})

test("an ARCHIVED thread opens empty — the server would refuse the write an edit makes", () => {
  assert.equal(seedsDefaults(view({ archived: true }), undefined), false)
})
