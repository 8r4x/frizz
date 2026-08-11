import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the air around a rendered PICTURE. Skipped unless a Vite URL serving the
// fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and
// set FRIZZ_PICTURE_SPACING_E2E_URL to its origin.
//
// The invariant (maintainer 2026-08-11, on an image `Read` with the live shimmer under it: "we need
// better spacing under the screenshots … it's too close"): a picture is a tool-activity EXCEPTION, so
// every spacing predicate used to see "a card" and charge the tight 6px run that binds a batch of
// compact bands together. A picture is not a compact band — measured 6.19px from the frame's bottom
// border to the shimmer's box — so it takes PICTURE_STEP against whatever it neighbours, on both sides,
// while the compact exceptions around it keep the run.
//
// Measured in the browser rather than asserted on the tree because this is layout, and because the rule
// is charged in FOUR places (the between-message gap, the working-indicator gap, the seams inside one
// tool band, and the seams between a message's blocks) that must not drift apart.
//
// The picture itself does not have to LOAD: `/local-image` is not served by a plain Vite dev server, so
// BlockImage falls back to its path text — and the gap is decided by the tool's `outputImage` field,
// never by whether the bytes arrived. Point the URL at a server that proxies /_frizz to a real stack if
// you want to SEE the frames while the numbers are checked.
const baseUrl = process.env.FRIZZ_PICTURE_SPACING_E2E_URL

const TIGHT = 6
const PICTURE = 22
// The virtualizer positions rows at fractional offsets, so a measured gap lands within a sub-pixel of
// its constant. Assert the pitch, not the rounding.
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.5, `${what}: expected ~${expected}px, got ${actual}px`)

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  // `flushSync` is the virtualizer's own dev-mode warning on this fixture — it predates this rule and
  // fires identically with the spacing reverted, so it is noise here rather than a signal.
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|local-image|flushSync/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

const fixtureUrl = (query: string) => new URL(`/screenshot-gap-fixture.html${query}`, baseUrl).href

// The gap from the last rendered message row to the runtime-status row. The virtualizer's DOM order is
// not its VISUAL order (rows are absolutely positioned), so the row above the shimmer is the one whose
// bottom edge sits lowest, never `rows[rows.length - 1]`.
async function tailGap(page: import("puppeteer").Page) {
  return page.evaluate(() => {
    const scope = document.querySelector("[data-virtualized-transcript]")
    if (!scope) return { error: "surface not mounted" }
    const rows = [...scope.querySelectorAll("[data-frizz-msg]")]
    const working = scope.querySelector("[data-working-indicator]")
    if (!working || rows.length === 0) return { error: "no live tail" }
    const last = rows.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a))
    return {
      lastRow: last.getAttribute("data-frizz-msg"),
      aboveWorking: Math.round((working.getBoundingClientRect().top - last.getBoundingClientRect().bottom) * 10) / 10,
    }
  })
}

// Every picture the fixture asks for has to have SETTLED — decoded and laid out, or fallen back to its
// path text — before a single gap is read, else the frame is still growing under the measurement.
async function settled(page: import("puppeteer").Page) {
  await page.evaluate(async () => {
    await Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null))))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
}

// Every gap between consecutive tool CARDS inside one message, in document order.
async function cardGaps(page: import("puppeteer").Page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-virtualized-transcript] .frizz-bash")]
      .filter((el) => !el.parentElement?.closest(".frizz-bash"))
    return cards.slice(1).map((c, i) => Math.round((c.getBoundingClientRect().top - cards[i].getBoundingClientRect().bottom) * 10) / 10)
  })
}

test("a picture takes its own gap on both sides, and the compact exceptions around it keep the tight run", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    // 1. The reported shape: an image Read, then the live shimmer.
    await page.goto(fixtureUrl(""), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    await settled(page)
    const live = await tailGap(page)
    assert.equal(live.error, undefined, `thread transcript must mount a live tail: ${live.error}`)
    near(live.aboveWorking!, PICTURE, "the shimmer under a picture")

    // 2. CONTROL: two compact background-op cards in the same shapes. Both the seam between them and
    //    the shimmer below them stay at the tight run — the picture gap is charged to pictures, not to
    //    every card that escapes the digest.
    await page.goto(fixtureUrl("?case=control"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    await settled(page)
    const control = await cardGaps(page)
    // Two cards, one seam: the lead-in Bash is inside the collapsed digest and draws no card of its own.
    assert.equal(control.length, 1, `the control must draw two op cards, got ${control.length + 1}`)
    for (const gap of control) near(gap, TIGHT, "a compact exception seam")
    near((await tailGap(page)).aboveWorking!, TIGHT, "the shimmer under a compact card")

    // 3. Two pictures batched in ONE message, then an ordinary tool band in the next: the seam inside
    //    the band and the seam across the message boundary both take the picture's gap.
    await page.goto(fixtureUrl("?case=cards"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[data-frizz-msg="m4"]')
    await settled(page)
    const stacked = await page.evaluate(() => {
      const scope = document.querySelector("[data-virtualized-transcript]")!
      const cards = [...scope.querySelectorAll("figure.frizz-bash, .frizz-bash")]
        .filter((el) => !el.parentElement?.closest(".frizz-bash"))
      const digest = scope.querySelector('[data-frizz-msg="m4"]')!
      const lastPicture = cards[cards.length - 1]
      return {
        betweenPictures: Math.round((cards[cards.length - 1].getBoundingClientRect().top - cards[cards.length - 2].getBoundingClientRect().bottom) * 10) / 10,
        intoDigest: Math.round((digest.getBoundingClientRect().top - lastPicture.getBoundingClientRect().bottom) * 10) / 10,
      }
    })
    near(stacked.betweenPictures, PICTURE, "the seam between two stacked pictures")
    near(stacked.intoDigest, PICTURE, "the seam out of a picture into a digest")

    // 4. Prose below a picture: already the widest ordinary boundary, and it widens to the picture's.
    await page.goto(fixtureUrl("?case=prose"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[data-frizz-msg="m4"]')
    await settled(page)
    const prose = await page.evaluate(() => {
      const scope = document.querySelector("[data-virtualized-transcript]")!
      const rows = [...scope.querySelectorAll("[data-frizz-msg]")]
      const i = rows.findIndex((r) => r.getAttribute("data-frizz-msg") === "m4")
      return Math.round((rows[i].getBoundingClientRect().top - rows[i - 1].getBoundingClientRect().bottom) * 10) / 10
    })
    near(prose, PICTURE, "prose under a picture")

    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})
