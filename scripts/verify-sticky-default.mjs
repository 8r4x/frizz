// Real-browser gate for "sticky user messages are no longer the default".
// Drives ONE owned headless Chrome through four states against a live adhoc stack:
//   1. fresh browser        → no pinned band, the ask flows and scrolls away
//   2. legacy stored prefs  → the one-time re-default fires: still no pinned band
//   3. Settings toggle ON   → the band pins immediately (opt-in still works)
//   4. reload after opt-in  → the band is STILL pinned (the marker stopped the migration re-running)
//   5. the drawer (ChatView) → the same two states on the other surface the pref drives
//   node scripts/verify-sticky-default.mjs <baseUrl> <shotDir> [slug=sticky-demo]
import puppeteer from "puppeteer"
import { mkdirSync } from "node:fs"

const [base, shots, slugArg] = process.argv.slice(2)
const slug = slugArg || "sticky-demo"
mkdirSync(shots, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ASK = "Can you make the most recent user message sticky"

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const askEl = () => [...document.querySelectorAll("[data-transcript-source-id]")].find((e) => (e.innerText || "").includes(${JSON.stringify(ASK)}))
  window.scrollTo(0, 0); await sleep(300)
  const atTop = (() => { const el = askEl(); if (!el) return null; const r = el.getBoundingClientRect(); return { viewportTop: Math.round(r.top), onScreen: r.bottom > 0 && r.top < window.innerHeight, sticky: !!el.closest('[data-transcript-sticky="true"]') } })()
  window.scrollTo(0, document.documentElement.scrollHeight); await sleep(700)
  const atBottom = (() => { const el = askEl(); if (!el) return null; const r = el.getBoundingClientRect(); return { viewportTop: Math.round(r.top), onScreen: r.bottom > 0 && r.top < window.innerHeight, sticky: !!el.closest('[data-transcript-sticky="true"]') } })()
  window.scrollTo(0, 0); await sleep(300)
  return { stored: JSON.parse(localStorage.getItem("frizz.prefs.v1") || "null"), pinnedBands: document.querySelectorAll('[data-transcript-sticky="true"]').length, atTop, atBottom }
})()`

// The DRAWER (ChatView) is the other surface the pref drives, and it scrolls its own container rather
// than the window. Same three readings: is a band pinned, where does the ask sit, does it stay on screen.
const DRAWER_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const scroller = document.querySelector("[data-virtualized-transcript-scroll]")
  const box = document.querySelector("[data-virtualized-transcript]")
  if (!scroller || !box) return { drawerFound: false }
  const askEl = () => [...box.querySelectorAll("[data-transcript-source-id]")].find((e) => (e.innerText || "").includes(${JSON.stringify(ASK)}))
  scroller.scrollTop = scroller.scrollHeight; await sleep(1200)
  const el = askEl()
  const b = scroller.getBoundingClientRect()
  const r = el && el.getBoundingClientRect()
  return {
    drawerFound: true,
    pinnedBands: scroller.querySelectorAll('[data-transcript-sticky="true"]').length,
    askAtBottom: el ? { topInPane: Math.round(r.top - b.top), onScreen: r.bottom > b.top && r.top < b.bottom, sticky: !!el.closest('[data-transcript-sticky="true"]') } : null,
  }
})()`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${JSON.stringify(detail)}` : ""}`)
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console: ${m.text()}`) })
  // The two states only LOOK different once the pane is scrolled: at the very top a pinned band sits
  // exactly where the flowed message would. Every optical shot is therefore taken at the bottom.
  const shotAtBottom = async (name) => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await sleep(800)
    await page.screenshot({ path: `${shots}/${name}` })
  }

  // ---- 1. FRESH BROWSER: nothing stored, so the new fallback decides.
  await page.goto(base, { waitUntil: "networkidle2", timeout: 60000 })
  await sleep(2500)
  const fresh = await page.evaluate(PROBE)
  check("fresh browser renders no pinned band", fresh.pinnedBands === 0, { pinnedBands: fresh.pinnedBands })
  check("the ask flows in place and scrolls away", fresh.atTop?.onScreen === true && fresh.atTop?.sticky === false && fresh.atBottom?.onScreen === false, fresh)
  await shotAtBottom("01-fresh-default-off.png")

  // ---- 2. LEGACY STORED PREFS: what every browser that has used the app already has on disk.
  await page.evaluate(() => {
    localStorage.setItem("frizz.prefs.v1", JSON.stringify({ compactDiffs: true, snoozePreset: "1d", stickyUserMessage: true, queueOrder: "fifo", diffsRedefaulted: true }))
  })
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 })
  await sleep(2500)
  const migrated = await page.evaluate(PROBE)
  check("a stored legacy `stickyUserMessage: true` is re-defaulted off", migrated.pinnedBands === 0, { pinnedBands: migrated.pinnedBands })
  check("the re-defaulted ask scrolls away too", migrated.atBottom?.onScreen === false, migrated.atBottom)
  await shotAtBottom("02-legacy-prefs-redefaulted.png")

  // ---- 3. OPT IN through the real Settings control.
  await page.click('[aria-label="Settings"]')
  await sleep(900)
  // Anchor on the field's own help button (`aria-label="About Sticky message"`) — the label text sits
  // in a span that also CONTAINS that button, so a "no children" text match never finds it.
  const clicked = await page.evaluate(() => {
    const help = document.querySelector('[aria-label="About Sticky message"]')
    if (!help) return { ok: false, why: "Sticky message field not found" }
    let node = help.parentElement
    for (let i = 0; i < 6 && node; i++) {
      const on = [...node.querySelectorAll("button")].find((b) => b.textContent.trim() === "On")
      if (on) { on.click(); return { ok: true, depth: i } }
      node = node.parentElement
    }
    return { ok: false, why: "no On button in the Sticky message field" }
  })
  check("the Settings 'Sticky message' On control is reachable", clicked.ok, clicked)
  await sleep(400)
  await page.keyboard.press("Escape")
  await sleep(900)
  const optedIn = await page.evaluate(PROBE)
  check("opting in pins the ask immediately", optedIn.pinnedBands === 1 && optedIn.atBottom?.sticky === true && optedIn.atBottom?.onScreen === true, optedIn)
  check("the opt-in is persisted with its marker", optedIn.stored?.stickyUserMessage === true && optedIn.stored?.stickyRedefaulted === true, optedIn.stored)
  await shotAtBottom("03-opted-in-pinned.png")

  // ---- 4. THE OPT-IN SURVIVES A RELOAD (the migration must not re-run and stomp it).
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 })
  await sleep(2500)
  const afterReload = await page.evaluate(PROBE)
  check("the opt-in survives a reload", afterReload.pinnedBands === 1 && afterReload.atBottom?.sticky === true, afterReload)
  await shotAtBottom("04-opt-in-survives-reload.png")

  // ---- 5. THE VIRTUALIZED ChatView (`/thread/<slug>/full`, the same component the drawer mounts) —
  //      the other surface the pref drives, and the one that HOISTS the pinned row out of the window.
  //      Still opted IN here, so the hoisted band must be present; then off, and it must not be.
  await page.goto(`${base.replace(/\/$/, "")}/thread/${slug}/full`, { waitUntil: "networkidle2", timeout: 60000 })
  await sleep(3000)
  const drawerOn = await page.evaluate(DRAWER_PROBE)
  check("virtualized transcript pins the ask while opted in", drawerOn.drawerFound && drawerOn.pinnedBands === 1 && drawerOn.askAtBottom?.sticky === true && drawerOn.askAtBottom?.onScreen === true, drawerOn)
  await page.screenshot({ path: `${shots}/06-full-opted-in-pinned.png` })

  await page.evaluate(() => localStorage.removeItem("frizz.prefs.v1"))
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 })
  await sleep(3000)
  const drawerOff = await page.evaluate(DRAWER_PROBE)
  check("virtualized transcript flows the ask at the new default", drawerOff.drawerFound && drawerOff.pinnedBands === 0 && drawerOff.askAtBottom?.sticky !== true, drawerOff)
  await page.screenshot({ path: `${shots}/07-full-default-off.png` })

  // ---- narrow viewport at the (new) default, for the responsive read.
  await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 })
  await page.goto(base, { waitUntil: "networkidle2", timeout: 60000 })
  await sleep(2500)
  const narrow = await page.evaluate(PROBE)
  check("narrow viewport also renders no pinned band by default", narrow.pinnedBands === 0, { pinnedBands: narrow.pinnedBands })
  await page.screenshot({ path: `${shots}/05-narrow-default-off.png` })

  check("no page or console errors", pageErrors.length === 0, pageErrors.slice(0, 5))
} catch (e) {
  console.error("HARNESS ERROR", e)
  process.exitCode = 1
} finally {
  await browser.close()
}
console.log(JSON.stringify({ pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length }))
if (results.some((r) => !r.ok)) process.exitCode = 1
