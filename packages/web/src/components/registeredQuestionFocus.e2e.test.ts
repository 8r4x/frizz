import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for "focusing the free-text box unselects the chosen option" on a REGISTERED
// question (maintainer 2026-08-28: "Focusing the free text option is supposed to unselect the other
// options"). The card's onFocus hands the producer its unchanged text and relies on THAT clearing the
// pick; this producer wrote only the draft and left the chip lit beside a focused box. Skipped unless a
// Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start
// `vite` in packages/web and set FRIZZ_REGISTERED_QUESTION_FOCUS_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_REGISTERED_QUESTION_FOCUS_E2E_URL

type Page = import("puppeteer").Page

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// A real mouse click at the centre of the i-th element `selector` matches. A chip's hit area is a
// stretched button whose mousedown is prevented, so only a pointer click exercises the focus dance the
// bug lives in — `el.click()` would skip it.
async function mouseClick(page: Page, selector: string, i = 0) {
  const box = await page.$$eval(selector, (ns, i) => {
    const r = ns[i as number]!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, i)
  await page.mouse.click(box.x, box.y)
}

// Which option rows of the card wear the selection border, by index.
const selectedRows = (page: Page, card: string) =>
  page.$$eval(`${card} [data-question-option]`, (ns) => ns.flatMap((n, i) => (n.classList.contains("border-accent") ? [i] : [])))
const boxFocused = (page: Page, card: string) =>
  page.$eval(`${card} textarea[data-surface='questionAnswer']`, (ta) => document.activeElement === ta)

test("focusing the free-text box unselects a registered question's chosen option; a multi keeps its set", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?many=1`, { waitUntil: "networkidle0" })
    const single = "[data-question-id='qst_0001aaaa']"
    const multi = "[data-question-id='qst_0004dddd']"
    await page.waitForSelector(`${single} [data-question-option]`)
    await page.waitForSelector(`${multi} [data-question-option]`)

    // ── SINGLE: pick B, then click into the box — B must let go ──
    await mouseClick(page, `${single} [data-question-option]`, 1)
    assert.deepEqual(await selectedRows(page, single), [1])
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, single), true)
    assert.deepEqual(await selectedRows(page, single), [])
    // Climbing back out without typing does not resurrect the pick.
    await page.keyboard.press("Escape")
    assert.equal(await boxFocused(page, single), false)
    assert.deepEqual(await selectedRows(page, single), [])
    // A chip click still takes over from a typed answer, and clears the text.
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    await page.keyboard.type("neither")
    assert.deepEqual(await selectedRows(page, single), [])
    await mouseClick(page, `${single} [data-question-option]`, 0)
    assert.deepEqual(await selectedRows(page, single), [0])
    assert.equal(await page.$eval(`${single} textarea[data-surface='questionAnswer']`, (ta) => (ta as HTMLTextAreaElement).value), "")

    // ── MULTI: the note box only adds colour, so the toggled set survives its focus ──
    await mouseClick(page, `${multi} [data-question-option]`, 0)
    await mouseClick(page, `${multi} [data-question-option]`, 2)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])
    await mouseClick(page, `${multi} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, multi), true)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
