// The pure pieces both TRIGGERS of the recurring prompt share: the parser that reads a worker's opt-out,
// and the two trailers that offer it. They are tested together because they are ONE contract — the
// wording delivered and the wording recognized have to agree, and nothing else in the system checks it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ALLDONE_SENTINEL, DEFAULT_RECURRING_PROMPT, saysAllDone, restPromptMessage, schedulePromptMessage, formatIntervalLabel, parseRecurringPrompt } from "./index.ts"

// THE DEFAULT TEXT IS THE ONE GOAL MOST THREADS EVER RUN: every new thread is born carrying it (dispatch
// `armDefaultGoal`) and the footer panel seeds an unarmed one from it, so almost nobody types their own.
// Its BIAS is therefore a product decision rather than a wording choice, and it is deliberately lopsided
// (maintainer 2026-08-14: bias "strongly towards continuing with its work if there is incomplete work,
// unless there is a pressing or imminent decision that is needed from the human"). It used to read as two
// equal branches — keep going, or ask — which is not what a delivery that lands on an ALREADY-STOPPED
// thread is for.
test("the default Goal sends a stopped thread back to the work, and narrows what earns a stop", () => {
  assert.match(DEFAULT_RECURRING_PROMPT, /^Keep going\./, "continuing leads; it is not one branch of two")
  assert.match(DEFAULT_RECURRING_PROMPT, /unfinished, unverified, or deferred/, "and it says what counts as left over")
  // The endings a worker mistakes for one. Naming them is the whole difference between "keep going" and a
  // thread that stops at the first green test run believing it is finished.
  assert.match(DEFAULT_RECURRING_PROMPT, /are none of them endings/)
  // The stop is NARROWED, not dropped: it still exists, still lands as a card the board can render, and
  // still costs the human nothing to answer — but only for a decision that is theirs AND blocking now.
  assert.match(DEFAULT_RECURRING_PROMPT, /genuinely the human's AND that blocks you right now/)
  assert.match(DEFAULT_RECURRING_PROMPT, /question fence/)
  // NO BACKTICKED FENCE NAMES. This text renders as markdown in the panel and in the transcript, where a
  // lone ``` opens a code block that swallows everything after it. The trailer can afford them; this
  // cannot, because the operator edits it.
  assert.doesNotMatch(DEFAULT_RECURRING_PROMPT, /```/)
  // …and it teaches no stopping protocol of its own: `restPromptMessage` appends the ```done exit to
  // every delivery, whatever the operator has typed over this.
  assert.match(restPromptMessage(DEFAULT_RECURRING_PROMPT), /```done/)
  assert.deepEqual(parseRecurringPrompt(restPromptMessage(DEFAULT_RECURRING_PROMPT)), {
    kind: "rest",
    prompt: DEFAULT_RECURRING_PROMPT,
  })
})

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
    // The trailer does NOT carry the sign-off protocol: frizz's reminder is its own delivery now
    // (scheduler SOURCE 9), and a copy here would be exactly the repetition it was separated to avoid.
    assert.doesNotMatch(message, /```question/)
    // The RETIRED sentinel must not appear: it is still HONOURED for sessions that predate the change
    // (scheduler `saidDone`), and advertising it would teach it to workers that have no need of it.
    assert.equal(message.includes(ALLDONE_SENTINEL), false, "the legacy sentinel is honoured, never advertised")
    assert.equal(saysAllDone(message), false)
    // De-emphasized: one parenthetical line, not a section. A trailer that grows starts competing with
    // the operator's actual instruction for the worker's attention.
    //
    // The ceiling briefly moved to 400 when this trailer carried the sign-off protocol; it is back at
    // 240 now that frizz's reminder is its own delivery.
    const trailer = message.slice(message.indexOf("("))
    assert.ok(trailer.length < 240, `trailer should stay a footnote, got ${trailer.length} chars`)
  })
}

// THE ONE DELIVERY ALLOWED TO EXCEED THE FOOTNOTE. In Autonomous mode the at-rest trigger fires over an
// unanswered ```question fence, so this bump can land on a worker whose own last word was a question to
// the human — and there, silence is the expensive option: it re-asks, and the operator gets the same
// card twice. The clause therefore has to overrule that instinct AND say what to do with the decision
// instead, which is more than the shared note's budget. Every other trailer stays capped above.
test("restPromptMessage names the autonomous override when the bump crosses a pending question", () => {
  const crossing = restPromptMessage("keep going", { overQuestion: true })
  assert.match(crossing, /AUTONOMOUS MODE/, "the worker is told why its question is being talked over")
  assert.match(crossing, /Do NOT re-ask it/, "…and the instinct it must overrule is named outright")
  assert.match(crossing, /which way you went/, "a decision the operator cannot see is worse than the question")
  assert.ok(crossing.includes("```done"), "the opt-out survives the longer note")

  // OPT-IN, and the plain trailer is unchanged: a worker bumped mid-work has no question outstanding,
  // and telling it not to re-ask one would be frizz inventing a state the thread is not in.
  assert.doesNotMatch(restPromptMessage("keep going"), /AUTONOMOUS MODE|re-ask/)
  assert.equal(restPromptMessage("keep going", {}), restPromptMessage("keep going"))

  // The longer trailer is still a TRAILER: the parser reads the delivery back as an ordinary rest bump,
  // so the chat collapses it into a wake divider like any other rather than dropping to raw prose.
  assert.deepEqual(parseRecurringPrompt(crossing), { kind: "rest", prompt: "keep going" })
})

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
