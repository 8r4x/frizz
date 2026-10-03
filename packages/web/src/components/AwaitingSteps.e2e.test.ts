import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5233 --strictPort --host 127.0.0.1 &
//   FRIZZ_AWAITING_STEPS_E2E_URL=http://127.0.0.1:5233 nub --test src/components/AwaitingSteps.e2e.test.ts
const baseUrl = process.env.FRIZZ_AWAITING_STEPS_E2E_URL

// STEPS FOR THE HUMAN (2026-10-03): an ```awaiting fence carrying `steps:` draws them on the resting card,
// with a note box and two verbs. Everything here is a RENDERING or an INPUT fact, and the steps render
// through the markdown sanitizer, which needs a real DOM — so it is pinned in a real browser against the
// real queue card (awaiting-bg-fixture.html?steps=…). Only the RPC answers are stubbed, in the fixture;
// the send itself goes through the composer's own eager follow-up, which is the point:
//
//   1. The card states the steps in order, as markdown, under the worker's heading, and offers no Snooze.
//   2. Return in the note box writes a newline and sends nothing — the card has two verbs, and a key
//      cannot know which one the human means.
//   3. "Done" sends ONE ordinary reply, the outcome then the note, bound to the thread's session, and the
//      card leaves the queue.
//   4. "Couldn't do it" with no note sends exactly that.

const CARD = "[data-awaiting-background]"

async function openFixture(query: string) {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setViewport({ width: 900, height: 900 })
  await page.goto(`${baseUrl}/awaiting-bg-fixture.html?${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
  await page.evaluate(() => {
    ;(window as unknown as { __rpc: unknown[] }).__rpc = []
    window.addEventListener("fixture-rpc", (e) => {
      ;(window as unknown as { __rpc: unknown[] }).__rpc.push((e as CustomEvent).detail)
    })
  })
  return { browser, page, errors }
}

type Sent = { rpc: string; body: { slug?: string; sessionId?: string; message?: string } }
const sent = (page: Awaited<ReturnType<typeof openFixture>>["page"]) =>
  page.evaluate(() => (window as unknown as { __rpc: Sent[] }).__rpc.filter((c) => c.rpc === "followUp"))

test("a steps card states the steps, keeps Return as a newline, and Done sends one reply", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { browser, page, errors } = await openFixture("steps=titled")
  try {
    // ---- 1. the statement ----
    const card = await page.$eval(CARD, (el) => ({
      title: (el.querySelector("svg + span") as HTMLElement | null)?.innerText.trim(),
      glyph: el.querySelector("svg")?.getAttribute("class") ?? "",
      steps: [...el.querySelectorAll("[data-awaiting-steps] li")].map((li) => (li as HTMLElement).innerText.trim()),
      code: [...el.querySelectorAll("[data-awaiting-steps] li code")].map((c) => c.textContent),
      strong: [...el.querySelectorAll("[data-awaiting-steps] li strong")].map((c) => c.textContent),
      snooze: !!el.querySelector("[data-awaiting-snooze]"),
      verbs: [...el.querySelectorAll("[data-awaiting-steps-reply] button")].map((b) => (b as HTMLElement).innerText.trim()),
    }))
    assert.equal(card.title, "Sign in to npm so the acme 4.2.0 release can publish", "the worker's own heading")
    assert.match(card.glyph, /lucide-list-todo/, "the to-do glyph, not the hourglass")
    assert.deepEqual(card.steps, [
      "Run npm login --auth-type=web in a terminal on this machine.",
      "Approve the browser prompt with the acme-bot account.",
      "Reply here once npm whoami prints acme-bot.",
    ], "every step, in the order the worker wrote them")
    assert.deepEqual(card.code, ["npm login --auth-type=web", "npm whoami", "acme-bot"], "a step is markdown: its code spans are code")
    assert.deepEqual(card.strong, ["acme-bot"])
    assert.equal(card.snooze, false, "the reader is the wait, so there is nothing to snooze until")
    assert.deepEqual(card.verbs, ["Done", "Couldn't do it"])

    // ---- 2. Return is a newline, never a send ----
    await page.click("[data-steps-note]")
    await page.keyboard.type("signed in as acme-bot")
    await page.keyboard.press("Enter")
    await page.keyboard.type("the token is good for 30 days")
    assert.equal(await page.$eval("[data-steps-note]", (el) => (el as HTMLTextAreaElement).value), "signed in as acme-bot\nthe token is good for 30 days")
    assert.deepEqual(await sent(page), [], "Return sent nothing")
    assert.ok(await page.$(CARD), "…and the card is still the ask")

    // ---- 3. Done: one ordinary reply, then the card leaves the queue ----
    await page.click("[data-steps-done]")
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const replies = await sent(page)
    assert.equal(replies.length, 1, "one click is one reply")
    assert.equal(replies[0].body.message, "Done — signed in as acme-bot\nthe token is good for 30 days", "the outcome, then the human's note, verbatim")
    assert.equal(replies[0].body.slug, "awaiting-bg-demo")
    assert.equal(replies[0].body.sessionId, "aaaaaaaa-bbbb-cccc-dddd-000000000001", "bound to the session that posted the steps")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)

    assert.deepEqual(errors, [], "a clean console")
  } finally {
    await browser.close()
  }
})

test("Couldn't do it with no note sends exactly that", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { browser, page, errors } = await openFixture("steps=1")
  try {
    const title = await page.$eval(`${CARD} svg + span`, (el) => (el as HTMLElement).innerText.trim())
    assert.equal(title, "For you to do", "an untitled steps card is headed for the reader")
    await page.click("[data-steps-not-done]")
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const replies = await sent(page)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].body.message, "Couldn't do it")
    assert.deepEqual(errors, [], "a clean console")
  } finally {
    await browser.close()
  }
})
