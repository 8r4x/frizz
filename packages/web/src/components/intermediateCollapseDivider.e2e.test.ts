import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_INTERMEDIATE_COLLAPSE_E2E_URL

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
//   FRIZZ_INTERMEDIATE_COLLAPSE_E2E_URL=http://127.0.0.1:5247 nub --test …
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

    // ---- 5. background tasks and sub-agent dispatches FOLD IN with everything else ----
    // They used to be lifted out as their own cards (maintainer 2026-08-01: "It's important that those
    // show up in the chat"), and that was reversed for the QUEUE CARD on 2026-08-12 — the card is a
    // triage surface whose shape is "the user's most recent message, some bit of text, then the click to
    // expand section followed by more text" ("I don't know why the bash calls weren't folded in to the
    // click to expand section that's kind of weird" … "Fold them in"). Nothing is lost: a task still
    // RUNNING is listed under the card's own prompt box from live board telemetry, and a finished one is
    // history the fold carries. The THREAD VIEW still gives every one its own card, with the mark and
    // flush rules this section used to pin here.
    await page.goto(variant("bgshells"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    assert.deepEqual(
      await page.$$eval(".frizz-bash-header", (ns) => ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      [],
      "no background task keeps a card of its own on a queue card",
    )
    assert.deepEqual(
      await page.$$eval("[data-tool-activity] button", (ns) => ns.map((n) => (n as HTMLElement).innerText.trim())),
      [],
      "…and nothing escapes as a batched activity band either",
    )
    assert.equal(
      await page.$eval(SEL, (n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      "8 tool calls · Click to expand",
      "every launch is counted by the divider instead",
    )

    // ---- 6. sub-agent dispatches get exactly the same treatment ----
    await page.goto(variant("dispatches"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    assert.deepEqual(
      await page.$$eval(".frizz-bash-header", (ns) => ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      [],
      "no dispatch keeps a card of its own on a queue card",
    )
    assert.equal(
      await page.$eval(SEL, (n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      "6 tool calls · Click to expand",
      "both dispatches are counted by the divider",
    )

    // ---- 7. an orphaned codex poll is chatter, and folds into the count ----
    // A codex long-poll gate emits `wait`/`write_stdin` calls the projector cannot pair with a launch, so
    // each reaches the client pending + `backgroundState: "unknown"` — which used to buy it a dedicated
    // card. A real rollout produced 888 of them, and the queue card was a wall of `Wait · cell 30 ·
    // unknown` rows counting up forever (maintainer 2026-08-09). Everything in the run folds now, polls
    // and the genuinely detached shell alike, so the count is the whole assertion.
    await page.goto(variant("codexpolls"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    assert.deepEqual(
      await page.$$eval(".frizz-bash-header", (ns) => ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      [],
      "not even the detached shell keeps a card here",
    )
    assert.equal(
      await page.$eval(SEL, (n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      "13 tool calls · Click to expand",
      "the ten polls are counted by the divider rather than drawn",
    )

    // ---- 8. no rest rule is drawn, and the window reaches back to the human's own ask ----
    // The queue card is a triage surface for the standing signal, and the rest hairline is its own
    // premise (maintainer 2026-08-11: "you shoudl NOT render the hairline for the rest/stop hook"). The
    // WINDOW, though, reaches back to the human's last message rather than to the previous rest — with
    // frizz driving threads across many rests, "the current turn" is a stretch the reader never saw the
    // start of, and the card was opening mid-conversation. So the earlier turn renders too; only its
    // rest rules do not.
    await page.goto(variant("priorrest"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const card = await page.evaluate(() => document.body.innerText)
    assert.equal(
      await page.$$eval('[data-wake-divider="rest"]', (ns) => ns.length),
      0,
      "the rest/stop-hook hairline is never drawn on a queue card",
    )
    assert.doesNotMatch(card, /Agent rested/, "…and its label must not survive as any other row either")
    assert.match(card, /Kick off the release workflow/, "the human's own ask anchors the window")
    // THE COMPLETION MARKER IS NOT A WAKE DELIVERY, and only the delivery cuts a run. This fixture holds
    // `boundary: "wake"` — the transcript's own "that task finished" hairline, whose LAUNCH already folds
    // into the count, so keeping it would render one event twice and inverted (see
    // queueCollapse.survivesQueueCollapse). What actually re-invokes a rested agent is the scheduler's
    // wake, a real user record carrying frizz's delivery token (`wake: true`), and that is section 9.
    assert.doesNotMatch(card, /Watching the release run/, "a completion marker folds like the launch it echoes")
    assert.doesNotMatch(card, /The watcher came back green/, "…so the run around it is one fold, not two")

    // ---- 9. ONE FOLD PER WAKE ----
    // The shape this collapse exists for (maintainer 2026-08-12): an agent parks on a PR watcher, the
    // watcher fires, it works, it rests, the watcher fires again. Each run folds SEPARATELY, and each
    // wake's hairline sits BETWEEN the run it ended and the run it caused — "multiple messages in their
    // complete form, with various collapsed tool call blocks between them, plus some hairline indicators
    // showing why they were reawoken". One global span produced the opposite: every hairline clustered
    // above a single fold, detached from the work it explained.
    await page.goto(variant("prwakes"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    // Read the whole ladder IN DOCUMENT ORDER — the interleaving is the entire claim, and three folds in
    // the right count but the wrong places would pass a per-selector check.
    const ladder = await page.$$eval("[data-wake-divider]", (ns) =>
      ns.map((n) => `${n.getAttribute("data-wake-divider")}: ${(n as HTMLElement).innerText.replace(/\s+/g, " ").trim()}`),
    )
    assert.deepEqual(
      ladder.map((row) => row.replace(/ · \d+m ago$/, "")),
      [
        "intermediate-summary: 6 tool calls · Click to expand",
        // THE FIRST PARK IS NOT NEWS. The watcher replays everything already sitting on the PR — eleven
        // items in this fixture, a hundred on a long-lived PR — and that used to render one row each
        // (maintainer 2026-08-13: "it's going to render like a hundred reviews, so let's hide all of
        // that on the initial watcher registration"). One honest line, and the worker still gets the
        // full list in the delivered steer.
        "github: 11 items already on colinhacks/zod#6382",
        "intermediate-summary: 7 tool calls · Click to expand",
        "github: New approval from @colinhacks on colinhacks/zod#6382",
        "intermediate-summary: 4 tool calls · Click to expand",
      ],
      `each run folds on its own, between the wakes that bound it, got ${ladder.join(" | ")}`,
    )
    const prCard = await page.evaluate(() => document.body.innerText)
    // NOT ONE ROW PER ITEM, at any count. This is the assertion that would catch the list coming back.
    assert.doesNotMatch(prCard, /@copilot-pull-request-reviewer/, "no per-item row survives the replay")
    assert.doesNotMatch(prCard, /@pullfrog/)
    // ONE CASE TREATMENT on the whole line — no run may escape the divider's petite-caps back to
    // ordinary case ("it's mixing small caps with regular font"). The ref is a LINK, and its underline
    // is what marks it; it needs no second signal in a different alphabet.
    const escapes = await page.$$eval('[data-wake-divider="github"] [class*="font-variant-caps"]', (ns) => ns.length)
    assert.equal(escapes, 0, "nothing on the GitHub hairline opts out of the divider's own casing")
    // Every run's closing message stays in full: the card reads down the page as the thread actually ran.
    assert.match(prCard, /PR #6382 is open against main/, "run 1's rest")
    assert.match(prCard, /Both review findings are addressed/, "run 2's rest")
    assert.match(prCard, /#5178 is merged as/, "run 3's rest")
    // Expanding is still ONE-WAY and card-wide: one press restores every run's hidden log at once.
    await page.click(SEL)
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, {}, SEL)
    assert.equal(
      await page.$$eval('[data-wake-divider="github"]', (ns) => ns.length),
      2,
      "…and the wake hairlines survive the expansion, still one per run",
    )

    // ---- 9. control: nothing intermediate, so no divider at all ----
    await page.goto(variant("single"), { waitUntil: "networkidle0" })
    await page.waitForFunction(() => document.querySelectorAll("[data-frizz-msg]").length > 0, { timeout: 10_000 })
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
