#!/usr/bin/env node
// A parametric sweep of the mark: one contiguous stroke, two blobs, exact
// 180-degree rotational symmetry, every dimension exposed as a knob.
//
// Construction, per half (the other half is always the exact C2 rotation):
//
//   centre --straight stem--> [tangent point] --around the blob--> --tail-->
//
// The stem meets the blob at a TRUE TANGENT POINT, computed rather than placed,
// so the join has no kink. It also means the two stems form ONE straight line
// through the centre: the centre carries a single clean stroke, never a pile-up.
//
// Tangency is computed in the blob's own frame, where the ellipse is a unit
// circle — translate by -E, unrotate by -tilt, scale by 1/lw and 1/lh. Affine
// maps preserve tangency, so the point maps straight back.
//
// Symmetry here is exact by construction and checked on the POINT SET (~1e-13),
// not inferred from a render. Rasterising a self-crossing stroke is itself
// slightly direction-dependent, so a pixel check reports up to ~2e-2 on shapes
// that are provably perfect; that number tracks how close the stroke runs to
// itself, which is why grazing is measured separately and culled.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { render, smooth, symmetryError } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-grid")

const CX = 256
const CY = 256
const STROKE = 22
const rad = (d) => (d * Math.PI) / 180

/**
 * Half the stroke, from the centre of symmetry out to one terminal.
 *
 * axis   direction from the centre to the blob's centre, degrees, 90 = straight up
 * dist   how far the blob sits from the centre — sets blob separation and stem length
 * lw,lh  the blob's half-width and half-height: the size and shape of the swoop
 * tilt   the blob's own rotation, degrees
 * side   which of the two tangent lines to leave on — where the line originates
 * dir    which way round the blob to travel
 * wrap   how far round the blob to go, degrees: how closed the swoop is
 * tail   terminal length, as a multiple of the blob's width
 * bend   how much the terminal curves away from the exit tangent, degrees
 */
function halfStroke({ axis, dist, lw, lh, tilt, side, dir, wrap, tail, bend = 0 }) {
  const E = [CX + dist * Math.cos(rad(axis)), CY - dist * Math.sin(rad(axis))]
  const ct = Math.cos(rad(tilt))
  const st = Math.sin(rad(tilt))
  const toCanvas = ([x, y]) => [E[0] + (x * lw * ct - y * lh * st), E[1] + (x * lw * st + y * lh * ct)]
  const v = [CX - E[0], CY - E[1]]
  const u = [(v[0] * ct + v[1] * st) / lw, (-v[0] * st + v[1] * ct) / lh]
  const d = Math.hypot(u[0], u[1])
  if (!(d > 1.08)) return null // the centre sits inside the blob: no tangent, no mark

  const phi0 = Math.atan2(u[1], u[0]) + side * Math.acos(1 / d)
  const phi1 = phi0 + dir * rad(wrap)
  const at = (phi) => toCanvas([Math.cos(phi), Math.sin(phi)])

  const start = at(phi0)
  const stem = []
  for (let i = 0; i <= 8; i += 1) stem.push([CX + ((start[0] - CX) * i) / 8, CY + ((start[1] - CY) * i) / 8])

  const arc = []
  const steps = Math.max(30, Math.round(wrap / 4))
  for (let i = 1; i <= steps; i += 1) arc.push(at(phi0 + ((phi1 - phi0) * i) / steps))

  const p = at(phi1)
  const q = at(phi1 + dir * 0.001)
  const n = Math.hypot(q[0] - p[0], q[1] - p[1])
  const [tx, ty] = [(q[0] - p[0]) / n, (q[1] - p[1]) / n]
  const term = []
  const len = tail * lw * 2
  for (let i = 1; i <= 12; i += 1) {
    const s = (len * i) / 12
    const a = rad(bend) * (i / 12) ** 2
    term.push([p[0] + s * (tx * Math.cos(a) - ty * Math.sin(a)), p[1] + s * (tx * Math.sin(a) + ty * Math.cos(a))])
  }
  return [...stem, ...arc, ...term]
}

/** Scale a C2 point set into a centred box. The bbox centre IS the symmetry
 *  centre, so scaling about it cannot break the symmetry. */
function fitCentred(points, half = 196) {
  let m = 0
  for (const [x, y] of points) m = Math.max(m, Math.abs(x - CX), Math.abs(y - CY))
  const k = half / m
  return points.map(([x, y]) => [CX + (x - CX) * k, CY + (y - CY) * k])
}

function spine(params) {
  const h = halfStroke(params)
  if (!h) return null
  const rot = h.map(([x, y]) => [2 * CX - x, 2 * CY - y])
  return fitCentred([...rot.slice(1).reverse(), ...h])
}

/** Largest deviation from exact C2, in units. Proves the symmetry directly. */
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
 * How cleanly the stroke meets itself.
 *
 * Where two parts of the stroke come within a stroke-and-a-half of each other,
 * the angle between them decides how it reads: a wide angle is a crisp crossing,
 * a narrow one is a graze — two lines running almost parallel a hair apart,
 * which looks like a smudge and is the "overlapping in the middle" problem.
 * Returns the narrowest such angle in degrees; 90 means nothing comes close.
 */
function grazeAngle(pts) {
  const near = STROKE * 1.7
  const skip = 14
  let worst = 90
  const tan = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 2)]
    const b = pts[Math.min(pts.length - 1, i + 2)]
    return Math.atan2(b[1] - a[1], b[0] - a[0])
  })
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + skip; j < pts.length; j += 1) {
      if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) > near) continue
      let a = Math.abs(tan[i] - tan[j]) % Math.PI
      if (a > Math.PI / 2) a = Math.PI - a
      worst = Math.min(worst, (a * 180) / Math.PI)
    }
  }
  return worst
}

/** Do two segments properly cross (not just touch at a shared endpoint)? */
function crosses(a, b, c, d) {
  const s = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return s(a, b, c) !== s(a, b, d) && s(c, d, a) !== s(c, d, b)
}

/** How many times the stroke passes over itself. One or two reads as a
 *  deliberate letterform; five reads as a scribble. */
function crossings(pts) {
  let n = 0
  for (let i = 0; i < pts.length - 1; i += 1) {
    for (let j = i + 3; j < pts.length - 1; j += 1) {
      if (crosses(pts[i], pts[i + 1], pts[j], pts[j + 1])) n += 1
    }
  }
  return n
}

/** A coarse shape signature, for dropping near-duplicates. */
function signature(pts) {
  const out = []
  for (let i = 0; i < 24; i += 1) out.push(pts[Math.round((i * (pts.length - 1)) / 23)])
  return out
}

function signatureDistance(a, b) {
  let worst = 0
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]))
  return worst
}

// ------------------------------------------------------------------ the sweep

const SWEEP = {
  axis: [90, 80, 70],
  dist: [104, 130, 156],
  lw: [36, 50, 64, 78],
  lh: [70, 92, 114],
  tilt: [-30, -15, 0, 15, 30],
  wrap: [290, 330],
  side: [1, -1],
  dir: [1, -1],
  tail: [0.9, 1.5],
}

const combos = []
for (const side of SWEEP.side)
  for (const dir of SWEEP.dir)
    for (const wrap of SWEEP.wrap)
      for (const tilt of SWEEP.tilt)
        for (const lh of SWEEP.lh)
          for (const lw of SWEEP.lw)
            for (const dist of SWEEP.dist)
              for (const axis of SWEEP.axis)
                for (const tail of SWEEP.tail) combos.push({ axis, dist, lw, lh, tilt, side, dir, wrap, tail })

// Score everything before rendering anything — geometry is cheap, rsvg is not.
// Metrics run on every third point: the shapes are smooth, so the coarse set
// says the same thing for a fraction of the work.
const scored = []
for (const params of combos) {
  const pts = spine(params)
  if (!pts) continue
  const coarse = pts.filter((_, i) => i % 3 === 0)
  const graze = grazeAngle(coarse)
  if (graze < 24) continue // two lines running almost parallel: reads as a smudge
  const cross = crossings(coarse)
  if (cross < 1 || cross > 3) continue // 0 is not a letterform, 4+ is a scribble
  scored.push({ params, pts, graze, cross, c2: c2Error(pts), sig: signature(pts) })
}

// Drop near-duplicates, then take an even stride so the grid spans the whole
// sweep instead of clustering wherever the nested loops happened to start.
const unique = []
for (const s of scored) {
  if (unique.every((u) => signatureDistance(u.sig, s.sig) > 26)) unique.push(s)
}
const TARGET = 144
const stride = Math.max(1, Math.floor(unique.length / TARGET))
const chosen = []
for (let i = 0; i < unique.length && chosen.length < TARGET; i += stride) chosen.push(unique[i])

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const SVG = (d) => `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.5" r="0.62">
      <stop offset="0" stop-color="#191a20"/><stop offset="1" stop-color="#0d0e10"/>
    </radialGradient>
    <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="230">
      <stop offset="0" stop-color="#ffdf7f"/><stop offset="0.62" stop-color="#eabe2c"/><stop offset="1" stop-color="#cf9412"/>
    </radialGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#bg)"/>
  <path d="${d}" fill="none" stroke="url(#ink)" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`

const kept = []
for (const [index, s] of chosen.entries()) {
  const id = `g${String(index + 1).padStart(3, "0")}`
  const src = join(outDir, `${id}.svg`)
  writeFileSync(src, SVG(smooth(s.pts)))
  render(src, join(outDir, `${id}-200.png`), 200)
  kept.push({ id, ...s.params, graze: Number(s.graze.toFixed(1)), crossings: s.cross, c2Error: s.c2 })
}

// Spot-check the raster on a sample; the point-set proof above is the real one.
const sample = kept.filter((_, i) => i % 24 === 0)
for (const k of sample) {
  render(join(outDir, `${k.id}.svg`), join(outDir, `${k.id}-512.png`), 512)
  k.rasterSymmetry = symmetryError(join(outDir, `${k.id}-512.png`))
}

writeFileSync(join(outDir, "variants.json"), JSON.stringify(kept, null, 2))
console.log(`${combos.length} combinations -> ${scored.length} clean -> ${unique.length} distinct -> ${kept.length} rendered`)
console.log(`worst C2 error across all rendered: ${Math.max(...kept.map((k) => k.c2Error)).toExponential(2)} units`)
console.log(`raster symmetry on ${sample.length} sampled: ${sample.map((k) => k.rasterSymmetry.toExponential(1)).join(", ")}`)
