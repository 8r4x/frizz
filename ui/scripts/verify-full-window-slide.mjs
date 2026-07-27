// Verify APPEND STABILITY on /thread/<slug>/full when the render window is SATURATED.
//
// This is the configuration every one of the maintainer's real threads is in and that no other harness
// reaches. `MAX_MESSAGES = 300` (transcript.ts) caps the live projection, so once a thread passes 300
// messages every new message also DROPS one off the HEAD: rows vanish above the reader, `beforeCursor`
// advances, and the `earlier-history:${beforeCursor}` row that sits at index 0 CHANGES ITS KEY. That
// makes `didEdgeKeysChange` true inside the virtualizer on every single append, which forces a full
// measurement rebuild (`pendingMin = 0; itemSizeCacheVersion++`) plus an anchor resolution — a far
// churnier path than "one row appended at the tail", and it runs several times a second on a live turn.
//
// Every earlier harness seeded a transcript comfortably UNDER 300 messages, so none of them ever ran it.
//
// Usage — boot a disposable stack first (see .agents/skills/adhoc-cdp), then:
//   node scripts/verify-full-window-slide.mjs --home=… --socket=… --url=… [--park=900] [--appends=25]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync, globSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, socket, url } = flags
const cwd = flags.cwd ?? process.cwd().replace(/\/ui$/, "")
const shotDir = flags.shots ?? tmpdir()
const parkTarget = Number(flags.park ?? 900)
const appends = Number(flags.appends ?? 25)
if (!home || !socket || !url) {
  console.error("usage: node scripts/verify-full-window-slide.mjs --home=… --socket=… --url=…")
  process.exit(1)
}
mkdirSync(shotDir, { recursive: true })

const db = globSync(join(home, ".fray/projects/*/ui.db"))[0]
if (!db) throw new Error(`no ui.db under ${home}/.fray/projects`)
const SLUG = "verify-window-slide"
const SESSION = "windslid-0000-4000-8000-000000000000"
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
const merged = (id, content) => ({
  ...base(),
  type: "assistant",
  message: { model: "claude-opus-5", id, type: "message", role: "assistant", content, usage: { input_tokens: 2, output_tokens: 40 } },
})
const prose = (paras, label) => Array.from({ length: paras }, (_, i) =>
  `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, quis nostrud exercitation ullamco laboris nisi.`).join("\n\n")

// > 300 projected messages on purpose: the window must already be FULL before the first append, so each
// append slides it. 200 settled exchanges = 400 messages, then a live turn to park inside.
const seed = []
for (let i = 0; i < 200; i++) {
  seed.push(user(`TASK:\nAsk ${i + 1}: earlier settled exchange.`))
  seed.push(assistant(prose(1 + (i % 3), `Reply ${i + 1}`), "end_turn"))
}
seed.push(user(`TASK:\n${prose(3, "The standing ask")}`))
for (let i = 0; i < 12; i++) seed.push(assistant(prose(2 + (i % 3), `Working step ${i + 1}`)))
let tailId = `msg_${n}`
writeFileSync(jsonl, seed.map((r) => JSON.stringify(r)).join("\n") + "\n")
try { execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", `fray-${SLUG}`, "sleep 7200"], { stdio: "ignore" }) } catch {}
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (slug, session_id, tmux_name, spawned_at, title, backend, model, effort, permission_mode)
  VALUES ('${SLUG}', '${SESSION}', 'fray-${SLUG}', '${now()}', 'Window slide', 'claude', 'opus', 'high', 'default')`])
const append = (record) => appendFileSync(jsonl, JSON.stringify(record) + "\n")
const api = createRpcClient(url)

let failures = 0
const check = (l, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))

  // Prove the precondition off the SERVER before touching the browser: a saturated window and a cursor
  // to advance. Without both, this harness is testing the same thing every other one already did.
  const first = await api.query("threadTranscript", { slug: SLUG })
  check("the render window is SATURATED before the first append (the configuration under test)",
    first.messages.length >= 300 && first.hasEarlier === true,
    `messages=${first.messages.length} hasEarlier=${first.hasEarlier} beforeCursor=${first.beforeCursor}`)

  await page.goto(new URL(`/thread/${SLUG}/full`, url).href, { waitUntil: "networkidle2", timeout: 60000 })
  await page.waitForFunction("document.querySelector('[data-standalone-thread] [data-drawer-transcript-scroll] [data-virtualized-transcript]')", { timeout: 40000 })

  const settle = (ms) => page.evaluate(async (wait) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 10; i++) await raf()
    await new Promise((r) => setTimeout(r, wait))
    for (let i = 0; i < 10; i++) await raf()
  }, ms)
  const probe = (key) => page.evaluate((k) => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    const boxEl = document.querySelector("[data-virtualized-transcript]")
    const top = el.getBoundingClientRect().top
    const all = Array.from(boxEl.querySelectorAll("[data-transcript-row-key]:not([data-transcript-sticky])"))
      .map((r) => ({ key: r.dataset.transcriptRowKey, y: r.getBoundingClientRect().top - top, h: r.getBoundingClientRect().height }))
      .sort((a, b) => a.y - b.y)
    const named = k ? all.find((r) => r.key === k) : undefined
    const chosen = named ?? all.find((r) => r.y + r.h > 240) ?? all[0]
    return {
      key: chosen?.key ?? null,
      y: chosen ? Math.round(chosen.y) : null,
      found: Boolean(named),
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      jumpVisible: Boolean(document.querySelector("[data-jump-to-latest]")),
      // Mechanism instrumentation: which row is at index 0, whether the "Load earlier messages" row is
      // still there, and how tall the virtualizer thinks the whole transcript is.
      firstRowKey: boxEl.querySelector("[data-index='0']")?.dataset.transcriptRowKey ?? null,
      hasEarlierRow: Array.from(boxEl.querySelectorAll("[data-transcript-row-key]")).some((r) => (r.dataset.transcriptRowKey ?? "").startsWith("earlier-history")),
      totalHeight: Math.round(parseFloat(boxEl.style.height || "0")),
    }
  }, key ?? null)

  await settle(3000)
  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-drawer-transcript-scroll]").getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await page.mouse.move(box.x, box.y)
  for (let i = 0; i < 60; i++) {
    if ((await probe()).distance >= parkTarget) break
    await page.mouse.wheel({ deltaY: -160 })
    await new Promise((r) => setTimeout(r, 35))
  }
  await settle(1600)

  let m = await probe()
  check(`the reader is parked ${m.distance}px above the bottom, detached`, m.distance > 300 && m.jumpVisible, `distance=${m.distance} jump=${m.jumpVisible}`)
  const anchorKey = m.key
  let lastY = m.y
  let lastFirst = m.firstRowKey
  let lastEarlierRow = m.hasEarlierRow
  console.log(`parked: anchor=${anchorKey} y=${lastY} distance=${m.distance} scrollTop=${m.scrollTop} firstRow=${m.firstRowKey} earlierRow=${m.hasEarlierRow} totalHeight=${m.totalHeight}`)
  await page.screenshot({ path: join(shotDir, "windowslide-0-parked.png") })

  const drifts = []
  const headChanges = []
  let earlierRowLostAt = null
  let vanished = null
  for (let i = 0; i < appends; i++) {
    // Alternate the two real shapes: a tool call merged into the tail message, and a fresh message
    // (which is what actually slides the window).
    if (i % 2 === 0) {
      append(merged(tailId, [{ type: "tool_use", id: `toolu_ws_${i}`, name: "Read", input: { file_path: `/Users/x/src/mod-${i}.ts` } }]))
    } else {
      append(assistant(prose(2, `Slide step ${i}`)))
      tailId = `msg_${n}`
    }
    await settle(420)
    const after = await probe(anchorKey)
    if (lastEarlierRow && !after.hasEarlierRow && earlierRowLostAt === null) earlierRowLostAt = i
    if (after.firstRowKey !== lastFirst) headChanges.push({ i, from: lastFirst, to: after.firstRowKey })
    if (!after.found) { vanished = i; break }
    const drift = after.y - lastY
    if (Math.abs(drift) > 2) {
      drifts.push({ i, drift })
      console.log(`  DRIFT ${drift > 0 ? "+" : ""}${drift}px after append ${i} (${i % 2 === 0 ? "merged tool call" : "new message"}) — y ${lastY}→${after.y}, scrollTop ${after.scrollTop}, distance ${after.distance}, totalHeight ${after.totalHeight}, firstRow=${after.firstRowKey}, earlierRow=${after.hasEarlierRow}`)
      lastY = after.y
    }
    lastFirst = after.firstRowKey
    lastEarlierRow = after.hasEarlierRow
  }
  console.log(`\nhead churn: index-0 row key changed ${headChanges.length}× during ${appends} appends`)
  for (const h of headChanges.slice(0, 6)) console.log(`  append ${h.i}: ${h.from} → ${h.to}`)
  check("the 'Load earlier messages' row survives a live push on a saturated window",
    earlierRowLostAt === null,
    earlierRowLostAt === null ? "" : `it disappeared at append ${earlierRowLostAt} — the push dropped hasEarlier from the cached page`)

  const last = await api.query("threadTranscript", { slug: SLUG })
  check("the window really did SLIDE while we watched (not passing vacuously)",
    last.beforeCursor !== first.beforeCursor,
    `beforeCursor ${first.beforeCursor} → ${last.beforeCursor}, messages ${first.messages.length} → ${last.messages.length}`)

  m = await probe(anchorKey)
  await page.screenshot({ path: join(shotDir, "windowslide-1-final.png") })
  check(`${appends} appends against a saturated window never moved the reader`,
    drifts.length === 0 && vanished === null,
    `${drifts.length} drifting appends${vanished !== null ? `; anchor row left the render window at append ${vanished}` : ""}`)
  check("the reader is still detached at the end", m.jumpVisible, `jump=${m.jumpVisible} distance=${m.distance}`)
  check("no console or page errors", errors.length === 0, errors.slice(0, 3).join(" | "))
  console.log(`\nscreenshots → ${shotDir}/windowslide-*.png`)
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
