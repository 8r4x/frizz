import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the TOOL-ROW RHYTHM. Skipped unless a Vite URL serving the fixtures is provided
// (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and set
// FRIZZ_TOOL_BATCH_SPACING_E2E_URL to its origin.
//
// The invariant after the minimal renderer: provider batching is invisible while collapsed, and after
// explicit expansion the detailed cards still use one 6px pitch. Measured in the browser rather than
// asserted on the tree because both disclosure grouping and card spacing are layout behavior.
const baseUrl = process.env.FRIZZ_TOOL_BATCH_SPACING_E2E_URL

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
// marker's note in ChatView), tagged with WHAT LIES BETWEEN the two cards.
// `nth` picks the column: the drawer mounts OVER the thread, so both are in the DOM at once.
//
// The tag used to be `sameMessage` — do the two cards share a display-message root — on the premise
// that a coalesced run is exactly one root, so crossing one could only mean the real prose break. That
// premise died with the background-launch ejection (2026-08-01): an ejected card is its own display
// message, so a seam now crosses a root for THREE different reasons, only one of which is prose. The
// tag is therefore what actually sits in the gap, which is what decides its height either way.
async function gaps(page: import("puppeteer").Page, nth: number) {
  return page.evaluate((idx) => {
    const scope = document.querySelectorAll("[data-transcript-column]")[idx]
    const cards = [...scope.querySelectorAll(".frizz-bash")]
    // Classified by what is PAINTED in the gap, found by geometry — the fixture's prose shares a message
    // root with its own tool band, so "a prose-only message root" would find nothing.
    //   • a digest HEADER is a real row, so a seam spanning one is legitimately taller than the pitch;
    //   • anything else with text in it is PROSE, and prose keeps the full between-block break.
    const inGap = (top: number, bottom: number) =>
      [...scope.querySelectorAll<HTMLElement>("*")].filter((n) => {
        const r = n.getBoundingClientRect()
        return r.height > 0 && r.top >= top - 0.5 && r.bottom <= bottom + 0.5
      })
    const out: { gap: number; spans: "nothing" | "digest" | "prose"; from: string; to: string }[] = []
    for (let i = 1; i < cards.length; i++) {
      const prev = cards[i - 1]
      const cur = cards[i]
      const top = prev.getBoundingClientRect().bottom
      const bottom = cur.getBoundingClientRect().top
      const occupants = inGap(top, bottom)
      // The HEADER ROW specifically — not merely "something inside a disclosure". The spacers BETWEEN
      // an expanded run's cards live inside that same container, so the looser test called every
      // intra-batch seam a digest span and left the tight-pitch assertion measuring one lonely gap.
      const hasDigest = occupants.some((n) => n.matches("[data-tool-activity] button") || n.querySelector("[data-tool-activity] button") !== null)
      const hasProse = occupants.some(
        (n) => (n.textContent ?? "").trim() !== "" && !n.closest("[data-tool-activity]") && !n.closest(".frizz-bash"),
      )
      out.push({
        gap: Math.round((bottom - top) * 10) / 10,
        spans: hasProse ? "prose" : hasDigest ? "digest" : "nothing",
        from: (prev.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
        to: (cur.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
      })
    }
    return out
  }, nth)
}

// A seam with NOTHING painted in it must sit at the tight run pitch — including the two either side of
// an ejected background card, which is the arrangement the ejection introduced.
const isProseBoundary = (g: { spans: string }) => g.spans === "prose"

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
      const fixtureUrl = (state: "live" | "gap" | "settled") => {
        const url = new URL("/tool-batch-spacing-fixture.html", baseUrl)
        if (query) url.searchParams.set("surface", "child")
        if (state !== "live") url.searchParams.set("state", state)
        return url.href
      }

      // The bottom slot, read out of whichever column this surface owns.
      const readWorkingSlot = (idx: number) => page.evaluate((i) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[i]
        const working = scope.querySelector<HTMLElement>("[data-working-indicator]")
        return {
          workingActivity: working?.dataset.workingActivity,
          shimmerText: working?.querySelector<HTMLElement>(".shimmer-text")?.textContent ?? "",
          digests: scope.querySelectorAll("[data-tool-activity] button").length,
        }
      }, idx)

      await page.goto(fixtureUrl("live"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-transcript-column]").length > n, {}, column)
      await page.waitForFunction((idx) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[idx]
        return scope?.querySelector("[data-working-indicator]")?.textContent?.includes("Final workflow validation")
      }, {}, column)
      const live = await page.evaluate((idx) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[idx]
        const disclosures = [...scope.querySelectorAll<HTMLElement>("[data-tool-activity] button")]
        const labels = disclosures.map((button) => button.getAttribute("aria-label") ?? "")
        const visibleCards = [...scope.querySelectorAll<HTMLElement>(".frizz-bash")].filter((card) => card.offsetParent !== null).length
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
      // The ONE visible card is the ejected background launch. Every ORDINARY card stays unmounted
      // behind its disclosure; a detached process is the exception, because its card is the reader's
      // only handle on something still running (lib/toolActivity.isToolActivityException).
      assert.equal(live.visibleCards, 1, "only the ejected background launch renders a card before any disclosure is expanded")
      assert.equal(live.labels.length, 2, "the background launch splits the run it lands in; the live run itself stays out of history")
      assert.match(live.labels[0], /Expand 4 tool calls: Ran 4 tool calls/, "the earlier settled run digests everything up to the background launch")
      assert.match(live.labels[1], /Expand 2 tool calls: Ran 2 tool calls/, "…and resumes as its own digest below it")
      assert.equal(live.workingActivity, "tool", "the ordinary Working slot identifies its tool-label state")
      // Shown AS WRITTEN, not prefixed: `Running` is a claim about what the tool is doing, and pasted
      // in front of a noun phrase it reads as nonsense — so an unconvertible description is only
      // sentence-cased (961cea3 made that the rule and left this expectation behind, red).
      assert.equal(live.shimmerText, "Final workflow validation", "an authored noun-phrase description beats the raw Bash command in the bottom shimmer")
      assert.doesNotMatch(live.workingText, /Working…/, "the gerund replaces rather than accompanies generic Working")
      assert.equal(live.pendingDisclosures, 0, "no historical disclosure may carry live state")

      // The INTER-CALL GAP — the same transcript with that one call's result landed, the turn still
      // running. The gerund is a claim that a tool is executing, so it has to end with the call: what the
      // reader is waiting on now is the model reasoning over what came back, and a stale `Final workflow
      // validation` sat there reading as a tool that had hung (maintainer 2026-08-04). History must NOT
      // move in the same beat — the digest count is unchanged from the live pass.
      await page.goto(fixtureUrl("gap"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-transcript-column]").length > n, {}, column)
      await page.waitForFunction((idx) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[idx]
        return scope?.querySelector("[data-working-indicator]") !== null
      }, {}, column)
      const gap = await readWorkingSlot(column)
      assert.equal(gap.shimmerText, "Thinking…", "a landed result hands the bottom slot back to the generic reading")
      assert.equal(gap.workingActivity, "generic", "…and the slot reports that it is no longer naming a tool")
      assert.equal(gap.digests, live.labels.length, "the run's digest must not appear in history during the gap")

      await page.goto(fixtureUrl("settled"), { waitUntil: "networkidle0" })
      await page.waitForFunction((n) => document.querySelectorAll("[data-transcript-column]").length > n, {}, column)
      const collapsed = await page.evaluate((idx) => {
        const scope = document.querySelectorAll("[data-transcript-column]")[idx]
        const disclosures = [...scope.querySelectorAll<HTMLElement>("[data-tool-activity] button")]
        const labels = disclosures.map((button) => button.getAttribute("aria-label") ?? "")
        const disclosureGeometry = disclosures.map((button) => {
          const label = button.querySelector<HTMLElement>("[data-tool-activity-label]")!
          const chevron = button.querySelector<SVGElement>("[data-tool-activity-chevron]")!
          const buttonRect = button.getBoundingClientRect()
          const labelRect = label.getBoundingClientRect()
          const chevronRect = chevron.getBoundingClientRect()
          return {
            gap: Math.round((chevronRect.left - labelRect.right) * 10) / 10,
            trailingSpace: Math.round((buttonRect.right - chevronRect.right) * 10) / 10,
          }
        })
        const visibleCards = [...scope.querySelectorAll<HTMLElement>(".frizz-bash")].filter((card) => card.offsetParent !== null).length
        const hasWorkingIndicator = scope.querySelector("[data-working-indicator]") !== null
        disclosures.forEach((button) => button.click())
        return { labels, disclosureGeometry, visibleCards, hasWorkingIndicator }
      }, column)
      assert.equal(collapsed.visibleCards, 1, "settled detail stays unmounted apart from the ejected background launch")
      assert.equal(collapsed.hasWorkingIndicator, false, "settled transcripts have no runtime tail")
      assert.equal(collapsed.labels.length, 3, "two prose-delimited runs, the first of them split by the background launch")
      assert.match(collapsed.labels[0], /Expand 4 tool calls: Ran 4 tool calls/, "the first prose tool tail absorbs provider batches up to the background launch")
      assert.match(collapsed.labels[1], /Expand 2 tool calls: Ran 2 tool calls/, "…and resumes across the batch below it, still presentation-transparent")
      assert.match(collapsed.labels[2], /Expand 3 tool calls: Ran 3 tool calls/, "the second prose tool tail absorbs the following provider batch")
      for (const geometry of collapsed.disclosureGeometry) {
        assert.ok(geometry.gap >= 3 && geometry.gap <= 5, `digest chevron must sit directly beside its label, got ${geometry.gap}px`)
        assert.ok(geometry.trailingSpace > 20, "the full transcript row remains the click target after moving the chevron")
      }
      await page.waitForSelector(".frizz-bash")
      await new Promise((r) => setTimeout(r, 600))

      const measured = await gaps(page, column)
      assert.ok(measured.length >= 8, `expected the fixture's full tool column, got ${measured.length} gaps`)

      const tool = measured.filter((g) => g.spans === "nothing")
      for (const g of tool) {
        assert.equal(g.gap, TIGHT, `${g.from} → ${g.to} must sit at the tight run`)
      }
      // The expanded detail actually contains adjacent cards — otherwise the assertion above is vacuous.
      assert.ok(tool.length >= 4, `fixture must contain intra-batch pairs, got ${tool.length}`)
      // …including the seam INTO the ejected background card. It is a display message of its own, so it
      // is exactly the card that could have opened a paragraph break above itself, and it must not. (Its
      // seam BELOW is not a bare gap — the next run's digest header sits in it — so it is covered by the
      // `digest` class, not here.)
      const ejected = tool.filter((g) => /Waiting for background/.test(g.to))
      assert.equal(ejected.length, 1, `the ejected card must join the tight run above it, got ${JSON.stringify(measured)}`)

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
