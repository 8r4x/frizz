import { test } from "node:test"
import assert from "node:assert/strict"
import { parseAnswersMessage, parseBuriedAnswersMessage, parseAnswersCard, pairAnswersMessage, pairAllAnswers, type MsgLike } from "./answersMessage.ts"

test("parses the multi-block composed-answer format into numbered rows", () => {
  const parsed = parseAnswersMessage("Answers:\n1. B. Hard-error with an install hint\n2. A. Preload it")
  assert.deepEqual(parsed, [
    { n: 1, answer: "B. Hard-error with an install hint" },
    { n: 2, answer: "A. Preload it" },
  ])
})

test("a multi-line answer folds its continuation lines in (newline preserved)", () => {
  const parsed = parseAnswersMessage("Answers:\n1. first line\ncontinued here\n2. second")
  assert.equal(parsed?.length, 2)
  assert.equal(parsed?.[0].answer, "first line\ncontinued here")
  assert.equal(parsed?.[1].answer, "second")
})

test("CR-separated composed answer (terminal-injected) parses (the newline-collapse fix)", () => {
  // The real session 2cfe3c81 16:24:42 shape: a follow-up round-tripped through the tty is \r-separated.
  const parsed = parseAnswersMessage("Answers:\r1. B. Hard-error with an install hint\r2. A. Preload it")
  assert.deepEqual(parsed, [
    { n: 1, answer: "B. Hard-error with an install hint" },
    { n: 2, answer: "A. Preload it" },
  ])
})

test("tolerates leading blank lines before the header", () => {
  const parsed = parseAnswersMessage("\n\nAnswers:\n1. yes")
  assert.deepEqual(parsed, [{ n: 1, answer: "yes" }])
})

test("a plain (non-answers) user message returns null → falls back to the bubble", () => {
  assert.equal(parseAnswersMessage("Stop. Ask me the questions again."), null)
})

test("a single bare answer (no 'Answers:' header) returns null", () => {
  assert.equal(parseAnswersMessage("B. Hard-error with an install hint"), null)
})

test("header present but no numbered lines → null (degrade to bubble)", () => {
  assert.equal(parseAnswersMessage("Answers:\njust some prose"), null)
})

test("prose that merely contains the word Answers is not misdetected", () => {
  assert.equal(parseAnswersMessage("Answers: it depends\n1. maybe"), null) // first line isn't exactly "Answers:"
})

test("empty / whitespace input returns null", () => {
  assert.equal(parseAnswersMessage(""), null)
  assert.equal(parseAnswersMessage("   \n  "), null)
})

// ---- parseBuriedAnswersMessage (composeAnswerWire's self-describing form) ----

test("parses the buried form's quoted question and answer into card rows", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “Which database?” → A. Postgres\n2. “Ship it?” → B. Hold')
  assert.deepEqual(parsed, [
    { n: 1, answer: "A. Postgres", question: "Which database?" },
    { n: 2, answer: "B. Hold", question: "Ship it?" },
  ])
})

test("an answer containing its own arrow keeps everything after the FIRST quote-arrow", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “Which flow?” → A. draft → review → merge')
  assert.equal(parsed?.[0].question, "Which flow?")
  assert.equal(parsed?.[0].answer, "A. draft → review → merge")
})

test("a multi-line buried answer folds its continuation lines in", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “Why?” → because\nof this\n2. “And?” → sure')
  assert.equal(parsed?.length, 2)
  assert.equal(parsed?.[0].answer, "because\nof this")
  assert.equal(parsed?.[1].answer, "sure")
})

test("an empty quoted question leaves the row unpaired (the numbered fallback, never an empty label)", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\n1. “” → A. Postgres')
  assert.deepEqual(parsed, [{ n: 1, answer: "A. Postgres" }])
})

test("CR-separated buried form parses (terminal-injected follow-up)", () => {
  const parsed = parseBuriedAnswersMessage('Answers to earlier questions:\r1. “Q?” → A')
  assert.deepEqual(parsed, [{ n: 1, answer: "A", question: "Q?" }])
})

test("buried detection is strict: wrong header, or rows without the quote-arrow, → null", () => {
  assert.equal(parseBuriedAnswersMessage('Answers to earlier questions: sort of\n1. “Q?” → A'), null)
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:\n1. just an answer"), null)
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:\nprose first\n1. “Q?” → A"), null)
  assert.equal(parseBuriedAnswersMessage("Answers to earlier questions:"), null)
  assert.equal(parseBuriedAnswersMessage("Answers:\n1. A"), null) // the live form is the other parser's
  assert.equal(parseBuriedAnswersMessage(""), null)
})

test("parseAnswersCard accepts either wire form", () => {
  assert.equal(parseAnswersCard('Answers to earlier questions:\n1. “Q?” → A')?.[0].question, "Q?")
  assert.equal(parseAnswersCard("Answers:\n1. A")?.[0].answer, "A")
  assert.equal(parseAnswersCard("plain follow-up"), null)
})

// ---- pairAnswersMessage (question↔answer correlation for the AnswersCard) ----
const user = (text: string): MsgLike => ({ role: "user", text })
const asst = (text: string): MsgLike => ({ role: "assistant", text })
const event = (text = "Agent finished"): MsgLike => ({ role: "assistant", kind: "event", text })
// An assistant message carrying one ```question block per body, in the frizz worker convention
// (context prose, then trailing lettered options).
const qmsg = (...bodies: string[]): MsgLike => asst(bodies.map((b) => "```question\n" + b + "\n```").join("\n\n"))

test("pairs answer N with question-block N of the immediately-preceding assistant message", () => {
  const msgs = [qmsg("Q1 — install policy?\n- A. soft\n- B. hard", "Q2 — trigger?\n- A. schema\n- B. flag"), user("Answers:\n1. B. hard\n2. A. schema")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 2)
  assert.equal(paired?.[0].question, "Q1 — install policy?") // options stripped — context prose only
  assert.equal(paired?.[0].answer, "B. hard")
  assert.equal(paired?.[1].question, "Q2 — trigger?")
  assert.equal(paired?.[1].answer, "A. schema")
})

test("skips event punctuation and tool-only (text-less) turns during the lookback", () => {
  const msgs = [qmsg("Pick one?\n- A. x\n- B. y"), event(), asst(""), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 3)
  assert.equal(paired?.[0].question, "Pick one?")
})

test("scans past a prose-only assistant message to the nearest question-bearing one", () => {
  const msgs = [qmsg("Pick one?\n- A. x"), asst("One more note before you answer."), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 2)
  assert.equal(paired?.[0].question, "Pick one?")
})

test("an intervening user message stops the lookback → unpaired numbered fallback", () => {
  const msgs = [qmsg("Old ask?\n- A. x"), user("something unrelated"), user("Answers:\n1. A. x")]
  const paired = pairAnswersMessage(msgs, 2)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, undefined) // those questions were already claimed — never mislabel
})

test("an out-of-range answer number degrades to unpaired rows (never the wrong question)", () => {
  const msgs = [qmsg("Only one?\n- A. x"), user("Answers:\n1. A. x\n2. B. y")] // n=2 but only one block
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 2)
  assert.ok(paired?.every((p) => p.question === undefined))
})

test("a PARTIAL answer set pairs by the answer's own number (sendAnswers keeps original block numbers)", () => {
  // Three-block ask, only block 2 answered → "Answers:\n2. …" must pair with the SECOND question.
  const msgs = [qmsg("First?\n- A. x", "Second?\n- B. y", "Third?\n- C. z"), user("Answers:\n2. B. y")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].n, 2)
  assert.equal(paired?.[0].question, "Second?")
})

test("non-increasing answer numbers (hand-typed) degrade to unpaired rows", () => {
  const msgs = [qmsg("First?\n- A. x", "Second?\n- B. y"), user("Answers:\n2. B\n1. A")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.ok(paired?.every((p) => p.question === undefined))
})

test("no preceding question message at all → unpaired rows", () => {
  const paired = pairAnswersMessage([user("Answers:\n1. A. x")], 0)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, undefined)
})

test("a non-answers message returns null (the caller renders the plain bubble)", () => {
  assert.equal(pairAnswersMessage([qmsg("Q?"), user("plain follow-up")], 1), null)
  assert.equal(pairAnswersMessage([qmsg("Q?"), asst("Answers:\n1. A")], 1), null) // wrong role
})

test("a one-block ask's answer pairs and cards up (the numbered form composeAnswerWire now always sends)", () => {
  const msgs = [qmsg("Delete the orphaned binaries?\n- A. Yes, delete them\n- B. Leave them"), user("Answers:\n1. A. Yes, delete them")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.length, 1)
  assert.equal(paired?.[0].question, "Delete the orphaned binaries?")
  assert.equal(paired?.[0].answer, "A. Yes, delete them")
})

// ---- legacy bare single answers (pre-numbering transcripts) ----

test("a LEGACY bare answer matching a one-block ask's option still cards up", () => {
  const msgs = [qmsg("Delete the orphaned binaries?\n- A. Yes, delete them\n- B. Leave them"), user("A. Yes, delete them")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.deepEqual(paired, [{ n: 1, answer: "A. Yes, delete them", question: "Delete the orphaned binaries?" }])
})

test("a bare reply that matches NO option keeps its plain bubble (never box an ordinary steer)", () => {
  const msgs = [qmsg("Delete them?\n- A. Yes\n- B. No"), user("Neither — check whether anything still links them first.")]
  assert.equal(pairAnswersMessage(msgs, 1), null)
})

test("a bare option match against a MULTI-block ask is not recovered (that form was always numbered)", () => {
  const msgs = [qmsg("First?\n- A. x\n- B. y", "Second?\n- A. p\n- B. q"), user("A. x")]
  assert.equal(pairAnswersMessage(msgs, 1), null)
})

test("a bare option match does not reach across an intervening human turn", () => {
  const msgs = [qmsg("Pick?\n- A. x\n- B. y"), user("hold on"), user("A. x")]
  assert.equal(pairAnswersMessage(msgs, 2), null)
})

test("a bare answer with no preceding ask at all stays a plain bubble", () => {
  assert.equal(pairAnswersMessage([user("A. x")], 0), null)
})

test("a CR-separated answers message still pairs (normalization happens inside)", () => {
  const msgs = [qmsg("Pick?\n- A. x", "Also?\n- B. y"), user("Answers:\r1. A. x\r2. B. y")]
  const paired = pairAnswersMessage(msgs, 1)
  assert.equal(paired?.[0].question, "Pick?")
  assert.equal(paired?.[1].question, "Also?")
})

test("pairAllAnswers: null at ordinary indices, pairing at answers indices", () => {
  const msgs = [qmsg("Pick?\n- A. x"), asst("prose"), user("Answers:\n1. A. x")]
  const all = pairAllAnswers(msgs)
  assert.deepEqual([all[0], all[1]], [null, null])
  assert.equal(all[2]?.[0].question, "Pick?")
})

test("the buried form pairs from its OWN quoted questions, ignoring the lookback entirely", () => {
  // Two asks buried behind an intervening human turn — the lookback would stop at that turn and drop
  // every question (or, worse, number-map onto the nearest ask). The inline quotes win instead.
  const msgs = [
    qmsg("Old ask — which database?\n- A. Postgres"),
    user("actually hold on"),
    qmsg("Newer ask — ship it?\n- A. Yes"),
    asst("still working…"),
    user('Answers to earlier questions:\n1. “Old ask — which database?” → A. Postgres\n2. “Newer ask — ship it?” → A. Yes'),
  ]
  const paired = pairAnswersMessage(msgs, 4)
  assert.equal(paired?.length, 2)
  assert.equal(paired?.[0].question, "Old ask — which database?")
  assert.equal(paired?.[0].answer, "A. Postgres")
  assert.equal(paired?.[1].question, "Newer ask — ship it?")
  assert.equal(paired?.[1].answer, "A. Yes")
})
