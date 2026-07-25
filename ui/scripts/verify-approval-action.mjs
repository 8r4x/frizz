// Browser gate for the ```question approval one-click action, driven against the REAL app on a REAL
// disposable stack. The gallery fixture stubs the callback, so it can only prove a button renders and
// calls back — it cannot prove the SEAM: the approve action → onInstantAnswer → sendAnswers(override)
// → composeAnswerWire → rpc.followUp. That seam is where React's async setState would silently drop the
// click (an onChip-then-onSubmit implementation composes from the PRE-click state and sends nothing),
// so this asserts on the actual RPC payload leaving the page.
//
// Deliberately layout-AGNOSTIC: it pins the gate's BEHAVIOR (one click answers; a danger gate arms
// first; the wire payload is the worker's own affirmative option verbatim), not how many buttons the
// card happens to render — so a card-chrome redesign doesn't false-fail it.
//
// Seed a stack + approval threads first (see .claude/skills/adhoc-cdp), then:
//   node scripts/verify-approval-action.mjs --url=http://127.0.0.1:4967 --slug=approval-gate --expect="A. Approve as-is"
//   node scripts/verify-approval-action.mjs --url=… --slug=danger-gate --danger --expect="A. Do it — …"
// Each run CONSUMES its seed (the answer is a newer user message, which retires the fence), so re-seed
// a fresh slug per run rather than re-pointing it at a spent one.
import puppeteer from "puppeteer"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=") || true] }),
)
const { url, slug, expect, danger, shots = "/tmp" } = flags
if (!url || !slug || !expect) {
  console.error('usage: node verify-approval-action.mjs --url= --slug= --expect="<answer>" [--danger] [--shots=/tmp]')
  process.exit(1)
}
let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const SEL = `[data-queue-card-root="${slug}"]`
// The gate's action, whatever the card's current shape: an approve verb, or the armed confirm it
// becomes on a danger gate. Never matches the card's lifecycle controls (Snooze / Mark as done).
const ACTION_SRC = "^(Approve|Approve as-is|Do it\\b.*|Click again to confirm)$"

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`) })

  // The actual bytes the click puts on the wire.
  const sends = []
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/rpc/followUp")) {
      try { sends.push(JSON.parse(req.postData() ?? "{}")) } catch { sends.push({ unparsed: req.postData() }) }
    }
  })

  await page.goto(url, { waitUntil: "networkidle2" })
  await page.waitForSelector(SEL, { timeout: 15000 })
  await settle(1200)

  const actions = () => page.evaluate((sel, src) => {
    const re = new RegExp(src)
    return [...document.querySelector(sel).querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => re.test(t))
  }, SEL, ACTION_SRC)
  const clickAction = () => page.evaluate((sel, src) => {
    const re = new RegExp(src)
    const b = [...document.querySelector(sel).querySelectorAll("button")].find((b) => re.test(b.textContent.trim()))
    if (!b) return null
    b.click()
    return b.textContent.trim()
  }, SEL, ACTION_SRC)

  check("the gate renders an approve action", (await actions()).length >= 1, JSON.stringify(await actions()))
  await page.screenshot({ path: `${shots}/fray-approval-${slug}-rest.png` })

  await clickAction()
  await settle(800)

  if (danger) {
    check("danger: the first click ARMS and sends nothing", sends.length === 0, `sends=${sends.length}`)
    check("danger: the armed action asks for confirmation", (await actions()).some((t) => /confirm/i.test(t)), JSON.stringify(await actions()))
    await page.screenshot({ path: `${shots}/fray-approval-${slug}-armed.png` })
    await clickAction()
    await settle(900)
  }

  await settle(1200)
  check("exactly ONE follow-up was sent", sends.length === 1, `sends=${sends.length} ${JSON.stringify(sends)}`)
  check("the wire payload is the worker's own affirmative option", sends[0]?.message === expect, `got ${JSON.stringify(sends[0]?.message)} want ${JSON.stringify(expect)}`)
  check("the send targets this thread", sends[0]?.slug === slug, JSON.stringify(sends[0]?.slug))
  await page.screenshot({ path: `${shots}/fray-approval-${slug}-sent.png` })
  check("no console/page errors", errors.length === 0, errors.join(" | ") || "clean")
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
