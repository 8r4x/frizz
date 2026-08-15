import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the Settings drawer's AUTOSAVE. There is no Save button any more, so the only
// thing that can prove a change persisted is watching the settingsSet requests leave the page. Skipped
// unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here):
// start `vite` in packages/web and set FRIZZ_SETTINGS_AUTOSAVE_E2E_URL to its origin.
//
// settings-formatting-fixture records every write on window.__settingsWrites and echoes the payload
// back, so these assertions read the real wire traffic of a real drawer, not a stub of it.
const baseUrl = process.env.FRIZZ_SETTINGS_AUTOSAVE_E2E_URL

type Write = { at: number; body: Record<string, unknown>; ok: boolean }

async function launch(query = "") {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/settings-formatting-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("textarea")
  return { browser, page, errors }
}

const readWrites = (page: import("puppeteer").Page) =>
  page.evaluate(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.map((w) => ({ ...w })))

test("the drawer offers no Save or Cancel — a toggle writes on the click", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()),
    )
    assert.ok(!buttons.some((label) => /^(Save|Saving…|Cancel)$/.test(label)), `no Save/Cancel button: ${buttons.join("|")}`)

    // Font: Mono. One discrete intent, so it must be on the wire without a debounce to wait out.
    await page.evaluate(() => {
      const mono = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Mono")!
      mono.click()
    })
    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 1, { timeout: 2000 })

    const writes = await readWrites(page)
    assert.equal(writes.length, 1, "exactly one write for one click")
    assert.equal(writes[0]!.body.font, "mono")
    // The whole object goes over, not a patch — anything dropped here is a setting silently reset.
    assert.equal(writes[0]!.body.permissionMode, "auto")
    assert.equal(writes[0]!.body.notifications, true)

    // The header reports the save rather than leaving the operator guessing.
    await page.waitForFunction(() => /Saving…|Saved/.test(document.querySelector("header")?.textContent ?? ""), { timeout: 2000 })

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("typing debounces to ONE write, and it carries the last keystroke", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.focus("textarea")
    await page.evaluate(() => {
      const box = document.querySelector("textarea")!
      box.setSelectionRange(0, box.value.length)
    })
    // 12 keystrokes at ~40ms apart: well inside the 500ms window, so a per-keystroke save would show
    // up here as a dozen writes.
    await page.keyboard.type("Investigate", { delay: 40 })
    const mid = await readWrites(page)
    assert.equal(mid.length, 0, `nothing written while typing continues, got ${mid.length}`)

    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 1, { timeout: 3000 })
    // Give a stray extra write time to arrive before declaring one to be one.
    await new Promise((r) => setTimeout(r, 600))

    const writes = await readWrites(page)
    assert.equal(writes.length, 1, `one write for a burst of typing, got ${writes.length}`)
    assert.equal(writes[0]!.body.githubPrompt, "Investigate", "the write carries the final text")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// Removing the Save button removed the operator's own retry. A mutation refused mid-update is
// certified side-effect-free (`retryable` in the envelope), so the drawer has to replay it — otherwise
// restarting Frizz while Settings is open silently discards whatever was changed in that window.
test("a replayable refusal is replayed until it lands, and says so meanwhile", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?retryableFailures=1")
  try {
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Mono")!.click()
    })
    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 1, { timeout: 2000 })
    // While the retry is pending the header owns up to it rather than implying the change was stored.
    assert.match(await page.evaluate(() => document.querySelector("header")!.textContent ?? ""), /Couldn't save/)

    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 2, { timeout: 6000 })
    const writes = await readWrites(page)
    assert.equal(writes[0]!.ok, false, "the first attempt was refused")
    assert.equal(writes[1]!.ok, true, "the replay landed")
    assert.equal(writes[1]!.body.font, "mono", "the replay carries the same value, not a reverted one")
    await page.waitForFunction(() => /Saved/.test(document.querySelector("header")?.textContent ?? ""), { timeout: 2000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("closing the drawer flushes a pending keystroke instead of dropping it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.focus("textarea")
    await page.evaluate(() => {
      const box = document.querySelector("textarea")!
      box.setSelectionRange(0, box.value.length)
    })
    await page.keyboard.type("Audit", { delay: 10 })
    // Immediately — inside the debounce window, with the write still pending.
    assert.equal((await readWrites(page)).length, 0)
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('header button[aria-label="Close"]')!.click())

    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 1, { timeout: 2000 })
    const writes = await readWrites(page)
    assert.equal(writes[0]!.body.githubPrompt, "Audit", "the half-typed value survived the close")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
