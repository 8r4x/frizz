#!/usr/bin/env node
// Generates the Frizz logo concept sheet: one SVG per concept, rendered to real
// PNGs at 512/128/64/32/16 so every idea is judged at the size it has to survive.
//
// The 16px rule that shapes every mark: 512 units -> 16px, so 1px = 32 units.
// A stroke below ~50 units dissolves; an ink gap below ~56 units closes up.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out")

const SIZES = [512, 128, 64, 32, 16]
const CASING = "#131519" // matches the tile so an over/under break reads as depth

// ---------------------------------------------------------------- path helpers

/** Catmull-Rom through the points, emitted as cubic beziers. */
function smooth(points) {
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

/** A vertical sine strand: x oscillates as y descends. */
function sineY({ y0, y1, cx, amp, period, phase = 0, steps = 48 }) {
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
function braid({ y0, y1, cx, amp, period, width }) {
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
function bowedRay({ cx, cy, angleDeg, length, bow, steps = 12 }) {
  const a = (angleDeg * Math.PI) / 180
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
function corkscrew({ r, c, a, turns, steps = 140 }) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = (turns * 2 * Math.PI * i) / steps
    points.push([r * Math.sin(t), c * t - a * Math.cos(t)])
  }
  return points
}

/** Scale and centre a point list into a box, preserving aspect. */
function fit(points, { left, top, right, bottom }) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const k = Math.min((right - left) / (maxX - minX), (bottom - top) / (maxY - minY))
  const dx = (left + right) / 2 - ((minX + maxX) / 2) * k
  const dy = (top + bottom) / 2 - ((minY + maxY) / 2) * k
  return smooth(points.map(([x, y]) => [x * k + dx, y * k + dy]))
}

// ------------------------------------------------------------------- concepts
// `mark` is the inner SVG for the glyph. Stroked paths inherit the gradient and
// round caps from the wrapping <g>.

const concepts = [
  {
    id: "fan",
    name: "Fan",
    tagline: "One prompt becomes many agents",
    idea: "The product's core motion read bottom-up — a single trunk splitting into three that sweep out and away.",
    small: "Holds. Tips sit 136 units apart on a 54 stroke, so the gaps stay above 2px.",
    risk: "The most expected shape in the set. A Y-with-branches is close to a rune and to a dozen other dev-tool marks.",
    mark: `
      <path d="M256 428 V292" stroke-width="54"/>
      <path d="M256 302 C256 216 208 178 120 148" stroke-width="54"/>
      <path d="M256 302 V116" stroke-width="54"/>
      <path d="M256 302 C256 216 304 178 392 148" stroke-width="54"/>`,
  },
  {
    id: "converge",
    name: "Converge",
    tagline: "Many agents come back to one queue",
    idea: "The truer half of Frizz. Work fans out, but the whole point of the app is that it all returns to one place you read top to bottom. Three strands run parallel, then merge low into a single root.",
    small: "Holds, and better than the fan — three parallel bars merging is a stable silhouette.",
    risk: "Splaying the arms straight makes it an aeroplane; the merge has to stay low and the bend has to stay soft.",
    mark: `
      <path d="M120 108 V208 C120 296 256 268 256 348" stroke-width="54"/>
      <path d="M256 108 V428" stroke-width="54"/>
      <path d="M392 108 V208 C392 296 256 268 256 348" stroke-width="54"/>`,
  },
  {
    id: "curl",
    name: "Curl",
    tagline: "Frizz, literally — one strand curling",
    idea: "A closed loop and one tail sweeping the other way — a tendril, not a numeral.",
    small: "Holds. The counter is 132 units across, so the hole stays open — though at exactly 16px it reads as a notch rather than a clean round hole.",
    risk: "Drawn with the tail on the loop's left it is unmistakably a 6, and no amount of tilt fixes that. The tail has to leave from the right and sweep back across, which is the whole design.",
    mark: `
      <g transform="rotate(18 256 256)">
        <circle cx="256" cy="326" r="94" stroke-width="56" fill="none"/>
        <path d="M350 320 C360 212 306 142 178 112" stroke-width="56"/>
      </g>`,
  },
  {
    id: "knot",
    name: "Knot",
    tagline: "Two strands, tied",
    idea: "A single overhand loop with two tails crossing below it. The one mark here with genuine craft in it at hero size.",
    small: "Fails. The crossings merge and the two tails close up into a capital A. Measured, not predicted — the 16px render is below.",
    risk: "Meaning fights the product: a knot says tangled and stuck, which is the state Frizz exists to prevent.",
    mark: `
      <path d="M166 426 V308 C166 214 268 186 302 250 C328 300 264 344 232 300" stroke-width="54"/>
      <path d="M346 426 V308 C346 214 244 186 210 250 C184 300 248 344 280 300" stroke="${CASING}" stroke-width="76"/>
      <path d="M346 426 V308 C346 214 244 186 210 250 C184 300 248 344 280 300" stroke-width="54"/>`,
  },
  {
    id: "twist",
    name: "Twist",
    tagline: "Parallel work, one cord",
    idea: "Two strands running in parallel and staying wound together — a real over-under weave, not two mirrored waves.",
    small: "Marginal. The casings close up as intended, but what is left is a knobbly column closer to a dollar sign than a cord.",
    risk: "Antiphase strands of equal weight make lens shapes that read as a stack of 8s; the alternating weave is what stops that.",
    mark: braid({ y0: 116, y1: 400, cx: 256, amp: 62, period: 184, width: 52 }),
  },
  {
    id: "spark",
    name: "Spark",
    tagline: "Frizz as static — everything going at once",
    idea: "Six bowed fibres from a common origin. Bowed, not straight, so it reads as hair with a charge in it rather than a sparkle or an asterisk.",
    small: "Holds. Radial symmetry is the friendliest thing you can hand a 16px box — there is no wrong orientation and no dead corner.",
    risk: "Busiest mark here. Too much bow and it turns into an octopus.",
    mark: [90, 150, 210, 270, 330, 30]
      .map((a, i) => `<path d="${bowedRay({ cx: 256, cy: 256, angleDeg: a, length: i % 2 ? 142 : 174, bow: 22 })}" stroke-width="52"/>`)
      .join("\n      "),
  },
  {
    id: "lanes",
    name: "Lanes",
    tagline: "Three threads running; one needs you",
    idea: "The queue insight as a picture — most threads run clean, one has gone wild and wants your attention. The only concept that encodes the app's job rather than its subject matter.",
    small: "Holds, but the story does not: at 16px the curl is a bump on a bar and the mark reads as three tallies.",
    risk: "Needs the curl to be extreme to survive, and extreme unbalances the mark at hero size.",
    mark: `
      <path d="M140 400 V136" stroke-width="52"/>
      <path d="M250 400 V136" stroke-width="52"/>
      <path d="M360 400 V266 C360 176 434 168 434 232" stroke-width="52"/>`,
  },
  {
    id: "looseend",
    name: "Loose end",
    tagline: "A single strand, curling free",
    idea: "Maximum legibility: one element, a 74 stroke, a 74-unit counter under the hook, tilted so the return leg falls at an angle.",
    small: "The most robust mark here by a distance — one element, nothing that can fuse, one counter and it is 74 units wide.",
    risk: "Upright it is a candy cane. Even tilted it is quiet — there is very little idea in it.",
    mark: `
      <g transform="rotate(-18 256 256)">
        <path d="M202 424 V226 A74 74 0 0 1 350 226 V304" stroke-width="74"/>
      </g>`,
  },
  {
    id: "monogram",
    name: "Monogram",
    tagline: "F, drawn in fibre",
    idea: "A wordmark-adjacent option: the arms end in curls rather than square cuts, so the letter carries the texture of the name.",
    small: "Holds as an F, though it drifts toward a P at the smallest size.",
    risk: "Safest identity play, least idea in it — and a letterform ties the mark to the name, so it cannot outlive a second rename.",
    mark: `
      <path d="M180 404 V128" stroke-width="56"/>
      <path d="M180 150 H318 C354 150 360 120 346 100" stroke-width="56"/>
      <path d="M180 270 H288 C312 270 316 250 310 236" stroke-width="56"/>`,
  },
  {
    id: "stack",
    name: "Stack",
    tagline: "The queue itself",
    idea: "Honest about what you actually look at all day — a stack of cards receding upward. Widths taper so it reads as depth, not as a menu.",
    small: "Very legible and completely generic. Three rows leave only 1.9px of gap, so it is also the concept the 16px rule punishes hardest.",
    risk: "One notch away from a hamburger icon, and it depicts the container rather than the brand.",
    mark: `
      <path d="M132 372 H380" stroke-width="54"/>
      <path d="M156 256 H356" stroke-width="54"/>
      <path d="M180 140 H332" stroke-width="54"/>`,
  },
  {
    id: "plume",
    name: "Plume",
    tagline: "One root, swept",
    idea: "The fan with weather in it. Asymmetry gives the mark a direction and some personality the symmetric options do not have.",
    small: "Holds. The sweep survives because all three strands share one side.",
    risk: "Reads botanical — a wheat sheaf or a sprout — which is a whole other brand.",
    mark: `
      <path d="M244 430 C244 336 214 262 188 210 C168 170 162 148 166 126" stroke-width="54"/>
      <path d="M244 430 C244 330 246 244 262 186 C274 142 282 118 288 100" stroke-width="54"/>
      <path d="M244 430 C246 334 268 258 306 202 C334 160 356 142 386 128" stroke-width="54"/>`,
  },
  {
    id: "coil",
    name: "Coil",
    tagline: "Frizz as a texture, not an object",
    idea: "A curly-cord corkscrew — two real loops, not a wave. The most literal picture of the word, and the least literal about the product.",
    small: "Fails, and it is the only outright failure in the set. Two loops inside 288 units leaves ~30 units of counter — under 1px — so at 16px the holes fill and it becomes a lump. Shown unfudged.",
    risk: "The arithmetic kills it: any coil with more than one turn cannot clear the 2px counter floor at favicon size. This direction is off the table unless the favicon is allowed to be a different, simpler mark than the logo.",
    mark: `<path d="${fit(corkscrew({ r: 76, c: 30, a: 92, turns: 2 }), { left: 132, top: 104, right: 380, bottom: 408 })}" stroke-width="54"/>`,
  },
  {
    id: "serpentine",
    name: "Serpentine",
    tagline: "Many threads, one continuous line",
    idea: "The queue drawn honestly: not a stack of separate cards but one thread laid back and forth, because that is what working a queue top to bottom actually is. Same silhouette as Stack, with a reason behind it.",
    small: "Holds at 1.75px of gap, same as Stack — and unlike Stack the connected ends stop it reading as a menu icon.",
    risk: "The idea only lands at hero size. Small, it is a stack of bars with the ends joined, and nobody reads the join.",
    mark: `<path d="M148 148 H316 A56 56 0 0 1 316 260 H196 A56 56 0 0 0 196 372 H364" stroke-width="54"/>`,
  },
  {
    id: "tuft",
    name: "Tuft",
    tagline: "One thread, two curls",
    idea: "A stem that splits into two outward curls. Outward curls are the single most unmistakable signal of frizz, and two of them make a face-like, friendly mark.",
    small: "Holds if the curl radius stays at 68 or above; below that the counters seal shut.",
    risk: "Symmetrical curls can tip into horns or a moustache depending on the weight.",
    mark: `
      <path d="M256 428 V310" stroke-width="52"/>
      <path d="M256 322 C256 236 214 168 156 180 C110 190 108 258 158 262" stroke-width="52"/>
      <path d="M256 322 C256 236 298 168 356 180 C402 190 404 258 354 262" stroke-width="52"/>`,
  },
  {
    id: "flick",
    name: "Flick",
    tagline: "A single strand with weight in it",
    idea: "The only tapered mark here — drawn as a filled shape, thick at the root and thinning as it curls. Tapering is what separates a drawn logo from a stroked one, and it is where the craft shows.",
    small: "Survives because the taper stops early: the tip stays 44 units wide, which is 1.4px, rather than running to a point.",
    risk: "A taper is the one thing that cannot be authored as a uniform stroke, so this mark is the most expensive to maintain and to redraw at other weights.",
    mark: `
      <path d="M206 428 C196 296 214 206 272 150 C310 112 358 100 396 114 C410 120 412 140 400 150 C368 160 330 170 300 200 C256 244 250 312 306 428 Z" fill="url(#ink)" stroke="none"/>`,
  },
]

// --------------------------------------------------------------------- render

function svg(concept) {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#191a20"/>
      <stop offset="1" stop-color="#0d0e10"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.44" r="0.5">
      <stop offset="0" stop-color="#e8b923" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#e8b923" stop-opacity="0"/>
    </radialGradient>
    <!-- userSpaceOnUse, not the default objectBoundingBox: a purely vertical or
         horizontal path has a zero-area bounding box, which makes a bbox
         gradient undefined and drops the element entirely. -->
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="120" y1="80" x2="400" y2="430">
      <stop offset="0" stop-color="#ffdf7f"/>
      <stop offset="0.52" stop-color="#e8b923"/>
      <stop offset="1" stop-color="#c2870f"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#bg)"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="115.5" fill="none" stroke="#2b2e35"/>
  <circle cx="256" cy="228" r="205" fill="url(#glow)"/>
  <g fill="none" stroke="url(#ink)" stroke-linecap="round" stroke-linejoin="round">
      ${concept.mark.trim()}
  </g>
</svg>
`
}

function render(source, output, size) {
  const result = spawnSync("rsvg-convert", ["-w", String(size), "-h", String(size), source, "-o", output], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || `rsvg-convert exited ${result.status}`)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const concept of concepts) {
  const source = join(outDir, `${concept.id}.svg`)
  writeFileSync(source, svg(concept))
  for (const size of SIZES) render(source, join(outDir, `${concept.id}-${size}.png`), size)
}

// The outgoing mark, rendered through the same pipeline so the before/after
// comparison in the artifact is like for like.
const currentIcon = join(here, "../../packages/web/public/favicon.svg")
for (const size of SIZES) render(currentIcon, join(outDir, `current-${size}.png`), size)

writeFileSync(join(outDir, "concepts.json"), JSON.stringify(concepts, null, 2))
console.log(`${concepts.map((c) => c.id).join(" ")}`)
console.log(`generated ${concepts.length} concepts x ${SIZES.length} sizes`)
