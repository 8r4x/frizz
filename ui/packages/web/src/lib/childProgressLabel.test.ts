import assert from "node:assert/strict"
import test from "node:test"
import { childProgressLabel } from "./childOps.ts"

// The "how far has it got" counter beside a live child's current step. Every field it reads is
// OPTIONAL — absent for a tmux thread, a codex child, or an older CLI — so the interesting cases are
// all the ways it must produce NOTHING rather than a half-formed reading.

test("both counters read as one compact group", () => {
  assert.equal(childProgressLabel(12, 13476), "12 tools · 13.5k tok")
})

test("each half stands alone when the other is missing", () => {
  assert.equal(childProgressLabel(12, undefined), "12 tools")
  assert.equal(childProgressLabel(undefined, 13476), "13.5k tok")
})

test("one tool is singular — a count is not a plural by default", () => {
  assert.equal(childProgressLabel(1, undefined), "1 tool")
})

test("nothing to report ⇒ no reading, so the row leaves no gap", () => {
  assert.equal(childProgressLabel(undefined, undefined), undefined)
  assert.equal(childProgressLabel(0, 0), undefined, "a child that has done nothing yet reads as nothing")
  assert.equal(childProgressLabel(Number.NaN, Number.NaN), undefined)
})

test("token magnitude is the reading — a raw six-digit count beside a truncated label is noise", () => {
  assert.equal(childProgressLabel(undefined, 947), "947 tok")
  assert.equal(childProgressLabel(undefined, 1_000), "1k tok", "a round thousand drops its .0")
  assert.equal(childProgressLabel(undefined, 9_940), "9.9k tok")
  assert.equal(childProgressLabel(undefined, 132_000), "132k tok", "past three significant figures the decimal stops earning its width")
  assert.equal(childProgressLabel(undefined, 2_400_000), "2.4M tok")
})
