// The pure pieces both recurring sources share: the parser that reads a worker's opt-out, and the two
// trailers that offer it. They are tested together because they are ONE contract — the wording
// delivered and the wording recognized have to agree, and nothing else in the system checks that.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ALLDONE_SENTINEL, saysAllDone, stopHookMessage, heartbeatMessage, formatIntervalLabel, parseRecurringPrompt } from "./index.ts"

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

// Both trailers carry the same two obligations, so both are held to them: name the exact token the
// parser reads, and WARN. Naming it without the warning is how a worker learns to end its own run for
// tidiness; warning without naming it leaves the opt-out undiscoverable.
for (const [label, message] of [
  ["stopHookMessage", stopHookMessage("  keep fixing the failing tests  ")],
  ["heartbeatMessage", heartbeatMessage("  keep fixing the failing tests  ", 600)],
] as const) {
  test(`${label}: the operator's words come first, then an offer AND a warning`, () => {
    assert.ok(message.startsWith("keep fixing the failing tests"), "the operator's text leads, verbatim and trimmed")
    assert.ok(message.includes(ALLDONE_SENTINEL), "the trailer names the exact token the parser reads")
    assert.match(message, /permanently stalls/, "and warns, in the same breath as the offer")
    // The trailer SAYS the word — and must not read as the worker having said it. This is delivered as
    // a USER turn so it never reaches the fold, but the shape is pinned regardless.
    assert.equal(saysAllDone(message), false)
    // De-emphasized: one parenthetical line, not a section. A trailer that grows starts competing with
    // the operator's actual instruction for the worker's attention.
    const trailer = message.slice(message.indexOf("("))
    assert.ok(trailer.length < 240, `trailer should stay a footnote, got ${trailer.length} chars`)
  })
}

test("the two trailers are distinguishable — a beat says why it arrived, and how often", () => {
  assert.match(heartbeatMessage("check the deploy", 600), /Heartbeat — sent every 10 min/)
  assert.match(stopHookMessage("check the deploy"), /Stop hook — sent each time you come to rest/)
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
  const hook = parseRecurringPrompt(stopHookMessage("Keep working the checklist."))
  assert.deepEqual(hook, { kind: "stop-hook", prompt: "Keep working the checklist." })

  const beat = parseRecurringPrompt(heartbeatMessage("Check the deploy.", 600))
  assert.deepEqual(beat, { kind: "heartbeat", every: "10 min", prompt: "Check the deploy." })

  // A multi-line operator prompt keeps every line, and only the trailer is stripped.
  const multi = parseRecurringPrompt(stopHookMessage("One.\nTwo.\n\nThree."))
  assert.equal(multi?.prompt, "One.\nTwo.\n\nThree.")
})

test("parseRecurringPrompt declines anything that is not one — text is never lost to a parse", () => {
  assert.equal(parseRecurringPrompt("just a message the human typed"), undefined)
  assert.equal(parseRecurringPrompt(undefined), undefined)
  assert.equal(parseRecurringPrompt(""), undefined)
  // A worker QUOTING the trailer mid-message is not a delivery: the trailer must end the text.
  assert.equal(parseRecurringPrompt("(Stop hook — sent each time you come to rest. blah) and then more"), undefined)
  // The trailer alone, with no operator words in front of it, is not a bump either.
  assert.equal(parseRecurringPrompt(stopHookMessage("x").replace(/^x/, "")), undefined)
})
