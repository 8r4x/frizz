/** HORIZONTAL rhythm for a strip of small marks — the sibling of `iconAlign.ts`, which does the same
 *  job vertically.
 *
 *  THE PROBLEM, stated once. `gap` spaces BOXES. The eye spaces INK. In a control strip those are not
 *  remotely the same measurement, because every mark wears a different amount of dead space inside its
 *  own box, from two independent sources:
 *
 *    1. the control's padding — a 24px hover square around a 12px glyph carries 6px a side;
 *    2. the GLYPH's own inset inside its svg — lucide's `Plug` paints only 8 of its 13 box px, while
 *       `RefreshCw` paints 10 of 12 and a bordered pill paints all of its box.
 *
 *  So a strip on one uniform `gap-1.5` drew SIX DIFFERENT distances. Measured on the shipped footer
 *  (`scripts/ink-gaps.mjs`, 2026-08-05, every CSS gap 6px):
 *
 *      context meter → hourglass    10.34px ink
 *      hourglass → heartbeat        12.50px
 *      plug → restart               20.50px   ← widest
 *      restart → Snooze pill        13.00px
 *      Snooze pill → Mark as done    5.78px   ← narrowest
 *
 *  A 3.5× spread, and the maintainer read it exactly off the pixels: "the perceived distance between
 *  the plug-in icon and the restart icon is much larger than the perceived distance between the
 *  restart icon and the left side of the snooze button, both of which are much larger than the space
 *  between the context icon and the heart… I'm sure the spacing is consistent in terms of the CSS, but
 *  what matters here is the visual spacing."
 *
 *  THE FIX. Collapse each mark's layout box onto its own ink with a negative margin equal to its
 *  MEASURED dead space, then let one `gap` mean what it says. After that the container's gap IS the
 *  ink gap, for pills and bare glyphs alike, and adding a mark to the strip is a one-line change
 *  rather than a re-tune.
 *
 *  Every constant below is a measurement, not a taste. Re-measure — never re-guess — if a glyph, an
 *  icon size, or a control's padding changes:
 *
 *      node scripts/ink-gaps.mjs http://localhost:5461/icon-rhythm-fixture.html \
 *        '[data-context-meter],[data-pending-snooze],[data-recurring-prompt],[data-reload-plugins],…'
 *
 *  and read `deadLeft`/`deadRight` off each mark. `packages/web/icon-rhythm-fixture.html` renders the
 *  real footer and the real composer rail side by side for exactly this.
 *
 *  THE ORDER ABOVE IS HISTORY, not the shipping strip, and TWO OF ITS MARKS HAVE LEFT. On 2026-08-11
 *  Reload plugins and Restart worker moved out of the right cluster into the LEFT one, behind the
 *  context meter (which stays far left, maintainer same day); on 2026-08-26 they left the footer
 *  altogether for the header's action strip ("the restart worker button should be at the top. I just
 *  realized it shouldn't be along the bottom"), and `INK_TRIM_PLUG` / `INK_TRIM_REFRESH` went with
 *  them — deleted rather than kept, because that strip is uniform 28px squares on a flat `gap-0.5`
 *  where every mark carries the same box and a trim would pull one verb out of the rhythm.
 *  The footer now reads meter · hourglass · goal … snooze · done. Both re-orders cost nothing to place,
 *  which is the property the trims buy — every mark's box is collapsed onto its own ink, so the
 *  container's one gap governs whatever sits beside whatever. Measured after the 2026-08-11 move:
 *  11.84 / 12.50 / 12.00 / 12.00 across the left cluster and 12.00 from the snooze split button to Mark
 *  as done, against the 12px target.
 *
 *  One consequence worth knowing before you change which mark comes FIRST. The footer's `px-3` clears
 *  the leading mark's BOX, so what the eye reads as the left inset is that padding minus the mark's own
 *  dead space — and the trims are what make the two agree. The meter, which leads it today, needs no
 *  trim (its ring reaches its own svg edge) and its ink lands 12.25px in; the plug, when it led the
 *  strip instead, put its box 4px from the edge and its ink at 12.5px. Either is within half a pixel of
 *  the 12px the right-hand pill keeps on the other side. An UNTRIMMED narrow glyph led there would sit a
 *  full dead-space width in. */

/** The strip's one optical distance: 12px of clear space between any two marks, whatever they are.
 *
 *  Chosen, not inherited. It is where the left cluster already sat (10.3 / 12.5px) — the one part of
 *  the strip the maintainer did NOT call wrong — and it is the tightest value the right cluster can
 *  hold without the two 24px icon hover-squares overlapping by more than a hair. Below ~11px the two
 *  bare glyphs start to read as one mark; above ~14px the two pills come apart. */
export const STRIP_INK_GAP = "gap-3"

/** `PendingSnooze` — lucide `Hourglass` at 12px (ink 8px, so 2px inset a side) inside `px-0.5`.
 *
 *  There is deliberately no constant for `ContextMeter`: its `em`-sized ring reaches its own svg edge
 *  (0.3px a side), which is under the floor where a correction smears the mark rather than moving it.
 *  It is measured, not missed. */
export const INK_TRIM_HOURGLASS = "-mx-1"

/** `RecurringPromptControl` (the Goal control) — Tabler's `target-arrow` at 12px inside `px-0.5`.
 *
 *  THE SWAP THE PREVIOUS NOTE PREDICTED. It said a mark swap forces a re-measure only when the new
 *  glyph's ink sits differently inside the viewBox, "because the next swap will be to something that
 *  does" — and on 2026-08-13 it was. lucide's `Target` painted a full-bleed circle out to the 24-unit
 *  bound (0.5px of inset a side inside the 12px box, hence the old -2.5px). Tabler's arcs stop at r=9
 *  and its dart stops at 21, so the ink starts a full unit further in: 3.0px of dead space on the left
 *  and 2.88px on the right, measured, once `px-0.5` is counted.
 *
 *  SYMMETRIC at 3px, because the glyph is: those two readings differ by 0.12px, which is far under the
 *  floor where a correction smears a mark instead of moving it. The strip then read 12.00px and 11.87px
 *  to the hourglass on its left and the armed-watchers eye on its right, against its 12px target.
 *
 *  THAT EYE IS GONE (2026-08-14 — it duplicated the rows under the prompt box; see
 *  ThreadLifecycleFooter), so the Goal is now the LAST mark in the cluster and only its left-hand gap is
 *  still drawn. The 3px stands unchanged: it is a property of this glyph's own dead space, measured on
 *  the mark rather than fitted to a neighbour, which is exactly why losing the neighbour costs nothing.
 *
 *  RE-MEASURE, DON'T RE-GUESS, if the mark changes again: `nub scripts/ink-gaps.mjs
 *  http://localhost:<vite>/icon-rhythm-fixture.html "[data-pending-snooze],[data-recurring-prompt]"`. */
export const INK_TRIM_GOAL = "-mx-[3px]"

/** THE COMPOSER RAIL is the same rule solved for absolute offsets instead of a flex gap, so it cannot
 *  use `STRIP_INK_GAP`. Its three buttons are 28px squares pinned from the box's right edge, and the
 *  send button is a FILLED square — its ink IS its box, while the paperclip paints 13px of its 28 and
 *  the GitHub mark 12.75. On the old even 36px pitch that drew 22.25px of ink between the paperclip
 *  and the GitHub mark against 15.75px between the GitHub mark and send ("the attachment icon and the
 *  GitHub icon feel further apart than the GitHub icon and the up arrow" — same maintainer, same day).
 *
 *  Offsets are therefore derived from ink, right to left, at a 14.75px gap — the distance the rail
 *  already kept beside the send button, so the one mark the eye is anchored on does not move. All
 *  measured from the box's right edge:
 *
 *      send             right-2        box [8, 36]    ink [8, 36]      → 14.75px to the rail action
 *      rail action      right-[43px]   box [43, 71]   ink [50.75, 63.5] → 14.25px to the paperclip
 *      paperclip        right-[71px]   box [71, 99]   ink [77.75, 90.75]
 *      paperclip alone  right-[44px]   box [44, 72]   ink [50.75, 63.75] → 14.75px to send
 *
 *  THE PAPERCLIP NEEDS ITS OWN OFFSET FOR THE SAME SLOT, which is the whole doctrine in one detail: it
 *  takes the rail-action position when no rail action is rendered, and it paints 1px less dead space on
 *  that side than the GitHub mark does, so parking it at the GitHub mark's offset drew 13.75px instead
 *  of 14.75. Same slot, same box, different glyph, different number — there is no shared "one 28px
 *  button every 36px" pitch that can be right for both. */
export const RAIL_SEND_OFFSET = "right-2"
export const RAIL_ACTION_OFFSET = "right-[43px]"
export const RAIL_PAPERCLIP_OFFSET = "right-[71px]"
export const RAIL_PAPERCLIP_PLAIN_OFFSET = "right-[44px]"

/** What the prose, chip and footer rows must reserve so text keeps its 8px clearance off the leftmost
 *  rail button: the paperclip's box edge (99px with a rail action, 72px without) plus 8. */
export const RAIL_RESERVE_WITH_ACTION = "pr-[6.6875rem]"
export const RAIL_RESERVE_PLAIN = "pr-20"
