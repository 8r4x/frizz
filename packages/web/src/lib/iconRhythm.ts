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
 *  real footer and the real composer rail side by side for exactly this. */

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

/** `RecurringPromptControl` — lucide `HeartPulse` at 12px (ink 11px) inside `px-0.5`. */
export const INK_TRIM_HEARTBEAT = "-mx-[2.5px]"

/** `ReloadPluginsButton` — lucide `Plug` at 13px in a 24px square, painting 8px of it.
 *
 *  SYMMETRIC, and that is a correction of the first attempt here. The instrument read this glyph's
 *  dead space as 8.5/7.5 and an asymmetric trim was cut to match — which then measured 13px of gap
 *  instead of 12, and re-reading the trimmed strip returned 7.5/8.5, the same asymmetry mirrored.
 *  A real 0.5px lean in a viewBox cannot swap sides when the element moves; a rasterisation phase can,
 *  and this glyph's stroke is faint enough at the extreme edge that a column falls in or out of the
 *  instrument's threshold depending on where the box lands on the device grid. So the 0.5px was the
 *  instrument, not the glyph, and 8/8 is the honest reading: it lands the gap at 11.5–12.0px, inside
 *  half a pixel of the target and well under anything an eye resolves. Rule of thumb this earned: on a
 *  thin stroke, distrust any asymmetry the size of one device pixel until it survives a move. */
export const INK_TRIM_PLUG = "-mx-2"

/** `RestartWorkerButton` — lucide `RefreshCw` at 12px (ink 10px) in a 24px square. */
export const INK_TRIM_REFRESH = "-mx-[7px]"

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
