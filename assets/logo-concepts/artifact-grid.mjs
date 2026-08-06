#!/usr/bin/env node
// The parametric sweep as a self-contained page: every tile is a real render
// inlined as a data URI, labelled with the id you can quote back and with the
// parameters that produced it.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const variants = JSON.parse(readFileSync(join(here, "out-grid/variants.json"), "utf8"))
const uri = (n) => `data:image/png;base64,${readFileSync(join(here, "out-grid", n)).toString("base64")}`

const worstC2 = Math.max(...variants.map((v) => v.c2Error))
const tile = (v) => `
    <figure>
      <img src="${uri(`${v.id}-200.png`)}" width="150" height="150" alt="Mark variant ${v.id}">
      <figcaption><b>${v.id}</b><span>blob ${v.lw}&times;${v.lh} &middot; tilt ${v.tilt}&deg; &middot; axis ${v.axis}&deg;<br>dist ${v.dist} &middot; wrap ${v.wrap}&deg; &middot; tail ${v.tail} &middot; ${v.side > 0 ? "side +" : "side −"}${v.dir > 0 ? " dir +" : " dir −"}</span></figcaption>
    </figure>`

writeFileSync(join(here, "frizz-grid.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frizz — parametric grid</title><style>
:root { --bg:#0d0e10; --panel:#131519; --border:#26282d; --fg:#e6e7e9; --muted:#8b8f96; --accent:#e8b923;
  --sans: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; --mono: ui-monospace,"SF Mono",Consolas,monospace; }
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.6}
.wrap{max-width:1400px;margin:0 auto;padding:56px 32px 96px}
h1{font-size:32px;letter-spacing:-.02em;margin:0 0 8px;font-weight:650}
h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:48px 0 16px}
p{margin:0 0 10px} .lede{color:var(--muted);font-size:15px;max-width:74ch} .lede b{color:var(--fg);font-weight:600}
code{font-family:var(--mono);font-size:.88em;background:#181b20;border:1px solid var(--border);border-radius:5px;padding:1px 5px}
.knobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:18px 0 8px}
.knobs div{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.knobs b{display:block;font-family:var(--mono);font-size:13px;color:var(--accent)}
.knobs span{color:var(--muted);font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;margin-top:20px}
figure{margin:0;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:10px 8px 8px;text-align:center}
figure img{display:block;margin:0 auto;border-radius:22px;width:150px;height:150px}
figcaption{margin-top:8px;font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.5}
figcaption b{display:block;color:var(--fg);font-size:12px;margin-bottom:3px}
.foot{margin-top:48px;border-top:1px solid var(--border);padding-top:22px;color:var(--muted);font-size:13.5px;max-width:76ch}
.foot b{color:var(--fg)}
</style></head><body><div class="wrap">
<h1>Frizz — parametric grid</h1>
<p class="lede">${variants.length} variants of one construction: a single contiguous stroke, two blobs, and <b>exact 180&deg; rotational symmetry</b>. Quote an id and I'll take it further.</p>

<h2>What varies</h2>
<div class="knobs">
  <div><b>blob w &times; h</b><span>size and shape of each swoop</span></div>
  <div><b>tilt</b><span>each blob's own rotation</span></div>
  <div><b>axis</b><span>direction from the centre to the blob — the letter's lean</span></div>
  <div><b>dist</b><span>how far the blobs sit from the centre</span></div>
  <div><b>wrap</b><span>how far round the blob the stroke travels</span></div>
  <div><b>side / dir</b><span>where the line originates on the blob, and which way round</span></div>
  <div><b>tail</b><span>terminal length</span></div>
</div>

<h2>The ${variants.length} options</h2>
<div class="grid">${variants.map(tile).join("")}</div>

<div class="foot">
<p><b>Symmetry is exact, not approximate.</b> Each half is authored once and the other half is its 180&deg; rotation, so the two can't drift. Measured on the point set, the worst deviation across all ${variants.length} is <code>${worstC2.toExponential(2)}</code> units — floating-point noise. That is a proof, not a pixel comparison.</p>
<p><b>Nothing here grazes.</b> The stroke meets a blob at a computed <i>tangent</i> point, so joins have no kink, and the two stems form one straight line through the centre rather than a pile-up. Any combination where two parts of the stroke ran closer than 1.7 stroke-widths at under 24&deg; to each other was discarded — that near-parallel graze is what reads as a smudge. Combinations with no crossing (not a letterform) or more than three (a scribble) were dropped too: 8640 combinations became 2815 clean, 657 visually distinct, and these ${variants.length}.</p>
<p><b>Not yet decided:</b> weight, colour and whether the tile stays. Everything is drawn at a uniform 22-unit stroke purely so the shapes compare fairly.</p>
</div>
</div></body></html>
`)
console.log(`frizz-grid.html — ${variants.length} variants`)
