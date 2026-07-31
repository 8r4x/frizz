import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the TOOL-ROW RHYTHM. Skipped unless a Vite URL serving the fixtures is provided
// (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and set
// FRAY_TOOL_BATCH_SPACING_E2E_URL to its origin.
//
// The invariant after the minimal renderer: provider batching is invisible while collapsed, and after
// explicit expansion the detailed cards still use one 6px pitch. Measured in the browser rather than
// asserted on the tree because both disclosure grouping and card spacing are layout behavior.
const baseUrl = process.env.FRAY_TOOL_BATCH_SPACING_E2E_URL

const TIGHT = 6
// Prose controls: boundaries on either side of a prose-bearing message must NOT be tight. Their exact
// heights are font-dependent, so assert only that they are comfortably wider than the tool run.
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

// Tool cards in distinct prose-delimited disclosures are the control — they keep the full
// between-block step. Provider turns inside one activity run coalesce into one display message, so a
// detailed-card seam that crosses display-message roots is exactly the real prose break in this fixture.
const isProseBoundary = (g: { sameMessage: boolean }) => !g.sameMessage

for (const [surface, query, column] of [
  ["thread transcript", "", 0],
  // The drawer mounts over the thread, so it is the SECOND column on the page.
  ["sub-agent drawer", "?surface=child", 1],
] as const) {
  test(`${surface}: live gerund stays at the bottom, then settled batches keep one pitch`, {
    skip: !baseUrl,
    timeout: 60_000,
  }, async () => {
    const { browser, page, errors } = await launch()
    try {
      const fixtureUrl = (state: "live" | "settled") => {
        const url = new URL("/tool-batch-spacing-fixture.html", baseUrl)
        if (query) url.searchParams.set("surface", "child")
        if (state === "settled") url.searchParams.set("state", "settled")
        return url.href
      }

      await page.goto(fixtureUrl("live"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-transcript-column]").length > n, {}, column)
      await page.waitForFunction((idx) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[idx]
        return scope?.querySelector("[data-working-indicator]")?.textContent?.includes("Printing the captured output")
      }, {}, column)
      const live = await page.evaluate((idx) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[idx]
        const disclosures = [...scope.querySelectorAll<HTMLElement>("[data-tool-activity] button")]
        const labels = disclosures.map((button) => button.getAttribute("aria-label") ?? "")
        const visibleCards = [...scope.querySelectorAll<HTMLElement>(".fray-bash")].filter((card) => card.offsetParent !== null).length
        const working = scope.querySelector<HTMLElement>("[data-working-indicator]")
        const shimmer = working?.querySelector<HTMLElement>(".shimmer-text")
        return {
          labels,
          visibleCards,
          workingText: working?.textContent ?? "",
          workingActivity: working?.dataset.workingActivity,
          shimmerText: shimmer?.textContent ?? "",
          pendingDisclosures: scope.querySelectorAll('[data-tool-activity-state="pending"]').length,
        }
      }, column)
      assert.equal(live.visibleCards, 0, "ordinary cards stay unmounted until a settled disclosure is expanded")
      assert.equal(live.labels.length, 1, "the pending run stays out of transcript history")
      assert.match(live.labels[0], /Expand 7 tool calls: Ran 7 tool calls/, "the earlier settled run keeps one historical digest")
      assert.equal(live.workingActivity, "tool", "the ordinary Working slot identifies its tool-label state")
      assert.equal(live.shimmerText, "Printing the captured output", "the newest gerund owns the existing bottom shimmer")
      assert.doesNotMatch(live.workingText, /Working…/, "the gerund replaces rather than accompanies generic Working")
      assert.equal(live.pendingDisclosures, 0, "no historical disclosure may carry live state")

      await page.goto(fixtureUrl("settled"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-transcript-column]").length > n, {}, column)
      const collapsed = await page.evaluate((idx) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[idx]
        const disclosures = [...scope.querySelectorAll<HTMLElement>("[data-tool-activity] button")]
        const labels = disclosures.map((button) => button.getAttribute("aria-label") ?? "")
        const visibleCards = [...scope.querySelectorAll<HTMLElement>(".fray-bash")].filter((card) => card.offsetParent !== null).length
        const hasWorkingIndicator = scope.querySelector("[data-working-indicator]") !== null
        disclosures.forEach((button) => button.click())
        return { labels, visibleCards, hasWorkingIndicator }
      }, column)
      assert.equal(collapsed.visibleCards, 0, "settled detail stays unmounted until its disclosure is expanded")
      assert.equal(collapsed.hasWorkingIndicator, false, "settled transcripts have no runtime tail")
      assert.equal(collapsed.labels.length, 2, "only the two prose-delimited activity runs get disclosures")
      assert.match(collapsed.labels[0], /Expand 7 tool calls: Ran 7 tool calls/, "the first prose tool tail absorbs all three following provider batches")
      assert.match(collapsed.labels[1], /Expand 3 tool calls: Ran 3 tool calls/, "the second prose tool tail absorbs the following provider batch")
      await page.waitForSelector(".fray-bash")
      await new Promise((r) => setTimeout(r, 600))

      const measured = await gaps(page, column)
      assert.ok(measured.length >= 8, `expected the fixture's full tool column, got ${measured.length} gaps`)

      const tool = measured.filter((g) => !isProseBoundary(g))
      for (const g of tool) {
        assert.equal(g.gap, TIGHT, `${g.from} → ${g.to} (sameMessage=${g.sameMessage}) must sit at the tight run`)
      }
      // The expanded detail actually contains adjacent cards — otherwise the assertion above is vacuous.
      assert.ok(tool.some((g) => g.sameMessage), "fixture must contain an intra-batch pair")

      // …and the prose adjacency is NOT collapsed with them.
      const prose = measured.filter(isProseBoundary)
      assert.equal(prose.length, 1, "only the real prose break may split the two expanded activity runs")
      for (const g of prose) {
        assert.ok(g.gap >= PROSE_MIN, `prose boundary must keep its break, got ${g.gap}px`)
      }

      assert.deepEqual(errors, [], "no console/page errors")
    } finally {
      await browser.close()
    }
  })
}
