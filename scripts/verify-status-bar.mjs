// Real-browser verification of the top-left status bar: order, geometry, both popovers (driven with a
// REAL mouse, because React's enter/leave can't be faked with dispatchEvent), the narrow viewport, and
// the degraded quota states. One browser launch, many shots.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import puppeteer from "puppeteer"

const BASE = process.env.BASE ?? "http://localhost:4941/status-bar-fixture.html"
const OUT = join(tmpdir(), "fray-statusbar")
mkdirSync(OUT, { recursive: true })

const results = []
const fail = (m) => { console.log("FAIL:", m); results.push(false) }
const pass = (m) => { console.log("pass:", m); results.push(true) }

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 420, deviceScaleFactor: 2 })

  // ---- 1. healthy: order + single-line geometry -------------------------------------------------
  // domcontentloaded, NOT networkidle: the fixture is served by a vite dev server whose HMR socket
  // never goes idle, so networkidle2 can hang forever.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 })
  await page.waitForSelector("[data-quota-bar] button", { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 600))

  const geom = await page.evaluate(() => {
    const bar = document.querySelector("[data-status-bar]")
    const items = [
      ["identity", bar.querySelector("[data-project-identity-state]")],
      ["settings", bar.querySelector('[aria-label="Settings"]')],
      ["reload", bar.querySelector('[aria-label="Update Fray"],[aria-label="Restart Fray"]')],
      ["claude", bar.querySelector('[aria-label^="Claude"]')],
      ["codex", bar.querySelector('[aria-label^="Codex"]')],
    ]
    const barBox = bar.getBoundingClientRect()
    return {
      bar: { x: barBox.x, y: barBox.y, h: Math.round(barBox.height) },
      items: items.map(([name, el]) => {
        if (!el) return { name, missing: true }
        const r = el.getBoundingClientRect()
        return { name, left: Math.round(r.left), cy: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
      }),
    }
  })
  console.log(JSON.stringify(geom, null, 2))

  const missing = geom.items.filter((i) => i.missing).map((i) => i.name)
  if (missing.length) fail(`missing from the bar: ${missing.join(", ")}`)
  else pass("identity, settings, reload and both quota chips all render")

  const order = geom.items.map((i) => i.left)
  const ascending = order.every((v, i) => i === 0 || v > order[i - 1])
  if (ascending) pass(`left-to-right order is slug → connection → settings → reload → claude → codex (${order.join(" < ")})`)
  else fail(`items are not in ascending x order: ${JSON.stringify(geom.items)}`)

  const cys = geom.items.map((i) => i.cy)
  const sameLine = Math.max(...cys) - Math.min(...cys) <= 1
  if (sameLine) pass(`every item shares one baseline (centre y = ${cys.join(",")})`)
  else fail(`items are not on one line: centre y = ${cys.join(",")}`)

  const buttons = geom.items.filter((i) => i.name === "settings" || i.name === "reload")
  const evenButtons = buttons.every((b) => b.w === 24 && b.h === 24)
  if (evenButtons) pass("settings and reload are identical 24px targets (WCAG 2.2 minimum)")
  else fail(`icon buttons differ in size: ${JSON.stringify(buttons)}`)

  await page.screenshot({ path: join(OUT, "01-healthy.png") })

  // ---- 2. the reload popover, opened with a REAL hover ------------------------------------------
  const reload = await page.$('[aria-label="Update Fray"],[aria-label="Restart Fray"]')
  await reload.hover()
  await page.waitForSelector("#update-restart-popover", { timeout: 5000 })
  await new Promise((r) => setTimeout(r, 250))
  const pop = await page.$eval("#update-restart-popover", (p) => {
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), w: Math.round(r.width) }
  })
  const popOnScreen = pop.x >= 0 && pop.right <= 1440 && pop.y >= 0
  if (popOnScreen) pass(`reload popover opens rightward and stays on-screen (x=${pop.x} right=${pop.right})`)
  else fail(`reload popover is off-screen: ${JSON.stringify(pop)} — the old right-0 anchor regressed`)
  await page.screenshot({ path: join(OUT, "02-reload-popover.png") })

  // Move the mouse away so the tooltip doesn't overlap the next shot.
  await page.mouse.move(1200, 300)
  await new Promise((r) => setTimeout(r, 250))

  // ---- 3. the quota popover, opened with a REAL click -------------------------------------------
  await page.click('[aria-label^="Claude"]')
  await page.waitForSelector('[data-radix-popper-content-wrapper]', { timeout: 5000 })
  await new Promise((r) => setTimeout(r, 350))
  const quotaPop = await page.$eval("[data-radix-popper-content-wrapper]", (p) => {
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), bottom: Math.round(r.bottom), right: Math.round(r.right) }
  })
  const barBottom = geom.bar.y + geom.bar.h
  if (quotaPop.y >= barBottom - 2 && quotaPop.right <= 1440 && quotaPop.x >= 0) {
    pass(`quota popover drops BELOW the bar and stays on-screen (y=${quotaPop.y} vs bar bottom ${barBottom})`)
  } else {
    fail(`quota popover is misplaced: ${JSON.stringify(quotaPop)} — expected it below the bar (side="bottom")`)
  }
  await page.screenshot({ path: join(OUT, "03-quota-popover.png") })

  // ---- 4. narrow viewport ------------------------------------------------------------------------
  await page.keyboard.press("Escape")
  await page.setViewport({ width: 420, height: 640, deviceScaleFactor: 2 })
  await new Promise((r) => setTimeout(r, 500))
  const narrow = await page.evaluate(() => {
    const bar = document.querySelector("[data-status-bar]")
    const r = bar.getBoundingClientRect()
    const codex = bar.querySelector('[aria-label^="Codex"]').getBoundingClientRect()
    return {
      barRight: Math.round(r.right),
      barHeight: Math.round(r.height),
      codexRight: Math.round(codex.right),
      viewport: window.innerWidth,
      bodyOverflows: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
  console.log("narrow:", JSON.stringify(narrow))
  if (narrow.codexRight <= narrow.viewport && !narrow.bodyOverflows && narrow.barHeight === 24) {
    pass(`narrow (420px): the bar stays one 24px line, the last chip is reachable, no horizontal overflow`)
  } else {
    fail(`narrow viewport broke the bar: ${JSON.stringify(narrow)}`)
  }
  await page.screenshot({ path: join(OUT, "04-narrow.png") })

  // ---- 5. degraded states ------------------------------------------------------------------------
  await page.setViewport({ width: 1440, height: 300, deviceScaleFactor: 2 })
  for (const [name, query] of [
    ["05-low-quota", "?state=low"],
    ["06-signed-out", "?state=signedout"],
    ["07-disconnected", "?connection=closed"],
    ["08-identity-loading", "?identity=loading"],
  ]) {
    await page.goto(BASE + query, { waitUntil: "domcontentloaded", timeout: 20000 })
    await new Promise((r) => setTimeout(r, 900))
    await page.screenshot({ path: join(OUT, `${name}.png`) })
    const text = await page.$eval("[data-status-bar]", (b) => b.innerText.replace(/\n/g, " · "))
    console.log(`${name}: ${text}`)
  }

  if (errors.length) fail(`console/page errors: ${errors.join(" | ")}`)
  else pass("no console or page errors")
} finally {
  await browser.close()
}

console.log(`\nshots in ${OUT}`)
const failed = results.filter((r) => !r).length
console.log(failed ? `${failed} CHECK(S) FAILED` : "ALL CHECKS PASSED")
process.exit(failed ? 1 : 0)
