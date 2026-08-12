#!/usr/bin/env node
// Variants of the fff row: spacing and outer tail length as INDEPENDENT knobs.
//
// In the first version one number did both jobs — trimming the connecting tails
// set the spacing, and whatever was left over became the outer tails, so they
// could not be chosen separately. Here:
//
//   gap   how much arc length is cut from BOTH ends of each inner copy. This
//         alone sets the pitch, because each copy's start tip lands on the
//         previous copy's end tip.
//   tail  the outer free ends, as a multiple of the glyph's own tail. Below 1 it
//         is cut back along the curve; above 1 it is extended straight along the
//         end tangent, which is where that stroke is already heading, so the
//         extension does not read as a joint.
//
// Trim before levelling. Levelling first and cutting after leaves the two ends
// of a copy at different heights, and translating horizontally then steps down
// at every join.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { selfCrossings } from "./crossings.mjs"
import { bezierSample, catmullPath } from "./fit-two.mjs"
import { render } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-fff")
const REPEATS = Number(process.env.REPEATS ?? 3)
const { stroke: BASE_STROKE, anchors } = JSON.parse(readFileSync(join(here, "final/anchors.json"), "utf8"))

const dense = bezierSample(anchors, 400)
const cum = [0]
for (let i = 1; i < dense.length; i += 1) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]))
const L = cum[cum.length - 1]
const idxAt = (len) => {
  let lo = 0
  let hi = cum.length - 1
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (cum[m] < len) lo = m + 1
    else hi = m
  }
  return lo
}

/** Extend a polyline beyond `pts[0]`, straight along the direction it arrives from. */
function extendStart(pts, extra) {
  if (extra <= 0) return pts
  const [x0, y0] = pts[0]
  const [x1, y1] = pts[Math.min(6, pts.length - 1)]
  const n = Math.hypot(x0 - x1, y0 - y1) || 1
  const dx = (x0 - x1) / n
  const dy = (y0 - y1) / n
  const add = []
  const steps = Math.max(2, Math.round(extra / 4))
  for (let i = steps; i >= 1; i -= 1) add.push([x0 + dx * extra * (i / steps), y0 + dy * extra * (i / steps)])
  return [...add, ...pts]
}

function build({ gap, tail, stroke }) {
  const a = idxAt(L * gap)
  // Mirror the index rather than looking it up again: idxAt(L*gap) and
  // idxAt(L*(1-gap)) can land a sample apart, and that alone desymmetrised the
  // row by up to half a unit.
  const b = dense.length - 1 - a
  // Level the TRIMMED ends so the row runs along a baseline.
  const ang = -Math.atan2(dense[b][1] - dense[a][1], dense[b][0] - dense[a][0])
  const ca = Math.cos(ang)
  const sa = Math.sin(ang)
  const spin = ([x, y]) => [256 + (x - 256) * ca - (y - 256) * sa, 256 + (x - 256) * sa + (y - 256) * ca]
  const rot = dense.map(spin)

  const naturalTail = cum[a]
  let head = rot.slice(0, a + 1)
  if (tail < 1) head = head.slice(idxAt(naturalTail * (1 - tail)))
  else if (tail > 1) head = extendStart(head, naturalTail * (tail - 1))
  // The far end is the head's exact 180-degree image about the glyph's centre,
  // which rotation about that same centre leaves in place. Building it
  // separately invites the two ends to differ by a rounded index.
  const end = head.map(([x, y]) => [512 - x, 512 - y]).reverse()

  const core = rot.slice(a, b + 1)
  const pitch = core[core.length - 1][0] - core[0][0]
  const shift = (pts, dx) => pts.map(([x, y]) => [x + dx, y])
  let row = [...head]
  for (let i = 0; i < REPEATS; i += 1) row = [...row, ...shift(core, pitch * i).slice(1)]
  row = [...row, ...shift(end, pitch * (REPEATS - 1)).slice(1)]
  return { row, pitch, stroke }
}

function c2Error(row) {
  const cx = (row[0][0] + row[row.length - 1][0]) / 2
  const cy = (row[0][1] + row[row.length - 1][1]) / 2
  let worst = 0
  for (let i = 0; i < row.length; i += 1) {
    const p = row[i]
    const q = row[row.length - 1 - i]
    worst = Math.max(worst, Math.hypot(p[0] - (2 * cx - q[0]), p[1] - (2 * cy - q[1])))
  }
  return worst
}

const SWEEP = {
  gap: [0.04, 0.07, 0.09, 0.11, 0.122],
  tail: [0.25, 0.55, 1, 1.5, 2.1],
  stroke: [BASE_STROKE * 0.7, BASE_STROKE, BASE_STROKE * 1.35],
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const kept = []
let rejected = 0
let index = 0
for (const stroke of SWEEP.stroke)
  for (const gap of SWEEP.gap)
    for (const tail of SWEEP.tail) {
      const { row, pitch } = build({ gap, tail, stroke })
      const crossings = selfCrossings(row.filter((_, i) => i % 3 === 0)).length
      if (crossings !== 2 * REPEATS) {
        rejected += 1
        continue
      }
      index += 1
      const id = `f${String(index).padStart(3, "0")}`
      const xs = row.map((p) => p[0])
      const ys = row.map((p) => p[1])
      const pad = stroke / 2 + 16
      const box = {
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        w: Math.max(...xs) - Math.min(...xs) + pad * 2,
        h: Math.max(...ys) - Math.min(...ys) + pad * 2,
      }
      const d = catmullPath(row.filter((_, i) => i % 10 === 0))
      const src = join(outDir, `${id}.svg`)
      writeFileSync(src, `<svg width="${Math.round(box.w)}" height="${Math.round(box.h)}" viewBox="${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">
  <defs><radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="${(box.x + box.w / 2).toFixed(1)}" cy="${(box.y + box.h / 2).toFixed(1)}" r="${(box.w / 2).toFixed(1)}">
    <stop offset="0" stop-color="#ffdf7f"/><stop offset="0.62" stop-color="#eabe2c"/><stop offset="1" stop-color="#cf9412"/>
  </radialGradient></defs>
  <rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${box.w.toFixed(1)}" height="${box.h.toFixed(1)}" fill="#0d0e10"/>
  <path d="${d}" fill="none" stroke="url(#ink)" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`)
      render(src, join(outDir, `${id}-480.png`), 480)
      kept.push({
        id,
        gap,
        tail,
        stroke: Number(stroke.toFixed(2)),
        pitch: Number(pitch.toFixed(1)),
        aspect: Number((box.w / box.h).toFixed(2)),
        c2Error: c2Error(row),
      })
    }

writeFileSync(join(outDir, "variants.json"), JSON.stringify(kept, null, 2))
console.log(`${kept.length} rendered, ${rejected} rejected for wrong crossing count`)
console.log(`pitch ${Math.min(...kept.map((k) => k.pitch)).toFixed(0)}..${Math.max(...kept.map((k) => k.pitch)).toFixed(0)}, aspect ${Math.min(...kept.map((k) => k.aspect)).toFixed(2)}..${Math.max(...kept.map((k) => k.aspect)).toFixed(2)}`)
console.log(`worst C2 error: ${Math.max(...kept.map((k) => k.c2Error)).toExponential(2)} units`)
