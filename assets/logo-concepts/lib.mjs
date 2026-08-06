// Shared geometry and rendering for the logo concept sheets.
//
// The 16px rule that shapes every mark: 512 units -> 16px, so 1px = 32 units.
// A stroke below ~50 units dissolves; an ink gap below ~56 units closes up.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export const SIZES = [512, 128, 64, 32, 16]
export const CASING = "#131519" // matches the tile so an over/under break reads as depth

// ---------------------------------------------------------------- path helpers

/** Catmull-Rom through the points, emitted as cubic beziers. */
export function smooth(points) {
  const p = points
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`
  for (let i = 0; i < p.length - 1; i += 1) {
    const p0 = p[i - 1] ?? p[i]
    const p1 = p[i]
    const p2 = p[i + 1]
    const p3 = p[i + 2] ?? p[i + 1]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  return d
}

const rad = (deg) => (deg * Math.PI) / 180

/** Points along a circular arc. Angles in degrees, 0 = east, growing clockwise (y is down). */
export function arcPts(cx, cy, r, a0, a1, steps = Math.max(6, Math.round(Math.abs(a1 - a0) / 9))) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const a = rad(a0 + ((a1 - a0) * i) / steps)
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return points
}

/** A vertical sine strand: x oscillates as y descends. */
export function sineY({ y0, y1, cx, amp, period, phase = 0, steps = 48 }) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const y = y0 + ((y1 - y0) * i) / steps
    points.push([cx + amp * Math.sin((2 * Math.PI * (y - y0)) / period + phase), y])
  }
  return smooth(points)
}

/**
 * Two strands wound into a braid. Strand A is laid over B everywhere, then the
 * short segments of B that belong on top are redrawn with a casing. At 16px the
 * casings close up and the pair reads as one thick cord, which is the point.
 */
export function braid({ y0, y1, cx, amp, period, width }) {
  const a = { y0, y1, cx, amp, period, phase: 0 }
  const b = { ...a, phase: Math.PI }
  const cased = (d) => `<path d="${d}" stroke="${CASING}" stroke-width="${width + 16}"/>
      <path d="${d}" stroke-width="${width}"/>`
  const parts = [`<path d="${sineY(b)}" stroke-width="${width}"/>`, cased(sineY(a))]
  // Crossings sit a quarter period in, then every half period. Put B over A at
  // every other one so the weave alternates.
  for (let k = 1; y0 + period / 4 + (k * period) / 2 < y1; k += 2) {
    const yc = y0 + period / 4 + (k * period) / 2
    const span = period * 0.34
    parts.push(cased(sineY({ ...b, y0: Math.max(y0, yc - span), y1: Math.min(y1, yc + span), steps: 20 })))
  }
  return parts.join("\n      ")
}

/** A ray from the centre that bows tangentially, so it reads as a fibre not a spike. */
export function bowedRay({ cx, cy, angleDeg, length, bow, steps = 12 }) {
  const a = rad(angleDeg)
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const r = length * t
    const off = bow * Math.sin(Math.PI * t) * t
    points.push([cx + r * Math.cos(a) - off * Math.sin(a), cy + r * Math.sin(a) + off * Math.cos(a)])
  }
  return smooth(points)
}

/**
 * A curly-cord corkscrew. `a > c` makes dy/dt change sign, so the strand doubles
 * back into real loops instead of degenerating into a sine wave.
 */
export function corkscrew({ r, c, a, turns, steps = 140 }) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = (turns * 2 * Math.PI * i) / steps
    points.push([r * Math.sin(t), c * t - a * Math.cos(t)])
  }
  return points
}

/** Points along an elliptical arc — a cursive loop is taller than it is wide. */
export function ellipsePts(cx, cy, rx, ry, a0, a1, steps = Math.max(8, Math.round(Math.abs(a1 - a0) / 8))) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const a = rad(a0 + ((a1 - a0) * i) / steps)
    points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return points
}

/** Points along a straight segment, excluding the start (so segments chain cleanly). */
export function linePts([x0, y0], [x1, y1], steps = 6) {
  const points = []
  for (let i = 1; i <= steps; i += 1) {
    points.push([x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps])
  }
  return points
}

/** Drop consecutive duplicate points so a chained spine has no zero-length steps. */
export function chain(...segments) {
  const out = []
  for (const p of segments.flat()) {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.01) out.push(p)
  }
  return out
}

/** Rotate a point list 180 degrees about a centre. */
export function rotate180(points, cx = 256, cy = 256) {
  return points.map(([x, y]) => [2 * cx - x, 2 * cy - y])
}

/**
 * Build a 180-degree rotationally symmetric stroke from one half.
 *
 * `half` must START at the centre of symmetry and run outwards. The returned
 * spine is the half's own 180-degree image, reversed, then the half itself — one
 * continuous curve through the centre that maps onto itself under C2. Deriving
 * the second half rather than hand-placing it is the only way to be sure: an
 * eyeballed opposite end is always a little off, and a little off is exactly
 * what reads as "not symmetric".
 */
export function c2(half, cx = 256, cy = 256) {
  return [...rotate180(half, cx, cy).slice(1).reverse(), ...half]
}

/** Scale and centre a point list into a box, preserving aspect. */
export function fit(points, { left, top, right, bottom }) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const k = Math.min((right - left) / (maxX - minX), (bottom - top) / (maxY - minY))
  const dx = (left + right) / 2 - ((minX + maxX) / 2) * k
  const dy = (top + bottom) / 2 - ((minY + maxY) / 2) * k
  return points.map(([x, y]) => [x * k + dx, y * k + dy])
}

/**
 * A broad-nib calligraphic stroke, emitted as a closed filled outline.
 *
 * A real nib is a flat edge held at a fixed angle: the stroke is widest where
 * the direction of travel runs across the nib and narrowest where it runs along
 * it. `wMin` is a floor the physical model does not have — without it the thins
 * go to zero, and a zero-width thin is invisible long before 16px.
 */
export function nibRibbon(points, { penAngle = -35, wMax = 100, wMin = 54, taper = 12, closed = false }) {
  const pen = rad(penAngle)
  const left = []
  const right = []
  // Smooth the tangent over a window: sampling one neighbour on each side makes
  // the width jitter wherever the spine's point spacing changes, which is what
  // turns a nib stroke into a lumpy ribbon.
  const span = 3
  // On a CLOSED spine the window has to wrap. Clamping it at the ends treats the
  // spine's first point differently from every other point, and on a symmetric
  // curve that one discrepancy sits opposite an ordinary point — enough to make
  // a mark that is symmetric by construction measure asymmetric.
  const n = closed ? points.length - 1 : points.length
  const at = (j) => (closed ? points[((j % n) + n) % n] : points[Math.min(points.length - 1, Math.max(0, j))])
  for (let i = 0; i < points.length; i += 1) {
    const prev = at(i - span)
    const next = at(i + span)
    const theta = Math.atan2(next[1] - prev[1], next[0] - prev[0])
    const w = wMin + (wMax - wMin) * Math.abs(Math.sin(theta - pen))
    // Ease the ends into a pen lift over `taper` samples. taper = 0 means no
    // lift at all, which is what a CLOSED spine wants — it has no ends, and
    // dividing by zero here NaNs every coordinate and silently empties the path.
    const t = taper > 0 ? Math.min(1, Math.min(i, points.length - 1 - i) / taper) : 1
    const scale = 0.42 + 0.58 * (1 - Math.cos((t * Math.PI) / 2))
    const nx = -Math.sin(theta) * ((w * scale) / 2)
    const ny = Math.cos(theta) * ((w * scale) / 2)
    left.push([points[i][0] + nx, points[i][1] + ny])
    right.push([points[i][0] - nx, points[i][1] - ny])
  }
  if (closed) {
    // Two closed rings — the outer and inner edges of the ribbon — filled with
    // the even-odd rule so the counters stay open.
    return `${smooth(left)} Z ${smooth(right.reverse())} Z`
  }
  const tail = right[right.length - 1]
  return `${smooth(left)} L${tail[0].toFixed(1)} ${tail[1].toFixed(1)} ${smooth(right.reverse()).slice(1)} Z`
}

/** Resample a spine to roughly even spacing, so width models track arc length. */
export function resample(points, step = 6) {
  const out = [points[0]]
  let carry = 0
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 1e-6) continue
    for (let d = step - carry; d < len; d += step) {
      out.push([x0 + ((x1 - x0) * d) / len, y0 + ((y1 - y0) * d) / len])
    }
    carry = (carry + len) % step
  }
  out.push(points[points.length - 1])
  return out
}

// --------------------------------------------------------------------- render

export function svg(concept) {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- The tile's own top-to-bottom gradient reverses under a half turn just as
         the ink's does. A symmetric mark on an asymmetric tile still measures
         asymmetric, so the tile gets a centred radial too. -->
    ${
      concept.symmetric
        ? `<radialGradient id="bg" cx="0.5" cy="0.5" r="0.62">
      <stop offset="0" stop-color="#191a20"/>
      <stop offset="1" stop-color="#0d0e10"/>
    </radialGradient>`
        : `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#191a20"/>
      <stop offset="1" stop-color="#0d0e10"/>
    </linearGradient>`
    }
    <radialGradient id="glow" cx="0.5" cy="${concept.symmetric ? "0.5" : "0.44"}" r="0.5">
      <stop offset="0" stop-color="#e8b923" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#e8b923" stop-opacity="0"/>
    </radialGradient>
    <!-- userSpaceOnUse, not the default objectBoundingBox: a purely vertical or
         horizontal path has a zero-area bounding box, which makes a bbox
         gradient undefined and drops the element entirely.
         A linear gradient reverses under a 180-degree rotation, so a mark that
         claims rotational symmetry cannot wear one — it gets a radial fill
         centred on the canvas instead, which is C2 by construction. -->
    ${
      concept.symmetric
        ? `<radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="230">
      <stop offset="0" stop-color="#ffdf7f"/>
      <stop offset="0.62" stop-color="#eabe2c"/>
      <stop offset="1" stop-color="#cf9412"/>
    </radialGradient>`
        : `<linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="120" y1="80" x2="400" y2="430">
      <stop offset="0" stop-color="#ffdf7f"/>
      <stop offset="0.52" stop-color="#e8b923"/>
      <stop offset="1" stop-color="#c2870f"/>
    </linearGradient>`
    }
  </defs>
  ${
    concept.invert
      ? `<rect x="16" y="16" width="480" height="480" rx="116" fill="url(#ink)"/>
  <g fill="none" stroke="#141518" stroke-linecap="round" stroke-linejoin="round">
      ${concept.mark.trim()}
  </g>`
      : `<rect x="16" y="16" width="480" height="480" rx="116" fill="url(#bg)"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="115.5" fill="none" stroke="#2b2e35"/>
  <circle cx="256" cy="${concept.symmetric ? 256 : 228}" r="205" fill="url(#glow)"/>
  <g fill="none" stroke="url(#ink)" stroke-linecap="round" stroke-linejoin="round">
      ${concept.mark.trim()}
  </g>`
  }
</svg>
`
}

export function render(source, output, size) {
  const result = spawnSync("rsvg-convert", ["-w", String(size), "-h", String(size), source, "-o", output], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `rsvg-convert exited ${result.status}`)
}

/**
 * Measure how rotationally symmetric a render actually is: RMSE between the
 * image and its own 180-degree rotation, normalised to 0..1. A mark built to be
 * C2 should come back at essentially zero, and anything that only looks
 * symmetric will not. Claiming symmetry is worthless; this is checkable.
 */
export function symmetryError(png) {
  const rotated = `${png}.rot180.png`
  const turn = spawnSync("magick", [png, "-rotate", "180", rotated], { encoding: "utf8" })
  if (turn.status !== 0) throw new Error(turn.stderr || "rotate failed")
  // `compare` exits non-zero when the images differ, which is the normal case
  // here — read the metric off stderr rather than trusting the exit status.
  const cmp = spawnSync("magick", ["compare", "-metric", "RMSE", png, rotated, "null:"], { encoding: "utf8" })
  rmSync(rotated, { force: true })
  const match = /\(([\d.eE+-]+)\)/.exec(cmp.stderr ?? "")
  if (!match) throw new Error(`could not parse RMSE from: ${cmp.stderr}`)
  return Number(match[1])
}

/** Render every concept at every size into a fresh directory, plus concepts.json. */
export function buildAll(concepts, outDir, extras = []) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const concept of concepts) {
    const source = join(outDir, `${concept.id}.svg`)
    writeFileSync(source, svg(concept))
    for (const size of SIZES) render(source, join(outDir, `${concept.id}-${size}.png`), size)
    concept.symmetryError = symmetryError(join(outDir, `${concept.id}-512.png`))
  }
  for (const [name, source] of extras) {
    for (const size of SIZES) render(source, join(outDir, `${name}-${size}.png`), size)
  }
  writeFileSync(join(outDir, "concepts.json"), JSON.stringify(concepts, null, 2))
  return concepts.length
}
