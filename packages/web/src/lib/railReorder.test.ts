import assert from "node:assert/strict"
import { test } from "node:test"
import { dropIndex, edgeScrollVelocity, moveItem, RAIL_STEP_PX, shiftFor } from "./railReorder.ts"

test("moveItem moves in both directions, and `to` is read against the post-removal list", () => {
  const list = ["a", "b", "c", "d"]
  assert.deepEqual(moveItem(list, 0, 2), ["b", "c", "a", "d"])
  assert.deepEqual(moveItem(list, 3, 1), ["a", "d", "b", "c"])
  assert.deepEqual(moveItem(list, 0, 3), ["b", "c", "d", "a"])
  // Non-moves and out-of-range are the identity, never a throw: a drop can land where it started.
  assert.deepEqual(moveItem(list, 1, 1), list)
  assert.deepEqual(moveItem(list, -1, 2), list)
  assert.deepEqual(moveItem(list, 0, 9), list)
  assert.deepEqual(list, ["a", "b", "c", "d"], "the input is not mutated")
})

test("the drop swaps at the HALFWAY point, not when a square fully clears its neighbour", () => {
  // Just under half a step is still the original slot; just over it has taken the next one.
  assert.equal(dropIndex(2, RAIL_STEP_PX * 0.49, 6), 2)
  assert.equal(dropIndex(2, RAIL_STEP_PX * 0.51, 6), 3)
  assert.equal(dropIndex(2, -RAIL_STEP_PX * 0.51, 6), 1)
  assert.equal(dropIndex(2, RAIL_STEP_PX * 2, 6), 4)
})

test("a drag past either end lands at the end rather than off the list", () => {
  assert.equal(dropIndex(1, -RAIL_STEP_PX * 40, 6), 0)
  assert.equal(dropIndex(1, RAIL_STEP_PX * 40, 6), 5)
})

test("only the squares between the two slots move, and they move exactly one step", () => {
  // Dragging index 1 down to 3: 2 and 3 slide UP into the gap, 0 and 4 do not move at all.
  assert.equal(shiftFor(0, 1, 3), 0)
  assert.equal(shiftFor(1, 1, 3), 0, "the held square is positioned by its own delta, not shifted")
  assert.equal(shiftFor(2, 1, 3), -RAIL_STEP_PX)
  assert.equal(shiftFor(3, 1, 3), -RAIL_STEP_PX)
  assert.equal(shiftFor(4, 1, 3), 0)

  // Dragging 3 up to 1: 1 and 2 slide DOWN.
  assert.equal(shiftFor(0, 3, 1), 0)
  assert.equal(shiftFor(1, 3, 1), RAIL_STEP_PX)
  assert.equal(shiftFor(2, 3, 1), RAIL_STEP_PX)
  assert.equal(shiftFor(3, 3, 1), 0)

  // A drag that has not changed slots moves nothing.
  for (const i of [0, 1, 2, 3]) assert.equal(shiftFor(i, 2, 2), 0)
})

test("edge auto-scroll engages only inside the zone, ramps with depth, and is signed", () => {
  const bounds = { top: 100, bottom: 500 }
  assert.equal(edgeScrollVelocity(300, bounds), 0, "the middle of the band does not scroll")
  assert.equal(edgeScrollVelocity(150, bounds), 0, "just outside the zone does not scroll")
  assert.ok(edgeScrollVelocity(110, bounds) < 0, "near the top scrolls up")
  assert.ok(edgeScrollVelocity(490, bounds) > 0, "near the bottom scrolls down")
  // Deeper into the zone is faster, and it is capped.
  assert.ok(Math.abs(edgeScrollVelocity(102, bounds)) > Math.abs(edgeScrollVelocity(130, bounds)))
  assert.ok(Math.abs(edgeScrollVelocity(-500, bounds)) <= 14)
})
