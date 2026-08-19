// Verify MID-SCROLL STABILITY in the thread transcript against a REAL running stack.
//
// verify-tail-follow.mjs guards the reader who is AT the bottom. This guards the opposite reader: parked
// in the MIDDLE, detached, "Jump to latest" showing. Nothing that lands while they read may move them —
// not a reply, not a sub-agent dispatch or return, not a queued→delivered flip, not the live clock.
//
// It measures what the READER perceives: the viewport-relative Y of a row on screen. scrollTop
// invariance is the WRONG assertion for a virtualizer — TanStack deliberately MOVES scrollTop to hold
// rows still when content above resizes, so "scrollTop unchanged" can mean the rows moved and
// "scrollTop changed" can mean they correctly did not. Several cases below expect scrollTop to change.
//
// THE CASE THAT MATTERS is the dequeue, and it only bites in one configuration — which this harness
// asserts it reached, because two earlier cuts of it passed while testing nothing:
//   * The pinned current ask must be ABOVE the reader (stuck at the pane top, its flow slot scrolled
//     past). That is the real shape of a live thread: one ask, a long working turn under it, the reader
//     scrolled into the middle of that. Park the reader above the ask instead and a dequeue changes
//     nothing above the viewport, so every case reads 0px for the wrong reason.
//   * A delivery is the ONLY event that moves the pin — a queued bubble is excluded from lastUserIdx,
//     so an enqueue cannot move it and no assistant reply ever can. When it moves, the row that WAS
//     pinned drops back into the absolute layer and re-renders FULL SIZE instead of the collapsed
//     pinned card (measured 218px → 366px), which is a fixed-size growth ABOVE the reader.
// So the dequeue case ASSERTS the pin re-expanded. If that assertion stops holding, the case is no
// longer exercising the bug and must be re-seeded rather than trusted.
//
// Usage — boot a disposable stack first (see .agents/skills/frizz-stack), then:
//   node scripts/verify-midscroll-stability.mjs --home=/abs/temp-home --url=http://127.0.0.1:PORT/
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync, globSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import puppeteer from "puppeteer"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, url } = flags
const cwd = flags.cwd ?? process.cwd()
const shotDir = flags.shots ?? tmpdir()
if (!home || !url) {
  console.error("usage: node scripts/verify-midscroll-stability.mjs --home=/abs/temp-home --url=http://127.0.0.1:PORT/")
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const db = globSync(join(home, ".frizz/projects/*/ui.db"))[0]
if (!db) throw new Error(`no ui.db under ${home}/.frizz/projects`)
const SLUG = "verify-midscroll"
const SESSION = "midscrol-0000-4000-8000-000000000000"
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const jsonl = join(jsonlDir, `${SESSION}.jsonl`)

const now = () => new Date().toISOString()
let n = 0
const base = () => ({ parentUuid: null, isSidechain: false, uuid: `${(++n).toString().padStart(8, "0")}-0000-4000-8000-000000000000`, timestamp: now(), session_id: SESSION, cwd })
const user = (text) => ({ ...base(), type: "user", message: { role: "user", content: text } })
const assistant = (text, stop = null) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text }], ...(stop ? { stop_reason: stop } : {}), usage: { input_tokens: 2, output_tokens: 80 } },
})
const agentDispatch = (id, description, prompt) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { description, prompt, subagent_type: "frizz:opus-high", run_in_background: true } }], usage: { input_tokens: 2, output_tokens: 40 } },
})
const agentResult = (id, content) => ({ ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } })
const prose = (paras, label) => Array.from({ length: paras }, (_, i) =>
  `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure.`).join("\n\n")

// The measured seed shape that reaches the configuration above: settled history, ONE long standing ask,
// then a long in-flight turn under it for the reader to park inside.
const seed = []
for (let i = 0; i < 8; i++) {
  seed.push(user(`TASK:\nAsk ${i + 1}: earlier settled exchange.`))
  seed.push(assistant(prose(2 + (i % 4), `Reply ${i + 1}`), "end_turn"))
}
seed.push(user(`TASK:\n${prose(4, "The standing ask")}`))
for (let i = 0; i < 14; i++) seed.push(assistant(prose(3 + (i % 4), `Working step ${i + 1}`)))
writeFileSync(jsonl, seed.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
  VALUES ('${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${now()}', 'Mid-scroll stability', 'claude', 'opus', 'high', 'default')`])
const append = (record) => appendFileSync(jsonl, JSON.stringify(record) + "\n")

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(new URL(`/thread/${SLUG}`, url).href, { waitUntil: "networkidle2", timeout: 30000 })
  await page.waitForFunction("document.querySelector('[data-drawer-transcript-scroll] [data-virtualized-transcript]')", { timeout: 20000 })

  const settle = (ms = 1600) => page.evaluate(async (wait) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 20; i++) await raf()
    await new Promise((r) => setTimeout(r, wait))
    for (let i = 0; i < 20; i++) await raf()
  }, ms)

  // Everything is scoped INSIDE [data-virtualized-transcript]: the pinned band's data-transcript-sticky
  // marker also appears on the eager path's own band, and a document-wide query picks up the wrong one.
  const probe = () => page.evaluate(() => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    const boxEl = document.querySelector("[data-virtualized-transcript]")
    const top = el.getBoundingClientRect().top
    const rows = Array.from(boxEl.querySelectorAll("[data-transcript-row-key]:not([data-transcript-sticky])"))
      .map((r) => ({ key: r.dataset.transcriptRowKey, y: r.getBoundingClientRect().top - top, h: r.getBoundingClientRect().height }))
      .sort((a, b) => a.y - b.y)
    const anchor = rows.find((r) => r.y + r.h > 240) ?? rows[0]
    const pin = boxEl.querySelector("[data-transcript-sticky]")
    return {
      anchorKey: anchor?.key ?? null,
      anchorY: anchor ? Math.round(anchor.y) : null,
      scrollTop: Math.round(el.scrollTop),
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      jumpVisible: Boolean(document.querySelector("[data-jump-to-latest]")),
      pinKey: pin?.dataset.transcriptRowKey ?? null,
      pinH: pin ? Math.round(pin.getBoundingClientRect().height) : null,
      // Stuck at the pane top ⇒ its flow slot is above the reader: the configuration under test.
      pinStuck: pin ? Math.round(pin.getBoundingClientRect().top - top) <= 2 : false,
      overflowAnchor: getComputedStyle(el).overflowAnchor,
    }
  })
  const rowY = (key) => page.evaluate((k) => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    const boxEl = document.querySelector("[data-virtualized-transcript]")
    const top = el.getBoundingClientRect().top
    const row = Array.from(boxEl.querySelectorAll("[data-transcript-row-key]:not([data-transcript-sticky])")).find((r) => r.dataset.transcriptRowKey === k)
    return row ? Math.round(row.getBoundingClientRect().top - top) : null
  }, key)
  // The height of a NAMED row wherever it now lives — used to prove the pin actually re-expanded.
  const rowH = (key) => page.evaluate((k) => {
    const boxEl = document.querySelector("[data-virtualized-transcript]")
    const row = Array.from(boxEl.querySelectorAll("[data-transcript-row-key]")).find((r) => r.dataset.transcriptRowKey === k)
    return row ? Math.round(row.getBoundingClientRect().height) : null
  }, key)

  await settle()
  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-drawer-transcript-scroll]").getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await page.mouse.move(box.x, box.y)
  for (let i = 0; i < 12; i++) { await page.mouse.wheel({ deltaY: -300 }); await new Promise((r) => setTimeout(r, 50)) }
  await settle(1000)

  let m = await probe()
  check("the reader is parked mid-transcript, detached", m.distance > 500 && m.jumpVisible, `distance=${m.distance} jump=${m.jumpVisible} anchorY=${m.anchorY}`)
  check("the configuration under test: the current ask is PINNED at the pane top, its slot above the reader", m.pinStuck, `pinKey=${m.pinKey} pinH=${m.pinH}`)
  check("the transcript scroller owns its offset alone (native scroll anchoring off)", m.overflowAnchor === "none", `overflow-anchor=${m.overflowAnchor}`)
  const anchorKey = m.anchorKey
  const pinnedKey = m.pinKey
  const pinnedHeightWhilePinned = m.pinH
  let lastY = m.anchorY
  let lastScrollTop = m.scrollTop
  await page.screenshot({ path: join(shotDir, "midscroll-0-parked.png") })

  const perturb = async (label, act, wait = 1600) => {
    await act()
    await settle(wait)
    const y = await rowY(anchorKey)
    const after = await probe()
    check(`mid-scroll: ${label}`, y !== null && y === lastY, `anchor Y ${lastY} → ${y} (drift ${y === null ? "row gone" : y - lastY + "px"}), scrollTop ${lastScrollTop} → ${after.scrollTop}`)
    if (y !== null) lastY = y
    lastScrollTop = after.scrollTop
  }

  await perturb("a plain reply landing at the tail leaves the reader untouched", () => append(assistant(prose(6, "A landing reply"))))
  await perturb("a sub-agent DISPATCH landing at the tail leaves the reader untouched", () => append(agentDispatch("agent-mid-1", "Investigate the drift", "Investigate the mid-scroll drift end to end and report.")))
  await perturb("a sub-agent RETURNING leaves the reader untouched", () => append(agentResult("agent-mid-1", prose(3, "Sub-agent report"))), 2200)
  await perturb("an ENQUEUED follow-up leaves the reader untouched", () => append({ ...base(), type: "queue-operation", operation: "enqueue", content: "One more thing: check the narrow layout too." }))

  // THE DEQUEUE — the pin moves off the standing ask, which re-expands ABOVE the reader.
  await perturb("the ENQUEUED→DELIVERED flip (DQ) leaves the reader untouched", () => append({ ...base(), type: "attachment", attachment: { type: "queued_command", prompt: "One more thing: check the narrow layout too.", origin: { kind: "human" }, commandMode: "prompt" } }), 2600)
  const pinnedHeightAfter = await rowH(pinnedKey)
  const afterDq = await probe()
  check("the DQ really did move the pin (this case is not passing vacuously)", afterDq.pinKey !== pinnedKey, `pin ${pinnedKey} → ${afterDq.pinKey}`)
  check("the un-pinned ask really did re-expand above the reader (the growth under test)", pinnedHeightAfter !== null && pinnedHeightAfter > pinnedHeightWhilePinned, `${pinnedHeightWhilePinned}px pinned → ${pinnedHeightAfter}px un-pinned`)
  await page.screenshot({ path: join(shotDir, "midscroll-1-after-dq.png") })

  await perturb("a reply after the DQ leaves the reader untouched", () => append(assistant(prose(4, "Answering the follow-up"))))
  await perturb("idling with NOTHING landing leaves the reader untouched", async () => {}, 3000)

  m = await probe()
  check("the reader is still detached after everything landed", m.jumpVisible, `jump=${m.jumpVisible} distance=${m.distance}`)
  await page.screenshot({ path: join(shotDir, "midscroll-2-final.png") })

  check("no console or page errors", errors.length === 0, errors.join(" | "))
  console.log(`\nscreenshots → ${shotDir}/midscroll-*.png`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
