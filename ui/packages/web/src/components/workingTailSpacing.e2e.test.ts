import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the LIVE TAIL's rhythm — the "Working…" shimmer that closes a running
// transcript. Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other
// *.e2e.test.ts here): start `vite` in packages/web and set FRAY_WORKING_TAIL_SPACING_E2E_URL to its
// origin.
//
// The invariant (maintainer 2026-07-31: "there's more space above the working shimmer than there is
// below the 'Thought for 37 seconds'"): the shimmer is the LIVE member of the quiet meta column, so
// under a meta tail it joins the same tight 6px run that binds a thought label to the tool bands below
// it — and it must land at the SAME optical white as a settled meta label sitting in that slot. Prose
// above it is the control: that boundary keeps the full STEP break.
//
// Measured in the browser rather than asserted on the tree because this is layout, and specifically
// because the box gap alone is not the claim — a line box 1.4px shorter than its peers put the shimmer's
// INK nearer the card above while every box reading said the gaps agreed.
const baseUrl = process.env.FRAY_WORKING_TAIL_SPACING_E2E_URL

const TIGHT = 6
const STEP = 14
// The virtualizer positions rows at fractional offsets, so a measured gap lands within a sub-pixel of
// its constant. Assert the pitch, not the rounding.
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.5, `${what}: expected ~${expected}px, got ${actual}px`)

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

const fixtureUrl = (query: string) => new URL(`/working-tail-spacing-fixture.html${query}`, baseUrl).href

// The box gap between the last rendered message row and the runtime-status row, scoped to a surface.
// `drawer` picks the sub-agent sheet's plain column; otherwise the thread's virtualized one.
async function tailGap(page: import("puppeteer").Page, drawer: boolean) {
  return page.evaluate((inDrawer) => {
    const scope = inDrawer
      ? document.querySelector("[data-transcript-column]")
      : document.querySelector("[data-virtualized-transcript]")
    if (!scope) return { error: "surface not mounted" }
    const rows = [...scope.querySelectorAll("[data-fray-msg]")]
    const working = scope.querySelector("[data-working-indicator]")
    if (!working || rows.length === 0) return { error: "no live tail" }
    const last = rows[rows.length - 1]
    const round = (n: number) => Math.round(n * 10) / 10
    return {
      lastRow: last.getAttribute("data-fray-msg"),
      aboveWorking: round(working.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
      betweenRows: rows.slice(1).map((r, i) => round(r.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom)),
    }
  }, drawer)
}

// The OPTICAL white above a quiet row: the last card's bottom edge to the top of the row's cap band.
// The cap band (baseline → cap height) rather than the string's own ink, because a descender moves the
// latter by >1px for the same glyph — see the `visual-review` skill.
const CAP_WHITE = `(() => {
  const baselineOf = (node) => {
    const span = document.createElement("span")
    node.parentNode.insertBefore(span, node)
    span.appendChild(node)
    const probe = document.createElement("span")
    probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
    span.appendChild(probe)
    const baseline = probe.getBoundingClientRect().bottom
    const cs = getComputedStyle(span)
    const font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " / " + cs.lineHeight + " " + cs.fontFamily
    probe.remove()
    span.parentNode.insertBefore(node, span)
    span.remove()
    return { baseline, font }
  }
  const capTop = (font, baseline) => {
    const c = document.createElement("canvas").getContext("2d")
    c.font = font
    return baseline - c.measureText("H").actualBoundingBoxAscent
  }
  const firstText = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) if (/\\S/.test(n.textContent)) return n
    return null
  }
  const card = document.querySelector('[data-fray-msg="a2"]').getBoundingClientRect()
  const white = (el) => {
    if (!el) return null
    const b = baselineOf(firstText(el))
    return Math.round((capTop(b.font, b.baseline) - card.bottom) * 100) / 100
  }
  const label = [...document.querySelectorAll('[data-fray-msg="m1"] span')].find((s) => s.children.length === 0 && s.textContent.trim().startsWith("Thought"))
  return {
    shimmer: white(document.querySelector("[data-working-indicator] .shimmer-text")),
    settledLabel: white(label),
  }
})()`

test("the live shimmer joins the meta run, and matches a settled label's optical white", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    // 1. The reported column: thought label → two Agent cards → Working…
    await page.goto(fixtureUrl(""), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    const live = await tailGap(page, false)
    assert.equal(live.error, undefined, `thread transcript must mount a live tail: ${live.error}`)
    assert.equal(live.lastRow, "a2", "the shimmer must follow the last Agent card")
    const [afterBubble, ...metaRun] = live.betweenRows!
    assert.ok(afterBubble > TIGHT * 2, `the user bubble keeps a real break, got ${afterBubble}px`)
    for (const gap of metaRun) near(gap, TIGHT, "a meta-run boundary")
    near(live.aboveWorking!, TIGHT, "the shimmer under a meta tail")

    // The shimmer's optical white — the number the report was actually about.
    const liveWhite = await page.evaluate(CAP_WHITE) as { shimmer: number; settledLabel: number | null }

    // 2. The PEER reference: a settled meta label in the same slot, under the same cards.
    await page.goto(fixtureUrl("?tail=meta"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[data-fray-msg="m1"]')
    const refWhite = await page.evaluate(CAP_WHITE) as { shimmer: number; settledLabel: number }
    assert.ok(
      Math.abs(liveWhite.shimmer - refWhite.settledLabel) < 0.5,
      `the shimmer must read as a peer of a settled meta label, got ${liveWhite.shimmer}px vs ${refWhite.settledLabel}px`,
    )

    // 3. CONTROL: prose under the cards restores the full break.
    await page.goto(fixtureUrl("?tail=prose"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    const prose = await tailGap(page, false)
    assert.equal(prose.lastRow, "p1", "the prose control must be the last rendered row")
    near(prose.aboveWorking!, STEP, "prose above the shimmer")

    // 4. The sub-agent drawer runs the plain column and must not disagree.
    await page.goto(fixtureUrl("?surface=child"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-transcript-column] [data-working-indicator]")
    const drawer = await tailGap(page, true)
    near(drawer.aboveWorking!, TIGHT, "the drawer shimmer")

    await page.goto(fixtureUrl("?surface=child&tail=prose"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-transcript-column] [data-working-indicator]")
    const drawerProse = await tailGap(page, true)
    near(drawerProse.aboveWorking!, STEP, "the drawer prose control")

    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})
