import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

const baseUrl = process.env.FRIZZ_WAKE_MARKDOWN_E2E_URL

test("fallback wake cards render safe Markdown through the real message component", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const errors: string[] = []
  const shots = process.env.FRIZZ_WAKE_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
    for (const font of ["sans", "mono"]) {
      for (const width of [1000, 390]) {
        const url = `${baseUrl}/frizz-wake-fixture.html?font=${font}${width < 500 ? "&dense" : ""}`
        await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 })
        await page.goto(url, { waitUntil: "networkidle0" })
        await page.waitForSelector('[data-frizz-msg="batched"] .md-body h3')
        const result = await page.evaluate(() => {
          const card = document.querySelector('[data-frizz-msg="batched"]')!
          const prose = card.querySelector(".md-body")!
          const pre = prose.querySelector("pre")!
          return {
            headings: Array.from(prose.querySelectorAll("h3")).map((el) => el.textContent),
            codes: Array.from(prose.querySelectorAll("li code")).map((el) => el.textContent),
            bold: prose.querySelector("strong")?.textContent,
            link: prose.querySelector('a[href="https://example.com/report"]')?.textContent,
            text: prose.textContent,
            script: !!prose.querySelector("script"),
            pwned: (window as Window & { __wakePwned?: boolean }).__wakePwned ?? false,
            overflow: document.documentElement.scrollWidth > innerWidth,
            preWhiteSpace: getComputedStyle(pre).whiteSpace,
            shellIsDivider: !!document.querySelector('[data-frizz-msg="w9"][data-wake-divider]'),
            trailer: document.querySelector('[data-frizz-msg="w15b"]')?.textContent,
          }
        })
        assert.deepEqual(result.headings, ["1. Awaiting park ended", "2. Timer fired"])
        assert.ok(result.codes.includes("shells: [bc3rwp1k7]"))
        assert.equal(result.bold, "finished")
        assert.equal(result.link, "report")
        assert.doesNotMatch(result.text!, /###|Registered PR watcher|STILL ARMED/)
        assert.equal(result.script, false)
        assert.equal(result.pwned, false)
        assert.equal(result.overflow, false)
        assert.equal(result.shellIsDivider, true)
        assert.doesNotMatch(result.trailer!, /Registered PR watcher|STILL ARMED/)
        if (width < 500) assert.equal(result.preWhiteSpace, "pre-wrap")
        if (shots) {
          const card = await page.$('[data-frizz-msg="batched"]')
          await card!.screenshot({ path: join(shots, `wake-${font}-${width}.png`) })
          const ink = await page.evaluate(() => {
            const title = document.querySelector('[data-frizz-msg="batched"] .tracking-tight')!
            const probe = document.createElement("span")
            probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
            title.append(probe)
            const baseline = probe.getBoundingClientRect().bottom
            probe.remove()
            const cs = getComputedStyle(title)
            const canvas = document.createElement("canvas").getContext("2d")!
            canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
            const metrics = canvas.measureText(title.textContent!)
            const rects = Array.from(document.querySelectorAll('[data-frizz-msg="batched"] .lucide-bell path')).map((el) => el.getBoundingClientRect())
            const iconCenter = (Math.min(...rects.map((r) => r.top)) + Math.max(...rects.map((r) => r.bottom))) / 2
            return { residualPx: iconCenter - (baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2) }
          })
          console.log({ font, width, headerInk: ink })
          if (width === 1000) {
            await page.setViewport({ width, height: 1000, deviceScaleFactor: 6 })
            const header = await page.$('[data-frizz-msg="batched"] .items-start')
            await header!.screenshot({ path: join(shots, `header-${font}.png`) })
          }
        }
      }
      if (shots) {
        // Reuse the project's pixel instrument against the untouched shared card header.
        console.log(execFileSync("nub", ["scripts/ink-gaps.mjs", `${baseUrl}/frizz-wake-fixture.html?font=${font}`,
          '[data-frizz-msg="batched"] .tracking-tight,[data-frizz-msg="batched"] .lucide-bell', "--dsf=6", "--w=1000"], { encoding: "utf8" }))
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
