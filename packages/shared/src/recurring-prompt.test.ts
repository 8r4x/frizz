// The pure pieces both TRIGGERS of the recurring prompt share: the parser that reads a worker's opt-out,
// and the two trailers that offer it. They are tested together because they are ONE contract — the
// wording delivered and the wording recognized have to agree, and nothing else in the system checks it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ALLDONE_SENTINEL, saysAllDone, restPromptMessage, schedulePromptMessage, formatIntervalLabel, parseRecurringPrompt } from "./index.ts"

test("saysAllDone: the sentinel opts out on its own line, however the worker dressed it", () => {
  assert.equal(saysAllDone("ALLDONE"), true)
  assert.equal(saysAllDone("Checked CI, nothing to do.\n\nALLDONE"), true)
  assert.equal(saysAllDone("**ALLDONE**"), true)
  assert.equal(saysAllDone("`ALLDONE`"), true)
  assert.equal(saysAllDone("- ALLDONE"), true)
  assert.equal(saysAllDone("ALLDONE."), true)
  assert.equal(saysAllDone("done\r\nALLDONE\r\n"), true, "CRLF transcripts must parse the same")
})

// The expensive failure is the FALSE POSITIVE, and it is expensive precisely because the opt-out is
// PERMANENT: a run stalls, nothing errors, and nobody finds out until someone looks. Both trailers name
// the token, which invites a worker to discuss it — so only a whole line ever counts.
test("saysAllDone: the sentinel embedded in prose does NOT opt out", () => {
  assert.equal(saysAllDone("I'll reply ALLDONE when there's nothing left."), false)
  assert.equal(saysAllDone("Nothing yet, so no ALLDONE from me."), false)
  assert.equal(saysAllDone("ALLDONEISH"), false)
  assert.equal(saysAllDone("all done"), false, "the sentinel is exact, not a phrase match")
  assert.equal(saysAllDone("alldone"), false, "…and it is the shouted token, not the lowercase word")
  assert.equal(saysAllDone(""), false)
  assert.equal(saysAllDone(undefined), false)
})

// Both trailers carry the same two obligations, so both are held to them: name the exact sign-off the
// scheduler reads, and WARN. Naming it without the warning is how a worker learns to end its own run for
// tidiness; warning without naming it leaves the opt-out undiscoverable.
for (const [label, message] of [
  ["restPromptMessage", restPromptMessage("  keep fixing the failing tests  ")],
  ["schedulePromptMessage", schedulePromptMessage("  keep fixing the failing tests  ", 600)],
] as const) {
  test(`${label}: the operator's words come first, then an offer AND a warning`, () => {
    assert.ok(message.startsWith("keep fixing the failing tests"), "the operator's text leads, verbatim and trimmed")
    assert.ok(message.includes("```done"), "the trailer names the exact sign-off the scheduler reads")
    assert.match(message, /ONLY when the work is genuinely finished/, "and warns, in the same breath as the offer")
    // The RETIRED sentinel must not appear: it is still HONOURED for sessions that predate the change
    // (scheduler `saidDone`), and advertising it would teach it to workers that have no need of it.
    assert.equal(message.includes(ALLDONE_SENTINEL), false, "the legacy sentinel is honoured, never advertised")
    assert.equal(saysAllDone(message), false)
    // De-emphasized: one parenthetical line, not a section. A trailer that grows starts competing with
    // the operator's actual instruction for the worker's attention.
    //
    // The ceiling moved from 240 on 2026-08-12, when the AT-REST trailer took on the sign-off protocol.
    // That is a deliberate purchase, not drift: the alternative is a SECOND delivery per rest (frizz's
    // built-in nudge, scheduler SOURCE 9) telling the worker how to sign off while the Goal is telling
    // it to keep going — two messages for one stop, which reads as frizz talking over itself. The
    // schedule trailer does NOT carry it and stays under the old ceiling, which is what keeps this an
    // exception rather than a new normal.
    const trailer = message.slice(message.indexOf("("))
    const ceiling = trailer.includes("come to rest") ? 400 : 240
    assert.ok(trailer.length < ceiling, `trailer should stay a footnote, got ${trailer.length} chars`)
  })
}

// The prompt is SHARED now, so the trailer is the only thing that says which trigger fired. That makes
// this distinction load-bearing rather than cosmetic: a worker reading a scheduled delivery has NOT
// necessarily stopped, and must not conclude it has.
test("the two trailers are distinguishable — each says why it arrived, and the scheduled one how often", () => {
  assert.match(schedulePromptMessage("check the deploy", 600), /Goal — sent every 10 min/)
  assert.match(restPromptMessage("check the deploy"), /Goal — sent each time you come to rest/)
})

test("formatIntervalLabel renders whole units", () => {
  assert.equal(formatIntervalLabel(45), "45s")
  assert.equal(formatIntervalLabel(90), "2 min", "under a minute is seconds; anything else rounds to whole minutes")
  assert.equal(formatIntervalLabel(600), "10 min")
  assert.equal(formatIntervalLabel(3600), "1 hr")
  assert.equal(formatIntervalLabel(5400), "1.5 hr")
  assert.equal(formatIntervalLabel(0), "—")
})

// The round trip the chat depends on: what the composers emit, the parser reads back. They live in one
// file precisely so this holds, and this is the test that proves it rather than assuming it.
test("parseRecurringPrompt reads back exactly what the composers emit", () => {
  const rest = parseRecurringPrompt(restPromptMessage("Keep working the checklist."))
  assert.deepEqual(rest, { kind: "rest", prompt: "Keep working the checklist." })

  const scheduled = parseRecurringPrompt(schedulePromptMessage("Check the deploy.", 600))
  assert.deepEqual(scheduled, { kind: "schedule", every: "10 min", prompt: "Check the deploy." })

  // A multi-line operator prompt keeps every line, and only the trailer is stripped.
  const multi = parseRecurringPrompt(restPromptMessage("One.\nTwo.\n\nThree."))
  assert.equal(multi?.prompt, "One.\nTwo.\n\nThree.")
})

test("parseRecurringPrompt declines anything that is not one — text is never lost to a parse", () => {
  assert.equal(parseRecurringPrompt("just a message the human typed"), undefined)
  assert.equal(parseRecurringPrompt(undefined), undefined)
  assert.equal(parseRecurringPrompt(""), undefined)
  // A worker QUOTING the trailer mid-message is not a delivery: the trailer must end the text.
  assert.equal(parseRecurringPrompt("(Recurring prompt — sent each time you come to rest. blah) and then more"), undefined)
  // The trailer alone, with no operator words in front of it, is not a delivery either.
  assert.equal(parseRecurringPrompt(restPromptMessage("x").replace(/^x/, "")), undefined)
})

// PRE-MERGE TRANSCRIPTS. Every thread open on disk when the stop hook and the heartbeat became one
// feature carries the OLD trailers, and those messages are not rewritten. The parser keeps both
// wordings so a whole thread's history does not silently demote from wake dividers to prose — a
// non-match loses no text, but it does lose the rendering.
test("parseRecurringPrompt still reads the PRE-MERGE trailers", () => {
  const legacyRest = "Keep working the checklist.\n\n(Stop hook — sent each time you come to rest. If there is genuinely no further work, reply ALLDONE on its own line to stop these prompts — but be sure, because it permanently stalls this run.)"
  assert.deepEqual(parseRecurringPrompt(legacyRest), { kind: "rest", prompt: "Keep working the checklist." })

  const legacyBeat = "Check the deploy.\n\n(Heartbeat — sent every 10 min. If there is genuinely no further work, reply ALLDONE on its own line to stop these prompts — but be sure, because it permanently stalls this run.)"
  assert.deepEqual(parseRecurringPrompt(legacyBeat), { kind: "schedule", every: "10 min", prompt: "Check the deploy." })
})
