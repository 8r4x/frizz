# Frizz icon concepts

Fifteen directions for the mark after the `fray` → `frizz` rename, drawn as real geometry and judged at favicon size.

Open [`frizz-logo-concepts.html`](frizz-logo-concepts.html) — it is self-contained (every render is inlined as a data URI), so it needs no server and no network.

## Regenerating

```sh
nub build.mjs      # 15 concepts x 5 sizes -> out/, plus the outgoing mark for comparison
nub artifact.mjs   # out/ -> frizz-logo-concepts.html
```

`build.mjs` needs `rsvg-convert` (`brew install librsvg`). `out/` is regenerated from scratch on every run and is not tracked.

## The constraint

A 512-unit canvas maps to 16 px, so **one pixel is 32 units**. That conversion decides what is drawable:

- **≥ 52u** minimum stroke — below this the mark dissolves.
- **≥ 64u** minimum ink gap — below this two features fuse.
- **3** elements across the width, and no more.

The outgoing fraying-rope mark draws its fibres at stroke-width 16–19, which is half a pixel at favicon size. They do not thin out; they disappear. Every concept here is judged against its real 16 px render rather than its hero render.
