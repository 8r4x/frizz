import assert from "node:assert/strict"
import test from "node:test"
import { lastRest, type RestAnchorMessage } from "./restAnchor.ts"

const user = (at?: string): RestAnchorMessage => ({ role: "user", at })
const agent = (at?: string): RestAnchorMessage => ({ role: "assistant", at })
const rest = (at?: string): RestAnchorMessage => ({ role: "assistant", kind: "event", boundary: "rest", at })
const wake = (): RestAnchorMessage => ({ role: "assistant", kind: "event", boundary: "wake" })
const reasoning = (): RestAnchorMessage => ({ role: "assistant", kind: "reasoning" })

// THE BUMP: the worker rested on message 1, the human replied, the reply is streaming as message 4. The
// anchor is still message 1 — the last assistant MESSAGE is 4, and keying on that is what made the fence
// card vanish the moment the reply started.
test("the anchor is the message before the last rest, not the last assistant message", () => {
  const messages = [user(), agent("2026-08-28T10:00:00.000Z"), rest("2026-08-28T10:00:01.000Z"), user("2026-08-28T10:05:00.000Z"), agent("2026-08-28T10:05:02.000Z")]
  assert.deepEqual(lastRest(messages), { index: 1, at: "2026-08-28T10:00:01.000Z" })
})

// The worker rested again: the anchor moves to the new rest, and the earlier one is history.
test("a later rest moves the anchor", () => {
  const messages = [user(), agent(), rest("t1"), user(), agent(), rest("t2")]
  assert.deepEqual(lastRest(messages), { index: 4, at: "t2" })
})

// A rest is closed by an UTTERANCE. The event lines that can sit between the prose and the rest — a
// child returning, a wake — and a reasoning summary are not the message the worker stopped on.
test("event and reasoning rows between the prose and the rest are skipped", () => {
  const messages = [user(), agent(), reasoning(), wake(), rest("t")]
  assert.deepEqual(lastRest(messages), { index: 1, at: "t" })
})

// No rest in the window at all — the human steered a turn still in flight, or the window is loaded
// above every rest. The caller falls back to the last assistant message, as before.
test("a window with no rest has no anchor", () => {
  assert.equal(lastRest([user(), agent(), user(), agent()]), undefined)
  assert.equal(lastRest([]), undefined)
})

// The rest event is the first thing loaded: the message it closed is above the window, and -1 says so
// rather than pointing at whatever assistant message happens to come next.
test("a rest at the top of the window anchors above it", () => {
  assert.deepEqual(lastRest([rest("t"), user(), agent()]), { index: -1, at: "t" })
})
