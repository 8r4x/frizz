import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the TOOL-ROW RHYTHM. Skipped unless a Vite URL serving the fixtures is provided
// (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and set
// FRAY_TOOL_BATCH_SPACING_E2E_URL to its origin.
//
// The invariant (maintainer 2026-07-27, "there's a bigger gap between independent batches as opposed to
// within a batch"): two ADJACENT tool cards sit at the same 6px pitch however the turn was chunked —
// batched inside one assistant message, or split across successive ones. The tailer chunks a burst of
// calls arbitrarily, so the chunking must not be legible as spacing. Measured in the browser rather than
// asserted on the tree because the bug was a container `gap` on a surface that never went through the
// spacer walk — only real layout catches that.
const baseUrl = process.env.FRAY_TOOL_BATCH_SPACING_E2E_URL

const TIGHT = 6
// The prose control: the one boundary that must NOT be tight. Its exact height is font-dependent, so
// assert only that it is comfortably wider than the tool run.
const PROSE_MIN = 30

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// Gaps between consecutive tool cards WITHIN one message column ([data-transcript-column] — see the
// marker's note in ChatView), tagged with whether the two cards came from the same assistant message.
// `nth` picks the column: the drawer mounts OVER the thread, so both are in the DOM at once.
async function gaps(page: import("puppeteer").Page, nth: number) {
  return page.evaluate((idx) => {
    const scope = document.querySelectorAll("[data-transcript-column]")[idx]
    const cards = [...scope.querySelectorAll(".fray-bash")]
    const out: { gap: number; sameMessage: boolean; from: string; to: string }[] = []
    for (let i = 1; i < cards.length; i++) {
      const prev = cards[i - 1]
      const cur = cards[i]
      out.push({
        gap: Math.round((cur.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) * 10) / 10,
        sameMessage: prev.closest("[data-fray-msg]") === cur.closest("[data-fray-msg]"),
        from: (prev.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
        to: (cur.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
      })
    }
    return out
  }, nth)
}

// A tool card that follows PROSE is the control — it keeps the full between-block step. Identified by
// the one fixture card whose message opens with "Confirming the marker file landed."
const isProseBoundary = (g: { to: string }) => g.to.startsWith("Read/private/tmp/out.log")

for (const [surface, query, column] of [
  ["thread transcript", "", 0],
  // The drawer mounts over the thread, so it is the SECOND column on the page.
  ["sub-agent drawer", "?surface=child", 1],
] as const) {
  test(`${surface}: adjacent tool cards keep one pitch across batch boundaries`, {
    skip: !baseUrl,
    timeout: 60_000,
  }, async () => {
    const { browser, page, errors } = await launch()
    try {
      await page.goto(`${baseUrl}/tool-batch-spacing-fixture.html${query}`, { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-transcript-column]").length > n, {}, column)
      await page.waitForSelector(".fray-bash")
      await new Promise((r) => setTimeout(r, 600))

      const measured = await gaps(page, column)
      assert.ok(measured.length >= 8, `expected the fixture's full tool column, got ${measured.length} gaps`)

      const tool = measured.filter((g) => !isProseBoundary(g))
      for (const g of tool) {
        assert.equal(g.gap, TIGHT, `${g.from} → ${g.to} (sameMessage=${g.sameMessage}) must sit at the tight run`)
      }
      // Both shapes are actually present — otherwise the assertion above is vacuous.
      assert.ok(tool.some((g) => g.sameMessage), "fixture must contain an intra-batch pair")
      assert.ok(tool.some((g) => !g.sameMessage), "fixture must contain a cross-message pair")

      // …and the prose adjacency is NOT collapsed with them.
      const prose = measured.filter(isProseBoundary)
      assert.equal(prose.length, 1, "expected exactly one prose-adjacent card")
      assert.ok(prose[0].gap >= PROSE_MIN, `prose boundary must keep its break, got ${prose[0].gap}px`)

      assert.deepEqual(errors, [], "no console/page errors")
    } finally {
      await browser.close()
    }
  })
}
