import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// The composer's SKILLS TYPEAHEAD (issue #21). A draft that is exactly one `/`-led token opens a menu
// of the thread's invocable skills; these tests pin the whole keyboard contract against the real
// <Composer> in a real browser: lazy single fetch, prefix-then-substring filtering, ArrowDown/Enter
// completion, Tab completion, Escape dismissing WITHOUT blurring (and staying dismissed until the
// draft changes), and — the seam that matters most — Enter sending the draft the moment the menu is
// NOT showing, exactly as before the feature existed.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_SKILLS_TYPEAHEAD_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_SKILLS_TYPEAHEAD_E2E_URL

const BOX = 'textarea[data-surface="chatComposer"]'
const MENU = "[data-slash-menu]"

type Hooks = { fetches: number; submitted: string[] }
type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined
let errors: string[] = []

before(async () => {
  if (!baseUrl) return
  const { default: puppeteer } = await import("puppeteer")
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
})

after(async () => { await browser?.close() })

const hooks = (): Promise<Hooks> => page!.evaluate(() => {
  const h = (window as unknown as { __typeahead: Hooks }).__typeahead
  return { fetches: h.fetches, submitted: h.submitted }
})
const menuRows = (): Promise<string[]> => page!.evaluate((sel) =>
  [...document.querySelectorAll(`${sel} button`)].map((row) => row.querySelector("span")!.textContent!), MENU)
const menuVisible = (): Promise<boolean> => page!.evaluate((sel) => Boolean(document.querySelector(sel)), MENU)
const boxValue = (): Promise<string> => page!.$eval(BOX, (el) => (el as HTMLTextAreaElement).value)

async function open() {
  errors = []
  await page!.goto(`${baseUrl}/skills-typeahead-fixture.html`, { waitUntil: "networkidle2" })
  await page!.waitForSelector(BOX)
  await page!.click(BOX)
}

test("typing `/` opens the menu once fetched, filters as the name grows, and a space closes it", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/")
  await page!.waitForSelector(MENU)
  assert.equal((await menuRows()).length, 5, "a bare slash offers the whole list")

  await page!.type(BOX, "fr")
  // Prefix matches lead; the namespaced `frizz:gh` is still reachable this way.
  assert.deepEqual(await menuRows(), ["/frizz-stack", "/frizz:gh"])

  await page!.type(BOX, "izz-stack now")
  assert.equal(await menuVisible(), false, "arguments have begun — the menu must be gone")
  assert.equal((await hooks()).fetches, 1, "the list is fetched exactly once")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("ArrowDown+Enter completes the highlighted skill instead of sending, and the send still works after", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/fr")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("ArrowDown")
  await page!.keyboard.press("Enter")
  assert.equal(await boxValue(), "/frizz:gh ", "Enter with the menu open completes, with a trailing space for arguments")
  assert.deepEqual((await hooks()).submitted, [], "…and must NOT send the draft")

  await page!.type(BOX, "check the PR")
  await page!.keyboard.press("Enter")
  assert.deepEqual((await hooks()).submitted, ["/frizz:gh check the PR"], "Enter with the menu closed sends as always")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("Tab completes the highlighted skill", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/head")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Tab")
  assert.equal(await boxValue(), "/headless-browser ")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("Escape dismisses without blurring and stays dismissed until the draft changes", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/vis")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Escape")
  assert.equal(await menuVisible(), false, "Escape closes the menu")
  const focused = await page!.evaluate((sel) => document.activeElement === document.querySelector(sel), BOX)
  assert.equal(focused, true, "…but must NOT blur the box — that is the NEXT Escape's job")
  await page!.type(BOX, "u")
  await page!.waitForSelector(MENU)
  assert.deepEqual(await menuRows(), ["/visual-review"], "typing again reopens the menu")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})
