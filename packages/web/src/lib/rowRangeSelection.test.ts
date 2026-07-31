import { test } from "node:test"
import assert from "node:assert/strict"
import { applyRowSelection } from "./rowRangeSelection.ts"

const KEYS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
const MAX = 20

function select(
  keys: readonly number[],
  clicks: { key: number; shift?: boolean }[],
  max = MAX,
): { selected: number[]; anchor: number | null; capped: boolean } {
  let selected: ReadonlySet<number> = new Set()
  let anchor: number | null = null
  let capped = false
  for (const click of clicks) {
    const result = applyRowSelection({ keys, key: click.key, shiftKey: click.shift ?? false, anchor, selected, max })
    selected = result.selected
    anchor = result.anchor
    capped = result.capped
  }
  return { selected: [...selected], anchor, capped }
}

test("a plain click toggles one row and moves the anchor", () => {
  assert.deepEqual(select(KEYS, [{ key: 8 }]), { selected: [8], anchor: 8, capped: false })
  assert.deepEqual(select(KEYS, [{ key: 8 }, { key: 5 }]), { selected: [8, 5], anchor: 5, capped: false })
  assert.deepEqual(select(KEYS, [{ key: 8 }, { key: 8 }]), { selected: [], anchor: 8, capped: false })
})

test("shift-click selects every row between the anchor and the clicked row, inclusive", () => {
  const down = select(KEYS, [{ key: 9 }, { key: 6, shift: true }])
  assert.deepEqual(down.selected, [9, 8, 7, 6])
  // The anchor STAYS on the first click so a second shift-click re-spans from the same origin.
  assert.equal(down.anchor, 9)
  const widened = select(KEYS, [{ key: 9 }, { key: 6, shift: true }, { key: 4, shift: true }])
  assert.deepEqual(widened.selected, [9, 8, 7, 6, 5, 4])
})

test("shift-click works upward — the range is direction-agnostic", () => {
  assert.deepEqual(select(KEYS, [{ key: 4 }, { key: 7, shift: true }]).selected, [4, 5, 6, 7])
})

test("shift-clicking after an UNCHECK clears the range instead of selecting it", () => {
  // Check 9→4, then uncheck 7 (plain, re-anchors there) and shift-click 5 to clear 7,6,5.
  const cleared = select(KEYS, [
    { key: 9 },
    { key: 4, shift: true },
    { key: 7 },
    { key: 5, shift: true },
  ])
  assert.deepEqual(cleared.selected, [9, 8, 4])
})

test("shift-click leaves rows outside the range alone", () => {
  const kept = select(KEYS, [{ key: 1 }, { key: 9 }, { key: 7, shift: true }])
  assert.deepEqual(kept.selected.sort((a, b) => a - b), [1, 7, 8, 9])
})

test("shift-click on the anchor row itself is a no-op, not an untoggle", () => {
  assert.deepEqual(select(KEYS, [{ key: 8 }, { key: 8, shift: true }]).selected, [8])
})

test("shift-click with no anchor yet degrades to a plain toggle", () => {
  assert.deepEqual(select(KEYS, [{ key: 6, shift: true }]), { selected: [6], anchor: 6, capped: false })
})

test("an anchor that left the list (a refetch dropped it) degrades to a plain toggle", () => {
  const result = applyRowSelection({
    keys: KEYS,
    key: 5,
    shiftKey: true,
    anchor: 99,
    selected: new Set([99]),
    max: MAX,
  })
  assert.deepEqual([...result.selected].sort((a, b) => b - a), [99, 5])
  assert.equal(result.anchor, 5)
})

test("the cap truncates a range at the far end, keeping a contiguous block from the anchor", () => {
  const capped = select(KEYS, [{ key: 10 }, { key: 1, shift: true }], 4)
  assert.deepEqual(capped.selected, [10, 9, 8, 7])
  assert.equal(capped.capped, true)
  // Upward from the anchor, the block still grows out from where the human started.
  const upward = select(KEYS, [{ key: 1 }, { key: 10, shift: true }], 4)
  assert.deepEqual(upward.selected, [1, 2, 3, 4])
  assert.equal(upward.capped, true)
})

test("a plain click that would exceed the cap reports capped and changes nothing", () => {
  const full = new Set([10, 9])
  const result = applyRowSelection({ keys: KEYS, key: 8, shiftKey: false, anchor: 9, selected: full, max: 2 })
  assert.deepEqual([...result.selected], [10, 9])
  assert.equal(result.capped, true)
  // …but an UNcheck at the cap still works.
  const uncheck = applyRowSelection({ keys: KEYS, key: 9, shiftKey: false, anchor: 9, selected: full, max: 2 })
  assert.deepEqual([...uncheck.selected], [10])
  assert.equal(uncheck.capped, false)
})

test("a capped range does not report capped when every row already fit", () => {
  const exact = select(KEYS, [{ key: 10 }, { key: 7, shift: true }], 4)
  assert.deepEqual(exact.selected, [10, 9, 8, 7])
  assert.equal(exact.capped, false)
})

test("the input set is never mutated", () => {
  const before = new Set([10])
  applyRowSelection({ keys: KEYS, key: 7, shiftKey: true, anchor: 10, selected: before, max: MAX })
  assert.deepEqual([...before], [10])
})
