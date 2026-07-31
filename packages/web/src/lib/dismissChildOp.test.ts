import assert from "node:assert/strict"
import test from "node:test"
import { childOpDismisser } from "./dismissChildOp.ts"

// WHO GETS THE ×. The maintainer's ruling, twice over on 2026-07-30: first the × had to actually kill
// ("The fucking X button didn't actually kill the sub-agent"), then — when a background shell's × still
// cleared the row and admitted in a toast that the work was probably still going — it had to stop being
// offered at all where it cannot deliver: "We shouldn't show the X if it doesn't fucking work."
//
// So these pin the ABSENCE cases as hard as the presence ones. A missing × is the feature.

const has = (op: Parameters<typeof childOpDismisser>[1]) => childOpDismisser("t", op) !== undefined

test("a RUNNING row gets the × only when the server says it can actually be stopped", () => {
  assert.equal(has({ id: "toolu_a", state: "running", stoppable: true }), true, "broker-backed live child: a real kill")
  assert.equal(has({ id: "toolu_a", state: "running" }), false, "no stop channel ⇒ no control, not a control that lies")
  assert.equal(has({ id: "toolu_a", state: "running", stoppable: false }), false, "an explicit false is as binding as an absent flag")
})

test("a background SHELL never offers to stop live work — it carries no stoppable field at all", () => {
  // BgShellView has no `stoppable` (fray holds no handle on the process), so a running shell falls out
  // by CONSTRUCTION here rather than by a kind check that could drift out of sync with the server.
  assert.equal(has({ id: "toolu_sh", state: "running" }), false, "the exact row the maintainer clicked")
  assert.equal(has({ id: "toolu_sh", state: "stale" }), true, "…but a finished shell can still be cleared")
})

test("a SETTLED row keeps its ×: clearing a finished op is the escape hatch, and it works everywhere", () => {
  // Withholding it here would strand a phantom row — and its Done-warning count — forever, which is
  // the original bug the × exists for. No provider control is needed to retire tracking.
  for (const state of ["stale", "rested"]) {
    assert.equal(has({ id: "toolu_a", state }), true, `${state} rows clear without needing a stop channel`)
  }
})

test("no handle, no ×: an id-less row and a descendant are both unactionable", () => {
  assert.equal(has({ state: "stale" }), false, "nothing to address the call with")
  assert.equal(has({ id: "toolu_g", state: "running", stoppable: true, depth: 2 }), false, "a descendant's dispatch lives in an ANCESTOR's transcript, so the row would not clear")
  assert.equal(has({ id: "toolu_a", state: "running", stoppable: true, depth: 1 }), true, "depth 1 is this thread's own child")
})
