import { test } from "node:test"
import assert from "node:assert/strict"
import {
  classifyLimitRecord,
  parseLimitResetClock,
  quotaWindowRecovered,
  resolveResetInstant,
  textResetInstant,
} from "./usage-limit.ts"

// Every literal in this file is copied from a REAL record in ~/.claude/projects (claude-code 2.1.216)
// — the shapes and phrasings below are observed, not invented.

// ---- classification ------------------------------------------------------------------------------

test("classify: the real session-limit record → session window + its reset clock", () => {
  const got = classifyLimitRecord(
    { isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429 },
    "You've hit your session limit · resets 5:50pm (America/Los_Angeles)",
  )
  assert.deepEqual(got, { window: "session", resetClock: { hour: 17, minute: 50, timeZone: "America/Los_Angeles" } })
})

test("classify: the real weekly-limit record → weekly window", () => {
  const got = classifyLimitRecord(
    { isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429 },
    "You've hit your weekly limit · resets 4pm (America/Los_Angeles)",
  )
  assert.deepEqual(got, { window: "weekly", resetClock: { hour: 16, minute: 0, timeZone: "America/Los_Angeles" } })
})

test("classify: the OTHER synthetic API errors in the corpus are NOT limits", () => {
  // These three are the complete set of non-limit isApiErrorMessage records observed locally. If any
  // of them classified as a limit, fray would auto-"continue" a thread whose real problem is
  // connectivity, an outage, or a terms prompt — none of which a wait fixes.
  assert.equal(classifyLimitRecord({ isApiErrorMessage: true, error: "server_error" }, "API Error: Unable to connect to API (ENOTFOUND)"), undefined)
  assert.equal(classifyLimitRecord({ isApiErrorMessage: true, error: "unknown" }, "API Error: Overloaded"), undefined)
  assert.equal(
    classifyLimitRecord({ isApiErrorMessage: true, error: "unknown", apiErrorStatus: 400 }, "API Error: 400 We've updated our Consumer Terms and Privacy Policy."),
    undefined,
  )
})

test("classify: a NON-synthetic record can never be a limit, whatever it says", () => {
  // The structural gate is what makes user- or model-authored text unable to forge a pause. An agent
  // quoting the limit line back (this very file does it) must not park its own thread.
  assert.equal(classifyLimitRecord({ error: "rate_limit" }, "You've hit your session limit · resets 5:50pm (America/Los_Angeles)"), undefined)
  assert.equal(classifyLimitRecord({ isApiErrorMessage: false, error: "rate_limit" }, "You've hit your session limit"), undefined)
})

test("classify: a rate_limit with unrecognized phrasing stays 'unknown' rather than guessing a window", () => {
  const got = classifyLimitRecord({ isApiErrorMessage: true, error: "rate_limit" }, "Rate limited, try later")
  assert.deepEqual(got, { window: "unknown" })
})

// ---- reset-clock parsing --------------------------------------------------------------------------

test("parse reset clock: meridiem, minutes, and 12am/12pm", () => {
  assert.deepEqual(parseLimitResetClock("resets 5:50pm (America/Los_Angeles)"), { hour: 17, minute: 50, timeZone: "America/Los_Angeles" })
  assert.deepEqual(parseLimitResetClock("resets 4pm (America/Los_Angeles)"), { hour: 16, minute: 0, timeZone: "America/Los_Angeles" })
  assert.deepEqual(parseLimitResetClock("resets 12am (UTC)"), { hour: 0, minute: 0, timeZone: "UTC" })
  assert.deepEqual(parseLimitResetClock("resets 12pm (UTC)"), { hour: 12, minute: 0, timeZone: "UTC" })
  assert.deepEqual(parseLimitResetClock("resets 12:40pm (America/Los_Angeles)"), { hour: 12, minute: 40, timeZone: "America/Los_Angeles" })
})

test("parse reset clock: no zone → unparseable (never assume this machine's zone)", () => {
  // The CLI prints the ACCOUNT's zone. Reading a bare "5:50pm" as local time would schedule the whole
  // fleet's resume hours off in either direction for anyone not sitting in that zone.
  assert.equal(parseLimitResetClock("resets 5:50pm"), undefined)
  assert.equal(parseLimitResetClock("resets 5:50pm (Middle/Earth)"), undefined)
  assert.equal(parseLimitResetClock("no clock here"), undefined)
})

// ---- wall clock → instant -------------------------------------------------------------------------

test("resolveResetInstant: the NEXT occurrence of the clock in its own zone", () => {
  // 2026-07-09T17:28Z is 10:28 PDT. The next 5:50pm PDT is the same day at 00:50Z on the 10th.
  const at = Date.parse("2026-07-09T17:28:00.000Z")
  const got = resolveResetInstant({ hour: 17, minute: 50, timeZone: "America/Los_Angeles" }, at)
  assert.equal(new Date(got!).toISOString(), "2026-07-10T00:50:00.000Z")
})

test("resolveResetInstant: rolls to TOMORROW when the clock already passed today", () => {
  // 2026-06-24T23:27Z is 16:27 PDT — past 4pm — so the next 4pm PDT is the following day.
  const at = Date.parse("2026-06-24T23:27:13.000Z")
  const got = resolveResetInstant({ hour: 16, minute: 0, timeZone: "America/Los_Angeles" }, at)
  assert.equal(new Date(got!).toISOString(), "2026-06-25T23:00:00.000Z")
})

test("resolveResetInstant: honors a zone whose offset differs from this machine's", () => {
  const at = Date.parse("2026-07-09T17:28:00.000Z") // 02:28 next day in Tokyo (UTC+9)
  const got = resolveResetInstant({ hour: 9, minute: 0, timeZone: "Asia/Tokyo" }, at)
  assert.equal(new Date(got!).toISOString(), "2026-07-10T00:00:00.000Z")
})

test("resolveResetInstant: survives a DST spring-forward boundary", () => {
  // 2026-03-08 is the US spring-forward. Asking for 5:50pm PDT that afternoon must land on the real
  // instant, not one hour out — the two-pass correction exists for exactly this.
  const at = Date.parse("2026-03-08T18:00:00.000Z") // 10:00 PST→PDT day, already past the transition
  const got = resolveResetInstant({ hour: 17, minute: 50, timeZone: "America/Los_Angeles" }, at)
  assert.equal(new Date(got!).toISOString(), "2026-03-09T00:50:00.000Z")
})

// ---- the text-derived firing instant --------------------------------------------------------------

test("textResetInstant: resolves a SESSION limit and anchors on the fault, not on now", () => {
  // 2026-07-21T22:26Z is 15:26 PDT; the next 5:50pm PDT is 2h24m later, at 00:50Z the next day.
  const faultAt = Date.parse("2026-07-21T22:26:23.160Z")
  const got = textResetInstant({ window: "session", resetClock: { hour: 17, minute: 50, timeZone: "America/Los_Angeles" } }, faultAt)
  assert.equal(new Date(got!).toISOString(), "2026-07-22T00:50:00.000Z")
})

test("textResetInstant: every REAL session-limit record in the corpus resolves, and within its window", () => {
  // The full set of distinct (timestamp, text) session-limit stops recorded locally. This is the
  // regression net for the 5-hour cap: if a future tweak made the cap too tight, or the clock parse
  // drifted, one of these real records would stop resolving and the feature would silently degrade to
  // "never auto-resumes" — the exact failure that is invisible until someone waits all afternoon.
  const corpus = [
    ["2026-07-02T19:30:52.225Z", "You've hit your session limit · resets 12:40pm (America/Los_Angeles)", "2026-07-02T19:40:00.000Z"],
    ["2026-07-09T04:25:09.720Z", "You've hit your session limit · resets 9:40pm (America/Los_Angeles)", "2026-07-09T04:40:00.000Z"],
    ["2026-07-10T19:39:11.421Z", "You've hit your session limit · resets 12:40pm (America/Los_Angeles)", "2026-07-10T19:40:00.000Z"],
    ["2026-07-21T22:27:20.000Z", "You've hit your session limit · resets 5:50pm (America/Los_Angeles)", "2026-07-22T00:50:00.000Z"],
  ] as const
  for (const [at, text, expected] of corpus) {
    const c = classifyLimitRecord({ isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429 }, text)
    assert.ok(c, `${text} must classify`)
    const faultAt = Date.parse(at)
    const got = textResetInstant(c, faultAt)
    assert.ok(got !== undefined, `${at} · ${text} must resolve a reset instant`)
    assert.equal(new Date(got).toISOString(), expected, `${at} · ${text}`)
    assert.ok(got - faultAt <= 5 * 3_600_000, "a session reset can never be more than its 5-hour window out")
  }
})

test("textResetInstant: a WEEKLY clock is never resolvable from text", () => {
  // The corpus proves why: a weekly stop at 2026-06-24T23:27Z (16:27 PDT) read "resets 4pm" — a time
  // that had ALREADY passed that day. Its real reset was days out, so any same-day reading would fire
  // the whole paused fleet straight back into an exhausted account.
  const faultAt = Date.parse("2026-06-24T23:27:13.000Z")
  assert.equal(textResetInstant({ window: "weekly", resetClock: { hour: 16, minute: 0, timeZone: "America/Los_Angeles" } }, faultAt), undefined)
  assert.equal(textResetInstant({ window: "unknown", resetClock: { hour: 16, minute: 0, timeZone: "America/Los_Angeles" } }, faultAt), undefined)
})

test("textResetInstant: rejects a session clock implying more than a 5-hour wait", () => {
  // A 5-hour window cannot reset 20 hours out; such a parse is a zone/meridiem surprise, not a
  // deadline. Better to fall through to the usage endpoint than to promise a wake for tomorrow.
  const faultAt = Date.parse("2026-07-09T17:28:00.000Z") // 10:28 PDT
  assert.equal(textResetInstant({ window: "session", resetClock: { hour: 9, minute: 0, timeZone: "America/Los_Angeles" } }, faultAt), undefined)
})

// ---- quota-derived recovery -----------------------------------------------------------------------

const hour = 3_600_000

test("quotaWindowRecovered: the window the fault belonged to is still open → not recovered", () => {
  const faultAt = Date.parse("2026-07-09T12:00:00.000Z")
  const now = faultAt + hour
  // Current 5h window ends 2h after the fault ⇒ it began 3h BEFORE the fault ⇒ same window.
  const windows = [{ key: "5h", resetsAt: (faultAt + 2 * hour) / 1000 }]
  assert.equal(quotaWindowRecovered(windows, "session", faultAt, now), false)
})

test("quotaWindowRecovered: a window that began AFTER the fault → recovered", () => {
  const faultAt = Date.parse("2026-07-09T12:00:00.000Z")
  const now = faultAt + 3 * hour
  // Current window ends 5h+1h after the fault ⇒ it began 1h AFTER it ⇒ the fault's window is over.
  const windows = [{ key: "5h", resetsAt: (faultAt + 6 * hour) / 1000 }]
  assert.equal(quotaWindowRecovered(windows, "session", faultAt, now), true)
})

test("quotaWindowRecovered: a reset instant already in the past → recovered", () => {
  const faultAt = Date.parse("2026-07-09T12:00:00.000Z")
  const now = faultAt + 6 * hour
  assert.equal(quotaWindowRecovered([{ key: "5h", resetsAt: (faultAt + hour) / 1000 }], "session", faultAt, now), true)
})

test("quotaWindowRecovered: the weekly window uses the 7-day span", () => {
  const day = 24 * hour
  const faultAt = Date.parse("2026-06-24T23:27:13.000Z")
  // Ends 3 days out ⇒ began 4 days BEFORE the fault ⇒ still the fault's own week.
  assert.equal(quotaWindowRecovered([{ key: "weekly", resetsAt: (faultAt + 3 * day) / 1000 }], "weekly", faultAt, faultAt + day), false)
  // Ends 7 days + 1h out ⇒ began an hour AFTER the fault ⇒ the week rolled.
  assert.equal(quotaWindowRecovered([{ key: "weekly", resetsAt: (faultAt + 7 * day + hour) / 1000 }], "weekly", faultAt, faultAt + 7 * day), true)
})

test("quotaWindowRecovered: nothing to read → INDETERMINATE, never a cheerful 'recovered'", () => {
  const faultAt = Date.parse("2026-07-09T12:00:00.000Z")
  const now = faultAt + hour
  assert.equal(quotaWindowRecovered([], "session", faultAt, now), undefined, "window absent")
  assert.equal(quotaWindowRecovered([{ key: "5h" }], "session", faultAt, now), undefined, "no reset instant")
  assert.equal(quotaWindowRecovered([{ key: "5h", resetsAt: 1 }], "unknown", faultAt, now), undefined, "unattributed window")
})

test("quotaWindowRecovered: a re-limit inside the CURRENT window reads as not-recovered (the anti-loop)", () => {
  // This is the property that makes the whole feature loop-proof. Suppose the window rolled, fray
  // resumed a thread, and it immediately blew the fresh window again. The NEW fault sits inside the
  // NEW window, so window-identity says "not recovered" and no second wake fires.
  const windowStart = Date.parse("2026-07-09T12:00:00.000Z")
  const resetsAt = windowStart + 5 * hour
  const reLimitAt = windowStart + 10 * 60_000 // ten minutes into the fresh window
  assert.equal(quotaWindowRecovered([{ key: "5h", resetsAt: resetsAt / 1000 }], "session", reLimitAt, reLimitAt + hour), false)
})
