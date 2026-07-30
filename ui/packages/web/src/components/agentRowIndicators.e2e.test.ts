import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRAY_AGENT_ROW_INDICATORS_E2E_URL

// An agent row is the ONE card family with two independent status sources — its own state reading (which
// carries its own mark) and the shared right-hand meta slot — so it is the only one that can render the
// same fact twice. It shipped doing exactly that: a live child read "running 3 min ●" AND "● running",
// and a quiet child read the self-contradicting "stale ●running". Pin both halves of that rule here:
// a resolved child owns the row's status alone, and a dispatch with NO child record must still surface
// its terminal status/duration through the meta slot (the suppression must never eat that).
//
// Since 2026-07-29 this also pins the row's SHAPE, which now mirrors the sub-agent lines under the
// prompt box: the liveness MARK first, then the petite-caps "Agent", then the title, then the RUNTIME
// right-justified at the far edge, then the chevron. The four facts that shape asserts — order, no
// model/effort tag, one flush right-hand column, and no EMPTY mark slot once the child has resolved —
// are each a thing the header used to get wrong.
test("an agent row mirrors the child-line shape and shows exactly one running indicator", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  })
  const page = await browser.newPage()
  const errors: string[] = []
  // The bare fixture page serves no favicon, so Chrome logs a 404 whose console text carries no URL.
  // Track the failing RESPONSE urls separately and exclude that one by path — precise enough to still
  // fail on any other missing resource, rather than blanket-ignoring every 404.
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1000, height: 1500, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/operation-indicators-fixture.html`, { waitUntil: "networkidle0" })
    const rows = await page.$$eval("[data-agent-rows] .fray-bash", (cards) =>
      cards.map((card) => {
        const header = card.querySelector<HTMLElement>(".fray-bash-header")!
        const [left, right] = Array.from(header.children) as HTMLElement[]
        const marks = card.querySelectorAll("[title='stale — no recent output'], [title^='rested —']")
        return {
          text: header.innerText.replace(/\s+/g, " ").trim(),
          indicators: card.querySelectorAll("[data-running-indicator]").length,
          // The left group's element order IS the mirrored shape: the mark slot (when the child has a
          // liveness reading at all), the kind label, then the title. `-1` for the slot means no slot
          // exists in the DOM — which is REQUIRED of a resolved child and a failure for a live one.
          markSlotIndex: Array.from(left.children).findIndex((child) => child.classList.contains("fray-agent-mark")),
          labelIndex: Array.from(left.children).findIndex((child) => child.classList.contains("fray-bash-label")),
          // How far "Agent" sits from the header's own left edge. This is the number the reader SEES as
          // the gap: an empty reserved slot pushed it out ~13px on a card whose child had finished, which
          // is the whole defect. A marked row is allowed that offset (a dot is standing in it); a
          // resolved row must be flush at 0.
          labelOffset: Math.round(left.querySelector(".fray-bash-label")!.getBoundingClientRect().left - left.getBoundingClientRect().left),
          quietMark: marks.length > 0 ? marks[0].getAttribute("title") : null,
          // The right-hand group holds the reading AND the chevron, in that order, flush to one edge.
          rightText: right.innerText.replace(/\s+/g, " ").trim(),
          rightEdge: Math.round(right.getBoundingClientRect().right * 10) / 10,
          chevronIsLast: right.lastElementChild!.matches("[data-tool-disclosure]"),
        }
      }),
    )
    assert.equal(rows.length, 7, "the fixture must cover live/stale/rested/finished/killed/cancelled/failed agent rows")

    // THE SHAPE. A child with a liveness reading leads with its mark, then "Agent"; a RESOLVED child has
    // no mark and NO SLOT for one, so "Agent" leads and sits flush at the header's left edge. The empty
    // reservation was a real, reported defect ("a weird gap … to the left of the word Agent"), so the
    // absence is pinned as hard as the presence. The chevron is last on the right on every row.
    const MARKED = 3 // rows 0-2 are the live / stale / rested children; 3-6 have all resolved.
    for (const [index, row] of rows.entries()) {
      const marked = index < MARKED
      assert.equal(row.markSlotIndex, marked ? 0 : -1, `row ${index}: ${marked ? "the liveness mark must lead the header" : "a resolved child must render no mark slot at all"}`)
      assert.equal(row.labelIndex, marked ? 1 : 0, `row ${index}: "Agent" must ${marked ? "follow the mark" : "lead the header"}`)
      assert.equal(marked ? row.labelOffset > 0 : row.labelOffset === 0, true, `row ${index}: "Agent" sits ${row.labelOffset}px from the left edge`)
      assert.ok(row.chevronIsLast, `row ${index}: the chevron must be the last thing on the row`)
    }
    // Right-justified means ONE column: every row's right-hand group ends at the same x, so a stack of
    // dispatch cards reads its runtimes down a single edge instead of at each label's ragged end.
    assert.equal(new Set(rows.map((row) => row.rightEdge)).size, 1, "every row's reading must end at the same right edge")

    // The model+effort profile is gone from the card entirely (it lives in the prompt box's own control
    // and in this row's tooltip) — no row may render it as a bracketed tag again.
    for (const row of rows) assert.doesNotMatch(row.text, /fray:|\[.*\]/)

    // A LIVE child: exactly one dot, and the runtime is a BARE compact duration — no "running" verb,
    // never doubled by the meta badge.
    assert.equal(rows[0].indicators, 1)
    assert.doesNotMatch(rows[0].text, /running/)
    assert.match(rows[0].rightText, /^\d+(s|m|hr( \d+m)?)$/)

    // A quiet child: the flat stale mark carries the state (its tooltip says so), with no dot and no
    // "running" badge to contradict it.
    assert.equal(rows[1].indicators, 0)
    assert.equal(rows[1].quietMark, "stale — no recent output")
    assert.doesNotMatch(rows[1].text, /running/)

    // A RESTED child — it stopped, the fan-out it launched has not — draws the hollow mark, not the
    // stale one, and still reads its runtime.
    assert.equal(rows[2].indicators, 0)
    assert.match(String(rows[2].quietMark), /^rested — /)
    assert.match(rows[2].rightText, /^\d+(s|m|hr( \d+m)?)$/)

    // A completed child: no mark, no slot, just the bare runtime. A card that reports a runtime and shows
    // no liveness mark already says "it ran and stopped", so the verb is deliberately absent.
    assert.equal(rows[3].indicators, 0)
    assert.equal(rows[3].rightText, "3m")
    assert.doesNotMatch(rows[3].text, /finished/)

    // A NON-nominal outcome keeps its verb: no mark can say "killed", so dropping it would delete the
    // one fact the reader needs.
    assert.equal(rows[4].indicators, 0)
    assert.equal(rows[4].rightText, "killed 41m")

    // No child record at all → the meta slot is the only status surface, so terminal state + duration
    // must still render. This is the regression the one-indicator rule must never cause.
    assert.equal(rows[5].indicators, 0)
    assert.match(rows[5].text, /cancelled/)
    assert.equal(rows[6].indicators, 0)
    assert.match(rows[6].text, /failed · 12 sec/)

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})
