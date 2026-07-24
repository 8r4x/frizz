/** Optical nudge for a small lucide icon sitting beside a short, DESCENDER-FREE label — the card
 *  eyebrows ("DONE", "ARM WATCHER") and the compact Snooze buttons.
 *
 *  Why it is needed at all: `items-center` aligns the two BOXES, but neither box is its glyph. A
 *  descender-free label ("Snooze", or anything uppercase) inks only from cap-top to baseline, so its
 *  ink rides HIGH inside the font box, while a lucide icon's ink is centered in its own. Centering the
 *  boxes therefore leaves the icon sitting visibly LOW.
 *
 *  Measured in a real browser (svg.getBBox() for icon ink, canvas actualBoundingBoxAscent/Descent for
 *  label ink) — the icon read low by 1.44px (Check @10px), 1.69px (Hourglass @10px) and 1.58px
 *  (Hourglass @12px). One value covers all three to within 0.2px, and 1.5px lands on a whole device
 *  pixel at 2× DPR, so it stays crisp instead of antialiasing across two rows.
 *
 *  NOT a line-height problem — do not "fix" this by reaching for leading-none. The ink offset works out
 *  to `-fontBox/2 + fontAscent - inkAscent + inkHeight/2`; the line-height cancels, so changing it
 *  moves nothing. Only a nudge moves the ink.
 *
 *  Does NOT apply to labels WITH descenders (they ink below the baseline, which re-centers them), nor
 *  to icons whose glyph is deliberately off-center. Re-measure before reusing it somewhere new. */
export const ICON_LABEL_NUDGE = "-translate-y-[1.5px]"
