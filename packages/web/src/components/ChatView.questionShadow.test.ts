import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const queue = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")

// A ```question fence restating a question REGISTERED at the same rest is folded into the registered
// card (lib/questionShadow) — the 2026-08-28 "same question showing up twice in a row". The fold is a
// prop on Message, so it works only where the transcript hands it over: these pin that every surface
// that renders an answerable message does, and that the queue card's card-level Send answers stands
// down when the standing ask has no card left of its own.

test("every answerable Message site hands the registered questions at its rest to the fold", () => {
  // Thread page: the plain path (keyed by `messageIndex`) and the virtualized path (`row.messageIndex`).
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(messageIndex\)\}/g) ?? []).length, 1, "plain transcript path")
  assert.equal((chat.match(/shadowedBy=\{shadowedByMessage\.get\(row\.messageIndex\)\}/g) ?? []).length, 1, "virtualized transcript path")
  // Queue card: the text-only first/last message and the ordinary message, both keyed by `globalIdx`.
  assert.equal((queue.match(/shadowedBy=\{shadowedByMessage\.get\(globalIdx\)\}/g) ?? []).length, 2, "both queue-card message sites")
})

test("the map is built off the same messages and questions the anchors use, on all three surfaces", () => {
  const build = /registeredAtRest\(messages, thread\?\.questions \?\? \[\]\), \[messages, thread\?\.questions\]\)/g
  assert.equal((chat.match(build) ?? []).length, 2, "one per ChatView transcript path")
  assert.equal((queue.match(build) ?? []).length, 1, "the queue card")
})

test("a folded fence leaves no Send button behind it", () => {
  // Message's own bottom button needs a block that actually rendered…
  assert.match(chat, /else if \(showSendButton && answering && askBlocks\.length > 0\)/)
  // …and the queue card's card-level button stands down for a standing ask folded whole.
  assert.match(queue, /const showSendAnswers = \(answerable && !tailAskShadowed\) \|\| anyAnswered/)
  assert.match(queue, /allFencesShadowed\(messages\[idx\]\.text, shadowedByMessage\.get\(idx\) \?\? \[\]\)/)
})
