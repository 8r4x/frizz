import { test } from "node:test"
import assert from "node:assert/strict"
import { applyRowSelection } from "./rowRangeSelection.ts"

const KEYS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]

function select(
  keys: readonly number[],
  clicks: { key: number; shift?: boolean }[],
): { selected: number[]; anchor: number | null } {
  let selected: ReadonlySet<number> = new Set()
  let anchor: number | null = null
  for (const click of clicks) {
    const result = applyRowSelection({ keys, key: click.key, shiftKey: click.shift ?? false, anchor, selected })
    selected = result.selected
    anchor = result.anchor
  }
  return { selected: [...selected], anchor }
}

test("a plain click toggles one row and moves the anchor", () => {
  assert.deepEqual(select(KEYS, [{ key: 8 }]), { selected: [8], anchor: 8 })
  assert.deepEqual(select(KEYS, [{ key: 8 }, { key: 5 }]), { selected: [8, 5], anchor: 5 })
  assert.deepEqual(select(KEYS, [{ key: 8 }, { key: 8 }]), { selected: [], anchor: 8 })
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
  assert.deepEqual(select(KEYS, [{ key: 6, shift: true }]), { selected: [6], anchor: 6 })
})

test("an anchor that left the list (a refetch dropped it) degrades to a plain toggle", () => {
  const result = applyRowSelection({
    keys: KEYS,
    key: 5,
    shiftKey: true,
    anchor: 99,
    selected: new Set([99]),
  })
  assert.deepEqual([...result.selected].sort((a, b) => b - a), [99, 5])
  assert.equal(result.anchor, 5)
})

test("a whole page selects in one range — nothing caps the selection", () => {
  const all = select(KEYS, [{ key: 10 }, { key: 1, shift: true }])
  assert.deepEqual(all.selected, KEYS)
})

test("selections made on an earlier page survive — the reducer only ever adds to what it is given", () => {
  // The picker keeps ONE selection set across pages; `keys` is just the visible page. Rows checked
  // elsewhere (600, 601) must ride through a click and a range on this page untouched.
  const carried = new Set([600, 601])
  const first = applyRowSelection({ keys: KEYS, key: 9, shiftKey: false, anchor: null, selected: carried })
  const ranged = applyRowSelection({ keys: KEYS, key: 6, shiftKey: true, anchor: first.anchor, selected: first.selected })
  assert.deepEqual([...ranged.selected].sort((a, b) => a - b), [6, 7, 8, 9, 600, 601])
})

test("the input set is never mutated", () => {
  const before = new Set([10])
  applyRowSelection({ keys: KEYS, key: 7, shiftKey: true, anchor: 10, selected: before })
  assert.deepEqual([...before], [10])
})
