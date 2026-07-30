import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@fray-ui/shared"
import { ContextMeter } from "./ContextMeter.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The readout has two halves that are easy to break in opposite directions, so both are pinned here.
//
// ABSENCE must cost nothing. The server omits `context` entirely unless it has BOTH halves of the
// fraction, and the client's contract is that an absent reading renders zero bytes — no 0% dial, no empty
// ring, no "—". A regression here is invisible in review and immediately visible in the product, because
// every Claude thread is in exactly that state until its first turn ends.
//
// PRESENCE must be findable. The percentage lives ON the surface (the dial alone was unreadable at 12.6px
// and 60% muted), while the raw fraction stays in the tooltip. And "thinner" must not become "smaller":
// the stroke was thinned from 3 to 2 with r raised to compensate, so the OUTER edge is still 7.5 units.

function thread(context?: { tokens: number; window: number }): ThreadView {
  // Only the field this component reads; the cast keeps the fixture honest about that rather than
  // inventing a whole plausible thread the assertions would not touch.
  return { id: "ctx", kind: "session", context } as unknown as ThreadView
}

// Wrapped in the provider the real app mounts at the root of every surface — the readout's own hover
// label goes through Radix, which throws without it. The provider itself emits no markup, so an absent
// reading still has to come out as the empty string.
function render(context?: { tokens: number; window: number }): string {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ContextMeter, { thread: thread(context) })),
  )
}

test("an absent reading renders NOTHING — no dial, no placeholder, no box", () => {
  assert.equal(render(undefined), "")
})

test("a meaningless denominator renders nothing rather than a fabricated fraction", () => {
  for (const window of [0, -1]) {
    assert.equal(render({ tokens: 4_000, window }), "", `window ${window} must render nothing`)
  }
})

test("the percent is ON the surface and the raw fraction is NOT", () => {
  const html = render({ tokens: 237_000, window: 272_000 })
  assert.match(html, />87%</, "the floored percent must be rendered as visible text")
  assert.ok(!html.includes(">237,000"), "the token count must stay in the tooltip, not on the surface")
  // The tooltip/screen-reader label carries both halves — that is where the numbers went, not away.
  assert.match(html, /aria-label="Context 87% full\s+237,000 of 272,000 tokens"/)
})

test("the number is tabular so a live reading cannot jitter the dial beside it", () => {
  assert.match(render({ tokens: 22_400, window: 272_000 }), /class="tabular-nums">8%</)
})

test("the percent is FLOORED — it says 100% only when the context genuinely is full", () => {
  // 99.9% must not round up to a full dial.
  assert.match(render({ tokens: 271_999, window: 272_000 }), />99%</)
  assert.match(render({ tokens: 272_000, window: 272_000 }), />100%</)
})

test("a nearly-empty context still draws a hairline of arc, not a bare ring", () => {
  // The arc uses the UNFLOORED fraction, so a reading that floors to 0% is still visibly non-zero.
  const html = render({ tokens: 1_088, window: 272_000 })
  assert.match(html, />0%</, "the label floors")
  const dash = html.match(/stroke-dasharray="([\d.]+)/)
  assert.ok(dash && Number(dash[1]) > 0, "the arc length must be > 0 even at a floored 0%")
})

test("a reading that overshoots its window clamps instead of wrapping past 12 o'clock", () => {
  const html = render({ tokens: 400_000, window: 272_000 })
  assert.match(html, />100%</)
  const [, filled, circumference] = html.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/)!
  assert.equal(filled, circumference, "an overshoot fills exactly one revolution, never more")
})

test("the ring is the THINNER stroke, and thinning it did not shrink the glyph", () => {
  const html = render({ tokens: 136_000, window: 272_000 })
  const strokes = [...html.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]))
  assert.deepEqual(strokes, [2, 2], "track and arc share one stroke width, thinned from the original 3")
  const radii = [...html.matchAll(/r="([\d.]+)"/g)].map((m) => Number(m[1]))
  assert.deepEqual(radii, [6.5, 6.5], "r rose as the stroke thinned")
  // The invariant that keeps "thinner" from silently becoming "smaller": r + half the stroke is the ring's
  // outer edge, and it must stay at 7.5 of the 16-unit viewBox (0.5 of clearance, centered on 8).
  assert.equal(radii[0]! + strokes[0]! / 2, 7.5, "the outer edge must not move when the stroke changes")
})

test("the size stays INHERITED — an em-sized svg, never a px one", () => {
  const html = render({ tokens: 136_000, window: 272_000 })
  assert.match(html, /class="h-\[1\.05em\] w-\[1\.05em\][^"]*"/)
  // Anchored on the attribute boundary: an unanchored /(width|height)="\d+"/ matches INSIDE
  // `stroke-width="2"` and fails on a component that is perfectly correct.
  assert.ok(!/\s(width|height)="\d/.test(html), "no px dimensions on the svg")
})
