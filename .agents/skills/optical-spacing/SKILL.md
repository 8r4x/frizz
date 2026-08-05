---
name: optical-spacing
description: >-
  Space a ROW of small marks — an icon strip, a button rail, a footer of mixed glyphs and pills — by
  the ink the eye reads instead of the boxes CSS lays out, and match their perceived weight. Invoke
  whenever you set or judge the horizontal rhythm of two or more adjacent controls, or when a
  maintainer says spacing "looks inconsistent" on a strip whose `gap` is provably uniform. The
  horizontal sibling of `visual-review` (vertical ink alignment) and `adhoc-cdp` (how to boot and
  shoot). Carries the law, the instrument (`scripts/ink-gaps.mjs`), the negative-margin fix, the
  arithmetic that decides whether a target gap is even reachable, and the pen-weight rule that colour
  tokens cannot fix.
metadata:
  internal: true
---

# Optical spacing — one gap should mean one distance

Written 2026-08-05, after a footer whose every CSS gap was 6px drew **six different distances** and the
maintainer read all of them off the pixels: *"I'm sure the spacing is consistent in terms of the CSS,
but what matters here is the visual spacing."*

---

## Law 1 — `gap` spaces boxes; the eye spaces ink

Dead space between a mark's box and its ink comes from **two** independent sources, and you must count
both:

1. **the control's padding** — a 24px hover square around a 12px glyph carries ~6px a side;
2. **the glyph's own inset inside its svg** — lucide's `Plug` paints 8 of its 13 box px, `RefreshCw`
   10 of 12, a bordered pill *all* of its box, and a **filled** button (send, primary) all of its box
   too. Its ink IS its box.

So on one flat `gap`, a bare glyph and a pill sit at wildly different perceived distances. Measured
baseline of the strip that triggered this, every CSS gap 6px:

| pair | ink gap |
| --- | --- |
| donut → hourglass | 10.34px |
| hourglass → heartbeat | 12.50px |
| plug → restart | **20.50px** |
| restart → pill | 13.00px |
| pill → pill | **5.78px** |

A 3.5× spread. The composer rail, on an even 36px pitch: 22.25px between two icons against 15.75px
between an icon and a filled button.

---

## Law 2 — the fix is a negative margin per mark, sized to its MEASURED dead space

Collapse each mark's layout box onto its own ink, then set one `gap`. After that the container's gap
*is* the optical distance, for pills and bare glyphs alike, and adding a mark is a one-liner rather
than a re-tune.

```tsx
<footer className="flex items-center gap-3">        {/* gap-3 now means 12px of INK */}
  <span className="px-0.5 -mx-1">   <Hourglass size={12}/></span>   {/* dead 4/4  */}
  <button className="size-6 -mx-2"> <Plug size={13}/>      </button> {/* dead 8/8  */}
  <button className="rounded-md border …">Mark as done</button>      {/* dead 0/0  */}
</footer>
```

Put the constants in ONE module with the measurements in the comment (this repo: `lib/iconRhythm.ts`)
— they are readings, not taste, and the next person must know to re-measure rather than re-guess.

**Absolutely-positioned rails** are the same law solved for offsets instead of a gap. Work right to
left from the anchor mark and derive each offset from the neighbour's ink, not from an even pitch.

---

## Law 3 — check the target gap is REACHABLE before you pick it

With fixed square hit-boxes, the minimum ink gap between two adjacent icons is `deadRight(a) +
deadLeft(b) + boxGap`. Two 24px squares around ~9px glyphs cannot sit closer than ~14.5px without
their boxes touching. So:

- **first compute the binding pair**, then choose the strip's one gap at or above it;
- if the number that comes out is too loose for the pills, you must either shrink the boxes or accept
  overlap. **Overlapping hover squares are fine** — only one can ever paint a fill at a time, and the
  overlap is empty padding on both sides. The later element in the DOM wins the pointer there. Say so
  in a comment; it looks like a bug to the next reader.
- Resizing the hit box to fix rhythm is the trap. No square is both small enough to space a 10px glyph
  like a pill and large enough to click — that is what separating *box* from *layout footprint* buys.

---

## Law 4 — same slot ≠ same offset

When two different glyphs can occupy one position (a paperclip that takes the rail-action slot when no
rail action renders), they need **two constants**, because they paint different dead space. Reusing
one drew 13.75px where 14.75px was wanted. There is no shared pitch that is right for both.

---

## Law 5 — a mark's weight is the PEN, not just the colour token

Two glyphs in the same `text-muted/60` still read as different families when one is drawn with a
fatter line. Convert every glyph to its **painted stroke width** before comparing:

```
paintedPx = strokeWidth × (renderedSize / viewBoxUnits)
lucide, size 12, strokeWidth 2, 24-unit viewBox  → 1.00px
hand-rolled, 1.05em (12.6px), strokeWidth 2, 16-unit viewBox → 1.575px   ← 57% heavier
```

That donut was half again as heavy as both neighbours and no colour change could have fixed it. Pin
the **painted** width in the test, not the raw `strokeWidth` — a viewBox change silently breaks it.

Colour still matters: unify the tone token *within* a cluster (a status group is one family), and let
tiers differ *between* clusters if the hierarchy is real (readouts quieter than verbs). Document that.

---

## The instrument — `scripts/ink-gaps.mjs`

`ink-pixels.mjs` scans one centre row and answers "how big is this mark"; it **cannot measure gaps**.
`ink-gaps.mjs` takes an ordered selector list, screenshots each element with a small padded clip,
unions **every** row to find the painted left/right edge, and converts back to absolute page px.

```bash
node scripts/ink-gaps.mjs "$URL" '[data-a],[data-b],[data-c]' --dsf=4 --pad=2
# per mark: boxCssPx, inkLeft/inkRight, deadLeft/deadRight, meanContrast, peakContrast
# per pair: inkGap (what the eye reads) and boxGap (what CSS says)
```

`deadLeft`/`deadRight` are the numbers you turn into margins. `meanContrast` is the weight comparator
— peak is a single-pixel max and is noisy.

### It has a noise floor: ±0.5–1px on a thin or diagonal stroke tip

A faint edge column falls in or out of the threshold depending on where the box lands on the device
grid. This produced a plausible "0.5px lean" that **flipped sides when the element moved** — a real
viewBox asymmetry cannot do that. Rules:

- distrust any asymmetry the size of one device pixel until it survives a move;
- prefer the symmetric average and verify the gap, rather than chasing an exact number;
- anything inside ±0.75px of target is done. The defect you are fixing is 5–15px.

---

## The loop

1. **Serve a fixture on a plain `vite` dev server** (`nubx vite --port=NNNN`). In this repo `*-fixture.html` is NOT servable through the app stack — it falls back to the SPA and you measure the wrong page. Render the REAL components with both states of any conditional shape (with/without a rail action), and mock only the gates that hide controls.
2. **Measure the baseline** and confirm the complaint in numbers before touching anything.
3. Compute the binding pair, pick the target, apply the trims.
4. **Re-measure.** Never assume a trim landed.
5. **Crop each cluster at dsf 6–8** and read it back critically — spacing, pen weight, tone. A 40px strip inside a 1400px shot cannot be reviewed.
6. **Then confirm on the real app.** A fixture proves the CSS; only the app proves which marks actually co-occur on one surface. Seed a row rather than eyeballing the board, and say plainly which marks you could not reach (ones gated on a live provider stream or a dev-build launcher) and why.
7. Check the **narrow width** and any padding the rail reserves — trims change layout width, so re-derive the reservation and assert the text clearance.

---

## Fallout to fix in the same change

- A test that pinned the old geometry (a stroke width, an offset). Re-pin the *property that matters*.
- The comment that justified the old number. Trimming the layout footprint usually **retires** an
  argument like "24px was chosen over 28px because it spends 12px rather than 14px to the pill" — that
  reasoning is now wrong, not merely stale. Say what replaced it.
- Any reservation derived from the old offsets (`pr-*` behind an absolute rail).
