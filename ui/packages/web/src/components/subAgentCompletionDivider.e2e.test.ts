import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRAY_SUBAGENT_COMPLETION_E2E_URL

// Both of the maintainer's 2026-07-27 asks are RENDERING facts, so they are pinned in a real browser
// against the real components (subagent-completion-fixture.html), not in string assertions:
//
//   1. A sub-agent finishing draws the SAME centred wake divider a background shell's completion draws
//      — same chrome, adjacent in the same transcript — instead of a second AgentBlock card that
//      disappeared into the surrounding tool band.
//   2. Every sub-agent title is a drill-in link that opens the drawer: the transcript launch card, the
//      completion divider, the rail row, the queue-card row, the ops-strip row, AND a nested dispatch
//      inside the sub-agent drawer itself (which had no slug at all and rendered as dead text).
//
// Run it against a plain vite over packages/web:
//   npx vite --port 5211 --strictPort --host 127.0.0.1
//   FRAY_SUBAGENT_COMPLETION_E2E_URL=http://127.0.0.1:5211 npx tsx --test …
test("a finished sub-agent draws the shell's wake divider, and every sub-agent title opens the drawer", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  const errors: string[] = []
  // The bare fixture page serves no favicon, so Chrome logs a 404 whose console text carries no URL.
  // Track failing RESPONSE urls separately and exclude that one by path.
  const notFound: string[] = []
  page.on("response", (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname) })
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))

  try {
    await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/subagent-completion-fixture.html`, { waitUntil: "networkidle0" })

    // ---- 1. convergence ----
    const dividers = await page.$$eval("[data-after] [data-wake-divider]", (nodes) =>
      nodes.map((n) => ({
        marker: (n as HTMLElement).dataset.wakeDivider,
        text: (n as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        hairlines: n.querySelectorAll("span.h-px").length,
        cls: n.className,
      })),
    )
    assert.equal(dividers.length, 2, "the after panel holds one agent completion and one shell wake")
    const [agent, shell] = dividers
    assert.equal(agent.marker, "agent")
    assert.equal(shell.marker, "event")
    // The convergence itself: identical chrome, two hairlines each, same wrapper classes.
    assert.equal(agent.cls, shell.cls, "the agent divider must reuse the shell wake divider's chrome verbatim")
    assert.equal(agent.hairlines, 2)
    assert.equal(shell.hairlines, 2)
    // innerText inserts a space between the guillemets and the title because they are separate flex
    // items (the guillemets sit OUTSIDE the truncating title so a clipped title still closes its
    // quote); the gap-less nested flex renders them touching. Tolerate that in the extraction only.
    assert.match(agent.text, /Sub-agent\s+«\s*Audit the pricing parser for edge cases\s*»\s+finished · 35 min$/)
    assert.match(shell.text, /Background task «.+» exited 143$/)

    // The completion point must no longer draw a bordered tool card. The after panel's ONLY Agent card
    // is the launch one; the before panel (the old rendering) keeps two, which is what made them
    // indistinguishable.
    const agentCards = (label: string) => page.$$eval(`${label} .fray-bash-header`, (h) => h.filter((n) => n.textContent?.startsWith("Agent")).length)
    assert.equal(await agentCards("[data-after]"), 1, "after: the dispatch card only")
    assert.equal(await agentCards("[data-before]"), 2, "before: the duplicate card this change removed")

    // ---- 2. every title opens the drawer ----
    const surfaces: [string, string][] = [
      ["completion divider", "[data-after] [data-subagent-completion-open]"],
      ["transcript launch card", '[data-after] button[aria-label^="Open sub-agent transcript"]'],
      ["sidebar rail row", '[data-live-rows] button[class*="pl-[26px]"]'],
      ["queue card row", "[data-queue-subagents] button"],
      ["drawer ops strip row", '[data-live-rows] [data-op-row] button[aria-label^="Open sub-agent transcript"]'],
    ]
    // Teardown between surfaces goes through the DOM (a drawer mid-slide-out fails hit-testing, which
    // would be a flake, not a finding). The affordance assertions above are the ones that use a real
    // mouse press.
    const closeAll = async () => {
      await page.evaluate(() => { for (const b of document.querySelectorAll<HTMLElement>('[aria-label="Close"]')) b.click() })
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Close"]').length === 0, { timeout: 5000 })
    }
    // A REAL mouse click on the rendered button (not el.click()), so a zero-size or covered affordance
    // fails here rather than silently "passing" through a synthetic dispatch.
    const mouseClick = async (selector: string) => {
      const el = await page.$(selector)
      if (!el) return false
      await el.evaluate((n) => n.scrollIntoView({ block: "center" }))
      await new Promise((r) => setTimeout(r, 120))
      await el.click()
      return true
    }
    for (const [label, selector] of surfaces) {
      assert.ok(await mouseClick(selector), `${label} must render a real, clickable button`)
      await page.waitForSelector('[aria-label="Close"]', { timeout: 5000 })
      await new Promise((r) => setTimeout(r, 400))
      const body = await page.$eval("body", (b) => (b as HTMLElement).innerText)
      assert.ok(
        body.includes("Reading the tier table") || body.includes("Transcript unavailable"),
        `${label} must open a resolved (or plainly unavailable) sub-agent drawer`,
      )
      await closeAll()
    }

    // A dispatch NESTED inside the sub-agent drawer — the scenario that was dead text before, because
    // the drawer provides no ThreadSlugContext. Both its card and its own completion divider must link.
    assert.ok(await mouseClick("[data-after] [data-subagent-completion-open]"))
    await page.waitForSelector('[aria-label="Close"]', { timeout: 5000 })
    // The drawer defers its transcript body a frame past the slide-in, so wait for the child's content.
    await page.waitForFunction(() => document.body.innerText.includes("Reading the tier table"), { timeout: 5000 })
    const nested = await page.$$eval("[data-subagent-completion-open]", (n) => n.map((e) => (e as HTMLElement).innerText))
    assert.ok(nested.some((t) => t.includes("Write property tests")), "the child's own completion divider links too")
    const nestedCard = await page.$$eval('button[aria-label^="Open sub-agent transcript"]', (n) => n.map((e) => e.getAttribute("aria-label")))
    assert.ok(nestedCard.some((t) => t?.includes("Write property tests")), "the child's own dispatch card links too")

    // A grandchild id the tailer cannot resolve degrades to the stated unavailable state, never a
    // dead link and never a blank drawer.
    const nestedLink = (await page.$$("[data-subagent-completion-open]")).at(-1)
    await nestedLink!.click()
    await new Promise((r) => setTimeout(r, 900))
    const afterNested = await page.$eval("body", (b) => (b as HTMLElement).innerText)
    assert.match(afterNested, /Transcript unavailable/)

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((p) => p !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})
