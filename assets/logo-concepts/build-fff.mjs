#!/usr/bin/env node
// The shipped mark written three times in a row — cursive "fff" — as ONE stroke
// with a single free end at each side, exactly like the single glyph.
//
// The copies chain by pure translation, and the joins are seamless for a reason
// worth stating: because the glyph is C2, its two tails are each other's
// rotations, which means the direction of travel where the stroke ENTERS equals
// the direction where it LEAVES. So laying the next copy's start tip on the
// previous copy's end tip matches position and tangent at once. No blending, no
// fudge — translation alone.
//
// The row is first rotated so the two tips are level, otherwise the glyphs climb
// diagonally instead of sitting on a baseline.
//
// The result keeps rotational symmetry too: the middle glyph maps to itself
// under a half turn and the outer two swap, so the whole row is C2 about its
// centre.
//
//   nub build-fff.mjs            write final/fff.svg and a tile version
//   REPEATS=5 nub build-fff.mjs  a different number of glyphs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { selfCrossings } from "./crossings.mjs"
import { bezierSample } from "./fit-two.mjs"
import { render } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const finalDir = join(here, "final")
mkdirSync(finalDir, { recursive: true })

const REPEATS = Number(process.env.REPEATS ?? 3)
const { stroke, anchors } = JSON.parse(readFileSync(join(finalDir, "anchors.json"), "utf8"))

/** Rotate an anchor list about a centre; tangent angles rotate with it. */
function rotateAnchors(list, ang, cx, cy) {
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  return list.map((a) => ({
    x: cx + (a.x - cx) * ca - (a.y - cy) * sa,
    y: cy + (a.x - cx) * sa + (a.y - cy) * ca,
    th: a.th + ang,
    in: a.in,
    out: a.out,
  }))
}

const shift = (list, dx, dy) => list.map((a) => ({ ...a, x: a.x + dx, y: a.y + dy }))

// Level the two tips so the glyphs sit on a baseline rather than climbing.
const start = anchors[0]
const end = anchors[anchors.length - 1]
const level = rotateAnchors(anchors, -Math.atan2(end.y - start.y, end.x - start.x), 256, 256)
const s0 = level[0]
const e0 = level[level.length - 1]
const pitch = e0.x - s0.x
console.log(`glyph tips levelled; pitch ${pitch.toFixed(1)} units`)

// Chain: each copy's start tip lands exactly on the previous copy's end tip, so
// the two share ONE anchor. Its tangent is unambiguous — the glyph's start and
// end tangents are identical to the last bit, which is what C2 guarantees — but
// its handles are not: it must take `in` from the arriving copy and `out` from
// the departing one. They are the swapped pair (17.28 / 30.27), so inheriting
// both from either side leaves a visible bulge and breaks the row's symmetry.
let chain = level
for (let i = 1; i < REPEATS; i += 1) {
  const next = shift(level, pitch * i, 0)
  const join = { ...chain[chain.length - 1], out: next[0].out }
  chain = [...chain.slice(0, -1), join, ...next.slice(1)]
}

const dense = bezierSample(chain, 60)
const crossings = selfCrossings(dense)
console.log(`${REPEATS} glyphs -> ${chain.length - 1} cubic segments, ${crossings.length} self-crossings (expect ${2 * REPEATS})`)

// C2 about the row's own centre: the middle glyph maps to itself, the outer pair swaps.
const cx = (dense[0][0] + dense[dense.length - 1][0]) / 2
const cy = (dense[0][1] + dense[dense.length - 1][1]) / 2
let c2 = 0
for (let i = 0; i < dense.length; i += 1) {
  const a = dense[i]
  const b = dense[dense.length - 1 - i]
  c2 = Math.max(c2, Math.hypot(a[0] - (2 * cx - b[0]), a[1] - (2 * cy - b[1])))
}
console.log(`row C2 error about its own centre: ${c2.toExponential(2)} units`)

function pathOf(list) {
  let d = `M${list[0].x.toFixed(2)} ${list[0].y.toFixed(2)}`
  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i]
    const b = list[i + 1]
    d += `C${(a.x + Math.cos(a.th) * a.out).toFixed(2)} ${(a.y + Math.sin(a.th) * a.out).toFixed(2)} ${(b.x - Math.cos(b.th) * b.in).toFixed(2)} ${(b.y - Math.sin(b.th) * b.in).toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
  }
  return d
}

const xs = dense.map((p) => p[0])
const ys = dense.map((p) => p[1])
const pad = stroke / 2 + 14
const box = {
  x: Math.min(...xs) - pad,
  y: Math.min(...ys) - pad,
  w: Math.max(...xs) - Math.min(...xs) + pad * 2,
  h: Math.max(...ys) - Math.min(...ys) + pad * 2,
}

const INK = `<defs><radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="${(box.x + box.w / 2).toFixed(1)}" cy="${(box.y + box.h / 2).toFixed(1)}" r="${(box.w / 2).toFixed(1)}">
      <stop offset="0" stop-color="#ffdf7f"/><stop offset="0.62" stop-color="#eabe2c"/><stop offset="1" stop-color="#cf9412"/>
    </radialGradient></defs>`
const d = pathOf(chain)

writeFileSync(join(finalDir, "fff.svg"), `<svg width="${Math.round(box.w)}" height="${Math.round(box.h)}" viewBox="${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">
  ${INK}
  <path d="${d}" fill="none" stroke="url(#ink)" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`)

// On the dark field, and a square-tile version for comparison with the icon.
writeFileSync(join(finalDir, "fff-dark.svg"), `<svg width="${Math.round(box.w)}" height="${Math.round(box.h)}" viewBox="${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">
  ${INK}
  <rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" fill="#0d0e10"/>
  <path d="${d}" fill="none" stroke="url(#ink)" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`)

const side = Math.max(box.w, box.h)
writeFileSync(join(finalDir, "fff-tile.svg"), `<svg width="512" height="512" viewBox="${(box.x + box.w / 2 - side / 2).toFixed(1)} ${(box.y + box.h / 2 - side / 2).toFixed(1)} ${side.toFixed(1)} ${side.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">
  ${INK}
  <rect x="${(box.x + box.w / 2 - side / 2).toFixed(1)}" y="${(box.y + box.h / 2 - side / 2).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="${(side * 0.226).toFixed(1)}" fill="#0d0e10"/>
  <path d="${d}" fill="none" stroke="url(#ink)" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`)

for (const [name, w] of [["fff-dark", 1200], ["fff-tile", 512]]) {
  render(join(finalDir, `${name}.svg`), join(finalDir, `${name}.png`), w)
}
console.log(`wrote final/fff.svg, final/fff-dark.svg, final/fff-tile.svg (${Math.round(box.w)}x${Math.round(box.h)})`)
