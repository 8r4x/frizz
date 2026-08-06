#!/usr/bin/env node
// The cursive family: one swooping path, a bulb at each end, exactly C2.
//
// The spine is a CURVE, not a straight line — but it still cannot kink, because
// every join is tangent-continuous by construction rather than by tuning:
//
//   centre --swooping spine arc--> [bulb, tangent, 360 deg] --swooping tail-->
//
// The bulb is placed FROM the spine rather than positioned independently: at the
// spine's end point the ellipse is built so that point lies on it with the
// spine's own direction as its tangent. The stroke then travels a full turn and
// comes back to the same point going the same way, so the tail picks up exactly
// where the spine left off. Nothing in the path changes direction abruptly.
//
// At the centre the half meets its own 180-degree rotation. Tangents agree there
// (reversal flips the rotated half's direction back), while the curvature sign
// flips — which is an inflection, and an inflection in the middle is exactly
// what makes a written f swoop rather than bulge one way.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chain, render, smooth } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-cursive")

const CX = 256
const CY = 256
const STROKE = 22
const CORE_R = 122 // the bulbs+spine are normalised to this before tails are added
const TILE_R = 208
const rad = (d) => (d * Math.PI) / 180

/**
 * Walk an arc from `p` heading `ang`, turning `bend` degrees in total.
 *
 * The start point is included. It matters: the half has to BEGIN at the centre
 * of symmetry, because that point is the one the whole path maps onto itself
 * through. Omitting it shifts the mirror join by one step and the mark comes out
 * asymmetric by twice the step size — about 5 units here, which is visible.
 */
function arcFrom(p, ang, length, bend, steps = 44) {
  const pts = [[p[0], p[1]]]
  let a = ang
  let [x, y] = p
  const ds = length / steps
  const dt = rad(bend) / steps
  for (let i = 0; i < steps; i += 1) {
    a += dt
    x += ds * Math.cos(a)
    y += ds * Math.sin(a)
    pts.push([x, y])
  }
  return { pts, end: [x, y], dir: a }
}

/**
 * One half: centre -> swooping spine -> bulb -> swooping tail.
 *
 * spineAngle  heading as the stroke leaves the centre
 * spineLen    how far it runs before reaching the bulb
 * spineBend   total turn along that run — 0 is straight, more is swoopier
 * along       bulb half-axis along the direction of travel
 * across      bulb half-axis standing off the spine
 * side        which side of the spine the bulb sits on
 * dir         which way round the bulb the stroke travels
 * tailBend    total turn along the terminal
 */
function half({ spineAngle, spineLen, spineBend, along, across, side, dir, tailBend, tailLen, bleed }) {
  const spine = arcFrom([CX, CY], rad(spineAngle), spineLen, spineBend * side)
  const t = spine.dir
  const tHat = [Math.cos(t), Math.sin(t)]
  const nHat = [-Math.sin(t) * side, Math.cos(t) * side]
  const P = spine.end
  const C = [P[0] + across * nHat[0], P[1] + across * nHat[1]]
  // The touch point sits at phi = -90 in the bulb's own frame, where the tangent
  // runs along tHat. Starting and ending there is what makes the turn seamless.
  const at = (phi) => [
    C[0] + along * Math.cos(phi) * tHat[0] + across * Math.sin(phi) * nHat[0],
    C[1] + along * Math.cos(phi) * tHat[1] + across * Math.sin(phi) * nHat[1],
  ]
  const bulb = []
  const steps = 84
  for (let i = 1; i <= steps; i += 1) bulb.push(at(-Math.PI / 2 + dir * 2 * Math.PI * (i / steps)))
  return { core: chain(spine.pts, bulb), bulb, exit: P, dir: t, tailBend, tailLen, bleed }
}

function spinePath(params) {
  const h = half(params)
  if (!h) return null
  let m = 0
  for (const p of h.core) m = Math.max(m, Math.hypot(p[0] - CX, p[1] - CY))
  if (!(m > 1)) return null
  const k = CORE_R / m
  const scale = ([x, y]) => [CX + (x - CX) * k, CY + (y - CY) * k]
  const core = h.core.map(scale)
  const bulb = h.bulb.map(scale)
  const exit = scale(h.exit)

  // Grow the terminal until it leaves the tile (bleed) or hits its length.
  const target = h.bleed ? 460 : h.tailLen
  const tail = arcFrom(exit, h.dir, target, h.tailBend * params.side, 26)
  let pts = tail.pts
  if (!h.bleed) {
    // Trim anything that would poke outside the tile rather than clipping it,
    // so a "contained" mark really is contained.
    const inside = pts.filter((p) => Math.hypot(p[0] - CX, p[1] - CY) <= TILE_R)
    pts = inside.length ? inside : []
  }
  const halfPts = chain(core, pts)
  const rot = halfPts.map(([x, y]) => [2 * CX - x, 2 * CY - y])
  return { pts: [...rot.slice(1).reverse(), ...halfPts], bulb }
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

/** Collision between the two HALVES — one bulb fouling the other, or a tail
 *  cutting through the far bulb. Contact within a half is by construction. */
function crossHalfGraze(pts) {
  const near = STROKE * 1.7
  const skip = Math.round(pts.length * 0.45)
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
      if (Math.abs(dx * tan[i][1] - dy * tan[i][0]) < STROKE * 0.3) continue
      let a = Math.abs(Math.atan2(tan[i][1], tan[i][0]) - Math.atan2(tan[j][1], tan[j][0])) % Math.PI
      if (a > Math.PI / 2) a = Math.PI - a
      worst = Math.min(worst, (a * 180) / Math.PI)
    }
  }
  return worst
}

/**
 * Is the bulb wholly inside the upper-right quadrant?
 *
 * Because the mark is C2, containing ONE bulb there puts the other wholly in the
 * lower-left by construction — so the two can never overlap or share a quadrant.
 * The margin is half the stroke plus clearance, so the test is about the drawn
 * ink rather than the centreline.
 */
function inUpperRight(bulb) {
  const m = STROKE / 2 + 6
  return bulb.every(([x, y]) => x - CX > m && CY - y > m)
}

/** Upright-ness: an f stands up. A mark whose bounding box is wider than it is
 *  tall reads as an infinity sign or a pair of rings lying down, not a letter. */
function uprightness(pts) {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  return h / Math.max(1, w)
}

function signature(pts) {
  const out = []
  for (let i = 0; i < 24; i += 1) out.push(pts[Math.round((i * (pts.length - 1)) / 23)])
  return out
}
const sigDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])))

// ------------------------------------------------------------------ the sweep

const SWEEP = {
  // Negative: y grows downward, so this heads UP and to the RIGHT, putting the
  // bulb in the upper-right quadrant and its C2 partner in the lower-left.
  spineAngle: [-34, -45, -56, -67],
  // The bulb has to clear the axes, so its size is capped by how far out it
  // sits. Growing both together is the only way to get a big bulb that still
  // fits its quadrant.
  spineLen: [96, 124, 152],
  spineBend: [0, 14, 28, 42], // 0 is a straight spine; more swoops it
  along: [58, 78, 98],
  across: [32, 44, 56],
  side: [1, -1],
  dir: [1, -1],
  tailBend: [0, 24, 48],
  ends: [
    { key: "in", tailLen: 92, bleed: false },
    { key: "out", tailLen: 190, bleed: false },
    { key: "bleed", tailLen: 0, bleed: true },
  ],
}

const combos = []
for (const side of SWEEP.side)
  for (const dir of SWEEP.dir)
    for (const spineBend of SWEEP.spineBend)
      for (const tailBend of SWEEP.tailBend)
        for (const along of SWEEP.along)
          for (const across of SWEEP.across)
            for (const spineLen of SWEEP.spineLen)
              for (const spineAngle of SWEEP.spineAngle)
                for (const e of SWEEP.ends) combos.push({ spineAngle, spineLen, spineBend, along, across, side, dir, tailBend, ...e })

const scored = []
const rejected = { degenerate: 0, quadrant: 0, graze: 0, lyingDown: 0 }
for (const params of combos) {
  const built = spinePath(params)
  if (!built || built.pts.length < 40) {
    rejected.degenerate += 1
    continue
  }
  const { pts, bulb } = built
  if (!inUpperRight(bulb)) {
    rejected.quadrant += 1
    continue
  }
  const coarse = pts.filter((_, i) => i % 3 === 0)
  const graze = crossHalfGraze(coarse)
  if (graze < 22) {
    rejected.graze += 1
    continue
  }
  const upright = uprightness(pts)
  if (upright < 1.05) {
    rejected.lyingDown += 1
    continue
  }
  scored.push({ params, pts, graze, upright, c2: c2Error(pts), sig: signature(pts) })
}
console.log(`rejected: ${JSON.stringify(rejected)}`)

const unique = []
for (const s of scored) {
  if (unique.every((u) => u.params.key !== s.params.key || sigDist(u.sig, s.sig) > 20)) unique.push(s)
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
  const id = `c${String(index + 1).padStart(3, "0")}`
  const src = join(outDir, `${id}.svg`)
  writeFileSync(src, SVG(smooth(s.pts)))
  render(src, join(outDir, `${id}-200.png`), 200)
  kept.push({ id, ...s.params, graze: Number(s.graze.toFixed(1)), upright: Number(s.upright.toFixed(2)), c2Error: s.c2 })
}

writeFileSync(join(outDir, "variants.json"), JSON.stringify(kept, null, 2))
const counts = kept.reduce((a, k) => ({ ...a, [k.key]: (a[k.key] ?? 0) + 1 }), {})
console.log(`${combos.length} combinations -> ${scored.length} clean -> ${unique.length} distinct -> ${kept.length} rendered`)
console.log(`terminals: ${JSON.stringify(counts)}`)
console.log(`worst C2 error: ${Math.max(...kept.map((k) => k.c2Error)).toExponential(2)} units`)
