import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here: start `vite` in packages/web and set
// FRIZZ_CODE_COPY_E2E_URL to its origin, e.g.
//   FRIZZ_CODE_COPY_E2E_URL=http://localhost:5731 nub --test --test-force-exit src/lib/copyCodeBlock.e2e.test.ts
const baseUrl = process.env.FRIZZ_CODE_COPY_E2E_URL

// The pieces of this are unit-testable in isolation and that proves nothing: the markup comes out of
// lib/syntaxHighlight.ts, the DOM sanitizer decides whether the wrapper's class and the button survive
// at all, the stylesheet decides whether the button is reachable, and a delegated document listener does
// the copying. The seam between those four is where the whole feature lives, so this drives the shipped
// path in a real browser and reads the REAL system clipboard back.
//
// Clipboard permission has to come through CDP: puppeteer's `overridePermissions("clipboard-write")`
// resolves to `denied` in headless Chrome, and the copy then fails in a way that looks exactly like a
// broken handler — an empty clipboard and no check.
test("a fenced code block copies its own source, minus the renderer's trailing newline", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    const cdp = await browser.target().createCDPSession()
    await cdp.send("Browser.grantPermissions", {
      origin: baseUrl!,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    })
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    // The fixture declares no favicon, so vite 404s /favicon.ico on every bare fixture page here.
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon\.ico|404 \(Not Found\)/.test(m.text())) pageErrors.push(m.text())
    })
    await page.setViewport({ width: 1400, height: 1100, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/syntax-highlighting-fixture.html`, { waitUntil: "networkidle2" })
    await page.waitForSelector(".md-code-copy")

    // Every fenced block gets one, and the wrapper class survived the sanitizer (without it the button
    // has no positioned ancestor and lands somewhere else entirely).
    const counts = await page.evaluate(() => ({
      blocks: document.querySelectorAll(".md-code").length,
      buttons: document.querySelectorAll(".md-code").length
        && [...document.querySelectorAll(".md-code")].filter((w) => w.querySelector(":scope > .md-code-copy")).length,
      positioned: [...document.querySelectorAll(".md-code")].every((w) => getComputedStyle(w).position === "relative"),
    }))
    assert.ok(counts.blocks > 1, "the fixture should render several fenced blocks")
    assert.equal(counts.buttons, counts.blocks)
    assert.equal(counts.positioned, true)

    // Quiet until hovered, so a transcript full of fences is not a wall of buttons.
    assert.equal(await page.$eval("#thread .md-code-copy", (b) => getComputedStyle(b).opacity), "0")
    await page.hover("#thread .md-code")
    // It fades in over --default-transition-duration, so this cannot be read on the same tick as the hover.
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#thread .md-code-copy")!).opacity === "1")

    const source = await page.$eval("#thread .md-code pre code", (code) => code.textContent ?? "")
    await page.click("#thread .md-code-copy")
    await page.waitForFunction(() => document.querySelector("#thread .md-code-copy")!.classList.contains("is-copied"))

    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    // The renderer appends exactly one LF so a still-streaming fence selects sanely. It must not reach
    // the clipboard: a shell command pasted into a terminal with a trailing newline RUNS.
    assert.match(source, /\n$/)
    assert.equal(clipboard, source.replace(/\n$/, ""))
    assert.ok(clipboard.includes("console.log(next.id)"))
    // highlight.js wraps tokens in <span>s; none of that markup may ride along.
    assert.ok(!clipboard.includes("<span"))

    assert.equal(await page.$eval("#thread .md-code-copy", (b) => (b as HTMLButtonElement).title), "Copied")
    // …and it goes back on its own, so a stale check never claims a copy that has scrolled out of memory.
    await page.waitForFunction(() => !document.querySelector("#thread .md-code-copy")!.classList.contains("is-copied"), { timeout: 5_000 })
    assert.equal(await page.$eval("#thread .md-code-copy", (b) => (b as HTMLButtonElement).title), "Copy code")

    // Each block copies its OWN source — the delegated listener resolves the code through the wrapper,
    // not through document order.
    const second = await page.evaluate(() => {
      const wrap = [...document.querySelectorAll<HTMLElement>("#thread .md-code")]
        .find((w) => /pnpm --filter/.test(w.textContent ?? ""))!
      return { text: wrap.querySelector("pre code")!.textContent!, index: [...document.querySelectorAll("#thread .md-code")].indexOf(wrap) }
    })
    await page.hover(`#thread .md-code:nth-of-type(${second.index + 1})`)
    await page.click(`#thread .md-code:nth-of-type(${second.index + 1}) .md-code-copy`)
    await page.waitForFunction((i: number) => document.querySelectorAll(".md-code-copy")[i]?.classList.contains("is-copied"), {}, second.index)
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), second.text.replace(/\n$/, ""))

    // THE REASON THE WRAPPER EXISTS. `pre` is the scroll container, so a button anchored inside it rides
    // the content and slides out of view the moment a long line is scrolled sideways.
    const held = await page.evaluate(() => {
      const wrap = [...document.querySelectorAll<HTMLElement>("#thread .md-code")]
        .find((w) => { const p = w.querySelector("pre")!; return p.scrollWidth > p.clientWidth + 20 })!
      const pre = wrap.querySelector("pre")!, btn = wrap.querySelector(".md-code-copy")!
      const offset = () => +(btn.getBoundingClientRect().right - pre.getBoundingClientRect().right).toFixed(2)
      const before = offset()
      pre.scrollLeft = pre.scrollWidth
      return { before, after: offset(), scrolled: pre.scrollLeft }
    })
    assert.ok(held.scrolled > 100, "the fixture should hold a block wide enough to scroll")
    assert.equal(held.after, held.before)

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
