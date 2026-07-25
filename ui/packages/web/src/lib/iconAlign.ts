/** Optical nudge for a small lucide icon sitting beside a short label — the card eyebrows ("DONE",
 *  "ARM WATCHER") and the compact card action buttons ("Snooze", "Approve", "Copy terminal command").
 *
 *  Why it is needed at all: `items-center` aligns the two BOXES, but neither box is its glyph. A short
 *  label inks from cap-top to baseline, so its mass rides HIGH inside the font box, while a lucide
 *  icon's ink is centred in its own. Centring the boxes therefore leaves the icon sitting visibly LOW.
 *
 *  IT IS FONT-DEPENDENT, which is the whole reason this is a CSS variable and not a constant. The app
 *  ships two type stacks (styles.css: mono by default, `html[data-font="sans"]` swaps to system-ui),
 *  and they need OPPOSITE treatment. Measured in a real browser across all 18 icon+label pairs on the
 *  card gallery — svg.getBBox() for icon ink, canvas cap-height for the label's optical centre:
 *
 *      ideal nudge      mono (ui-monospace)      sans (system-ui)
 *      10px eyebrow     -1.44 … -1.69            -0.02 … +0.23
 *      11px action      -1.75 … -1.76            -0.01 … -0.13
 *
 *  So sans needs essentially NOTHING (its font box already sits where the ink does), and the old
 *  hard-coded -1.5px was pushing every eyebrow icon a full 1.5px too HIGH for anyone running the sans
 *  font. mono lands on -1.7px: within 0.26px of every measured pair, and it is the ink, not the box,
 *  that the eye reads.
 *
 *  Measure against the CAP BLOCK (cap-top → baseline), not the full ink bounding box. An incidental
 *  descender — the Q in "QUESTION", the p in "Approve" — drags the bbox down ~0.85px without moving
 *  where the word's mass actually reads, and chasing it produces a different nudge per label.
 *
 *  NOT a line-height problem — do not "fix" this by reaching for leading-none. The ink offset works out
 *  to `-fontBox/2 + fontAscent - inkAscent + inkHeight/2`; the line-height cancels, so changing it
 *  moves nothing. Only a nudge moves the ink.
 *
 *  Sized for a 12px lucide icon beside a 10–12px label. Re-measure before reusing it somewhere new;
 *  the audit routine lives in the adhoc-cdp loop (svg.getBBox + TextMetrics, both fonts). */
export const ICON_LABEL_NUDGE = "icon-label-nudge"
