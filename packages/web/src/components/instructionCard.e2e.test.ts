import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the INSTRUCTION card (`mcp__frizz__instruct`, 2026-10-03): steps a worker handed
// the human because only the human can perform them. What a browser settles that a unit test cannot:
// the card draws its numbered steps (one with a code block), offers no × and no "Send answers", and
// each of its two verbs sends ONE reply — the exact payload the worker reads — on its own, never
// folded into a question batch staged beside it. Skipped unless a Vite URL serving the fixtures is
// provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and set
// FRIZZ_INSTRUCTION_CARD_E2E_URL to its origin.
//
// Each case loads a fresh page: a reply dissolves the queue card, so nothing on it can be clicked after.
const baseUrl = process.env.FRIZZ_INSTRUCTION_CARD_E2E_URL

type Page = import("puppeteer").Page

const CARD = "[data-question-id='ins_0001aaaa0001']"
const QUESTION = "[data-question-id='qst_0001aaaa']"
const TITLE = "Sign in to npm so the release can publish"

async function launch(query: string) {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/registered-question-fixture.html?${query}&font=sans`, { waitUntil: "networkidle0" })
  // Every write the card makes, as the fixture echoes it.
  await page.evaluate(() => {
    const w = window as unknown as { __rpc: unknown[] }
    w.__rpc = []
    window.addEventListener("fixture-rpc", (e) => w.__rpc.push((e as CustomEvent).detail))
  })
  return { browser, page, errors }
}

async function rpcs(page: Page, count: number): Promise<{ rpc: string; body: { slug: string; answers: unknown[] } }[]> {
  await page.waitForFunction((n) => (window as unknown as { __rpc: unknown[] }).__rpc.length >= n, { timeout: 10_000 }, count)
  return page.evaluate(() => (window as unknown as { __rpc: { rpc: string; body: { slug: string; answers: unknown[] } }[] }).__rpc)
}

// A real pointer click at the element's centre: the verbs prevent mousedown, so only a pointer click
// exercises the path a human takes.
async function mouseClick(page: Page, selector: string) {
  const box = await page.$eval(selector, (n) => {
    const r = n.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.click(box.x, box.y)
}

test("an instruction draws its numbered steps with no × and no Send, and Done sends one reply with the note", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("instruct=1")
  try {
    await page.waitForSelector(`${CARD} [data-instruction-steps] li`)
    const card = await page.$eval(CARD, (n) => ({
      text: (n as HTMLElement).innerText,
      steps: [...n.querySelectorAll("[data-instruction-steps] > li")].map((li) => (li as HTMLElement).innerText.trim()),
      code: n.querySelector("[data-instruction-steps] pre")?.textContent?.trim(),
      list: getComputedStyle(n.querySelector("[data-instruction-steps]")!).listStyleType,
    }))
    assert.match(card.text, /For you to do/)
    assert.match(card.text, new RegExp(TITLE))
    assert.match(card.text, /needs a maintainer's npm session/, "the context renders")
    assert.equal(card.steps.length, 3)
    assert.equal(card.list, "decimal", "the steps are NUMBERED")
    assert.equal(card.code, "npm login --auth-type=web", "a step's code block renders inside its own list item")
    // Nothing on this stack is staged, and an instruction cannot be waved away: the decline is a verb.
    assert.equal(await page.$("[data-send-answers]"), null, "no Send answers beside an instruction alone")
    assert.equal(await page.$(`${CARD} [data-dismiss-question]`), null, "no × on an instruction")

    await mouseClick(page, `${CARD} textarea`)
    await page.keyboard.type("signed in as the maintainer")
    await mouseClick(page, `${CARD} [data-instruction-done]`)
    const [sent] = await rpcs(page, 1)
    assert.equal(sent.rpc, "answerQuestions")
    assert.deepEqual(sent.body, {
      slug: "registered-question-demo",
      answers: [{ questionId: "ins_0001aaaa0001", question: TITLE, chosen: ["Done"], text: "signed in as the maintainer" }],
    })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// ENTER IS A NEWLINE in this box, never a send: the card has two verbs, and a note explaining why the
// steps FAILED, sent as "Done" by a Return key, would tell the worker they were performed. Asked beside a
// staged question, so neither verb nor the question batch can ride the key.
test("Enter in an instruction's note box writes a newline and sends nothing", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("mixed=1")
  try {
    await page.waitForSelector(`${QUESTION} [data-question-option]`)
    await mouseClick(page, `${QUESTION} [data-question-option]`)
    await mouseClick(page, `${CARD} textarea`)
    await page.keyboard.type("couldn't")
    await page.keyboard.press("Enter")
    await page.keyboard.type("the 2FA app is elsewhere")
    await new Promise((r) => setTimeout(r, 500))
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __rpc: unknown[] }).__rpc), [], "nothing is sent")
    assert.equal(await page.$eval(`${CARD} textarea`, (ta) => (ta as HTMLTextAreaElement).value), "couldn't\nthe 2FA app is elsewhere")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("beside a staged question, Couldn't do it sends ONLY the instruction", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("mixed=1")
  try {
    await page.waitForSelector(`${QUESTION} [data-question-option]`)
    await page.waitForSelector(`${CARD} [data-instruction-not-done]`)
    // The stack still answers its question: Send is there, and waits for a pick.
    assert.equal(await page.$eval("[data-send-answers]", (b) => (b as HTMLButtonElement).disabled), true)
    await mouseClick(page, `${QUESTION} [data-question-option]`)
    assert.equal(await page.$eval("[data-send-answers]", (b) => (b as HTMLButtonElement).disabled), false, "the pick is staged")
    await mouseClick(page, `${CARD} [data-instruction-not-done]`)
    const sent = await rpcs(page, 1)
    // A finished act is not held for, nor mixed with, an answer the human has not sent.
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].body.answers, [{ questionId: "ins_0001aaaa0001", question: TITLE, chosen: ["Couldn't do it"] }])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("beside an instruction, Send answers sends ONLY the question", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("mixed=1")
  try {
    await page.waitForSelector(`${QUESTION} [data-question-option]`)
    // A note typed on the instruction must not ride the question batch either.
    await mouseClick(page, `${CARD} textarea`)
    await page.keyboard.type("half a note")
    await mouseClick(page, `${QUESTION} [data-question-option]`)
    await mouseClick(page, "[data-send-answers]")
    const sent = await rpcs(page, 1)
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].body.answers.map((a) => (a as { questionId: string }).questionId), ["qst_0001aaaa"])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a reported instruction settles to its title and the reply, with no verbs left", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("settled=1")
  try {
    await page.waitForSelector(`[data-settled-question]${CARD}`)
    const settled = await page.$eval(`[data-settled-question]${CARD}`, (n) => ({
      text: (n as HTMLElement).innerText,
      buttons: n.querySelectorAll("button, textarea").length,
      steps: n.querySelectorAll("[data-instruction-steps]").length,
    }))
    assert.match(settled.text, new RegExp(TITLE))
    // The note is the human's own words, so it reads back verbatim — backticks and all — exactly as a
    // settled question's typed answer does.
    assert.match(settled.text, /Done — signed in; `npm whoami` prints the maintainer account/)
    assert.equal(settled.buttons, 0, "a settled card is read-only")
    assert.equal(settled.steps, 0, "the steps are dropped once the human has reported on them")
    // The settled QUESTION beside it still draws as a question.
    assert.ok(await page.$(`[data-settled-question]${QUESTION}`), "the settled question still renders")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
