// Tool activity and transcript thoughts are peer progress rows. Keep their regular type scale,
// light-grey tone, and line box shared so alternating `N tool calls` / `Thought for Ns` rows have
// one rhythm without making thought metadata look like a separate petite-caps label system.
//
// 14px is the ASSISTANT PROSE size (`.md-body` in styles.css), and these rows deliberately match it
// (maintainer 2026-07-31, on a shot of `Ran 2 tool calls` above a reply: "is this the same font size?
// shoudl be"). They sat at 13px, which read as a second, smaller type scale interleaved with the
// prose rather than as the same column speaking quietly — the tone, not the size, is what makes these
// rows recede. Any glyph sized against this line must be `1em` so it follows.
export const TRANSCRIPT_META_LABEL_CLASS = "text-[14px] leading-5 text-muted"

// The DISCLOSURE CHEVRON of that same column — one measured treatment for the tool digest, the codex
// reasoning toggle and the live shimmer alike. Each used to place its own by hand and the three drifted:
// two different vertical offsets, two different tones, and a horizontal rhythm nobody had measured at
// all (maintainer 2026-08-05: "fix the fucking optical spacing on that chevron").
//
// Both corrections are in `em`, so they track the `1em` glyph rather than pinning to today's 14px. They
// are EXACT at the size that ships (residual −0.01px at 14px, in every row and both chevron states) and
// hold to about a pixel elsewhere: forced to 28px the vertical residual reads +0.98px, because the
// browser rounds a font's used ascent per size — the baseline lands 27px into the doubled line box where
// 26px would be proportional. Nothing renders this column at any other size, so that is recorded rather
// than chased (see `visual-review`: correct for the size that ships, and say so).
//
//  · VERTICAL — `items-center` centres the glyph's BOX on the flex line; the eye reads INK. Measured
//    2026-08-05 at 14px/leading-5: lucide's chevron paints 4.67 × 8.33 of its 14px box, and its ink
//    centre lands 1.45px BELOW the label's cap band (baseline → cap height — the string-independent
//    reference, because a descender moves the string's own ink box by >1px; see the `visual-review`
//    skill). The digest's hand-set `top-[calc(0.032em+1px)]` pushed it a further 1.45px DOWN, for a
//    2.90px error. `-0.104em` lifts the ink to a ~0px residual.
//  · HORIZONTAL — `gap` spaces BOXES, and this glyph wears 4.67px of dead space on EACH side, a third
//    of its box per side. So on `gap-1` beside its label and `gap-2` before the shimmer's clock, the
//    row drew 9.06px and 13.00px of INK where the CSS claimed 4 and 8 — the chevron floated almost
//    equidistant between the two and read as a third, unrelated mark instead of the label's handle.
//    A negative margin sized to that measured dead space collapses the box onto the ink; after it, a
//    container's `gap` IS the optical distance.
//
// The trim is STATE-DEPENDENT because rotating the glyph rotates its ink box: 4.67px wide pointing
// right, 8.33px wide pointing down, so an open chevron wears only 2.83px of dead space a side. One
// constant for both would over-collapse the open state by 1.8px, which is well above the instrument's
// ±0.75px noise floor. The ink CENTRE is invariant under the rotation (lucide's `m9 18 6-6-6-6` is
// symmetric about the 24-unit box centre), so the vertical correction is shared.
const TRANSCRIPT_META_CHEVRON_BASE =
  "size-[1em] shrink-0 -translate-y-[0.104em] text-muted/70 transition-transform group-hover:text-fg"

export function transcriptMetaChevronClass(open: boolean): string {
  return `${TRANSCRIPT_META_CHEVRON_BASE} ${open ? "-mx-[0.202em] rotate-90" : "-mx-[0.333em]"}`
}
