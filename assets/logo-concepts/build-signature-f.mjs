#!/usr/bin/env node
// The written signature f: two narrow loops crossing at a waist, with a long
// crossbar. This is the shape a hand actually makes, not the hooked f that a
// favicon prefers, so the sheet is organised around that tension: how fine can
// the line be before 16px eats it, and what do you keep when it does.

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildAll, nibRibbon, resample, smooth } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-sig")

/**
 * The f's body as a Gerono figure-eight, sheared.
 *
 *   x = cx + A·sin(2t)/2 + L·cos(t) + S·(cy − y)      y = cy − B·cos(t)
 *
 * `A` is the loop width and `B` the half-height, so A:B is the whole game — the
 * written loops in the reference run about 3:1 tall, and anything squatter than
 * ~2:1 stops reading as an f and starts reading as an 8.
 *
 * `S` is the shear. A plain `L` lean slides each loop sideways but leaves its
 * long axis vertical, which looks upright and drawn; shearing tilts the axes
 * themselves, which is what makes the pair look written. Sweeping the whole
 * 0..2π closes the curve on itself; stopping short leaves a terminal to run a
 * swash off.
 */
function figure8({ cx = 256, cy = 268, A = 66, B = 172, L = 0, S = 0.3, lower = 1.16, t0 = 0, t1 = 2 * Math.PI, steps = 240 }) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + ((t1 - t0) * i) / steps
    const u = Math.cos(t)
    // A written descender runs longer and wider than the ascender. Blending the
    // factor across u rather than switching on its sign keeps the curve smooth
    // through the waist, where a hard switch would leave a visible kink exactly
    // at the crossing.
    const k = 1 + ((lower - 1) * (1 - u)) / 2
    const y = cy - B * k * u
    points.push([cx + (A * k * Math.sin(2 * t)) / 2 + L * u + S * (cy - y), y])
  }
  return points
}

const body = (opts = {}) => smooth(figure8(opts))

// Truncating at t = 3π/2 − 0.3 leaves the pen on the descender's upper right,
// which is where a written f throws its exit swash.
const swashBody = figure8({ t1: 1.5 * Math.PI - 0.3, steps: 180 })
const swashTail = [[318, 306], [382, 292], [444, 288]]

// The reference's long rising crossbar: flat at the left tip, then climbing
// across the waist and out well past the letter on the right.
const risingBar = "M84 330 C142 328 206 312 282 280 C338 256 392 242 432 236"
// The other reference's pair: a short bar in from the left, and the swash out.
const shortBar = "M88 274 C142 268 196 268 252 282"

const FINE = 22
const BOLD = 46

const concepts = [
  {
    id: "sig-fine",
    name: "Signature",
    rank: "pick",
    tagline: "The written f, drawn as written",
    idea: "Two narrow loops crossing at the waist with a long rising crossbar — the reference, built as a real figure-eight rather than traced. The ascender throws right, the descender throws left, and the single crossing is what makes it read as handwriting instead of as a symbol.",
    small: "Fails, and it is not close. A 22-unit line is 0.69px at 16px, and the loops are 66 wide so their counters are 44 units — 1.4px. Both numbers are under the floor, so the letter thins to a grey smudge. This weight is a logo, not a favicon.",
    risk: "None as a logo — this is the most characterful mark in any of the three sheets. The risk is only that it cannot also be the favicon, so the brand needs two drawings rather than one.",
    verdict: "Use it big: README, site header, app splash, stickers. Pair it with a simplified companion for the tab.",
    mark: `<path d="${body()}" stroke-width="${FINE}"/>
      <path d="${risingBar}" stroke-width="${FINE}"/>`,
  },
  {
    id: "sig-fine-swash",
    name: "Signature with swash",
    rank: "pick",
    tagline: "The same hand, with the tail thrown out to the right",
    idea: "The second reference. The descender does not close its loop; it runs out into a long horizontal tail, and a short bar comes in from the left to meet the stem. The tail gives the mark a baseline to sit a wordmark on.",
    small: "Fails at the same weight and for the same reason. The tail survives longest because it is the one horizontal run of ink.",
    risk: "The swash needs horizontal room, so this version does not fit a square tile as comfortably as the closed one — it wants to be a wide lockup.",
    verdict: "The better choice if the mark will usually appear beside the word Frizz rather than alone.",
    mark: `<path d="${smooth([...swashBody, ...swashTail])}" stroke-width="${FINE}"/>
      <path d="${shortBar}" stroke-width="${FINE}"/>`,
  },
  {
    id: "sig-contrast",
    name: "Signature with pen contrast",
    rank: "pick",
    tagline: "Thick where the pen presses, thin where it travels",
    idea: "The reference has real weight variation — the outsides of the loops are heavy, the crossing strokes are fine. This runs the same spine through a broad-nib model so the contrast is generated by the pen angle rather than drawn by hand.",
    small: "Fails, like every fine weight here, but it fails last: the heavy parts of the loops are the final thing to survive.",
    risk: "Contrast this high has to be redrawn for every size and weight — you cannot restroke your way to a bolder version.",
    verdict: "The most finished-looking of the three fine variants, and the one closest to the reference's actual texture.",
    mark: `<path d="${nibRibbon(resample(figure8({}), 4), { penAngle: -32, wMax: 54, wMin: 15, taper: 16 })}" fill="url(#ink)" stroke="none"/>
      <path d="${risingBar}" stroke-width="20"/>`,
  },
  {
    id: "sig-bold",
    name: "Signature, bold",
    rank: "pick",
    tagline: "The same letter at a weight a tab can hold",
    idea: "The same letter at a 46 stroke. Weight and loop width have to move together — a heavier line needs wider loops or the counters close — so bolding also squares the proportions up from 3:1 toward 1.5:1.",
    small: "Holds, just. Loops widened to 112 leave 112-46 = 66 units of counter, and the 46 stroke is 1.4px. Legible rather than crisp.",
    risk: "Bolding a signature costs exactly the quality that made it one. The loops have to widen to keep their counters, and at that proportion the f starts reading as an 8 — visible in the render below.",
    verdict: "The honest compromise if there has to be one drawing. Compare it against running two.",
    mark: `<path d="${body({ A: 112, B: 168, S: 0.24 })}" stroke-width="${BOLD}"/>
      <path d="${risingBar}" stroke-width="${BOLD - 4}"/>`,
  },
  {
    id: "sig-bold-nobar",
    name: "Bold, no crossbar",
    rank: "pick",
    tagline: "The favicon companion",
    idea: "The bold body with the crossbar dropped and the loops opened further. Not a rival to the signature — the piece you show at 16px when the signature itself cannot go there.",
    small: "The best small render on this sheet. Losing the crossbar frees the whole width, so the loops open to 132 and the counters reach 80 units — 2.5px, the only comfortable margin here.",
    risk: "Plainly reads as an 8, not an f. That is survivable for a companion icon that always appears downstream of the real logo, and fatal for one that has to stand alone.",
    verdict: "The one to pair with Signature. A detailed logo plus a reduced icon is the normal way out of this, and this is the reduction.",
    mark: `<path d="${body({ A: 132, B: 158, S: 0.22 })}" stroke-width="52"/>`,
  },
  {
    id: "sig-knockout",
    name: "Bold, knocked out",
    rank: "maybe",
    tagline: "The companion reversed out of solid amber",
    idea: "The same reduced mark as a hole in a filled amber tile.",
    small: "Carries much more of the 16x16 than a thin line on near-black, so it holds its place in a tab strip instead of receding. Knocked-out counters read narrower than positive ones, so the letter is drawn a little heavier here.",
    risk: "Loud on every tab, forever.",
    verdict: "Worth testing head to head with the positive version once the form is settled.",
    invert: true,
    mark: `<path d="${body({ A: 138, B: 156, S: 0.22 })}" stroke-width="56"/>`,
  },
  {
    id: "sig-medium",
    name: "Middleweight",
    rank: "maybe",
    tagline: "Splitting the difference",
    idea: "A 34 stroke — heavier than the reference, lighter than the bold. Included to show where the cliff actually is rather than assuming it.",
    small: "Marginal, and this is where the cliff is. 34 units is 1.06px of stroke and the 88-wide loops leave 54 units of counter (1.7px): present, but soft rather than drawn.",
    risk: "Compromises tend to lose both arguments; this one is neither a signature nor a solid icon.",
    verdict: "Useful as a measurement, probably not as a choice.",
    mark: `<path d="${body({ A: 88, B: 170, S: 0.27 })}" stroke-width="34"/>
      <path d="${risingBar}" stroke-width="32"/>`,
  },
  {
    id: "sig-fine-nobar",
    name: "Signature, bare",
    rank: "maybe",
    tagline: "The written f with nothing crossing it",
    idea: "The fine body alone. Shows how much of the letter the crossbar is actually carrying — without it the figure-eight is elegant but stops being an f.",
    small: "Fails at this weight regardless.",
    risk: "Reads as an infinity sign or an ampersand flourish more than as a letter.",
    verdict: "Mostly a control, but a pretty one — it is the shape the wordmark could use as a divider or a bullet.",
    mark: `<path d="${body()}" stroke-width="${FINE}"/>`,
  },
]

const count = buildAll(concepts, outDir, [["current", join(here, "../../packages/web/public/favicon.svg")]])
console.log(concepts.map((c) => c.id).join(" "))
console.log(`generated ${count} signature-f concepts`)
