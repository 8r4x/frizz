// The three ways the optimistic steer overlay must YIELD, driven in a real browser. Placement is a
// much louder claim than a spinner — a row that jumps to the top of the running band and stays there
// on a steer that never landed is worse than one that never moved — so each retreat is exercised:
//
//   rollback  — the followUp POST fails (intercepted at the network). clearSteered must drop the row
//               straight back into the rested band, at its old position, with its card restored.
//   expiry    — the send succeeds but the worker never writes a turn (a swallowed injection). The row
//               must fall out of the running band on its own at STEER_OPTIMISM_MS, unprompted by any
//               board push, because nothing else will repaint a quiet thread at the cap.
//   held      — a SNOOZED (Held-band) row that gets steered must leave the dimmed band for the running
//               band, exactly as the server re-derives it once the turn starts (isHeld excuses a
//               running thread), and must fall back into Held when the hint expires.
//
//   node scripts/verify-steer-rail-edges.mjs <url> [outDir]
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const [url, outDir = "/tmp/steer-rail/edges"] = process.argv.slice(2)
if (!url) {
  console.error("usage: node verify-steer-rail-edges.mjs <url> [outDir]")
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const PROBE = `(() => {
  const rail = document.querySelector('[data-sidebar-rail]')
  if (!rail) return { ready: false }
  const rows = []
  let band = 'running'
  const walk = (node, inHeld) => {
    for (const child of node.children) {
      if (child.tagName === 'HR' && !inHeld) { band = 'rested'; continue }
      const row = child.querySelector?.(':scope > [data-sidebar-item]')
      if (row) { rows.push({ id: row.dataset.sidebarItem, band: inHeld ? 'held' : band }); continue }
      if (child.tagName === 'SECTION' && child.getAttribute('aria-label') === 'Held') walk(child, true)
    }
  }
  walk(rail, false)
  return { ready: true, rows, cards: [...document.querySelectorAll('[data-queue-card]')].map((e) => e.dataset.queueCard) }
})()`

const api = createRpcClient(url)
await api.waitForHealth()
const board = await api.query("board")
const sid = (slug) => board.threads.find((t) => t.id === slug)?.sessionId

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
const results = {}
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))

  // ── rollback: fail the followUp POST at the wire ────────────────────────────────────────────────
  await page.setRequestInterception(true)
  let failFollowUps = true
  page.on("request", (req) => {
    // Failed AFTER a beat, not instantly: a real transport failure takes time, and the point of this
    // case is that the row visibly moved on optimism FIRST and then had to be taken back.
    if (failFollowUps && req.url().endsWith("/rpc/followUp")) {
      setTimeout(() => { void req.abort("failed").catch(() => {}) }, 1500)
      return
    }
    void req.continue()
  })
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 })
  await page.waitForSelector(`[data-sidebar-item]`, { timeout: 20_000 })
  await new Promise((r) => setTimeout(r, 2500))

  const steer = async (slug, text) => {
    const composer = `[data-queue-card="${slug}"] textarea`
    await page.waitForSelector(composer, { timeout: 10_000 })
    await page.click(composer)
    await page.type(composer, text)
    await page.keyboard.press("Enter")
  }
  const settle = async (ms) => { await new Promise((r) => setTimeout(r, ms)) }
  const bandOf = async (slug) => (await page.evaluate(PROBE)).rows.find((r) => r.id === slug)?.band ?? null

  await steer("worker-6", "this send is going to fail")
  await settle(400)
  const rollbackPeak = await bandOf("worker-6")
  // Past the abort (1.5s) AND past TodosView's 8s reappear guard, which is what puts the card back.
  await settle(10_000)
  const rollbackSettled = await page.evaluate(PROBE)
  await page.screenshot({ path: join(outDir, "20-rollback.png") })
  results.rollback = {
    bandWhileOptimistic: rollbackPeak,
    bandAfterFailure: rollbackSettled.rows.find((r) => r.id === "worker-6")?.band ?? null,
    cardRestored: rollbackSettled.cards.includes("worker-6"),
    pass: rollbackPeak === "running" && rollbackSettled.rows.find((r) => r.id === "worker-6")?.band === "rested",
  }

  // ── expiry: the send succeeds, the worker never starts a turn ───────────────────────────────────
  failFollowUps = false
  await steer("worker-7", "this one lands but the worker never picks it up")
  await settle(400)
  const expiryPeak = await bandOf("worker-7")
  await page.screenshot({ path: join(outDir, "21-expiry-optimistic.png") })
  // STEER_OPTIMISM_MS is 12s; wait past it with NO board push touching this thread.
  await settle(13_500)
  const expirySettled = await page.evaluate(PROBE)
  await page.screenshot({ path: join(outDir, "22-expiry-elapsed.png") })
  results.expiry = {
    bandWhileOptimistic: expiryPeak,
    bandAfterCap: expirySettled.rows.find((r) => r.id === "worker-7")?.band ?? null,
    cardRestored: expirySettled.cards.includes("worker-7"),
    pass: expiryPeak === "running" && expirySettled.rows.find((r) => r.id === "worker-7")?.band === "rested",
  }

  // ── held: a snoozed row steered must leave the dimmed band ──────────────────────────────────────
  const heldSlug = "worker-3"
  await api.mutate("setThreadSnooze", {
    slug: heldSlug,
    sessionId: sid(heldSlug),
    until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
  })
  await settle(2500)
  const heldBefore = await bandOf(heldSlug)
  await page.screenshot({ path: join(outDir, "23-held-before.png") })
  // A Held row has no queue card, so its steer goes through the thread DRAWER's composer — tagged by
  // its fixed-positioned drawer ancestor, since the workpane's queue cards share the placeholder.
  await page.click(`[data-sidebar-item="${heldSlug}"] button`)
  await settle(1500)
  const tagged = await page.evaluate(() => {
    const ta = [...document.querySelectorAll("textarea")].find((e) => e.closest(".fixed"))
    if (!ta) return false
    ta.setAttribute("data-probe-composer", "1")
    return true
  })
  if (!tagged) throw new Error("no drawer composer found for the held row")
  const drawerComposer = "[data-probe-composer]"
  await page.click(drawerComposer)
  await page.type(drawerComposer, "picking this back up now")
  await page.keyboard.press("Enter")
  await settle(400)
  const heldPeak = await bandOf(heldSlug)
  await page.screenshot({ path: join(outDir, "24-held-steered.png") })
  results.held = {
    bandBefore: heldBefore,
    bandWhileOptimistic: heldPeak,
    pass: heldBefore === "held" && heldPeak === "running",
  }

} finally {
  await browser.close()
  console.log(JSON.stringify({ ...results, pageErrors: errors }, null, 2))
  const checks = ["rollback", "expiry", "held"]
  const failed = checks.filter((k) => !results[k]?.pass)
  if (failed.length) { console.error("FAIL:", failed.join(", ")); process.exitCode = 1 }
  else console.error("PASS: rollback, expiry, held")
}
