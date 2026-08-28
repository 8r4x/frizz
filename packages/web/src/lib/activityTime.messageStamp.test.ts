import { test } from "node:test"
import assert from "node:assert/strict"
import { messageStamp } from "./activityTime.ts"

// The reading is locale-formatted, so these assert its SHAPE and the two decisions that are actually
// ours — that the date is always present, and that the year is present only when it differs — rather
// than pinning a string that would break on a machine with different locale settings.

test("carries the date on every reading, not just on a message from another day", () => {
  const now = new Date(2026, 7, 25, 14, 0, 0)
  const sameDay = messageStamp(new Date(2026, 7, 25, 10, 31, 0).toISOString(), now)
  assert.ok(sameDay, "a valid instant must produce a reading")
  // A bare clock would encode "today" in an ABSENCE. The date is unconditional precisely so there is
  // no rule to know — see the comment on messageStamp.
  assert.match(sameDay, /\d/, "reading has no digits at all")
  assert.ok(!/^\d{1,2}:\d{2}/.test(sameDay), `same-day reading is a bare clock: ${sameDay}`)
  assert.ok(sameDay.includes(","), `expected "<date>, <time>": ${sameDay}`)
})

test("omits the year within the current year and states it outside", () => {
  const now = new Date(2026, 7, 25, 14, 0, 0)
  const thisYear = messageStamp(new Date(2026, 0, 3, 9, 5, 0).toISOString(), now)!
  const lastYear = messageStamp(new Date(2025, 0, 3, 9, 5, 0).toISOString(), now)!
  // DERIVE the glyph rather than spelling "2026" — the year is formatted in the runtime locale's own
  // calendar, so a Gregorian literal is exactly the locale pin this file's header says it avoids. Under
  // `LANG=th_TH.UTF-8` a 2025 instant renders as the Buddhist-era 2568 and `includes("2025")` fails
  // while messageStamp behaves exactly as specified. CI resolves to en-US today; a contributor machine
  // need not. `\p{Nd}` and not `\D`: under ar-SA the year is "٢٠٢٥" in Arabic-Indic digits, which an
  // ASCII-only strip reduces to the empty string — and `includes("")` is vacuously true, so the test
  // would pass while asserting nothing. Verified across en-US, th-TH, ar-SA, fa-IR, ja-JP, zh-CN,
  // ko-KR, he-IL, hi-IN and de-DE: both assertions hold in every one.
  const yearGlyph = (y: number) =>
    (new Date(y, 0, 3).toLocaleDateString([], { year: "numeric" }).match(/\p{Nd}/gu) ?? []).join("")
  assert.ok(!thisYear.includes(yearGlyph(2026)), `current year should be implicit: ${thisYear}`)
  assert.ok(lastYear.includes(yearGlyph(2025)), `a prior year must be stated: ${lastYear}`)
})

test("a long-running thread's two ends never read the same", () => {
  // The whole reason the date is unconditional: a worker parked on a PR watcher for days puts two
  // adjacent messages on different dates at the same wall-clock time.
  const now = new Date(2026, 7, 25, 14, 0, 0)
  const monday = messageStamp(new Date(2026, 7, 24, 10, 31, 0).toISOString(), now)
  const tuesday = messageStamp(new Date(2026, 7, 25, 10, 31, 0).toISOString(), now)
  assert.notEqual(monday, tuesday, "same clock on different days must not collide")
})

test("a missing or unparseable instant yields null rather than an Invalid Date", () => {
  assert.equal(messageStamp(undefined), null)
  assert.equal(messageStamp(""), null)
  assert.equal(messageStamp("not a date"), null)
  // The field is optional on the wire and absent on legacy transcripts, so this is the common path,
  // not a defensive flourish — the caller renders nothing at all when it is null.
  assert.equal(messageStamp("2026-13-45T99:99:99Z"), null)
})
