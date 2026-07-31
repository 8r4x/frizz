import assert from "node:assert/strict"
import test from "node:test"

// Range selection is a MOUSE gesture: the modifier, the anchor, the browser's own text-selection
// reflex. Unit tests pin the reducer, but only a real browser proves the wiring — that shift reaches
// the handler, that the row's title link doesn't swallow the click, and that dragging across rows
// doesn't paint a text selection over the list. Drive the real component in the fixture page.
const baseUrl = process.env.FRAY_GITHUB_PICKER_RANGE_E2E_URL

test("shift-clicking two rows in the GitHub picker selects every row in between", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  const errors: string[] = []
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  // The checkbox sits at the row's left edge — click there so the gesture never lands on the title
  // link (which stops propagation and would open GitHub instead of selecting).
  const CHECKBOX = { x: 14, y: 14 }
  const row = (n: number) => `[data-row-number="${n}"]`
  const click = async (n: number, shift = false) => {
    if (shift) await page.keyboard.down("Shift")
    await page.click(row(n), { offset: CHECKBOX })
    if (shift) await page.keyboard.up("Shift")
  }
  const checked = () => page.$$eval("[data-row-number]", (rows) =>
    rows.filter((r) => r.getAttribute("aria-pressed") === "true").map((r) => Number(r.getAttribute("data-row-number"))))

  try {
    await page.setViewport({ width: 1100, height: 950, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/github-picker-range-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-row-number="412"]')
    const numbers = await page.$$eval("[data-row-number]", (rows) => rows.map((r) => Number(r.getAttribute("data-row-number"))))
    assert.equal(numbers.length, 24, "the fixture must render more rows than the 20-per-batch cap")
    assert.deepEqual(await checked(), [], "nothing is selected before the first click")

    // The gesture from the task: click one row, shift-click another, get everything in between.
    await click(400)
    await click(366, true)
    assert.deepEqual(await checked(), [400, 398, 395, 390, 388, 381, 377, 370, 366])

    // Shift+click must not leave the browser's own text selection smeared across the rows.
    assert.equal(await page.evaluate(() => String(window.getSelection() ?? "")), "")

    // A second shift-click re-spans from the SAME anchor, so the range widens rather than restarting.
    await click(348, true)
    assert.deepEqual(await checked(), [400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348])

    // Shift-clicking UPWARD from a fresh anchor is symmetric, and rows outside the span are untouched.
    await click(321)
    await click(330, true)
    assert.deepEqual(await checked(), [400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348, 330, 328, 321])

    // Plain-click an already-checked row to uncheck it, then shift-click: the range CLEARS.
    await click(390)
    await click(377, true)
    assert.deepEqual(await checked(), [400, 398, 395, 370, 366, 361, 359, 352, 348, 330, 328, 321])

    // A range that overruns the server's per-batch cap truncates VISIBLY: 20 rows, contiguous from the
    // anchor, plus the toast and the footer hint. Reload first for a clean, empty selection.
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector('[data-row-number="412"]')
    await click(412)
    await click(318, true)
    const capped = await checked()
    assert.equal(capped.length, 20, "the cap holds the selection at the server's per-batch max")
    assert.deepEqual(capped, numbers.slice(0, 20), "the kept block is contiguous from the anchor")
    const body = await page.$eval("body", (node) => node.innerText.replace(/\s+/g, " "))
    assert.match(body, /20 max per batch — selection capped/, "the capped range must say so in a toast")

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})
