import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the GitHub picker's header: the repo slug as a right-justified link out, and
// the gear that opens the triage prompt in a modal popover. Drives github-picker-range-fixture, which
// records every settingsSet the popover makes. Skipped unless FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL names
// a vite serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL

type Fixture = { settingsWrites: Record<string, unknown>[]; dispatched: unknown[] }
const GEAR = 'button[aria-label="Triage prompt settings"]'
const PANEL = "[data-github-prompt-menu]"

async function launch(query = "?rows=5") {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/github-picker-range-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-row-number]")
  return { browser, page, errors }
}

const writes = (page: import("puppeteer").Page) =>
  page.evaluate(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.map((w) => ({ ...w })))

async function selectAllInTextarea(page: import("puppeteer").Page) {
  await page.focus(`${PANEL} textarea`)
  await page.evaluate((panel) => {
    const box = document.querySelector<HTMLTextAreaElement>(`${panel} textarea`)!
    box.setSelectionRange(0, box.value.length)
  }, PANEL)
}

test("the header links out to the repo, right-justified, with the gear beside it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const header = await page.$eval("h2", (h2) => {
      const link = h2.querySelector<HTMLAnchorElement>("a.github-repo-link")!
      const gear = h2.querySelector<HTMLButtonElement>('button[aria-label="Triage prompt settings"]')!
      const title = h2.querySelector("span")!
      return {
        href: link.href,
        target: link.target,
        text: link.textContent?.trim(),
        hasArrow: link.querySelector("svg") !== null,
        linkRight: link.getBoundingClientRect().right,
        gearLeft: gear.getBoundingClientRect().left,
        gearRight: gear.getBoundingClientRect().right,
        h2Right: h2.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
        dash: /—/.test(h2.textContent ?? ""),
      }
    })
    assert.equal(header.href, "https://github.com/fixture/repo")
    assert.equal(header.target, "_blank")
    assert.equal(header.text, "fixture/repo")
    assert.equal(header.hasArrow, true)
    assert.equal(header.dash, false, "the slug is no longer an em-dashed suffix of the title")
    assert.ok(header.linkRight < header.gearLeft, "the slug sits left of the gear")
    assert.ok(header.h2Right - header.gearRight < 2, "the gear is flush with the header's right edge")
    assert.ok(header.linkRight - header.titleRight > 100, "the slug is right-justified, well clear of the title")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the prompt panel shows the effective prompt, survives the pointer leaving, and debounces typing to one write", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    assert.match(await page.$eval(`${PANEL} textarea`, (el) => (el as HTMLTextAreaElement).value), /^Triage \{repo\}#\{n\}/, "prefilled with the shipped default")
    await page.mouse.move(8, 8, { steps: 10 })
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(await page.$(PANEL), "the panel is still open after the pointer left it")

    await selectAllInTextarea(page)
    await page.keyboard.type("Custom prompt", { delay: 30 })
    assert.equal((await writes(page)).length, 0, "nothing written while typing continues")
    await page.waitForFunction(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.length === 1, { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 600))
    const sent = await writes(page)
    assert.equal(sent.length, 1, "one write for a burst of typing")
    assert.equal(sent[0]!.githubPrompt, "Custom prompt")
    assert.equal(sent[0]!.font, "sans", "the whole object goes over")
    assert.match(await page.$eval(PANEL, (el) => el.textContent ?? ""), /Reset to default/, "a customized prompt offers its reset")

    // Escape closes the panel and ONLY the panel — the picker's own Escape handler closes the whole
    // modal, and it must not see this press.
    await page.keyboard.press("Escape")
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$("h2"), "the picker is still open")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("closing the panel by clicking outside flushes a pending keystroke, closes nothing else, and holds dispatch until the write lands", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?rows=5&settingsDelay=1500")
  try {
    // A row is checked, so the dispatch button is live and its gating is observable.
    await page.click("[data-row-number]")
    const startButton = async () => page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))!)
    assert.equal(await (await startButton()).evaluate((b) => (b as HTMLButtonElement).disabled), false)

    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    await selectAllInTextarea(page)
    await page.keyboard.type("Flushed", { delay: 10 })
    assert.equal((await writes(page)).length, 0, "still inside the debounce")
    // Outside click: the panel's own dismiss. The picker's backdrop would close the picker on a
    // mousedown that reached it — it must not, because the modal panel owns the pointer.
    await page.mouse.click(8, 8)
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$("h2"), "the picker survived the outside click")
    // The flushed write is in flight for 1.5s: the button waits on it.
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))?.disabled === true, { timeout: 2000 })
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))?.disabled === false, { timeout: 5000 })
    const sent = await writes(page)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.githubPrompt, "Flushed", "the half-typed value survived the close")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
