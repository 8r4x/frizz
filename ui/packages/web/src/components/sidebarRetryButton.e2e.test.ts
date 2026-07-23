import assert from "node:assert/strict"
import test from "node:test"

// The stalled row's one-click Retry is a HOVER affordance whose click must (a) fire the recovery
// follow-up and (b) NOT also navigate the row — two behaviors only a real browser proves: that the
// button is hidden until hover, that it reveals on hover, that stopPropagation actually keeps the row
// click from co-firing, and that the real retrySession → showToast → Toaster path runs.
const baseUrl = process.env.FRAY_SIDEBAR_RETRY_E2E_URL

test("hovering a stalled sidebar row reveals a Retry button that restarts the session in one click", {
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

  const retry = '[data-sidebar-retry="stalled-migration"]'
  const visible = (sel: string) => page.$eval(sel, (el) => {
    const style = getComputedStyle(el)
    return style.display !== "none" && style.visibility !== "hidden"
  }).catch(() => false)

  try {
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/sidebar-retry-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-sidebar-item="stalled-migration"]')

    // The two STOPPED rows (a [!] crash and a […] exited-at-rest) carry a retry control; the live
    // working row and the live turn-idle resting row must not.
    const retryCount = await page.$$eval("[data-sidebar-retry]", (els) => els.map((e) => e.getAttribute("data-sidebar-retry")))
    assert.deepEqual(retryCount, ["stalled-migration", "exited-at-rest"], "exactly the two stopped rows carry Retry")

    // Hidden at rest…
    assert.equal(await visible(retry), false, "the Retry button is hidden until the row is hovered")

    // …revealed on hover.
    await page.hover('[data-sidebar-item="stalled-migration"]')
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).display !== "none" : false
    }, { timeout: 5_000 }, retry)
    assert.equal(await visible(retry), true, "hovering the row reveals Retry")

    // It sits at the row's RIGHT edge (right-justified), past the row's horizontal midpoint.
    const geo = await page.evaluate((rowSel, btnSel) => {
      const row = document.querySelector(rowSel)!.getBoundingClientRect()
      const btn = document.querySelector(btnSel)!.getBoundingClientRect()
      return { rowLeft: row.left, rowRight: row.right, btnLeft: btn.left, btnRight: btn.right }
    }, '[data-sidebar-item="stalled-migration"]', retry)
    assert.ok(geo.btnLeft > (geo.rowLeft + geo.rowRight) / 2, "Retry is right-justified in the row")
    assert.ok(geo.rowRight - geo.btnRight < 12, "…pinned near the right edge")

    // Click it. The recovery follow-up must fire with the shared restart message, and — crucially — the
    // row must NOT also navigate (stopPropagation): no thread drawer opens.
    await page.click(retry)
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]").length === 1, { timeout: 5_000 })
    const calls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]"))
    // retrySession resolves the session-guard id from the board; the fixture thread carries none, so
    // it sends "" (the server would fail a stale/absent row closed). The message is the shared constant.
    assert.deepEqual(calls, [{ slug: "stalled-migration", sessionId: "", message: "Continue exactly where you left off." }])

    // The retry toast confirms it to the user.
    await page.waitForFunction(() => /Retrying/.test(document.body.innerText), { timeout: 5_000 })

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})
