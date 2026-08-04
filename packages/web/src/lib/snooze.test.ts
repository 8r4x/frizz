import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_SNOOZE_PRESET,
  formatSnoozedUntil,
  formatSnoozeWake,
  formatAutoSnoozedUntil,
  formatUserSnooze,
  snoozePromptPreview,
  isSnoozePreset,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetAction,
  snoozePresetInstant,
  snoozePresetLabel,
} from "./snooze.ts"

test("snooze preset metadata has a stable one-day default and sentence-case labels", () => {
  assert.equal(DEFAULT_SNOOZE_PRESET, "1d")
  assert.equal(snoozePresetLabel(DEFAULT_SNOOZE_PRESET), "1 day")
  // Sentence case, like every other preset in the same menu — "Tomorrow" was the only capitalized
  // entry in a list of bare nouns, and it capitalized mid-phrase inside the button.
  assert.equal(snoozePresetLabel("tomorrow"), "tomorrow")
  assert.equal(isSnoozePreset("1w"), true)
  assert.equal(isSnoozePreset("custom"), false)
})

// You snooze FOR a duration but UNTIL an instant. Gluing the bare label on gave "Snooze tomorrow",
// which reads as deferring the snoozing rather than naming the wake.
test("the button says 'until' for a calendar preset and nothing extra for a duration", () => {
  assert.equal(snoozePresetAction("tomorrow"), "Snooze until tomorrow")
  assert.equal(snoozePresetAction("1d"), "Snooze 1 day")
  assert.equal(snoozePresetAction("1h"), "Snooze 1 hour")
  assert.equal(snoozePresetAction("3d"), "Snooze 3 days")
  assert.equal(snoozePresetAction("1w"), "Snooze 1 week")
})

test("snooze presets distinguish exact duration from tomorrow's local wall clock", () => {
  const now = new Date(2026, 11, 31, 23, 30, 0, 0)
  assert.equal(Date.parse(snoozePresetInstant("1h", now.getTime())) - now.getTime(), 60 * 60 * 1000)
  assert.equal(Date.parse(snoozePresetInstant("1d", now.getTime())) - now.getTime(), 24 * 60 * 60 * 1000)
  const tomorrow = new Date(snoozePresetInstant("tomorrow", now.getTime()))
  assert.deepEqual(
    [tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()],
    [2027, 0, 1, 9, 0],
  )
})

test("calendar tomorrow stays at 9 AM while exact-day snooze crosses a DST boundary", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const beforeSpringForward = new Date(2026, 2, 7, 12, 0, 0, 0)
    const exactDay = new Date(snoozePresetInstant("1d", beforeSpringForward.getTime()))
    const tomorrow = new Date(snoozePresetInstant("tomorrow", beforeSpringForward.getTime()))
    assert.equal(exactDay.getTime() - beforeSpringForward.getTime(), 86_400_000)
    assert.equal(exactDay.getHours(), 13, "24 elapsed hours is 13:00 after the missing spring hour")
    assert.equal(tomorrow.getHours(), 9, "calendar preset preserves the promised local wall clock")
    assert.deepEqual(parseLocalSnooze("2026-03-08T02:30", beforeSpringForward.getTime()), {
      ok: false,
      message: "That local time does not exist",
    })
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test("custom local snooze round-trips wall-clock input and rejects normalized/past values", () => {
  const now = new Date(2026, 6, 13, 12, 0, 0, 0)
  assert.equal(localDateTimeInputValue(now), "2026-07-13T12:00")
  const parsed = parseLocalSnooze("2026-07-14T08:45", now.getTime())
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    const result = new Date(parsed.until)
    assert.deepEqual(
      [result.getFullYear(), result.getMonth(), result.getDate(), result.getHours(), result.getMinutes()],
      [2026, 6, 14, 8, 45],
    )
  }
  assert.deepEqual(parseLocalSnooze("2026-02-30T09:00", now.getTime()), { ok: false, message: "That local time does not exist" })
  assert.deepEqual(parseLocalSnooze("2026-07-13T11:59", now.getTime()), { ok: false, message: "Choose a time in the future" })
})

test("wake formatting uses the local calendar and locale-aware times", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const now = new Date(2026, 6, 13, 8, 0, 0, 0)
    const today = new Date(2026, 6, 13, 9, 0, 0, 0).toISOString()
    const tomorrow = new Date(2026, 6, 14, 9, 30, 0, 0).toISOString()
    const wednesday = new Date(2026, 6, 15, 21, 0, 0, 0).toISOString()
    const farDate = new Date(2026, 6, 21, 21, 0, 0, 0).toISOString()
    assert.equal(formatSnoozeWake(today, now.getTime()), "Today at 9:00 AM")
    assert.equal(formatSnoozeWake(tomorrow, now.getTime()), "Tomorrow at 9:30 AM")
    assert.equal(formatSnoozeWake(wednesday, now.getTime()), "Wednesday at 9:00 PM")
    assert.equal(formatSnoozeWake(farDate, now.getTime()), "Jul 21 at 9:00 PM")
    assert.equal(formatSnoozedUntil(wednesday, now.getTime()), "Snoozed until Wednesday at 9:00 PM")
    assert.equal(formatSnoozedUntil("not-a-date", now.getTime()), null)
    // A worker `timer:` park is the SAME concept as a human snooze — an `auto` variant that resolves
    // itself by resuming the agent. Same wake phrase, "Auto-snoozed until" prefix.
    assert.equal(formatAutoSnoozedUntil(today, now.getTime()), "Auto-snoozed until today at 9:00 AM")
    assert.equal(formatAutoSnoozedUntil(wednesday, now.getTime()), "Auto-snoozed until Wednesday at 9:00 PM")
    assert.equal(formatAutoSnoozedUntil("not-a-date", now.getTime()), null)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test("a snooze carrying a prompt reads as the AUTO variant and names the follow-up it will send", () => {
  const previousTz = process.env.TZ
  process.env.TZ = "America/Los_Angeles"
  try {
    const now = new Date(2026, 6, 13, 8, 0, 0, 0)
    const wednesday = new Date(2026, 6, 15, 21, 0, 0, 0).toISOString()
    // Without a prompt it is still the reminder it always was — YOU act at the deadline.
    assert.equal(formatUserSnooze(wednesday, undefined, now.getTime()), "Snoozed until Wednesday at 9:00 PM")
    assert.equal(formatUserSnooze(wednesday, "   ", now.getTime()), "Snoozed until Wednesday at 9:00 PM")
    // With one, frizz resolves the park by resuming the agent — the same thing "Auto-snoozed" already
    // means for a worker `timer:` park, so it must not sprout a third vocabulary.
    assert.equal(
      formatUserSnooze(wednesday, "Check CI", now.getTime()),
      "Auto-snoozed until Wednesday at 9:00 PM — then: Check CI",
    )
    assert.equal(formatUserSnooze("not-a-date", "Check CI", now.getTime()), null)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test("a snooze prompt preview collapses to one line and truncates without spilling the tooltip", () => {
  assert.equal(snoozePromptPreview("  check\n  CI   now  "), "check CI now")
  assert.equal(snoozePromptPreview("abcdefghij", 5), "abcd\u2026")
  assert.equal(snoozePromptPreview("abcde", 5), "abcde", "exactly at the cap is not truncated")
})
