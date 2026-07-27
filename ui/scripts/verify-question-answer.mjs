// Browser gate for the ```question card's ANSWERING contract, driven against the REAL app on a REAL
// disposable stack. The gallery fixture holds local state, so it can prove the chips and the textarea
// behave — but not the SEAM that actually matters: card → answering controller → composeAnswerWire →
// rpc.followUp. So this asserts on the bytes leaving the page.
//
// The two behaviors it pins (both settled 2026-07-26):
//   1. NOTHING in a question card sends on a single click. The retired ```question approval gate had a
//      lone Approve button that fired immediately; every kind now STAGES (pick a chip / type, then
//      Send answers). A legacy `approval` block must therefore render the same two chips as any other
//      two-option question, and clicking one must put nothing on the wire.
//   2. The free-text box takes NEWLINES on a bare Enter, and only ⌘/Ctrl-Enter sends — so a multi-line
//      answer can be typed without firing a reply mid-sentence, and the newlines survive to the wire.
//
// Seed a stack + question threads first (scripts/seed-question-cards.mjs, see .claude/skills/adhoc-cdp):
//   node scripts/verify-question-answer.mjs --url=http://127.0.0.1:4930 --slug=q-legacy-approval
// Each run CONSUMES its seed (the answer is a newer user message, which retires the ask), so re-seed a
// fresh slug per run rather than re-pointing it at a spent one.
import puppeteer from "puppeteer"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=") || true] }),
)
const { url, slug, shots = "/tmp" } = flags
if (!url || !slug) {
  console.error("usage: node verify-question-answer.mjs --url= --slug= [--shots=/tmp]")
  process.exit(1)
}
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const SEL = `[data-queue-card-root="${slug}"]`
const ANSWER_BOX = `${SEL} textarea[data-surface="questionAnswer"]`

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`) })

  const sends = []
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/rpc/followUp")) {
      try { sends.push(JSON.parse(req.postData() ?? "{}")) } catch { sends.push({ unparsed: req.postData() }) }
    }
  })

  await page.goto(url, { waitUntil: "networkidle2" })
  await page.waitForSelector(SEL, { timeout: 15000 })
  await page.waitForSelector(ANSWER_BOX, { timeout: 15000 })
  await settle(1200)

  // Every button inside the card, so the assertions can talk about what the card offers without
  // knowing its chrome. Chips are the option buttons; the lifecycle controls are named separately.
  const buttons = () => page.evaluate((sel) =>
    [...document.querySelector(sel).querySelectorAll("button")].map((b) => b.textContent.trim()), SEL)

  const labels = await buttons()
  check(
    "the card offers NO one-click approve action",
    !labels.some((t) => /^(approve|approve as-is|do it\b|click again to confirm)/i.test(t)),
    JSON.stringify(labels),
  )
  const chips = labels.filter((t) => /^[A-Z][.)]\s/.test(t))
  check("the gate's options render as answerable chips", chips.length >= 2, JSON.stringify(chips))
  await page.screenshot({ path: `${shots}/fray-question-${slug}-rest.png` })

  // 1. A chip click STAGES — it must not send.
  const clicked = await page.evaluate((sel) => {
    const b = [...document.querySelector(sel).querySelectorAll("button")].find((b) => /^[A-Z][.)]\s/.test(b.textContent.trim()))
    b.click()
    return b.textContent.trim()
  }, SEL)
  await settle(900)
  check("clicking a chip sends NOTHING (the answer is staged)", sends.length === 0, `sends=${sends.length} after clicking ${JSON.stringify(clicked)}`)
  await page.screenshot({ path: `${shots}/fray-question-${slug}-staged.png` })

  // 2. Enter inside the free-text box writes a NEWLINE and sends nothing.
  await page.focus(ANSWER_BOX)
  await page.keyboard.type("Hold for now.")
  await page.keyboard.press("Enter")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Rerun CI first, then ask me again.")
  await settle(600)
  const typed = await page.$eval(ANSWER_BOX, (el) => el.value)
  check("Enter inserts a NEWLINE in the free-text box", typed.split("\n").length === 3, JSON.stringify(typed))
  check("typing Enter never sends", sends.length === 0, `sends=${sends.length}`)
  // The box grows with its content instead of clipping the extra lines behind a hidden overflow.
  const box = await page.$eval(ANSWER_BOX, (el) => ({ h: el.clientHeight, scroll: el.scrollHeight }))
  check("the box grew to fit the multi-line answer", box.h >= box.scroll - 1, JSON.stringify(box))
  await page.screenshot({ path: `${shots}/fray-question-${slug}-multiline.png` })

  // 3. ⌘-Enter sends the staged answer, newlines intact.
  await page.keyboard.down("Meta")
  await page.keyboard.press("Enter")
  await page.keyboard.up("Meta")
  await settle(1500)
  check("⌘-Enter sends exactly ONE follow-up", sends.length === 1, `sends=${sends.length} ${JSON.stringify(sends)}`)
  check("the send targets this thread", sends[0]?.slug === slug, JSON.stringify(sends[0]?.slug))
  check(
    "the wire payload keeps the typed newlines",
    sends[0]?.message === typed,
    `got ${JSON.stringify(sends[0]?.message)} want ${JSON.stringify(typed)}`,
  )
  await page.screenshot({ path: `${shots}/fray-question-${slug}-sent.png` })
  check("no console/page errors", errors.length === 0, errors.join(" | ") || "clean")
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
