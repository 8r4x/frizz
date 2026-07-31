// Headless screenshot + in-page evaluate loop for iterating on the fray-ui UI.
// No chrome-devtools MCP this session, so we drive puppeteer directly (it resolves the cached Chrome
// under ~/.cache/puppeteer). This is the visual-review loop: screenshot + evaluate_script routines
// (occlusion/clip/alignment/optical-center) against the live app.
//
// Usage:
//   nub ui/scripts/shot.mjs <url> [out.png] [evalExprOr@file] [--before=exprOr@file] [--w=1440] [--h=900] [--wait=1500]
//     [--clip=<css selector>] [--pad=8] [--dsf=2]
//   evalExpr: a JS expression string evaluated in page context (completion value → printed as JSON).
//   @file:    read the expression from a file (e.g. an occlusion routine).
//   --clip:   shoot only that element's box (+ --pad px of margin) instead of the viewport, and --dsf
//             raises the device pixel ratio — together they make a 27px row judgeable without zooming
//             the page (a `zoom`/`transform` hack reflows this app's centered layout and moves the very
//             thing you were trying to photograph off-screen).
import { readFileSync } from "node:fs"
import puppeteer from "puppeteer"

const args = process.argv.slice(2)
const pos = args.filter((a) => !a.startsWith("--"))
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const [url, out, evalArg] = pos
const W = Number(flags.w) || 1440
const H = Number(flags.h) || 900
const WAIT = Number(flags.wait) || 1500

if (!url) {
  console.error("usage: nub shot.mjs <url> [out.png] [evalExprOr@file] [--w=] [--h=] [--wait=]")
  process.exit(1)
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: Number(flags.dsf) || 2 })
  const errors = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 })
  await new Promise((r) => setTimeout(r, WAIT)) // let the SSE board render
  if (flags.before) {
    const expr = flags.before.startsWith("@") ? readFileSync(flags.before.slice(1), "utf8") : flags.before
    await page.evaluate(expr)
  }
  if (out) {
    const clip = flags.clip
      ? await page.evaluate((sel, pad) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 }
        }, flags.clip, Number(flags.pad) || 8)
      : null
    if (flags.clip && !clip) console.error(`clip selector matched nothing: ${flags.clip}`)
    await page.screenshot({ path: out, fullPage: false, ...(clip ? { clip } : {}) })
    console.error("shot ->", out)
  }
  if (evalArg) {
    const expr = evalArg.startsWith("@") ? readFileSync(evalArg.slice(1), "utf8") : evalArg
    const res = await page.evaluate(expr)
    console.log(JSON.stringify(res, null, 2))
  }
  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"))
} finally {
  await browser.close()
}
