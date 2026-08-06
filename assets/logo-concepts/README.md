# Frizz icon concepts

Three sheets of directions for the mark after the `fray` → `frizz` rename, each drawn as real geometry and judged at favicon size. Every page is self-contained — all renders are inlined as data URIs — so they need no server and no network.

| Sheet | Open | What it covers |
| --- | --- | --- |
| The cursive f | [`frizz-signature-f.html`](frizz-signature-f.html) | The written signature f from [`reference/reference-brief.png`](reference/reference-brief.png) — two loops crossing at a waist, with a crossbar. **Every mark is exactly 180° rotationally symmetric, and measured.** Eight weights and treatments. |
| The hooked f | [`frizz-cursive-f.html`](frizz-cursive-f.html) | Eight lowercase `f`s built from hooks rather than loops — the favicon-viable family. |
| Icon concepts | [`frizz-logo-concepts.html`](frizz-logo-concepts.html) | The original fifteen non-letterform directions: fan, curl, spark, lanes, knot and the rest. |

## Regenerating

```sh
nub build.mjs             # the fifteen icon concepts  -> out/
nub build-cursive-f.mjs   # the hooked f family        -> out-f/
nub build-signature-f.mjs # the written signature f    -> out-sig/
nub artifact.mjs          # every out*/ -> its HTML sheet
nub artifact.mjs signature-f   # or just one
```

`build*.mjs` needs `rsvg-convert` (`brew install librsvg`). Shared geometry and rendering live in `lib.mjs`. The `out*/` directories are regenerated from scratch on every run and are not tracked.

## The constraint every sheet is judged against

A 512-unit canvas maps to 16 px, so **one pixel is 32 units**:

- **≥ 52u** minimum stroke — below this the mark dissolves.
- **≥ 64u** minimum ink gap or counter — below this two features fuse, or a hole fills.
- **3** elements across the width, and no more.

The outgoing fraying-rope mark draws its fibres at stroke-width 16–19, which is half a pixel at favicon size. They do not thin out; they disappear.

**Rotational symmetry.** The cursive f is C2 by nature — two loops crossing once at a waist are point reflections of each other. Every mark on that sheet is derived from one half and rotated, never drawn twice, then checked: render, rotate 180°, take the RMSE. Controls set the scale — a perfect centred circle scores `1.3e-3` (the rasteriser's floor) and a circle just 4 units off centre scores `9.3e-2`, 75x higher. All eight marks land at or under the floor.

**The size finding.** A genuinely written cursive `f` cannot also be the favicon — its line runs about 0.69 px and its loop counters about 1.4 px at 16 px, and bolding it until the arithmetic works widens the loops until the letter reads as an `8`. The resolution is two drawings: the signature as the logo, and the hooked `ƒ` as the icon.
