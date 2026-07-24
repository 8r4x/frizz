import assert from "node:assert/strict"
import test from "node:test"
import { activeSidebarSection, queueNavigationSettled, railRevealDelta } from "./sidebarScrollspy.ts"

// An 800px viewport throughout: half of it — the coverage a newcomer must reach — is 400.
const VIEWPORT = 800

test("scrollspy keeps the rail on a tall card while it still fills most of the screen", () => {
  assert.equal(activeSidebarSection([
    { id: "tall", top: -1200, bottom: 500 },
    { id: "next", top: 580, bottom: 1400 },
  ], VIEWPORT), "tall")
})

test("scrollspy hands the rail over once the next card owns more than half the viewport", () => {
  assert.equal(activeSidebarSection([
    // The tall card is still 200px on screen — the old reading-line rule held the rail here until it
    // had scrolled off entirely.
    { id: "tall", top: -1500, bottom: 200 },
    { id: "next", top: 280, bottom: 1100 },
  ], VIEWPORT), "next")
})

test("scrollspy leaves the rail alone while the newcomer is still the smaller half", () => {
  assert.equal(activeSidebarSection([
    { id: "tall", top: -1300, bottom: 430 },
    { id: "next", top: 510, bottom: 1300 },
  ], VIEWPORT), "tall")
})

test("scrollspy marks the topmost wholly visible card, not whichever card covers the most", () => {
  assert.equal(activeSidebarSection([
    { id: "short", top: 12, bottom: 300 },
    { id: "big", top: 380, bottom: 1100 },
  ], VIEWPORT), "short")
})

test("scrollspy advances as soon as the top card starts leaving the screen", () => {
  assert.equal(activeSidebarSection([
    { id: "leaving", top: -40, bottom: 248 },
    { id: "whole", top: 328, bottom: 700 },
  ], VIEWPORT), "whole")
})

test("scrollspy does not let a small card lower down steal from a bigger partly scrolled one", () => {
  assert.equal(activeSidebarSection([
    { id: "mostly-shown", top: -100, bottom: 380 },
    { id: "small", top: 460, bottom: 580 },
  ], VIEWPORT), "mostly-shown")
})

test("scrollspy stays deterministic across a keyframe reorder and ignores fully past cards", () => {
  assert.equal(activeSidebarSection([
    { id: "old", top: -320, bottom: -4 },
    { id: "reordered", top: 40, bottom: 700 },
    { id: "later", top: 780, bottom: 1400 },
  ], VIEWPORT), "reordered")
})

test("scrollspy returns no marker when no queue card is on screen", () => {
  assert.equal(activeSidebarSection([], VIEWPORT), null)
  assert.equal(activeSidebarSection([{ id: "past", top: -400, bottom: 0 }], VIEWPORT), null)
  assert.equal(activeSidebarSection([{ id: "below", top: 900, bottom: 1400 }], VIEWPORT), null)
})

test("scrollspy gives a short final visible card the rail at the true document bottom", () => {
  assert.equal(activeSidebarSection([
    { id: "long", top: -740, bottom: 560 },
    { id: "final", top: 640, bottom: 764 },
  ], VIEWPORT, true), "final")
})

test("scrollspy does not promote the final card away from the document bottom", () => {
  assert.equal(activeSidebarSection([
    { id: "current", top: -80, bottom: 560 },
    { id: "final", top: 640, bottom: 764 },
  ], VIEWPORT, false), "current")
})

test("a click-to-card pin holds the rail until its card reaches the landing", () => {
  // Still travelling: the card is below the landing and the reader hasn't moved since the click.
  assert.equal(queueNavigationSettled({ id: "target", top: 240, bottom: 700 }, 1049, 1049, 12), false)
  // Arrived.
  assert.equal(queueNavigationSettled({ id: "target", top: 12, bottom: 480 }, 1049, 1049, 12), true)
  // Unmounted mid-flight.
  assert.equal(queueNavigationSettled(undefined, 1049, 1049, 12), true)
})

test("a click-to-card pin lets go once the reader scrolls away from the landing", () => {
  // A last card at the document's scroll end never reaches the landing; the reader scrolling back up
  // is what must release it, or the rail stays frozen on a card that is no longer on screen at all.
  assert.equal(queueNavigationSettled({ id: "last", top: 515, bottom: 848 }, 700, 1049, 12), true)
  // A sub-pixel settle after the landing is not the reader scrolling.
  assert.equal(queueNavigationSettled({ id: "last", top: 515, bottom: 848 }, 1048.5, 1049, 12), false)
})

test("rail reveal scrolls only enough to expose an active item and leaves visible rows alone", () => {
  assert.equal(railRevealDelta(100, 500, 90, 126), -18)
  assert.equal(railRevealDelta(100, 500, 470, 520), 28)
  assert.equal(railRevealDelta(100, 500, 160, 220), 0)
})
