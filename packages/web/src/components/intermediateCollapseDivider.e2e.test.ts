import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRAY_INTERMEDIATE_COLLAPSE_E2E_URL

// The queue card's collapsed intermediate run is a HAIRLINE DIVIDER, not a bordered bar (maintainer
// 2026-07-31: "turn this into a hairline divider … the expand icon, followed by the number of tool
// calls, then something that just says 'Click to expand'. We can drop the step count."). All three
// halves of that are RENDERING facts, so they are pinned in a real browser against the real components
// rather than in string assertions:
//
//   1. It wears the transcript's shared WakeDivider chrome — two hairlines flanking a centred label —
//      and paints no border or panel fill of its own. A box here reads as a card competing with the
//      messages it sits between, which is what it used to be.
//   2. The label is `N tool calls · Click to expand`, and carries NO step count anywhere.
//   3. The whole ROW is the affordance, and expanding is still ONE-WAY: a real mouse press anywhere on
//      it restores every hidden tool disclosure and unmounts the divider.
//
// Run it against a plain vite over packages/web:
//   nubx vite --port 5247 --strictPort --host 127.0.0.1
//   FRAY_INTERMEDIATE_COLLAPSE_E2E_URL=http://127.0.0.1:5247 nub --test …
const SEL = '[data-wake-divider="intermediate-summary"]'

const launch = async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  return { browser, page, errors }
}

const variant = (v: string) => new URL(`/intermediate-collapse-fixture.html?variant=${v}`, baseUrl).href

test("the collapsed intermediate run is a hairline divider that names its tool calls and nothing else", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(variant("heavy"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })

    const divider = await page.$eval(SEL, (n) => {
      const el = n as HTMLElement
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName,
        text: el.innerText.replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label"),
        hairlines: el.querySelectorAll("span.h-px").length,
        icons: el.querySelectorAll("svg").length,
        borderWidth: cs.borderTopWidth,
        // A divider draws NO fill of its own. `rgba(…, 0)` and `transparent` both read as no paint.
        painted: !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor),
      }
    })

    // ---- 1. the shared divider chrome, and no box of its own ----
    assert.equal(divider.tag, "BUTTON", "the whole row is the affordance, so the root is the control")
    assert.equal(divider.hairlines, 2, "two hairlines flanking the label — the transcript's divider chrome")
    assert.equal(divider.icons, 1, "the stacked-chevron expand glyph leads the label")
    assert.equal(divider.borderWidth, "0px", "a hairline divider draws no border — that was the bordered bar")
    assert.equal(divider.painted, false, "…and no panel fill either")

    // The chrome must be the SAME one the wake dividers wear, not a look-alike. Compare against a real
    // one rendered by ChatView on another fixture rather than restating class names here.
    await page.goto(new URL("/subagent-completion-fixture.html", baseUrl).href, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-wake-divider="agent"]', { timeout: 10_000 })
    const wakeChrome = await page.$eval('[data-wake-divider="agent"]', (n) => ({
      label: (n.querySelector("span.petite-caps") as HTMLElement).className,
      hairline: (n.querySelector("span.h-px") as HTMLElement).className,
    }))
    await page.goto(variant("heavy"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const ourChrome = await page.$eval(SEL, (n) => ({
      label: (n.querySelector("span.petite-caps") as HTMLElement).className,
      hairline: (n.querySelector("span.h-px") as HTMLElement).className,
    }))
    assert.deepEqual(ourChrome, wakeChrome, "the collapse divider must reuse the wake divider's chrome verbatim")

    // ---- 2. the label: tool calls and the affordance, never a step count ----
    assert.equal(divider.text, "11 tool calls · Click to expand")
    assert.doesNotMatch(divider.text, /step/i, "the step count was dropped — it must not come back")
    assert.doesNotMatch(divider.text, /\bShow\b/, "the trailing Show chip went with the bar")
    assert.equal(divider.aria, "Expand 11 tool calls of intermediate agent activity")

    // ---- 3. a REAL mouse press on the row expands it, one-way ----
    // Not el.click(): a zero-height or covered row must fail here rather than pass through a synthetic
    // dispatch. The divider is an 18px rule, which is exactly the geometry worth proving hittable.
    const box = (await (await page.$(SEL))!.boundingBox())!
    assert.ok(box.height >= 12, `the row must be a real hit target, got ${box.height}px`)
    const hitsItself = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement
      const r = el.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(sel) === el
    }, SEL)
    assert.ok(hitsItself, "nothing may cover the divider's own centre")

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, {}, SEL)

    // Every hidden call comes back, and they add up to exactly what the label promised.
    const restored = await page.$$eval("[data-tool-activity] button", (ns) =>
      ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    )
    const restoredCalls = restored.reduce((sum, label) => sum + Number(/Ran (\d+) tool call/.exec(label)?.[1] ?? 0), 0)
    assert.equal(restoredCalls, 11, `the expansion must restore exactly the 11 calls the label counted, got ${restored.join(" | ")}`)

    // ---- 4. a run with no tool calls states only the affordance ----
    await page.goto(variant("notools"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const bare = await page.$eval(SEL, (n) => ({
      text: (n as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      aria: n.getAttribute("aria-label"),
    }))
    assert.equal(bare.text, "Click to expand", "with nothing to count, the label is just the affordance")
    assert.equal(bare.aria, "Expand intermediate agent activity")

    // ---- 5. background tasks under the divider are REAL CARDS, never a `Ran N` band ----
    // They are lifted out of the collapsed span because a detached process is the one class of call
    // still going after the batch that started it (maintainer 2026-08-01: "eject background tasks from
    // the tool call collapsing logic. It's important that those show up in the chat"). Three shells
    // launched from three separate assistant records therefore land as three cards — the collapsing
    // path must not reclaim them as one batched disclosure either.
    await page.goto(variant("bgshells"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const shells = await page.$$eval(".fray-bash-header", (ns) =>
      ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    )
    assert.deepEqual(
      shells,
      [
        "Bash Starting the first server in the sandbox running",
        "Bash Capturing a genuine cold start panel running",
        "Bash Waiting for the cold start to serve done · 42 sec",
      ],
      `each background task keeps its own card under the divider, got ${shells.join(" | ")}`,
    )
    assert.deepEqual(
      await page.$$eval("[data-tool-activity] button", (ns) => ns.map((n) => (n as HTMLElement).innerText.trim())),
      [],
      "no ordinary-activity band may swallow a background task",
    )

    // …and ONLY the live ones are marked. The finished task states its outcome in words and draws no
    // glyph at all — the liveness column means "something is alive behind this row", so a completed op
    // has nothing to say in it (maintainer 2026-08-01). Read as computed style so a mark that stopped
    // animating but stayed on screen would still fail here.
    const marksIn = (selector: string) =>
      page.$$eval(selector, (ns) =>
        ns.map((n) => {
          const el = n as HTMLElement
          const cs = getComputedStyle(el)
          return { kind: el.dataset.runningIndicator, animated: cs.animationName !== "none" }
        }),
      )
    assert.deepEqual(
      await marksIn(".fray-bash-header [data-running-indicator]"),
      [{ kind: "tool-disclosure", animated: true }, { kind: "tool-disclosure", animated: true }],
      "the two live shells pulse — and the finished one is not among them",
    )
    assert.deepEqual(
      await page.$$eval(".fray-bash-header [data-done-indicator], .fray-bash-header .fray-tool-spinner", (ns) => ns.length),
      0,
      "no finished glyph and no spinner may exist on a background card",
    )
    // The finished card's slot is GONE, not merely empty: its label starts flush at the header's left
    // edge, exactly like the settled foreground cards elsewhere in the transcript.
    const flush = await page.$$eval(".fray-bash-header", (ns) =>
      ns.map((n) => {
        const left = n.firstElementChild as HTMLElement
        const label = left.querySelector(".fray-bash-label") as HTMLElement
        return Math.round(label.getBoundingClientRect().left - left.getBoundingClientRect().left)
      }),
    )
    assert.ok(flush[0] > 0 && flush[1] > 0, `the two live cards step in by the mark slot, got ${flush.join(", ")}`)
    assert.equal(flush[2], 0, `the finished card must be flush at 0, got ${flush[2]}px`)

    // ---- 6. sub-agent dispatches get exactly the same treatment ----
    // "Same for sub-agent dispatches" (maintainer 2026-08-01) — the ejection AND the mark rule. A running
    // child pulses; a resolved one draws nothing at all and reads its runtime in words.
    await page.goto(variant("dispatches"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const agentCards = await page.$$eval(".fray-bash-header", (ns) =>
      ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    )
    assert.deepEqual(
      agentCards.map((label) => label.replace(/\b\d+ min\b/, "N min")),
      ["Agent Audit the queue card's collapse N min", "Agent Cross-check the sub-agent drawer N min"],
      `both dispatches keep their card under the divider, got ${agentCards.join(" | ")}`,
    )
    assert.deepEqual(
      await marksIn(".fray-bash-header [data-running-indicator]"),
      [{ kind: "subagent-disclosure", animated: true }],
      "only the running child is marked",
    )
    assert.equal(
      await page.$$eval(".fray-bash-header [data-done-indicator], .fray-bash-header .fray-tool-spinner", (ns) => ns.length),
      0,
      "a resolved dispatch draws no finished glyph, and nothing spins",
    )
    const agentFlush = await page.$$eval(".fray-bash-header", (ns) =>
      ns.map((n) => {
        const left = n.firstElementChild as HTMLElement
        const label = left.querySelector(".fray-bash-label") as HTMLElement
        return Math.round(label.getBoundingClientRect().left - left.getBoundingClientRect().left)
      }),
    )
    assert.ok(agentFlush[0] > 0, `the running dispatch steps in by the mark slot, got ${agentFlush[0]}px`)
    assert.equal(agentFlush[1], 0, `the resolved dispatch must be flush at 0, got ${agentFlush[1]}px`)

    // ---- 7. control: nothing intermediate, so no divider at all ----
    await page.goto(variant("single"), { waitUntil: "networkidle0" })
    await page.waitForFunction(() => document.querySelectorAll("[data-fray-msg]").length > 0, { timeout: 10_000 })
    assert.equal(
      await page.$$eval(SEL, (n) => n.length),
      0,
      "a single agent turn hides nothing, so it must not draw an anchorless divider",
    )

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
