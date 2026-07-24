import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// REGRESSION. GithubTrigger self-gates (renders null when gh is unauthed), but Composer reserves the
// leftAction rail slot whenever the PROP is truthy — and a `<GithubTrigger />` element is truthy even
// when it renders nothing. Passing it unconditionally left an empty hole between the paperclip and
// send. The fix hoists the gate to the caller via useGithubTriggerVisible(): unauthed → no leftAction
// prop → the paperclip sits directly beside send. These tests pin both states off the
// composer-icons fixture, whose `?unauthed` query stubs the signed-out githubStatus.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRAY_COMPOSER_ICONS_E2E_URL to its origin.
const baseUrl = process.env.FRAY_COMPOSER_ICONS_E2E_URL

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined

before(async () => {
  if (!baseUrl) return
  const { default: puppeteer } = await import("puppeteer")
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 })
})

after(async () => {
  await browser?.close()
})

// The evaluate body must stay a single flat arrow — tsx's esbuild transform wraps nested function
// declarations in a `__name` helper that doesn't exist in the page context.
const rail = async (p: Page) =>
  p.evaluate(`(() => {
    const box = (label) => {
      const el = document.querySelector('button[aria-label^="' + label + '"]')
      return el ? el.getBoundingClientRect().toJSON() : null
    }
    return { github: box("Investigate"), attach: box("Attach files"), send: box("Send") }
  })()`) as Promise<{ github: DOMRect | null; attach: DOMRect | null; send: DOMRect | null }>

test("authed: GitHub trigger renders between attach and send", { skip: !baseUrl }, async () => {
  await page!.goto(`${baseUrl}/composer-icons-fixture.html`, { waitUntil: "networkidle0" })
  await page!.waitForSelector('button[aria-label^="Investigate"]')
  const r = await rail(page!)
  assert.ok(r.github && r.attach && r.send)
  assert.ok(r.attach!.right <= r.github!.left, "attach sits left of the GitHub trigger")
  assert.ok(r.github!.right <= r.send!.left, "GitHub trigger sits left of send")
})

test("unauthed: no GitHub slot is reserved — attach sits directly beside send", { skip: !baseUrl }, async () => {
  await page!.goto(`${baseUrl}/composer-icons-fixture.html?unauthed`, { waitUntil: "networkidle0" })
  await page!.waitForSelector('button[aria-label="Attach files"]')
  const r = await rail(page!)
  assert.equal(r.github, null, "GitHub trigger must not render when unauthed")
  assert.ok(r.attach && r.send)
  const gap = r.send!.left - r.attach!.right
  assert.ok(gap >= 0 && gap <= 12, `attach must abut send (gap was ${gap}px — a reserved empty slot regressed)`)
})
