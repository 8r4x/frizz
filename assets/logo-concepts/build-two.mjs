#!/usr/bin/env node
// The approved two-crossing cursive f, made exactly C2 and swept into variants.
//
// The two-crossing topology is what lets the mark be rotationally symmetric at
// all, and the two fit together rather than fighting. Each half of the stroke
// carries ONE loop and ONE crossing, so the crossings are each other's partners
// under a half turn. Splitting the approved mark BETWEEN its crossings — which
// is its own centre of symmetry — and rebuilding it as half + rotation gives an
// exactly symmetric mark that still looks like the approved one.
//
// (Splitting at the arc-length midpoint does NOT work: that point lands inside a
// loop, and rotating that half gives two long bars with stubs on them.)
//
// Variants come from deformations that vary SMOOTHLY with arc length from the
// centre — a growth ramp and a twist — plus global anisotropy and shear. Because
// they depend only on distance along the stroke, and the two halves have
// identical arc-length parameterisation, every one of them preserves C2 exactly.
// Nothing is cut and re-joined, so nothing can kink.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { selfCrossings } from "./crossings.mjs"
import { bezierSample, catmullPath } from "./fit-two.mjs"
import { render } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-two")
const N = 256
const CX = 128
const CY = 128
const WANT = 2
const rad = (d) => (d * Math.PI) / 180

/** The approved mark, split at its own centre of symmetry into two candidate halves. */
function baseHalves() {
  const c = JSON.parse(readFileSync(join(here, "fit/curve-best.json"), "utf8"))
  const dense = bezierSample(c.anchors, 200)
  const xs = selfCrossings(dense)
  if (xs.length !== 2) throw new Error(`approved mark has ${xs.length} crossings, expected 2`)
  const M = [(xs[0][0] + xs[1][0]) / 2, (xs[0][1] + xs[1][1]) / 2]
  let bi = -1
  let bd = Infinity
  for (let i = Math.floor(dense.length * 0.25); i < Math.floor(dense.length * 0.75); i += 1) {
    const d = Math.hypot(dense[i][0] - M[0], dense[i][1] - M[1])
    if (d < bd) {
      bd = d
      bi = i
    }
  }
  const at = dense[bi]
  const shift = (seg) => seg.map(([x, y]) => [x - at[0] + CX, y - at[1] + CY])
  return { lower: shift(dense.slice(bi)), upper: shift(dense.slice(0, bi + 1).reverse()) }
}

/**
 * Deform a half smoothly by distance along the stroke from the centre.
 *
 * `grow` is the scale reached at the tail, ramped with `ease`; `twist` is the
 * rotation reached there. Both are functions of arc length only, so the mark's
 * other half — which has the same arc-length parameterisation — is deformed
 * identically and the symmetry survives untouched.
 */
function deform(half, { grow, twist, ease, aniso, shear }) {
  let len = 0
  const cum = [0]
  for (let i = 1; i < half.length; i += 1) {
    len += Math.hypot(half[i][0] - half[i - 1][0], half[i][1] - half[i - 1][1])
    cum.push(len)
  }
  return half.map(([x, y], i) => {
    const t = Math.pow(cum[i] / len, ease)
    const s = 1 + (grow - 1) * t
    const a = rad(twist) * t
    let dx = (x - CX) * s
    let dy = (y - CY) * s
    const rx = dx * Math.cos(a) - dy * Math.sin(a)
    const ry = dx * Math.sin(a) + dy * Math.cos(a)
    dx = rx * aniso
    dy = ry / aniso
    return [CX + dx + shear * -dy, CY + dy]
  })
}

function mirror(half) {
  const rot = half.map(([x, y]) => [2 * CX - x, 2 * CY - y])
  return [...rot.slice(1).reverse(), ...half]
}

function fitCentred(pts, half = 104) {
  let m = 0
  for (const [x, y] of pts) m = Math.max(m, Math.abs(x - CX), Math.abs(y - CY))
  return pts.map(([x, y]) => [CX + (x - CX) * (half / m), CY + (y - CY) * (half / m)])
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

function signature(pts) {
  const out = []
  for (let i = 0; i < 28; i += 1) out.push(pts[Math.round((i * (pts.length - 1)) / 27)])
  return out
}
const sigDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])))

// ------------------------------------------------------------------ the sweep

const SWEEP = {
  base: ["upper", "lower"],
  grow: [0.72, 0.86, 1, 1.16, 1.34],
  twist: [-34, -17, 0, 17, 34],
  ease: [1, 1.7],
  aniso: [0.88, 1, 1.14],
  shear: [-0.16, 0, 0.16],
  stroke: [7.5, 9.4, 12],
}

const halves = baseHalves()
const combos = []
for (const base of SWEEP.base)
  for (const grow of SWEEP.grow)
    for (const twist of SWEEP.twist)
      for (const ease of SWEEP.ease)
        for (const aniso of SWEEP.aniso)
          for (const shear of SWEEP.shear)
            for (const stroke of SWEEP.stroke) combos.push({ base, grow, twist, ease, aniso, shear, stroke })

const scored = []
const rejected = { crossings: 0 }
for (const p of combos) {
  const pts = fitCentred(mirror(deform(halves[p.base], p)))
  const n = selfCrossings(pts.filter((_, i) => i % 4 === 0)).length
  if (n !== WANT) {
    rejected.crossings += 1
    continue
  }
  scored.push({ params: p, pts, c2: c2Error(pts), sig: signature(pts) })
}

const unique = []
for (const s of scored) {
  if (unique.every((u) => u.params.stroke !== s.params.stroke || sigDist(u.sig, s.sig) > 7)) unique.push(s)
}

const TARGET = 144
const stride = Math.max(1, Math.floor(unique.length / TARGET))
const chosen = []
for (let i = 0; i < unique.length && chosen.length < TARGET; i += stride) chosen.push(unique[i])

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const TILE = (d, stroke) => `<svg width="512" height="512" viewBox="0 0 ${N} ${N}" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="8" width="240" height="240" rx="58" fill="#0d0e10"/>
  <path d="${d}" fill="none" stroke="#efbf2e" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`

const kept = []
for (const [index, s] of chosen.entries()) {
  const id = `t${String(index + 1).padStart(3, "0")}`
  const src = join(outDir, `${id}.svg`)
  writeFileSync(src, TILE(catmullPath(s.pts.filter((_, i) => i % 6 === 0)), s.params.stroke))
  render(src, join(outDir, `${id}-200.png`), 200)
  kept.push({ id, ...s.params, c2Error: s.c2 })
}

writeFileSync(join(outDir, "variants.json"), JSON.stringify(kept, null, 2))
console.log(`${combos.length} combinations -> ${scored.length} with exactly 2 crossings -> ${unique.length} distinct -> ${kept.length} rendered`)
console.log(`rejected for wrong crossing count: ${rejected.crossings}`)
console.log(`worst C2 error: ${Math.max(...kept.map((k) => k.c2Error)).toExponential(2)} units`)
