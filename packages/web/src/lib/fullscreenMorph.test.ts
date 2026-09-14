import assert from "node:assert/strict"
import test from "node:test"
import { visibleMorphStart } from "./fullscreenMorph.ts"

// A 1440×900 window — the geometry every number below was measured in.
const VIEWPORT = { width: 1440, height: 900 }

test("a tall card scrolled to its middle morphs from the viewport-high slice the reader can see", () => {
  // The measured case: a 2869px card parked halfway, top 1020px above the window, bottom 949px below.
  const start = visibleMorphStart({ left: 629, top: -1020, width: 720, height: 2869 }, VIEWPORT)
  assert.deepEqual(start?.box, { left: 629, top: 0, width: 720, height: 900 })
  // The old snapshot is the whole card; sliding it up by the hidden part — as a fraction of the width
  // the snapshot is sized by — puts the reader's slice at the group's top edge.
  assert.equal(start?.oldShiftFraction, -1020 / 720)
})

test("a card whose top is on screen still starts from that edge — nothing visible is trimmed", () => {
  const start = visibleMorphStart({ left: 629, top: 121, width: 720, height: 2869 }, VIEWPORT)
  assert.deepEqual(start?.box, { left: 629, top: 121, width: 720, height: 900 - 121 })
  assert.equal(start?.oldShiftFraction, 0)
})

test("a card that fits on screen morphs from its whole box, exactly as the browser would", () => {
  const rect = { left: 629, top: 121, width: 720, height: 657 }
  const start = visibleMorphStart(rect, VIEWPORT)
  assert.deepEqual(start?.box, rect)
  assert.equal(start?.oldShiftFraction, 0)
})

test("the bottom of a card scrolled past the window's end is trimmed to the visible remainder", () => {
  const start = visibleMorphStart({ left: 629, top: -2200, width: 720, height: 2869 }, VIEWPORT)
  assert.deepEqual(start?.box, { left: 629, top: 0, width: 720, height: 669 })
  assert.equal(start?.oldShiftFraction, -2200 / 720)
})

test("a surface entirely off screen, or with no size, leaves the morph to the browser", () => {
  assert.equal(visibleMorphStart({ left: 629, top: 950, width: 720, height: 400 }, VIEWPORT), null)
  assert.equal(visibleMorphStart({ left: 629, top: -3000, width: 720, height: 2869 }, VIEWPORT), null)
  assert.equal(visibleMorphStart({ left: 629, top: 100, width: 0, height: 0 }, VIEWPORT), null)
})
