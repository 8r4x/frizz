#!/usr/bin/env node
// The written cursive f, built to be 180-degree rotationally symmetric.
//
// C2 is not a decoration bolted onto this letterform, it is what the letterform
// already is: two loops crossing once at a waist ARE point reflections of each
// other through that crossing. Everything here is therefore derived from one
// half and rotated, never hand-placed twice — and every render is measured
// against its own 180-degree rotation, with the error reported on the sheet.
//
// Four things break C2 if you let them, and all four were in the previous draft:
//   1. an ascender/descender size difference
//   2. a crossbar whose halves are not exact rotations of each other
//   3. a linear ink gradient, which reverses under rotation
//   4. a background glow centred anywhere but the middle of the canvas

import { writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildAll, c2, nibRibbon, render, smooth, svg, symmetryError } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-sig")

const CX = 256
const CY = 256 // the symmetry centre must be the canvas centre, or the RENDER is not C2

/**
 * The f's body as a sheared Gerono figure-eight, centred on the canvas.
 *
 *   x = CX + A·sin(2t)/2 + S·(CY − y)      y = CY − B·cos(t)
 *
 * C2 holds exactly: mapping t → π−t negates both x−CX and y−CY, so the curve is
 * its own 180-degree rotation. The shear is a linear map about the centre and
 * linear maps commute with point reflection, so shearing preserves it — which is
 * why the letter can lean like handwriting and still be perfectly symmetric.
 *
 * `A` is loop width and `B` half-height. A:B is the whole game: written loops
 * run about 3:1 tall, and anything squatter than ~2:1 reads as an 8.
 */
function figure8({ A = 68, B = 176, S = 0.3, t0 = 0, t1 = 2 * Math.PI, steps = 240 } = {}) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + ((t1 - t0) * i) / steps
    const y = CY - B * Math.cos(t)
    points.push([CX + (A * Math.sin(2 * t)) / 2 + S * (CY - y), y])
  }
  return points
}

const body = (opts) => smooth(figure8(opts))

// Crossbars are built as ONE half running out from the centre; c2() supplies the
// other half as an exact rotation. Hand-placing both ends is what put the last
// draft's bar 15 units off centre.
const barRising = c2([[256, 256], [300, 248], [352, 238], [412, 230]], CX, CY)
const barLong = c2([[256, 256], [310, 250], [372, 240], [446, 234]], CX, CY)
const barFlat = c2([[256, 256], [312, 254], [368, 250], [428, 248]], CX, CY)
// A crossbar that is itself an S-curve: still exactly C2, and it echoes the
// body's own curvature instead of cutting across it.
const barSwash = c2([[256, 256], [306, 242], [356, 244], [408, 262], [446, 258]], CX, CY)

const FINE = 22

const concepts = [
  {
    id: "sig-c2",
    name: "Signature",
    rank: "pick",
    symmetric: true,
    tagline: "The written f, exactly symmetric under a half turn",
    idea: "Two narrow loops crossing once at the waist, with a rising crossbar through the centre. The ascender and descender are the same loop rotated 180 degrees — not two similar loops drawn twice — and the crossbar's halves are derived the same way. Turn the tile upside down and nothing changes.",
    small: "Fails at this weight. A 22-unit line is 0.69px at 16px and the 68-wide loops leave 46 units of counter, 1.4px. Both under the floor. This is a logo weight.",
    risk: "Symmetry costs the letter some handwriting: a real hand makes the descender bigger than the ascender, and forbidding that makes the f slightly more mechanical than the reference.",
    verdict: "The mark, at the size it is meant for. Measured symmetry error is on the card.",
    mark: `<path d="${body()}" stroke-width="${FINE}"/>
      <path d="${smooth(barRising)}" stroke-width="${FINE}"/>`,
  },
  {
    id: "sig-c2-swash",
    name: "Signature, swash bar",
    rank: "pick",
    symmetric: true,
    tagline: "The crossbar curved to echo the loops",
    idea: "Same body, but the bar is an S-curve rather than a straight rise — built from one half and rotated, so it stays exactly C2. It follows the body's curvature instead of cutting across it, which is closer to how the reference's bar actually moves.",
    small: "Fails at this weight, like every fine variant.",
    risk: "The curved bar reads as a flourish rather than structure, so the letter leans further from an f and closer to an ornament.",
    verdict: "The prettiest of the fine set, and the one that most looks drawn rather than constructed.",
    mark: `<path d="${body()}" stroke-width="${FINE}"/>
      <path d="${smooth(barSwash)}" stroke-width="${FINE}"/>`,
  },
  {
    id: "sig-c2-contrast",
    name: "Signature, pen contrast",
    rank: "pick",
    symmetric: true,
    tagline: "Thick where the pen presses — and still symmetric",
    idea: "The same spine through a broad-nib model. A nib is C2-safe by luck of the maths: rotating a stroke 180 degrees reverses its tangent, and the nib's width depends on the sine of the angle between tangent and pen, which is unchanged by that reversal. So the contrast rotates with the letter.",
    small: "Fails at this weight, but fails last — the heavy outsides of the loops are the final thing to survive.",
    risk: "Contrast has to be redrawn for every weight; you cannot restroke your way to a bolder version.",
    verdict: "Closest to the reference's actual texture, and the same symmetry guarantee as the monoline versions.",
    mark: `<path d="${nibRibbon(figure8({ steps: 480 }), { penAngle: -32, wMax: 56, wMin: 15, taper: 0, closed: true })}" fill="url(#ink)" fill-rule="evenodd" stroke="none"/>
      <path d="${smooth(barLong)}" stroke-width="19"/>`,
  },
  {
    id: "sig-c2-medium",
    name: "Middleweight",
    rank: "pick",
    symmetric: true,
    tagline: "Heavier, wider loops, same symmetry",
    idea: "A 34 stroke on 96-wide loops. Included to locate the cliff by measurement rather than assumption.",
    small: "Marginal, and this is where the cliff sits. 34 units is 1.06px of stroke, and 96-wide loops leave 62 units of counter — 1.9px, just at the floor.",
    risk: "Neither as fine as the signature nor as solid as the bold; compromises tend to lose both arguments.",
    verdict: "The lightest weight that has any chance in a tab, and the heaviest that still looks written.",
    mark: `<path d="${body({ A: 96, B: 172, S: 0.27 })}" stroke-width="34"/>
      <path d="${smooth(barRising)}" stroke-width="32"/>`,
  },
  {
    id: "sig-c2-bare",
    name: "Bare, no crossbar",
    rank: "maybe",
    symmetric: true,
    tagline: "The body alone",
    idea: "The figure-eight with nothing crossing it. Shows how much of the letter the bar is carrying — and it is the most purely symmetric object here, since there is only one curve to be symmetric.",
    small: "Fails at the fine weight; the bold version below is the one that survives.",
    risk: "Without the bar it is an infinity sign, not an f.",
    verdict: "Useful as a divider or a bullet in the wordmark rather than as the mark itself.",
    mark: `<path d="${body()}" stroke-width="${FINE}"/>`,
  },
  {
    id: "sig-c2-bold",
    name: "Bold",
    rank: "maybe",
    symmetric: true,
    tagline: "The weight a 16px tab can actually hold",
    idea: "The same symmetric geometry at a 48 stroke. Weight and loop width move together — a heavier line needs wider loops or the counters close — so bolding also squares the proportions up.",
    small: "Holds. 128-wide loops leave 80 units of counter (2.5px) and the 48 stroke is 1.5px, the only comfortable margin on this sheet.",
    risk: "At 128:166 the loops are about 1.3:1, past the point where a figure-eight stops reading as an f and starts reading as an 8. Visible in the render.",
    verdict: "Symmetric and legible small, but no longer really the letter. If one drawing has to do everything, this is what it costs.",
    mark: `<path d="${body({ A: 128, B: 166, S: 0.22 })}" stroke-width="48"/>`,
  },
  {
    id: "sig-c2-bold-bar",
    name: "Bold with bar",
    rank: "maybe",
    symmetric: true,
    tagline: "Bold, with the crossbar kept",
    idea: "The bold body with a flat symmetric bar. The bar is what pulls it back from an 8 toward an f, so it is worth the pixels it costs.",
    small: "Marginal. The bar adds a third horizontal band, and three bands inside 320 units is the tightest arrangement anywhere in these sheets.",
    risk: "The bar fuses with the loops at 16px, which thickens the middle rather than reading as a crossbar.",
    verdict: "Better than the bare bold as a standalone icon, worse as a pure shape. Judge from the 16px tile.",
    mark: `<path d="${body({ A: 128, B: 166, S: 0.22 })}" stroke-width="48"/>
      <path d="${smooth(barFlat)}" stroke-width="42"/>`,
  },
  {
    id: "sig-c2-knockout",
    name: "Knocked out",
    rank: "maybe",
    symmetric: true,
    invert: true,
    tagline: "The bold mark reversed out of solid amber",
    idea: "Same symmetric geometry as a hole in a filled tile. Treatment rather than form — the one variable here that changes how visible the icon is rather than what it says.",
    small: "Carries far more of the 16x16 than a thin line on near-black, so it holds its place in a tab strip instead of receding.",
    risk: "Loud on every tab, forever. Knocked-out counters read narrower than positive ones, so it is drawn a little heavier.",
    verdict: "Worth testing head to head with the positive version once the form is settled.",
    mark: `<path d="${body({ A: 132, B: 164, S: 0.22 })}" stroke-width="52"/>`,
  },
]

const count = buildAll(concepts, outDir, [["current", join(here, "../../packages/web/public/favicon.svg")]])

// Controls for the symmetry metric. Without these the per-mark numbers mean
// nothing: you cannot tell a symmetric mark from a nearly-symmetric one until
// you know what the rasteriser's own floor is, and what a real, small
// asymmetry actually costs.
const CONTROLS = [
  ["a circle centred on the canvas — symmetric by definition", `<circle cx="256" cy="256" r="150" stroke-width="56"/>`],
  ["the empty tile, no mark at all", `<circle cx="256" cy="256" r="0" stroke-width="0"/>`],
  ["the same circle moved 4 units off centre", `<circle cx="260" cy="256" r="150" stroke-width="56"/>`],
]
const controls = CONTROLS.map(([label, mark]) => {
  const id = `control-${CONTROLS.findIndex(([l]) => l === label)}`
  const source = join(outDir, `${id}.svg`)
  writeFileSync(source, svg({ mark, symmetric: true }))
  render(source, join(outDir, `${id}-512.png`), 512)
  return { label, error: symmetryError(join(outDir, `${id}-512.png`)) }
})
writeFileSync(join(outDir, "controls.json"), JSON.stringify(controls, null, 2))

// The proof image: the mark beside its own 180-degree rotation.
const proof = spawnSync("magick", [
  join(outDir, "sig-c2-512.png"), "-rotate", "180", join(outDir, "sig-c2-rotated-512.png"),
])
if (proof.status !== 0) throw new Error("could not build the rotation proof")

for (const c of concepts) console.log(`${c.id.padEnd(20)} symmetry error ${c.symmetryError.toExponential(2)}`)
for (const c of controls) console.log(`  control: ${c.label} — ${c.error.toExponential(2)}`)
console.log(`generated ${count} symmetric signature-f concepts`)
