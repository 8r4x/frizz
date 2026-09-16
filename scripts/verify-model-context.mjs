// Real browser → project RPC → settings persistence, against an isolated adhoc-stack.mjs instance.
// nub scripts/verify-model-context.mjs http://127.0.0.1:PORT/project/frizz /absolute/shots
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const url = process.argv[2]
if (!url) throw new Error("Pass the URL of a disposable Frizz project, never the live server")
const shots = resolve(process.argv[3] ?? ".adhoc-shots/model-context")
mkdirSync(shots, { recursive: true })
const api = createRpcClient(url, new URL(url).pathname.split("/")[2])
const original = await api.query("settingsGet")
const originalProfile = await api.query("dispatchPreferencesGet")
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] })
const pid = browser.process().pid
const errors = []
try {
  const page = await browser.newPage()
  let holdContext = false
  let heldRequest
  // The sandbox has neither a launcher nor GitHub login. Stub those unrelated dependencies only;
  // every settings/model RPC below reaches the real server.
  await page.setRequestInterception(true)
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/_frizz/control/status") {
      void request.respond({ status: 200, contentType: "application/json", body: "null" })
    } else if (new URL(request.url()).pathname.endsWith("/rpc/githubList")) {
      void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { items: [], total: 0, page: 1, pageCount: 1 } }) })
    } else if (holdContext && request.url().endsWith("/rpc/contextWindowSet")) {
      heldRequest = request
    } else void request.continue()
  })
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 2 })
  await page.goto(url, { waitUntil: "networkidle2" })
  const model = '[aria-label="Model and effort"]'
  const claude = '[aria-label="Claude Code compaction window"]'
  const codex = '[aria-label="Codex context window"]'
  const popup = '[data-context-window-menu]'
  const openGrid = async () => {
    if (!await page.$(model)) {
      await page.click('[aria-label="New thread"]')
      await page.waitForSelector(model)
    }
    if (!await page.$(".profile-grid-menu")) await page.click(model)
    await page.waitForSelector(codex)
  }
  const choose = async (selector, label, key, expected) => {
    await page.click(selector)
    await page.waitForSelector(popup)
    const option = (await page.$$(`${popup} [role="menuitemradio"]`))
    let picked = false
    for (const button of option) {
      if (await button.evaluate(el => el.textContent.trim()) === label) {
        await button.click(); picked = true; break
      }
    }
    assert.ok(picked, `missing option ${label}`)
    await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, selector)
    assert.equal((await api.query("settingsGet"))[key], expected)
    assert.ok(await page.$(".profile-grid-menu"), "choosing context must leave the model grid open")
  }
  await openGrid()
  await page.click(claude)
  await page.waitForSelector(popup)
  assert.deepEqual(await page.$$eval(`${popup} [role="menuitemradio"]`, els => els.map(el => el.textContent.trim())), ["200k", "350k", "500k (default)", "750k", "1M (maximum)"])
  await page.keyboard.press("Escape")
  await page.click(codex)
  await page.waitForSelector(popup)
  assert.deepEqual(await page.$$eval(`${popup} [role="menuitemradio"]`, els => els.map(el => el.textContent.trim())), ["272k (default)", "472k", "672k", "872k (maximum)"])
  await page.keyboard.press("Escape")
  assert.equal(await page.$(popup), null)
  assert.ok(await page.$(".profile-grid-menu"), "Escape closes the nested picker first")
  // A slow save cannot race a dispatch that would otherwise pick up the previous window.
  holdContext = true
  await page.click(codex)
  const change = await page.$(`${popup} [role="menuitemradio"]:nth-child(2)`)
  await change.click()
  await page.waitForFunction(() => document.querySelector('.context-window-trigger')?.disabled)
  assert.equal(await page.$eval('textarea[placeholder="Describe the task…"]', el => el.disabled), true)
  assert.ok(heldRequest)
  holdContext = false
  await heldRequest.continue()
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, codex)
  assert.equal((await api.query("settingsGet")).codexContextWindow, 472000)
  for (const [label, value] of [["472k", 472000], ["672k", 672000], ["872k (maximum)", 872000], ["272k (default)", undefined]]) {
    await choose(codex, label, "codexContextWindow", value)
  }
  await choose(claude, "750k", "autoCompactWindow", 750000)
  await choose(codex, "672k", "codexContextWindow", 672000)
  const saved = await api.query("settingsGet")
  assert.equal(saved.autoCompactWindow, 750000)
  for (const key of Object.keys(original).filter(key => !["autoCompactWindow", "codexContextWindow"].includes(key))) {
    assert.deepEqual(saved[key], original[key], `unrelated setting ${key} survives`)
  }
  assert.deepEqual(await api.query("dispatchPreferencesGet"), originalProfile, "context does not select a model/effort")
  await page.reload({ waitUntil: "networkidle2" })
  await openGrid()
  assert.equal(await page.$eval(codex, el => el.textContent.trim()), "672k")
  assert.equal(await page.$eval(claude, el => el.textContent.trim()), "750k")

  const readings = []
  for (const width of [1200, 390]) for (const font of ["sans", "mono"]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 })
    await api.mutate("settingsSet", { ...await api.query("settingsGet"), font })
    // A breakpoint changes which composer is mounted. Load at the target width rather than holding
    // an ElementHandle to the outgoing desktop composer's menu while React replaces that subtree.
    await page.reload({ waitUntil: "networkidle2" })
    await openGrid()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.font), font)
    // Probe before opening the child focus scope; temporary probe nodes are not user interactions.
    const alignment = await page.$$eval('.context-window-trigger', buttons => buttons.map(button => {
      const text = button.querySelector('.context-window-value')
      const probe = document.createElement('span')
      probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0'
      text.append(probe)
      const baseline = probe.getBoundingClientRect().bottom
      probe.remove()
      const cs = getComputedStyle(text)
      const canvas = document.createElement('canvas').getContext('2d')
      canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const metrics = canvas.measureText(text.textContent)
      const path = button.querySelector('path').getBoundingClientRect()
      const mid = baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2
      return { label: button.getAttribute('aria-label'), residual: +(path.top + path.height / 2 - mid).toFixed(2) }
    }))
    for (const reading of alignment) assert.ok(Math.abs(reading.residual) < 0.4, JSON.stringify({font,...reading}))
    await page.click(codex)
    await page.waitForSelector(popup)
    const geometry = await page.$eval(popup, el => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight }
    })
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry))
    readings.push({ width, font, geometry, alignment })
    await page.screenshot({ path: `${shots}/${font}-${width}.png` })
    if (width === 1200 && font === "sans") {
      const clip = await page.evaluate(() => {
        const boxes = [document.querySelector('.profile-grid-menu'), document.querySelector('[data-context-window-menu]')].map(el => el.getBoundingClientRect())
        const x = Math.min(...boxes.map(r => r.left)), y = Math.min(...boxes.map(r => r.top))
        return { x, y, width: Math.max(...boxes.map(r => r.right)) - x, height: Math.max(...boxes.map(r => r.bottom)) - y }
      })
      await page.screenshot({ path: `${shots}/model-picker.png`, clip })
    }
    await page.keyboard.press("Escape")
  }
  // Keyboard activation uses the same save path, without accidentally selecting a model row.
  await page.click(codex)
  await page.keyboard.press("Home")
  await page.keyboard.press("Enter")
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, codex)
  assert.equal((await api.query("settingsGet")).codexContextWindow, undefined)
  await page.keyboard.press("Escape")
  assert.equal(await page.$(".profile-grid-menu"), null)
  await page.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 6 })
  await page.reload({ waitUntil: "networkidle2" })
  await openGrid()
  await (await page.$(codex)).screenshot({ path: `${shots}/control-6x.png` })
  await page.keyboard.press("Escape")
  // The sandbox has no GitHub login. Open the real modal via its store, without mocking its model
  // picker or settings. Use Vite's exact loaded module URL so HMR cannot create a second store.
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === "/src/store.ts")
    const { store } = await import(resource.name)
    store.showGithubPicker = true
  })
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Model and effort"]').length === 2)
  await (await page.$$(model)).at(-1).click()
  await page.click(codex)
  await page.waitForSelector(popup)
  assert.equal(await page.$eval(popup, el => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  }), true, "context options are clickable above the GitHub dialog")
  await page.keyboard.press("Escape")
  assert.equal(await page.$(popup), null)
  assert.ok(await page.$(".profile-grid-menu"))
  await page.keyboard.press("Escape")
  assert.equal(await page.$(".profile-grid-menu"), null)
  assert.equal((await page.$$(model)).length, 2, "Escape preserves the GitHub dialog")
  assert.deepEqual(errors, [], "no console or page errors")
  writeFileSync(`${shots}/verification.json`, JSON.stringify({ readings, errors }, null, 2))
  console.log("PASS: presets, both providers, reload persistence, unrelated settings, model/effort unchanged, keyboard/Escape, narrow geometry, both fonts, GitHub dialog layering, no browser errors")
} finally {
  try { await api.mutate("settingsSet", original) } finally { await browser.close() }
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  assert.equal(alive, false, `owned browser ${pid} exited`)
  console.log(`Browser ${pid} cleaned up`)
}
