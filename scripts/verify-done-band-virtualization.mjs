// THE DONE BAND'S COST, measured — the instrument behind the Done band's virtualization in Sidebar.tsx.
//
// Three readings, taken with the band COLLAPSED and then EXPANDED so the difference is the band and
// nothing else:
//   · the sidebar rail's DOM node count;
//   · a FULL style recalculation, which is the MECHANISM — App.tsx's body scroll lock forces exactly one
//     every time an overlay opens, so whatever the rail is holding is paid for by every later navigation;
//   · the processing time and the time to the next paint of a real navigation (opening the settings
//     drawer, which is an overlay open and therefore takes that lock).
//
// With --shots=<dir> it also photographs the expanded rail at the top, the middle and the bottom of its
// scroll, and audits the mounted rows for contiguity — a virtualized band whose rows have the wrong
// height leaves a seam the numbers above cannot see.
//
// Boot a stack on a HOME with a big archive first (see the frizz-stack skill), then:
//   nub scripts/verify-done-band-virtualization.mjs --url=http://127.0.0.1:4941/project/frizz --label=before
import { mkdirSync } from "node:fs"
import puppeteer from "puppeteer"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url")
const label = opt("label", "run")
const shots = opt("shots")
if (!url) { console.error("usage: nub scripts/verify-done-band-virtualization.mjs --url= [--label=]"); process.exit(1) }

// HMR OFF, and this is not optional here. Several agents build and edit inside this working tree at
// once, and any write Vite cannot hot-patch makes it call location.reload() — which destroys the page
// mid-reading and surfaces as an unrelated-looking puppeteer error. Vite's client is the only WebSocket
// the app opens (the board arrives over EventSource), so pointing the `vite-hmr` socket at a dead port
// leaves the app fully live and merely deaf to reloads.
const BLOCK_HMR = `
if (!window.__hmrBlocked) {
  window.__hmrBlocked = true
  const Real = window.WebSocket
  window.WebSocket = new Proxy(Real, {
    construct(target, args) {
      const protocols = args[1]
      const isHmr = protocols === "vite-hmr" || (Array.isArray(protocols) && protocols.includes("vite-hmr"))
      return isHmr ? new target("ws://127.0.0.1:9/", protocols) : new target(...args)
    },
  })
}
`

const INSTRUMENT = `
window.__probe = {
  // A FULL style recalculation with NO visual effect: the rule matches every element under <html> and
  // only sets outline-color on elements that draw no outline, so flipping the attribute invalidates the
  // whole tree's computed style and the getComputedStyle read forces the recalculation synchronously.
  recalc(samples = 9) {
    if (!document.getElementById("recalc-probe")) {
      const style = document.createElement("style")
      style.id = "recalc-probe"
      style.textContent = 'html[data-recalc-probe="1"] * { outline-color: rgba(0,0,0,0) }'
      document.head.appendChild(style)
    }
    const readings = []
    for (let i = 0; i < samples; i++) {
      const t0 = performance.now()
      if (i % 2 === 0) document.documentElement.setAttribute("data-recalc-probe", "1")
      else document.documentElement.removeAttribute("data-recalc-probe")
      getComputedStyle(document.body).outlineColor
      readings.push(performance.now() - t0)
    }
    document.documentElement.removeAttribute("data-recalc-probe")
    readings.sort((a, b) => a - b)
    return { median: +readings[Math.floor(readings.length / 2)].toFixed(2), readings: readings.map((r) => +r.toFixed(2)) }
  },
  railNodes() {
    const rail = document.querySelector("[data-sidebar-rail]")
    return rail ? rail.getElementsByTagName("*").length : -1
  },
  // The scroll extent is the control on the virtualization itself: a virtualized band that reports a
  // different scrollHeight than the eagerly mounted one has the wrong estimate, and the scrollbar lies.
  railScroll() {
    const rail = document.querySelector("[data-sidebar-rail]")
    return rail ? { scrollHeight: rail.scrollHeight, clientHeight: rail.clientHeight } : null
  },
  rows: () => document.querySelectorAll("[data-sidebar-item]").length,
  doneExpanded() {
    const rail = document.querySelector("[data-sidebar-rail]")
    const header = [...rail.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Done"))
    return header ? Boolean(header.querySelector("svg.rotate-90")) : null
  },
  // WHAT ONE NAVIGATION COSTS. Three readings of the same click:
  //   processing  — the browser's own: how long the main thread was busy before it could paint again,
  //                 taken as the long task the click starts (React 19 defers a discrete update's render
  //                 to a microtask, so the synchronous span around .click() is near zero by
  //                 construction and only proves the click landed).
  //   toPaint     — click to the frame that shows the result, via a rAF and the task after it.
  //   blockingMs  — every long task in the window after the click, summed: the span the reader cannot
  //                 interact at all.
  async interact(selector, windowMs = 900) {
    const element = document.querySelector(selector)
    if (!element) return null
    const longTasks = []
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(+e.duration.toFixed(1)) })
    observer.observe({ type: "longtask", buffered: false })
    const t0 = performance.now()
    element.click()
    const sync = performance.now() - t0
    const toPaint = await new Promise((resolve) => {
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
      requestAnimationFrame(() => setTimeout(() => done(+(performance.now() - t0).toFixed(2)), 0))
      setTimeout(() => done(null), 4000)
    })
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    observer.disconnect()
    return {
      sync: +sync.toFixed(2),
      toPaint,
      processing: longTasks.length > 0 ? longTasks[0] : 0,
      blockingMs: +longTasks.reduce((a, b) => a + b, 0).toFixed(1),
      longTasks,
    }
  },
}
`

const browser = await puppeteer.launch({
  headless: "new",
  // --disable-gpu IS LOad-BEARING on this machine, and it took an hour to find. With the GPU process
  // in play under a heavy load (a dozen agents compiling at once, load average 30-50), the renderer
  // produced ONE frame in five seconds and Page.captureScreenshot never returned — so every rAF-based
  // paint reading hung and every screenshot timed out, on this app and on example.com alike. Software
  // rasterization: 3 frames in 29.5ms and a 35ms screenshot. The three backgrounding flags keep a page
  // Chrome believes is occluded from having its timers frozen as well.
  args: [
    "--no-sandbox",
    "--force-color-profile=srgb",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
  protocolTimeout: 120_000,
})
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const errors = []
  // The blocked HMR socket logs its own failure; that noise is this script's doing, not the app's.
  page.on("console", (m) => { if (m.type() === "error" && !/127\.0\.0\.1:9|vite/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => { if (!/WebSocket closed without opened/.test(String(e))) errors.push(String(e)) })
  // Both run before the app's first script on every document, so a reload costs a retry, not the probe.
  await page.evaluateOnNewDocument(BLOCK_HMR)
  await page.evaluateOnNewDocument(INSTRUMENT)
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForSelector("[data-sidebar-item]", { timeout: 60_000 })
  await settle(4000)

  const condition = async () => {
    const geometry = await page.evaluate(() => ({
      railNodes: window.__probe.railNodes(),
      railScroll: window.__probe.railScroll(),
      rows: window.__probe.rows(),
      doneExpanded: window.__probe.doneExpanded(),
      recalc: window.__probe.recalc(),
    }))
    // Opening the settings drawer: an OVERLAY open, so it takes App's body scroll lock and pays for a
    // full style recalculation of whatever the sidebar is currently holding. The first open is DISCARDED
    // — it also mounts the drawer's own subtree for the first time, which is not what is being compared.
    const navigations = []
    for (let i = 0; i < 4; i++) {
      const reading = await page.evaluate(() => window.__probe.interact('[aria-label="Settings"]'))
      if (i > 0) navigations.push(reading)
      await page.keyboard.press("Escape")
      await settle(700)
    }
    return { ...geometry, navigations }
  }

  const out = { label, url }
  console.error("[probe] reading the collapsed band…")
  out.collapsed = await condition()
  console.error("[probe] expanding Done…")
  await page.evaluate(() => {
    const rail = document.querySelector("[data-sidebar-rail]")
    const header = [...rail.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Done"))
    if (header && !header.querySelector("svg.rotate-90")) header.click()
  })
  await settle(3000)
  console.error("[probe] reading the expanded band…")
  out.expanded = await condition()

  // THE BAND ITSELF, at three scroll positions. The numbers above say the rail got cheaper; only this
  // says it still renders the archive. At each stop: are the mounted rows contiguous (no gap, no
  // overlap between one row's bottom and the next row's top), in the board's own order, and does the
  // row under the reader match the index the band claims it is at?
  if (shots) {
    mkdirSync(shots, { recursive: true })
    out.scrollStops = []
    const stops = [0, 0.5, 1]
    for (const fraction of stops) {
      const at = await page.evaluate((f) => {
        const rail = document.querySelector("[data-sidebar-rail]")
        rail.scrollTop = Math.round((rail.scrollHeight - rail.clientHeight) * f)
        return rail.scrollTop
      }, fraction)
      await settle(1200)
      const audit = await page.evaluate(() => {
        const rail = document.querySelector("[data-sidebar-rail]")
        const railBox = rail.getBoundingClientRect()
        const band = document.querySelector("[data-done-band]")
        const rows = [...band.querySelectorAll(":scope > [data-index]")]
          .map((element) => ({ index: Number(element.dataset.index), top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, id: element.querySelector("[data-sidebar-item]")?.dataset.sidebarItem }))
          .sort((a, b) => a.index - b.index)
        // Contiguity alone cannot tell a correct band from one parked entirely off screen — a blank rail
        // passes it. Count what actually overlaps the rail's viewport.
        const onScreen = rows.filter((r) => r.bottom > railBox.top && r.top < railBox.bottom).length
        const seams = []
        for (let i = 1; i < rows.length; i++) {
          if (rows[i].index !== rows[i - 1].index + 1) { seams.push({ after: rows[i - 1].index, gapInIndex: true }); continue }
          const seam = +(rows[i].top - rows[i - 1].bottom).toFixed(2)
          if (Math.abs(seam) > 0.01) seams.push({ after: rows[i - 1].index, seamPx: seam })
        }
        const heights = [...new Set(rows.map((r) => +(r.bottom - r.top).toFixed(2)))]
        return { mounted: rows.length, onScreen, firstIndex: rows[0]?.index, lastIndex: rows.at(-1)?.index, firstId: rows[0]?.id, firstTopInRail: rows[0] ? Math.round(rows[0].top - railBox.top) : null, seams, heights }
      })
      const file = `${shots}/done-band-${label}-${String(fraction).replace(".", "_")}.png`
      // page.screenshot with an explicit clip, NOT ElementHandle.screenshot: the latter first scrolls the
      // element into view, and on this sticky, internally scrolled column that call never returns.
      const clip = await page.evaluate(() => {
        const { x, y, width, height } = document.querySelector("[data-sidebar-rail]").getBoundingClientRect()
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
      })
      // FORCE A FRESH FRAME FIRST. Without this the capture came back one scroll stop STALE — the shot
      // of the band's middle was pixel-for-pixel the shot of its top, and the shot of its bottom was the
      // blank instant between "the rail scrolled" and "the virtualizer re-rendered". Two rAFs guarantee
      // the compositor has drawn the state the audit just measured.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await page.screenshot({ path: file, clip })
      out.scrollStops.push({ fraction, scrollTop: at, ...audit, shot: file })
    }
    // THE OPTICAL SPACING PASS, on the axis this change can actually break. Virtualizing swaps a row's
    // container from a static box in flow to an absolutely positioned one, so the risk is VERTICAL
    // RHYTHM: a wrong height or a stale measurement leaves a pitch the CSS still claims is uniform.
    // The gap instrument (scripts/ink-gaps.mjs) answers the sideways question; this is the same law
    // upright — scan the rendered rail for painted rows, group them into ink bands, and read the pitch
    // between consecutive bands. The rail carries BOTH kinds of row at once, so the eagerly rendered
    // Rested rows above the rule are the control for the virtualized Done rows below it.
    // BOTH APP FONTS. Setting `data-font` alone measures the same font twice: lib/font.ts also pins the
    // resolved stack as an INLINE style on <body> (its flash guard for an HMR swap of styles.css), and
    // an inline style outranks the attribute rule. Clearing it is what hands the choice back to the CSS.
    for (const font of ["mono", "sans"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.font = value
        document.body.style.fontFamily = ""
        document.querySelector("[data-sidebar-rail]").scrollTop = 0
      }, font)
      await settle(1200)
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 4 })
      await settle(600)
      const clip = await page.evaluate(() => {
        const { x, y, width } = document.querySelector("[data-sidebar-rail]").getBoundingClientRect()
        return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: 600 }
      })
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const b64 = await page.screenshot({ clip, encoding: "base64" })
      const bands = await page.evaluate(async (data, dsf) => {
        const img = new Image()
        img.src = "data:image/png;base64," + data
        await img.decode()
        const canvas = document.createElement("canvas")
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        const at = (x, y) => { const i = (y * canvas.width + x) * 4; return [pixels[i], pixels[i + 1], pixels[i + 2]] }
        const bg = at(canvas.width - 2, 2)
        const dist = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2])
        const painted = []
        for (let y = 0; y < canvas.height; y++) {
          let hit = false
          for (let x = 0; x < canvas.width && !hit; x++) if (dist(at(x, y)) > 24) hit = true
          painted.push(hit)
        }
        const out = []
        let start = -1
        for (let y = 0; y <= painted.length; y++) {
          if (painted[y] && start < 0) start = y
          if (!painted[y] && start >= 0) { out.push({ top: +(start / dsf).toFixed(2), height: +((y - start) / dsf).toFixed(2) }); start = -1 }
        }
        return out
      }, b64, 4)
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      const pitches = bands.slice(1).map((b, i) => +(b.top - bands[i].top).toFixed(2))
      out[`inkBands_${font}`] = { bands: bands.length, tops: bands.map((b) => b.top), pitches }
    }
    await page.evaluate(() => { document.documentElement.dataset.font = "sans" })

    // The band's order must be the board's own archived order — the rail cannot invent one.
    out.orderMatchesBoard = await page.evaluate(() => {
      const band = document.querySelector("[data-done-band]")
      const mounted = [...band.querySelectorAll(":scope > [data-index]")]
        .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
        .map((element) => element.querySelector("[data-sidebar-item]")?.dataset.sidebarItem)
      return { tail: mounted.slice(-4) }
    })
  }

  out.errors = errors
  console.log(JSON.stringify(out, null, 2))
} finally {
  await browser.close()
}
