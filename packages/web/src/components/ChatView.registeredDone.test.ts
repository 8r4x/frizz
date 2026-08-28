import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const queue = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")

// A completion registered with `mcp__frizz__done` is in no message, so the transcript's fence parser
// never draws it — and until 2026-08-27 nothing else did either: the thread rested on a prose handoff
// with no card at its end, on the thread page, on /full and on the queue card alike. These pin the
// wiring: the card is the LAST rung of the runtime-status ladder, in BOTH transcript paths, and its
// predicate is also in each path's gate — a rung without its gate is a card that never renders, and a
// gate without its rung is an empty slot at the transcript's end (the 2026-08-25 mismatch, one over).

test("both transcript paths compute the predicate off the final assistant message", () => {
  const sites = chat.match(/const registeredDone = showsRegisteredDoneCard\(thread, lastAgentIdx >= 0 \? \w+\[lastAgentIdx\]\?\.text : undefined\)/g) ?? []
  assert.equal(sites.length, 2, "one per transcript path (plain and virtualized)")
})

test("the card is the last rung of the ladder, after the resting card, in both paths", () => {
  // Followed by the RESIDUAL rung (RestedCard), which is the one that closes the chain — see below.
  const rungs = chat.match(/\) : registeredDone \? \(\n[\s\S]*?<FenceCard fenceKind="done" body=\{thread!\.lastFence!\.body\} hints=\{\[\]\} \/>\n\s*\) : restedCard \? \(/g) ?? []
  assert.equal(rungs.length, 2, "the rung must sit in the plain and the virtualized ladder, above the residual rung")
  for (const rung of rungs) {
    const idx = chat.indexOf(rung)
    const before = chat.slice(Math.max(0, idx - 900), idx)
    assert.match(before, /<AwaitingBackgroundCard thread=\{thread!\} \/>\s*$/, "the resting card must be the rung directly above it")
  }
})

test("both gates include it, so the slot opens exactly when the rung renders", () => {
  assert.match(chat, /showsRestingCard\(thread\) \|\| registeredDone \|\| restedCard\) && \(/, "the plain path's spacer gate")
  assert.match(chat, /\|\| showsRestingCard\(thread\)\n\s*\|\| registeredDone\n\s*\|\| restedCard,\n\s*\)/, "the virtualized path's hasRuntimeStatus")
})

test("the queue card draws the same card off the same predicate", () => {
  assert.match(queue, /showsRegisteredDoneCard\(thread, lastAgentIdx >= 0 \? messages\[lastAgentIdx\]\?\.text : undefined\) && \(/)
  assert.match(queue, /<FenceCard fenceKind="done" body=\{thread\.lastFence!\.body\} hints=\{\[\]\} wrap \/>/)
})

// THE RESIDUAL RUNG sits under the registered done in both ladders, on the same gate discipline: a rest
// that carries no other card still has to say so (RestedCard), and a gate without its rung is an empty
// slot at the transcript's end.
test("the rested card is the final rung after the registered done, in both paths, and in both gates", () => {
  const rungs = chat.match(/\) : restedCard \? \(\n[\s\S]*?<RestedCard thread=\{thread!\} \/>\n\s*\) : null\}/g) ?? []
  assert.equal(rungs.length, 2)
  for (const rung of rungs) {
    const before = chat.slice(Math.max(0, chat.indexOf(rung) - 400), chat.indexOf(rung))
    assert.match(before, /<FenceCard fenceKind="done" body=\{thread!\.lastFence!\.body\} hints=\{\[\]\} \/>\s*$/, "the registered done must be the rung directly above it")
  }
  assert.match(chat, /\|\| registeredDone \|\| restedCard\) && \(/, "the plain path's spacer gate")
  assert.match(chat, /\|\| registeredDone\n\s*\|\| restedCard,\n\s*\)/, "the virtualized path's hasRuntimeStatus")
  assert.match(queue, /showsRestedCard\(thread, lastAgentIdx >= 0 \? messages\[lastAgentIdx\]\?\.text : undefined\) && \(/)
})
