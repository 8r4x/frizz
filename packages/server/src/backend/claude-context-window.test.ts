import test from "node:test"
import assert from "node:assert/strict"
import { resolveClaudeLaunchModel } from "./claude-context-window.ts"

// The picker stores BARE aliases; the 1M window is added at the spawn edge. Both halves of the pair
// matter: the suffix is what requests the window, and the fallback is what keeps a subscription
// without the long-context beta from dying on a hard 400 at launch.
test("a 1M-capable alias launches with the suffix AND the bare alias as its fallback", () => {
  assert.deepEqual(resolveClaudeLaunchModel("opus"), { model: "opus[1m]", fallbackModel: "opus" })
  assert.deepEqual(resolveClaudeLaunchModel("fable"), { model: "fable[1m]", fallbackModel: "fable" })
  assert.deepEqual(resolveClaudeLaunchModel("sonnet"), { model: "sonnet[1m]", fallbackModel: "sonnet" })
})

// There is no Haiku 1M — asking for one is the measured hard 400, so it must never be requested.
test("haiku is passed through untouched, with no fallback to arrange", () => {
  assert.deepEqual(resolveClaudeLaunchModel("haiku"), { model: "haiku" })
})

// A wrong suffix is a DEAD session rather than a degraded one, so anything not on the exact-alias
// list is passed through rather than guessed at.
test("a full id, an unknown alias and an absent model are never given a suffix", () => {
  assert.deepEqual(resolveClaudeLaunchModel("claude-opus-5"), { model: "claude-opus-5" })
  assert.deepEqual(resolveClaudeLaunchModel("gpt-5.5"), { model: "gpt-5.5" })
  assert.equal(resolveClaudeLaunchModel(undefined), undefined)
  assert.equal(resolveClaudeLaunchModel(""), undefined)
})

// An explicit `[1m]` (hand-typed, or stored by some other build) is honoured — but it never travels
// without the safety net either, which is exactly the case the E2E harness uses as its control.
test("an explicit [1m] request keeps its window but still gains a fallback", () => {
  assert.deepEqual(resolveClaudeLaunchModel("opus[1m]"), { model: "opus[1m]", fallbackModel: "opus" })
  assert.deepEqual(resolveClaudeLaunchModel("haiku[1m]"), { model: "haiku[1m]", fallbackModel: "haiku" })
})
