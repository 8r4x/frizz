#!/usr/bin/env node
// The figure-eight family, from the reference: two tall narrow teardrop loops
// forming one CLOSED figure-eight, plus a separate gently-arced crossbar.
//
// The loops come from a sheared Gerono figure-eight, which is the right curve
// for this and not an approximation of it: it is rounded at the apexes and
// pinches to a point at the waist, which is exactly the teardrop the reference
// draws. C2 is exact — mapping t to pi-t negates both coordinates about the
// centre — and shear is linear, so the mark can lean without losing symmetry.
//
// Proportions are taken off the reference rather than guessed. Measured on a
// 512 canvas its loops are about 102 wide by 185 tall each, so loop width to
// full height is roughly 0.28; anything squatter stops reading as this mark.
//
// One consequence of insisting on exact C2 that is worth stating plainly: a
// single crossbar that maps onto itself under a half turn must pass through the
// centre, and the figure-eight's own waist is already there. So the bar and the
// waist coincide, where the reference has the bar passing just below. Sweeping
// the bar's angle and bow is how that node is made to read cleanly.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { render, smooth } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-eight")

const CX = 256
const CY = 256
const TILE_R = 214
const rad = (d) => (d * Math.PI) / 180

/** The closed figure-eight: two teardrop loops meeting at the centre. */
function eight({ loopW, loopH, shear, steps = 260 }) {
  const pts = []
  for (let i = 0; i <= steps; i += 1) {
    const t = (2 * Math.PI * i) / steps
    const y = CY - loopH * Math.cos(t)
    pts.push([CX + (loopW / 2) * Math.sin(2 * t) + shear * (CY - y), y])
  }
  return pts
}

/** The crossbar: one half authored from the centre, the other its rotation. */
function bar({ barAngle, barLen, barBend, barBleed }) {
  const half = []
  const steps = 22
  let a = rad(-barAngle) // negative: y grows downward, so this rises to the right
  let [x, y] = [CX, CY]
  half.push([x, y])
  const reach = barBleed ? 420 : barLen
  const ds = reach / steps
  const dt = rad(barBend) / steps
  for (let i = 0; i < steps; i += 1) {
    a += dt
    x += ds * Math.cos(a)
    y += ds * Math.sin(a)
    if (!barBleed && Math.hypot(x - CX, y - CY) > TILE_R) break
    half.push([x, y])
  }
  const rot = half.map(([px, py]) => [2 * CX - px, 2 * CY - py])
  return [...rot.slice(1).reverse(), ...half]
}

/**
 * Largest distance from any point's 180-degree image to the curve itself.
 *
 * Deliberately NOT the reversed-index comparison used elsewhere. That shortcut
 * only holds when the path is authored as a half plus its rotation; on a CLOSED
 * curve the symmetry partner of a point is somewhere else entirely in the
 * parameterisation, and the index test reports hundreds of units of error on a
 * curve that is in fact exactly symmetric. This asks the question directly.
 */
function c2Error(pts) {
  let worst = 0
  for (const [x, y] of pts) {
    const tx = 2 * CX - x
    const ty = 2 * CY - y
    let best = Infinity
    for (const [px, py] of pts) {
      const d = (px - tx) ** 2 + (py - ty) ** 2
      if (d < best) best = d
    }
    worst = Math.max(worst, Math.sqrt(best))
  }
  return worst
}

/** Scale a C2 set about the centre — which cannot disturb the symmetry. */
function fitCentred(sets, half) {
  let m = 0
  for (const set of sets) for (const [x, y] of set) m = Math.max(m, Math.abs(x - CX), Math.abs(y - CY))
  const k = half / m
  return sets.map((set) => set.map(([x, y]) => [CX + (x - CX) * k, CY + (y - CY) * k]))
}

// ------------------------------------------------------------------ the sweep

const SWEEP = {
  // The reference measures about 0.28 loop-width to full-height on a 512
  // canvas, so the range is centred on narrow rather than on round.
  loopW: [72, 88, 104, 122],
  loopH: [162, 182, 202],
  shear: [0, 0.09, 0.18],
  barAngle: [10, 18, 27],
  barBend: [0, 16, 32],
  ends: [
    { key: "in", barLen: 150, barBleed: false },
    { key: "out", barLen: 999, barBleed: false },
    { key: "bleed", barLen: 0, barBleed: true },
  ],
  stroke: [24, 32],
}

const combos = []
for (const loopW of SWEEP.loopW)
  for (const loopH of SWEEP.loopH)
    for (const shear of SWEEP.shear)
      for (const barAngle of SWEEP.barAngle)
        for (const barBend of SWEEP.barBend)
          for (const stroke of SWEEP.stroke)
            for (const e of SWEEP.ends) combos.push({ loopW, loopH, shear, barAngle, barBend, stroke, ...e })

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const SVG = (loop, barPath, stroke) => `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="tile"><rect x="16" y="16" width="480" height="480" rx="116"/></clipPath>
    <radialGradient id="bg" cx="0.5" cy="0.5" r="0.62">
      <stop offset="0" stop-color="#191a20"/><stop offset="1" stop-color="#0d0e10"/>
    </radialGradient>
    <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="250">
      <stop offset="0" stop-color="#ffe08a"/><stop offset="0.6" stop-color="#eebe2e"/><stop offset="1" stop-color="#c98d10"/>
    </radialGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#bg)"/>
  <g clip-path="url(#tile)" fill="none" stroke="url(#ink)" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${loop}"/>
    <path d="${barPath}"/>
  </g>
</svg>
`

// Sample evenly across the sweep rather than rendering all of it.
const TARGET = 144
const stride = Math.max(1, Math.floor(combos.length / TARGET))
const chosen = []
for (let i = 0; i < combos.length && chosen.length < TARGET; i += stride) chosen.push(combos[i])

const kept = []
for (const [index, p] of chosen.entries()) {
  const rawLoop = eight(p)
  const rawBar = bar(p)
  const [loopPts, barPts] = fitCentred([rawLoop, rawBar], 196)
  const err = Math.max(c2Error(loopPts), c2Error(barPts))
  const id = `e${String(index + 1).padStart(3, "0")}`
  const src = join(outDir, `${id}.svg`)
  writeFileSync(src, SVG(`${smooth(loopPts)} Z`, smooth(barPts), p.stroke))
  render(src, join(outDir, `${id}-200.png`), 200)
  kept.push({ id, ...p, c2Error: err })
}

writeFileSync(join(outDir, "variants.json"), JSON.stringify(kept, null, 2))
console.log(`${combos.length} combinations -> ${kept.length} rendered`)
console.log(`worst C2 error: ${Math.max(...kept.map((k) => k.c2Error)).toExponential(2)} units`)
