import assert from "node:assert/strict"
import test from "node:test"
import { allFencesShadowed, fenceRestatesRegistered, fenceStandsFor, placeQuestions, registeredAtRest } from "./questionShadow.ts"
import { type MessageSegment, splitQuestionBlocks } from "./questionBlocks.ts"

// The pair from the 2026-08-28 report, verbatim: the registration (a plain string — the `ask` schema
// carries no markdown) and the fence the worker wrote sixteen seconds later, with `code`, a link and a
// trailing parenthetical the registration does not have.
const REGISTERED = {
  spec: {
    question: "Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open, and the published announcement documents its API (z.config({ memoizer: z.memoizer() })) in the Zod Mini tab.",
    kind: "question" as const,
    options: [{ label: "Merge #6482, then cut 4.5.0", recommended: true }, { label: "Cut 4.5.0 without #6482" }, { label: "Hold the release" }],
  },
}
const FENCE = [
  "Cut 4.5.0 now? The memoizer opt-in PR [#6482](https://github.com/colinhacks/zod/pull/6482) is still open, and the published announcement documents its API (`z.config({ memoizer: z.memoizer() })`) in the Zod Mini tab. (also on the board as a card)",
  "",
  "- A. Merge #6482 first, then bump to 4.5.0 and push — the release includes the memoizer API the post documents (recommended)",
  "- B. Cut 4.5.0 without #6482 — the Zod Mini memoizer tab gets stripped from the announcement first; the API ships in a later 4.5.x",
  "- C. Hold the release — nothing is bumped until further instruction",
].join("\n")

test("the re-fenced release question restates its registration despite the markup and the trailing aside", () => {
  assert.equal(fenceRestatesRegistered(FENCE, [REGISTERED]), true)
})

test("the same question asked with different context around it still folds — the `?` head is the question", () => {
  const reworded = "Before anything is pushed: Cut 4.5.0 now? #6482 is still open.\n\n- A. Yes\n- B. No"
  assert.equal(fenceRestatesRegistered(reworded, [REGISTERED]), true)
})

test("a fence that only asks the registered question's opening is a prefix of it, and folds", () => {
  assert.equal(fenceRestatesRegistered("Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open\n\n- A. Yes\n- B. No", [REGISTERED]), true)
})

test("a different question at the same rest is NOT folded — the fold never hides an unseen question", () => {
  const other = "Which npm dist-tag should 4.5.0 publish under?\n\n- A. `latest` (recommended)\n- B. `next`"
  assert.equal(fenceRestatesRegistered(other, [REGISTERED]), false)
})

test("nothing folds against no registration, and a head too short to mean anything never matches", () => {
  assert.equal(fenceRestatesRegistered(FENCE, []), false)
  const short = { spec: { question: "Proceed?", kind: "question" as const } }
  assert.equal(fenceRestatesRegistered("Proceed?\n\n- A. Yes\n- B. No", [short]), false)
})

test("allFencesShadowed is true only when every fence in the text restates a registration", () => {
  const one = `Prose first.\n\n\`\`\`question\n${FENCE}\n\`\`\`\n`
  const two = `${one}\n\`\`\`question\nWhich npm dist-tag should 4.5.0 publish under?\n\n- A. latest\n- B. next\n\`\`\`\n`
  assert.equal(allFencesShadowed(one, [REGISTERED]), true)
  assert.equal(allFencesShadowed(two, [REGISTERED]), false)
  assert.equal(allFencesShadowed("No fence here at all.", [REGISTERED]), false)
  assert.equal(allFencesShadowed(one, []), false)
})

// The transcript shape of the report: a fence, two watcher wakes (user turns frizz wrote), the
// registration, then the final message with the fence again. The registration belongs to the rest the
// final message ended, so every message of THAT rest sees it — and the first fence, one rest up, does not.
const at = (min: number) => new Date(Date.UTC(2026, 7, 28, 17, min)).toISOString()
const MESSAGES = [
  { role: "user", at: at(0) },
  { role: "assistant", at: at(5) }, // the first fence
  { role: "user", at: at(6) }, // the PR watcher's wake
  { role: "assistant", at: at(9) }, // tool calls
  { role: "assistant", at: at(11) }, // the final message, fence restated
]
const QUESTION = { ...REGISTERED, id: "qst_6b9bdbe563fa", askedAt: at(10) }

test("registeredAtRest maps every message of the asking rest to the registration, and no other", () => {
  const map = registeredAtRest(MESSAGES, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [3, 4])
  assert.deepEqual(map.get(4), [QUESTION])
  assert.equal(map.get(1), undefined, "the first fence is one rest up; the wake closed that rest")
})

test("a question the human already replied past belongs to the rest it was asked at", () => {
  const replied = [...MESSAGES, { role: "user", at: at(15) }, { role: "assistant", at: at(16) }]
  const map = registeredAtRest(replied, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [3, 4])
})

test("a registration whose rest is above the loaded window maps to nothing", () => {
  const map = registeredAtRest(MESSAGES.slice(2), [{ ...QUESTION, askedAt: at(1) }])
  assert.equal(map.size, 0)
})

// ---- PLACEMENT ----
// The worker writes the ask into the middle of its handoff; the registered card renders in that slot.

const fenced = (body: string, info = "") => `\`\`\`question${info ? ` ${info}` : ""}\n${body}\n\`\`\``
const questionSeg = (text: string, info = "") => {
  const segs = splitQuestionBlocks(fenced(text, info)).filter((s) => s.kind === "question")
  assert.equal(segs.length, 1, "the fixture must produce exactly one question segment")
  return segs[0] as Extract<MessageSegment, { kind: "question" }>
}

test("fenceStandsFor matches by the info-string id, whatever the prose says", () => {
  const seg = questionSeg("Something else entirely?\n\n- A. Yes\n- B. No", QUESTION.id)
  assert.equal(fenceStandsFor(seg, [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(seg, [{ ...QUESTION, id: "qst_000000000000" }]), undefined, "a different id names a different row")
})

test("fenceStandsFor falls back to the prose when the worker wrote no id", () => {
  assert.equal(fenceStandsFor(questionSeg(FENCE), [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(questionSeg("Which npm dist-tag?\n\n- A. latest\n- B. next"), [QUESTION]), undefined)
})

const HANDOFF = `Here is what landed, and one thing is still open.\n\n${fenced(FENCE)}\n\nThe rest of the write-up follows.`

test("placeQuestions puts the rest's group in the message that stands for it, and clears its anchor", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? HANDOFF : "prose" }))
  const { placed, placedAnchors } = placeQuestions(messages, [QUESTION])
  assert.deepEqual([...placed.keys()], [4])
  assert.deepEqual(placed.get(4), [QUESTION])
  assert.ok(placedAnchors.has(4), "the anchor row must not draw it a second time")
})

test("the FIRST standing fence of the rest wins — one slot, because the stack sends as one batch", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 3 || i === 4 ? HANDOFF : "prose" }))
  const { placed } = placeQuestions(messages, [QUESTION])
  assert.deepEqual([...placed.keys()], [3])
})

test("a handoff that names none of its registrations places nothing — the anchor still draws them", () => {
  const messages = MESSAGES.map((m) => ({ ...m, text: "Landed it. Nothing else to say." }))
  const { placed, placedAnchors } = placeQuestions(messages, [QUESTION])
  assert.equal(placed.size, 0)
  assert.equal(placedAnchors.size, 0)
})

test("a fence one rest ABOVE the registration never places it", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 1 ? HANDOFF : "prose" }))
  assert.equal(placeQuestions(messages, [QUESTION]).placed.size, 0)
})

test("a registration whose rest is above the loaded window places nothing", () => {
  const messages = MESSAGES.slice(2).map((m) => ({ ...m, text: HANDOFF }))
  assert.equal(placeQuestions(messages, [{ ...QUESTION, askedAt: at(1) }]).placed.size, 0)
})
