#!/usr/bin/env node
// Assembles the concept sheet into one self-contained HTML file. Every image is
// a real rsvg render inlined as a data URI, so the page can be opened, mailed or
// archived on its own — nothing here is a CSS approximation of the mark.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out")
const concepts = JSON.parse(readFileSync(join(outDir, "concepts.json"), "utf8"))

const uri = (name) => `data:image/png;base64,${readFileSync(join(outDir, name)).toString("base64")}`
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Shortlist and verdict are my reading of the 16px renders below, not a ranking
// the geometry produces on its own.
const VERDICTS = {
  curl: ["pick", "Survives smallest, says the name, and is the only mark here that is both distinctive and structurally safe."],
  converge: ["pick", "The one idea that is about the product rather than the word. Stable silhouette, no glyph collision."],
  looseend: ["pick", "The safety option. Nothing will ever break it; nothing about it is memorable either."],
  spark: ["maybe", "Most personality, most noise. Radial symmetry is a real asset for an icon."],
  tuft: ["maybe", "Distinctive and friendly, but it is the Aries glyph and you will not un-see that."],
  flick: ["maybe", "The only drawn-not-stroked mark. Elegant, and the most work to maintain."],
  fan: ["maybe", "Reads clearly; reads like everyone else's logo too."],
  plume: ["maybe", "Charming, but botanical — a different brand's mark."],
  monogram: ["maybe", "Safe, and welds the identity to the current name."],
  serpentine: ["maybe", "Best idea-per-pixel of the queue concepts, but the idea is invisible small."],
  twist: ["weak", "Degrades to a knobbly column."],
  lanes: ["weak", "The story disappears at 16px; only three tallies remain."],
  stack: ["weak", "A hamburger menu with extra steps."],
  knot: ["no", "Collapses to a capital A, and its meaning is the opposite of the product's."],
  coil: ["no", "Cannot clear the counter floor at any pitch above one turn. Arithmetically excluded."],
}

const VERDICT_LABEL = { pick: "shortlist", maybe: "in play", weak: "weak", no: "ruled out" }

const card = (c) => {
  const [rank, verdict] = VERDICTS[c.id]
  return `
  <article class="card ${rank}" id="${c.id}">
    <div class="hero"><img src="${uri(`${c.id}-128.png`)}" width="128" height="128" alt="${esc(c.name)} concept at 128 pixels"></div>
    <div class="body">
      <h3>${esc(c.name)} <span class="rank ${rank}">${VERDICT_LABEL[rank]}</span></h3>
      <p class="tagline">${esc(c.tagline)}</p>
      <p>${esc(c.idea)}</p>
      <p class="line"><b>At 16px.</b> ${esc(c.small)}</p>
      <p class="line"><b>Risk.</b> ${esc(c.risk)}</p>
      <p class="line verdict"><b>Verdict.</b> ${esc(verdict)}</p>
    </div>
    <div class="evidence">
      <div class="row">
        <div class="ev"><img class="px" src="${uri(`${c.id}-16.png`)}" width="96" height="96" alt="${esc(c.name)} rendered at 16 pixels and magnified"><span>16px &middot; 6&times;</span></div>
        <div class="ev"><img class="px" src="${uri(`${c.id}-32.png`)}" width="96" height="96" alt="${esc(c.name)} rendered at 32 pixels and magnified"><span>32px &middot; 3&times;</span></div>
      </div>
      <div class="ev">
        <div class="tabstrip">
          <div class="tab"><img src="${uri(`${c.id}-16.png`)}" width="16" height="16" alt=""><span>frizz</span></div>
          <div class="tab dim"><img src="${uri(`${c.id}-16.png`)}" width="16" height="16" alt=""><span>zod</span></div>
        </div>
        <span>actual size, in a tab</span>
      </div>
    </div>
  </article>`
}

const order = ["pick", "maybe", "weak", "no"]
const sorted = [...concepts].sort((a, b) => order.indexOf(VERDICTS[a.id][0]) - order.indexOf(VERDICTS[b.id][0]))

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frizz — logo concepts</title>
<style>
  :root {
    --bg: #0d0e10; --panel: #131519; --panel2: #181b20; --border: #26282d;
    --fg: #e6e7e9; --muted: #8b8f96; --accent: #e8b923; --live: #4ac97e; --warn: #d98a3a; --dead: #6b7280;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--sans); line-height: 1.6; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 64px 32px 96px; }
  h1 { font-size: 34px; letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 650; }
  h2 { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin: 56px 0 18px; }
  h3 { font-size: 19px; margin: 0 0 2px; font-weight: 620; display: flex; align-items: center; gap: 10px; }
  p { margin: 0 0 10px; }
  .lede { color: var(--muted); font-size: 15px; max-width: 68ch; }
  .lede b { color: var(--fg); font-weight: 600; }
  code { font-family: var(--mono); font-size: 0.88em; background: var(--panel2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }

  .rule { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 20px; }
  .rule div { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .rule b { display: block; font-family: var(--mono); font-size: 21px; color: var(--accent); font-weight: 600; }
  .rule span { color: var(--muted); font-size: 13px; }

  .before { display: flex; gap: 28px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 22px 26px; }
  .before img { border-radius: 12px; display: block; }
  .before .px { image-rendering: pixelated; }
  .before p { margin: 0; color: var(--muted); font-size: 14px; max-width: 48ch; }
  .before b { color: var(--fg); }

  .card { display: grid; grid-template-columns: 128px 1fr 208px; gap: 26px; align-items: start; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; margin-bottom: 14px; }
  .card.no { opacity: 0.62; }
  .hero img { border-radius: 28px; display: block; }
  .tagline { color: var(--accent); font-size: 14px; margin-bottom: 10px; }
  .body p { font-size: 14px; color: #c9ccd1; }
  .line { color: var(--muted); font-size: 13.5px; }
  .line b { color: var(--fg); font-weight: 600; }
  .verdict b { color: var(--accent); }

  .rank { font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase; font-weight: 650; padding: 3px 8px; border-radius: 999px; border: 1px solid; }
  .rank.pick { color: var(--live); border-color: color-mix(in srgb, var(--live) 45%, transparent); background: color-mix(in srgb, var(--live) 12%, transparent); }
  .rank.maybe { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .rank.weak { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 42%, transparent); background: color-mix(in srgb, var(--warn) 10%, transparent); }
  .rank.no { color: var(--dead); border-color: var(--border); }

  .evidence { display: flex; flex-direction: column; gap: 12px; }
  .evidence .row { display: flex; gap: 12px; }
  .ev { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
  .ev span { font-size: 10.5px; color: var(--muted); font-family: var(--mono); }
  .ev .px { image-rendering: pixelated; border-radius: 9px; width: 100%; height: auto; display: block; }
  .tabstrip { display: flex; gap: 4px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 5px; }
  .tab { display: flex; align-items: center; gap: 6px; background: var(--panel2); border-radius: 6px; padding: 5px 8px; font-size: 11px; color: #c9ccd1; white-space: nowrap; overflow: hidden; }
  .tab.dim { opacity: 0.5; }
  .tab img { flex: none; }

  .foot { margin-top: 56px; border-top: 1px solid var(--border); padding-top: 24px; color: var(--muted); font-size: 13.5px; max-width: 72ch; }
  .foot b { color: var(--fg); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Frizz — icon concepts</h1>
  <p class="lede">Fifteen directions for the mark after the rename, each drawn as real geometry and rendered with <code>rsvg-convert</code> at 512, 128, 32 and 16&nbsp;px. <b>Every concept is judged at 16px, not at hero size</b> — the favicon is the constraint, so the small render is the evidence and the big one is the advert. Nothing on this page is a CSS approximation; the pixels you see at 16px are the pixels a browser tab would show.</p>

  <h2>The 16px rule</h2>
  <p class="lede">A 512-unit canvas maps to 16&nbsp;px, so <b>one pixel is 32 units</b>. That single conversion decides what is drawable and rules out most of what a logo wants to be.</p>
  <div class="rule">
    <div><b>&ge; 52u</b><span>minimum stroke. Below this the mark dissolves into a smudge.</span></div>
    <div><b>&ge; 64u</b><span>minimum ink gap. Below this two features fuse into one.</span></div>
    <div><b>3</b><span>elements across the width. That is the whole budget — 288 usable units buys no more.</span></div>
  </div>

  <h2>Why the current mark fails</h2>
  <div class="before">
    <img src="${uri("current-128.png")}" width="128" height="128" alt="The current fraying-rope icon at 128 pixels">
    <img class="px" src="${uri("current-16.png")}" width="128" height="128" alt="The current icon rendered at 16 pixels and magnified">
    <p>The fraying rope reads beautifully large and is <b>structurally impossible small</b>. Its five loose fibres are drawn at stroke-width 16–19 on a 512 canvas — <b>half a pixel</b> at favicon size. They do not thin out; they cease to exist, and what survives is an amber smear. The fraying is the entire idea of the old mark, and the favicon is exactly where it cannot be shown.</p>
  </div>

  <h2>Concepts</h2>
${sorted.map(card).join("\n")}

  <div class="foot">
    <p><b>How to read the verdicts.</b> They are my reading of the 16px renders on this page, not something the geometry decides. Three marks are structurally safe and distinctive — <b>Curl</b>, <b>Converge</b>, <b>Loose end</b>. Two are ruled out by measurement rather than taste: <b>Coil</b> cannot clear the counter floor at any pitch above one turn, and <b>Knot</b> collapses to a capital A while also meaning the opposite of what the product does.</p>
    <p><b>What is not decided here.</b> Colour is carried over from the existing mark (<code>#e8b923</code> on <code>#0d0e10</code>) so the concepts are compared on form alone — none of these is a proposal about palette. Nor is the dark rounded tile load-bearing: it guarantees favicon contrast against any browser theme, but every mark here would also work knocked out on a flat field.</p>
  </div>
</div>
</body>
</html>
`

const out = join(here, "frizz-logo-concepts.html")
writeFileSync(out, html)
console.log(`${out} (${(html.length / 1024).toFixed(0)} KB, ${concepts.length} concepts)`)
