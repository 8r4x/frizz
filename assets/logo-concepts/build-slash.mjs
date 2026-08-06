#!/usr/bin/env node
// The slash-spine family: one straight diagonal backbone with a bulb hung off
// each end, drawn as a single contiguous stroke, exactly C2 symmetric.
//
// The kink is designed out rather than tuned out. The stem runs from the centre
// along the spine and meets the bulb at a computed TANGENT point; the stroke
// then travels a FULL 360 degrees round the bulb, so it comes back to that same
// point travelling in the same direction, and the terminal carries straight on
// down the spine. Entry line, exit line and both terminals are therefore one
// unbroken straight line through the whole mark — the forward slash.
//
// Any wrap other than 360 lands the exit somewhere else on the bulb with a
// different tangent, and the terminal leaves at an angle. That is exactly the
// kink in g068. 360 is not a tuned value, it is the only one that cannot kink.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chain, render, smooth } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-slash")

const CX = 256
const CY = 256
const STROKE = 22
const CORE_R = 118 // radius the bulbs are normalised to, before terminals
const TILE_R = 206 // a contained terminal must stop inside this
const GRAZE_MIN = 20
const rad = (d) => (d * Math.PI) / 180

/**
 * The bulb end of one half: stem out from the centre, then all the way round.
 *
 * axis     spine angle in degrees; 90 is vertical, smaller leans it toward "/"
 * dist     how far along the spine the bulb sits
 * lw,lh    bulb half-width and half-height
 * tiltRel  bulb rotation RELATIVE to the spine — 0 lays it along the backbone
 * side     which of the two tangent lines from the centre, i.e. which side the
 *          bulb hangs off the spine
 * dir      which way round the bulb the stroke travels
 * wrap     degrees travelled round the bulb; 360 is the kink-free case
 */
function bulbHalf({ axis, dist, lw, lh, tiltRel, side, dir, wrap }) {
  const tilt = 90 - axis + tiltRel
  const E = [CX + dist * Math.cos(rad(axis)), CY - dist * Math.sin(rad(axis))]
  const ct = Math.cos(rad(tilt))
  const st = Math.sin(rad(tilt))
  const toCanvas = ([x, y]) => [E[0] + (x * lw * ct - y * lh * st), E[1] + (x * lw * st + y * lh * ct)]
  const v = [CX - E[0], CY - E[1]]
  const u = [(v[0] * ct + v[1] * st) / lw, (-v[0] * st + v[1] * ct) / lh]
  const d = Math.hypot(u[0], u[1])
  if (!(d > 1.1)) return null

  const phi0 = Math.atan2(u[1], u[0]) + side * Math.acos(1 / d)
  const at = (phi) => toCanvas([Math.cos(phi), Math.sin(phi)])
  const start = at(phi0)

  const stem = []
  for (let i = 0; i <= 10; i += 1) stem.push([CX + ((start[0] - CX) * i) / 10, CY + ((start[1] - CY) * i) / 10])

  const arc = []
  const steps = Math.max(48, Math.round(wrap / 4))
  for (let i = 1; i <= steps; i += 1) arc.push(at(phi0 + dir * rad(wrap) * (i / steps)))

  const p = at(phi0 + dir * rad(wrap))
  const q = at(phi0 + dir * (rad(wrap) + 0.001))
  const n = Math.hypot(q[0] - p[0], q[1] - p[1])
  return { core: chain(stem, arc), exit: p, dir: [(q[0] - p[0]) / n, (q[1] - p[1]) / n] }
}

/** How far a terminal can run from `p` along `d` before leaving the safe circle. */
function lengthInside(p, d, radius) {
  const v = [p[0] - CX, p[1] - CY]
  const b = v[0] * d[0] + v[1] * d[1]
  const c = v[0] * v[0] + v[1] * v[1] - radius * radius
  const disc = b * b - c
  return disc <= 0 ? 0 : Math.max(0, -b + Math.sqrt(disc))
}

function spine(params) {
  const h = bulbHalf(params)
  if (!h) return null
  // Normalise on the bulbs alone, so terminal length is free to bleed or not.
  let m = 0
  for (const p of h.core) m = Math.max(m, Math.hypot(p[0] - CX, p[1] - CY))
  const k = CORE_R / m
  const scale = ([x, y]) => [CX + (x - CX) * k, CY + (y - CY) * k]
  const core = h.core.map(scale)
  const exit = scale(h.exit)

  const len = params.bleed ? 460 : Math.min(params.tail, lengthInside(exit, h.dir, TILE_R))
  const term = []
  for (let i = 1; i <= 14; i += 1) {
    const s = (len * i) / 14
    term.push([exit[0] + s * h.dir[0], exit[1] + s * h.dir[1]])
  }
  const half = chain(core, term)
  const rot = half.map(([x, y]) => [2 * CX - x, 2 * CY - y])
  return [...rot.slice(1).reverse(), ...half]
}

function c2Error(pts) {
  let worst = 0
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[pts.length - 1 - i]
    worst = Math.max(worst, Math.hypot(a[0] - (2 * CX - b[0]), a[1] - (2 * CY - b[1])))
  }
  return worst
}

/**
 * Collision check between the two HALVES of the mark — one bulb fouling the
 * other, or a terminal cutting through the far bulb.
 *
 * It deliberately does not look within a half. A loop attached tangentially to
 * its own spine touches it by construction and reads as intentional; scoring
 * that as a graze rejects the entire kink-free family, which is what happened
 * on the first run. Only contact across the halves is a real defect here.
 */
function grazeAngle(pts) {
  const near = STROKE * 1.7
  const sameLine = STROKE * 0.3
  const skip = Math.round(pts.length * 0.45) // far enough apart to be the other half
  let worst = 90
  const tan = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 2)]
    const b = pts[Math.min(pts.length - 1, i + 2)]
    const n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [(b[0] - a[0]) / n, (b[1] - a[1]) / n]
  })
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + skip; j < pts.length; j += 1) {
      const dx = pts[j][0] - pts[i][0]
      const dy = pts[j][1] - pts[i][1]
      if (Math.hypot(dx, dy) > near) continue
      // Offset measured across the stroke's own direction, not along it.
      if (Math.abs(dx * tan[i][1] - dy * tan[i][0]) < sameLine) continue
      let a = Math.abs(Math.atan2(tan[i][1], tan[i][0]) - Math.atan2(tan[j][1], tan[j][0])) % Math.PI
      if (a > Math.PI / 2) a = Math.PI - a
      worst = Math.min(worst, (a * 180) / Math.PI)
    }
  }
  return worst
}

function signature(pts) {
  const out = []
  for (let i = 0; i < 24; i += 1) out.push(pts[Math.round((i * (pts.length - 1)) / 23)])
  return out
}
const sigDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])))

// ------------------------------------------------------------------ the sweep

const SWEEP = {
  axis: [50, 58, 66, 74],
  dist: [90, 112, 134],
  lw: [30, 42, 54],
  lh: [76, 96, 116],
  tiltRel: [-18, -6, 6, 18],
  side: [1, -1],
  dir: [1, -1],
  wrap: [360],
  ends: [
    { key: "in", tail: 96, bleed: false },
    { key: "out", tail: 999, bleed: false }, // clamped to the tile: runs right to the edge
    { key: "bleed", tail: 0, bleed: true },
  ],
}

const combos = []
for (const side of SWEEP.side)
  for (const dir of SWEEP.dir)
    for (const tiltRel of SWEEP.tiltRel)
      for (const lh of SWEEP.lh)
        for (const lw of SWEEP.lw)
          for (const dist of SWEEP.dist)
            for (const axis of SWEEP.axis)
              for (const wrap of SWEEP.wrap)
                for (const e of SWEEP.ends) combos.push({ axis, dist, lw, lh, tiltRel, side, dir, wrap, ...e })

const scored = []
const reasons = { degenerate: 0, graze: 0 }
for (const params of combos) {
  const pts = spine(params)
  if (!pts) {
    reasons.degenerate += 1
    continue
  }
  const coarse = pts.filter((_, i) => i % 3 === 0)
  const graze = grazeAngle(coarse)
  if (graze < GRAZE_MIN) {
    reasons.graze += 1
    continue
  }
  scored.push({ params, pts, graze, c2: c2Error(pts), sig: signature(pts) })
}
const perKey = (list) => list.reduce((a, s) => ({ ...a, [s.params.key]: (a[s.params.key] ?? 0) + 1 }), {})
console.log(`rejected: ${JSON.stringify(reasons)}   clean per treatment: ${JSON.stringify(perKey(scored))}`)

// Dedupe within each terminal treatment, so all three are represented rather
// than the first one crowding the other two out.
const unique = []
for (const s of scored) {
  if (unique.every((u) => u.params.key !== s.params.key || sigDist(u.sig, s.sig) > 24)) unique.push(s)
}

const TARGET = 144
const byKey = { in: [], out: [], bleed: [] }
for (const s of unique) byKey[s.params.key].push(s)
const chosen = []
for (const key of ["bleed", "out", "in"]) {
  const list = byKey[key]
  const want = Math.round(TARGET / 3)
  const stride = Math.max(1, Math.floor(list.length / want))
  for (let i = 0, n = 0; i < list.length && n < want; i += stride, n += 1) chosen.push(list[i])
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const SVG = (d) => `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="tile"><rect x="16" y="16" width="480" height="480" rx="116"/></clipPath>
    <radialGradient id="bg" cx="0.5" cy="0.5" r="0.62">
      <stop offset="0" stop-color="#191a20"/><stop offset="1" stop-color="#0d0e10"/>
    </radialGradient>
    <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="240">
      <stop offset="0" stop-color="#ffdf7f"/><stop offset="0.62" stop-color="#eabe2c"/><stop offset="1" stop-color="#cf9412"/>
    </radialGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#bg)"/>
  <g clip-path="url(#tile)">
    <path d="${d}" fill="none" stroke="url(#ink)" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`

const kept = []
for (const [index, s] of chosen.entries()) {
  const id = `s${String(index + 1).padStart(3, "0")}`
  const src = join(outDir, `${id}.svg`)
  writeFileSync(src, SVG(smooth(s.pts)))
  render(src, join(outDir, `${id}-200.png`), 200)
  kept.push({ id, ...s.params, graze: Number(s.graze.toFixed(1)), c2Error: s.c2 })
}

writeFileSync(join(outDir, "variants.json"), JSON.stringify(kept, null, 2))
const counts = kept.reduce((a, k) => ({ ...a, [k.key]: (a[k.key] ?? 0) + 1 }), {})
console.log(`${combos.length} combinations -> ${scored.length} clean -> ${unique.length} distinct -> ${kept.length} rendered`)
console.log(`terminals: ${JSON.stringify(counts)}`)
console.log(`worst C2 error: ${Math.max(...kept.map((k) => k.c2Error)).toExponential(2)} units`)
