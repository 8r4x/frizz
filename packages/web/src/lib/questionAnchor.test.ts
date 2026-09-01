import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { agentSpokeLast, questionAnchorIndex, questionsByAnchor, type AnchorMessage } from "./questionAnchor.ts"

const at = (n: number) => new Date(Date.UTC(2026, 7, 27, 20, n)).toISOString()
const msg = (role: string, minute: number, kind?: string): AnchorMessage => ({ role, at: at(minute), ...(kind ? { kind } : {}) })

// THE ORDINARY CASE, and the one that must not move: the worker asked and rested, nothing has happened
// since, so the card is the tail exactly as it was before there was an anchor at all.
test("a question asked at the last rest anchors to the tail", () => {
  const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2)]
  assert.equal(questionAnchorIndex(messages, at(2)), 2)
})

// THE REPORT. The human replied past the question without answering it — the composer is right there —
// and the worker has worked since. Pinned to the tail the card sat UNDER their own newest message and
// under everything after it, claiming to be the current ask.
test("a question the human replied past sits at ITS rest, above their reply", () => {
  const messages = [
    msg("user", 0),        // 0 the original task
    msg("assistant", 1),   // 1 the worker's turn…
    msg("assistant", 2),   // 2 …and the rest it asked at
    msg("user", 3),        // 3 the human replies without answering
    msg("assistant", 4),   // 4 the worker gets on with it
  ]
  assert.equal(questionAnchorIndex(messages, at(2)), 2)
})

// A wake is recorded as a USER turn, and it counts: the thread moved on, whoever moved it.
test("frizz's own delivery ends the rest just as a typed reply does", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3)]
  assert.equal(questionAnchorIndex(messages, at(1)), 0)
})

test("punctuation is not a turn", () => {
  // An event line and a reasoning summary carry a nominal role; neither ends a rest.
  const messages = [msg("assistant", 1), msg("user", 2, "event"), msg("user", 2, "reasoning"), msg("assistant", 3)]
  assert.equal(questionAnchorIndex(messages, at(1)), 3)
})

test("a rest older than the loaded window goes above everything, never back to the tail", () => {
  // -1 rather than the tail: at the bottom the card would be lying about being the current ask, which is
  // the whole defect. At the top it is merely as high as this window can put it.
  const messages = [msg("user", 5), msg("assistant", 6)]
  assert.equal(questionAnchorIndex(messages, at(1)), -1)
})

test("an unreadable instant degrades to the tail rather than to the top", () => {
  const messages = [msg("user", 0), msg("assistant", 1)]
  assert.equal(questionAnchorIndex(messages, "not a date"), 1)
  assert.equal(questionAnchorIndex([], at(1)), -1)
})

test("a message with no instant cannot end a rest", () => {
  const messages: AnchorMessage[] = [{ role: "assistant", at: at(1) }, { role: "user" }, { role: "assistant", at: at(3) }]
  assert.equal(questionAnchorIndex(messages, at(1)), 2)
})

// One `ask` call registers several questions at ONE instant, and they must stay one stack.
test("questions from one call group together; questions from two rests do not", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3)]
  const grouped = questionsByAnchor(messages, [
    { id: "a", askedAt: at(1) },
    { id: "b", askedAt: at(1) },
    { id: "c", askedAt: at(3) },
  ])
  assert.deepEqual([...grouped.keys()].sort(), [0, 2])
  assert.deepEqual(grouped.get(0)?.map((q) => q.id), ["a", "b"])
  assert.deepEqual(grouped.get(2)?.map((q) => q.id), ["c"])
})

// THE ONE THING THE PURE FUNCTION CANNOT PIN: that both surfaces split the stack the same way. The
// in-flight ANSWER belongs to the TAIL wherever the questions sit — it is the human's newest turn, and
// the delivered copy of it lands at the tail a second later — so a mount placed at an older rest must
// not draw it. Two drawing it would render the answer twice, in two places, seconds apart.
//
// The prop is OPT-IN (`inFlight`, the rows the transcript is not already drawing — see
// unrenderedAnswers) rather than the opt-out `showInFlight` it was until 2026-09-01, so an anchored
// mount draws nothing by simply not passing it, and this reads the same guarantee off the new spelling.
test("a mount placed at an older rest never draws the in-flight answer", () => {
  for (const file of ["ChatView.tsx", "TodosView.tsx"]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8")
    const mounts = [...source.matchAll(/<RegisteredQuestionStack[^>]*>/g)].map((m) => m[0])
    const tail = mounts.filter((m) => /questions=\{[^}]*[Tt]ail\}/.test(m))
    // An ANCHORED mount is one handed a group that is not the tail. The eager fallback passes no
    // `questions` at all — it only renders with an empty transcript, where every rest IS the tail.
    const anchored = mounts.filter((m) => /questions=\{/.test(m) && !/[Tt]ail\}/.test(m))
    assert.equal(tail.length, 1, `${file}: exactly one tail mount`)
    assert.ok(anchored.length >= 1, `${file}: at least one anchored mount`)
    assert.match(tail[0], /inFlight=\{/, `${file}: the tail mount draws the in-flight answer`)
    for (const m of anchored) assert.ok(!/inFlight=\{/.test(m), `${file}: an anchored mount must not`)
    // …and the mount with no `questions` at all (the empty-transcript fallback) is a tail too.
    for (const m of mounts.filter((x) => !/questions=\{/.test(x))) {
      assert.match(m, /inFlight=\{/, `${file}: the fallback mount is a tail mount`)
    }
  }
})

// ---- AT REST, THE CURRENT REST OWNS THE ASK -------------------------------------------------------
//
// The other half of the 2026-08-27 report, and the one freezing the card at its asking rest created.
// The human replies past an open question without answering it, the worker answers the follow-up and
// RESTS AGAIN with the question still open. Anchored to history, the card sits above the human's own
// reply and the newest handoff — the one they are actually reading — shows no ask at all, so the rest
// reads as a bare stop while frizz's sign-off nudge rightly stands down (the open row IS the sign-off).
// Observed 2026-08-31 on `evaluate-critically-never-assume`: "Why was this able to come to rest without
// a proper handoff?"
test("at rest, a question the human replied past moves to the current rest", () => {
  const messages = [
    msg("user", 0),        // 0 the original task
    msg("assistant", 1),   // 1 the worker's turn…
    msg("assistant", 2),   // 2 …and the rest it asked at
    msg("user", 3),        // 3 the human replies without answering
    msg("assistant", 4),   // 4 the worker answers and rests again
  ]
  const grouped = questionsByAnchor(messages, [{ id: "a", askedAt: at(2) }], { atRest: true })
  assert.deepEqual([...grouped.keys()], [4])
})

// MID-FLIGHT IT MUST NOT MOVE, which is the 2026-08-27 defect itself: while the worker is running, the
// tail is live output, and a card under it claims to be the current ask when the rest it belongs to is
// further up.
test("running, the same question stays at its own rest", () => {
  const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2), msg("user", 3), msg("assistant", 4)]
  const grouped = questionsByAnchor(messages, [{ id: "a", askedAt: at(2) }], { atRest: false })
  assert.deepEqual([...grouped.keys()], [2])
})

// AT REST BUT THE HUMAN SPOKE LAST: their message is the tail and the worker has not picked it up yet.
// Dropping the card below it is the original report verbatim, so `atRest` alone cannot be the test —
// the worker must also have ended the exchange.
test("at rest with the human's reply unanswered at the tail, the card stays above it", () => {
  const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2), msg("user", 3)]
  const grouped = questionsByAnchor(messages, [{ id: "a", askedAt: at(2) }], { atRest: true })
  assert.deepEqual([...grouped.keys()], [2])
})

// Two questions asked at two different rests collapse into ONE stack at the current rest: both are open,
// both are owed an answer now, and splitting them across the transcript hides the older one above a
// reply the human has already scrolled past.
test("at rest, questions from several rests collapse into one stack in asked order", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), msg("assistant", 5)]
  const grouped = questionsByAnchor(
    messages,
    [{ id: "a", askedAt: at(1) }, { id: "b", askedAt: at(3) }],
    { atRest: true },
  )
  assert.deepEqual([...grouped.keys()], [4])
  assert.deepEqual(grouped.get(4)?.map((q) => q.id), ["a", "b"])
})

// No questions ⇒ no groups, at rest or not; the tail entry must not be minted for an empty set.
test("no open questions produces no groups", () => {
  const messages = [msg("user", 0), msg("assistant", 1)]
  assert.equal(questionsByAnchor(messages, [], { atRest: true }).size, 0)
})

// The default (no opts) is the mid-flight reading, which is what keeps lib/questionShadow's fold —
// which spans from the asking rest onward and must never be collapsed to the tail — unchanged.
test("omitting opts keeps the historical anchor", () => {
  const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2), msg("user", 3), msg("assistant", 4)]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "a", askedAt: at(2) }]).keys()], [2])
})

test("agentSpokeLast reads the end of the exchange, ignoring punctuation", () => {
  assert.equal(agentSpokeLast([msg("user", 0), msg("assistant", 1)]), true)
  assert.equal(agentSpokeLast([msg("assistant", 0), msg("user", 1)]), false)
  // An event line after the worker's last word is punctuation, not the human taking the floor.
  assert.equal(agentSpokeLast([msg("assistant", 0), msg("user", 1, "event")]), true)
  assert.equal(agentSpokeLast([]), false)
})
