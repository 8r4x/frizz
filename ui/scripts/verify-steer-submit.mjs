// End-to-end proof that a Claude follow-up fray injects is actually SUBMITTED — driven against a REAL
// `claude` TUI in a REAL tmux pane, through fray's REAL resumeThread + REAL delivery confirmer.
//
//   node scripts/verify-steer-submit.mjs [sends=10] [--legacy]
//
// The browser cannot reach this: the bug is a race between tmux's writes and the TUI's paste ingestion,
// and the only ground truth is Claude Code's own session JSONL. So this is a focused real-subsystem
// harness — real tmux socket, real claude process, real SQLite storage, real resume/confirm code.
//
//   --legacy  reproduce the PRE-FIX behaviour (tmux.sendKeys: `send-keys -l <text>` plus a SEPARATE
//             `send-keys Enter`, no settle, no confirmer) so before and after are measured by the same
//             instrument on the same machine.
//
// Assertions (each prints PASS/FAIL; any FAIL exits 1):
//   1. every follow-up reaches Claude Code as its OWN message — no concatenation
//   2. no follow-up is delivered TWICE — the retry cannot double-send
//   3. all N follow-ups arrive at all
//   4. NEGATIVE CONTROL: a draft the operator typed into the pane is never submitted
//   5. NEGATIVE CONTROL: a follow-up whose first Enter landed never gets a second copy
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import * as tmux from "../packages/server/src/tmux.ts"
import { createStorage } from "../packages/server/src/storage.ts"
import { resumeThread } from "../packages/server/src/resume.ts"
import { appendDelivery, parseDeliveryLedger } from "../packages/server/src/delivery-ledger.ts"
import { createDeliveryConfirmer, flushStuckComposer } from "../packages/server/src/delivery-confirm.ts"

const args = process.argv.slice(2)
const LEGACY = args.includes("--legacy")
const SENDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 10)
const GAP_MS = 700 // deliberately tighter than an operator types, to stress the accumulation path
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SLUG = "steer-submit-probe"
const SOCKET = `fray-steer-verify-${process.pid}`
const TARGET = `=fray-${SLUG}:`
const failures = []
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!cond) failures.push(label)
}

// ── real, isolated project + storage ─────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "fray-steer-verify-"))
mkdirSync(join(root, "project"), { recursive: true })
// realpath: on macOS os.tmpdir() is a /var symlink and Claude Code keys its per-project transcript dir
// on the RESOLVED cwd. Reading the unresolved spelling looks for the JSONL where nothing writes it.
const projectDir = realpathSync(join(root, "project"))
writeFileSync(join(projectDir, "README.md"), "scratch project for the steering-submit verifier\n")
const stateDir = join(root, "state")
mkdirSync(stateDir, { recursive: true })
const storage = createStorage(join(stateDir, "ui.db"))
tmux.setSocket(SOCKET)

// Claude Code writes its session JSONL under the REAL home (the pane needs real credentials), keyed by
// the project dir — this run's throwaway temp dir, so none of the operator's state is read or written.
const claudeSessionId = randomUUID()
const jsonl = join(homedir(), ".claude", "projects", projectDir.replace(/\//g, "-"), `${claudeSessionId}.jsonl`)

const tmuxRaw = (...a) => execFileSync("tmux", ["-L", SOCKET, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const cleanup = () => { try { execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" }) } catch {} }
process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit(1) })

const capture = () => { try { return tmuxRaw("capture-pane", "-p", "-t", TARGET) } catch { return "" } }
async function waitFor(pred, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (pred(capture())) return true; await sleep(150) }
  console.error(`\n--- pane at timeout (${label}) ---\n${capture()}\n---`)
  throw new Error(`timed out waiting for ${label}`)
}
function readRecords() {
  const out = []
  if (!existsSync(jsonl)) return out
  for (const line of readFileSync(jsonl, "utf8").split("\n")) {
    if (!line.trim()) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    if (r.type === "queue-operation" && r.operation === "enqueue" && typeof r.content === "string") out.push({ kind: "enqueue", text: r.content })
    else if (r.type === "user" && r.isMeta !== true) {
      const c = r.message?.content
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : ""
      if (t) out.push({ kind: "user", text: t })
    }
  }
  return out
}

// ── a REAL claude TUI in the pane fray addresses by slug ─────────────────────────────────────────
tmuxRaw("new-session", "-d", "-s", `fray-${SLUG}`, "-x", "160", "-y", "45", "-c", projectDir,
  "claude", "--session-id", claudeSessionId, "--dangerously-skip-permissions", "--model", "haiku")
await waitFor((t) => /trust this folder|bypass permissions|for shortcuts/i.test(t), 60_000, "boot")
if (/trust this folder/i.test(capture())) {
  tmuxRaw("send-keys", "-t", TARGET, "Enter")
  await waitFor((t) => !/trust this folder/i.test(t), 30_000, "trust")
}
await waitFor((t) => /bypass permissions|for shortcuts/i.test(t), 60_000, "composer")
await sleep(3000)
tmux.invalidateLiveness()

storage.upsertSession({
  slug: SLUG,
  session_id: claudeSessionId,
  tmux_name: `fray-${SLUG}`,
  spawned_at: new Date().toISOString(),
  last_read_at: null,
  unread: 0,
  exited: 0,
  archived: 0,
  rested_at: null,
  title_auto: 0,
  title: "steering submit probe",
  state: "open",
  meta: null,
  seen_at: null,
  plan_path: null,
  transcript_id: null,
  permission_mode: "bypassPermissions",
  permission_pending: null,
})
storage.setBackend(SLUG, "claude")

const board = { refresh: () => {} }
const deps = {
  project: { dir: projectDir, cwdSlug: projectDir.replace(/\//g, "-"), stateDir },
  storage,
  board,
  getSettings: () => ({ permissionMode: "bypassPermissions" }),
}
const confirmer = createDeliveryConfirmer({ storage, board })

// The PRE-FIX injector, for the --legacy before-measurement: the un-settled literal+Enter pair.
const legacyInject = (text) => {
  tmuxRaw("send-keys", "-t", TARGET, "-l", text)
  tmuxRaw("send-keys", "-t", TARGET, "Enter")
}
// Exactly what router.followUp does for a Claude row: flush a stranded composer, inject, ledger it.
async function steer(text, deliveryId) {
  if (LEGACY) legacyInject(text)
  else {
    await flushStuckComposer({ storage, board }, SLUG)
    resumeThread(deps, SLUG, text)
  }
  if (deliveryId) appendDelivery(storage, SLUG, { id: deliveryId, text })
}

// ── render pressure: one long primer turn, so every follow-up is QUEUED (the operator's shape) ────
const IN_FLIGHT = /esc to interrupt|Generating…|Running \d+ shell|\(\d+s · ↓|Thinking…|Pondering|Cogitating|Simmering|Herding/i
const PRIMER = "Run this bash command then reply with the single word done: for i in $(seq 1 1600); do echo \"noise line $i\"; sleep 0.12; done"
let primerRetries = 0
resumeThread(deps, SLUG, PRIMER)
for (;;) {
  const t0 = Date.now(); let started = false
  while (Date.now() - t0 < 12_000) { if (IN_FLIGHT.test(capture())) { started = true; break } await sleep(150) }
  if (started) break
  if (++primerRetries > 8) throw new Error("primer never started")
  tmuxRaw("send-keys", "-t", TARGET, "Enter")
}
console.log(`# primer turn running (Enters the TUI swallowed before it started: ${primerRetries})`)
console.log(`# transcript: ${jsonl} (exists=${existsSync(jsonl)})`)
await sleep(1500)

// ── the measurement: N follow-ups through the real path, with the real confirmer ticking ─────────
const confirmTimer = LEGACY ? null : setInterval(() => { try { confirmer.tick() } catch (e) { console.error("confirmer:", e) } }, 500)
const sent = []
for (let i = 0; i < SENDS; i++) {
  const tag = `STEER-${String(i).padStart(3, "0")}`
  const text = `${tag} please note this follow-up and keep going with the current task`
  sent.push({ tag, text })
  await steer(text, `deliv-${i}`)
  await sleep(GAP_MS)
}
await sleep(8000)

const records = readRecords()
const carrying = records.filter((r) => /STEER-\d\d\d/.test(r.text))
const enq = carrying.filter((r) => r.kind === "enqueue")
const composed = carrying.filter((r) => (r.text.match(/STEER-\d\d\d/g) ?? []).length > 1)
const tags = enq.flatMap((r) => r.text.match(/STEER-\d\d\d/g) ?? [])
const dupes = tags.filter((t, i) => tags.indexOf(t) !== i)
const missing = sent.map((s) => s.tag).filter((t) => !carrying.some((r) => r.text.includes(t)))

console.log(`\n# mode=${LEGACY ? "LEGACY (pre-fix)" : "FIXED"}  sends=${SENDS}  gap=${GAP_MS}ms`)
console.log(`# records carrying a probe: ${carrying.length} (${enq.length} queue records)`)
console.log(`# concatenated records: ${composed.length}`)
for (const c of composed) console.log(`#   composed: ${JSON.stringify(c.text.slice(0, 170))}`)
ok(composed.length === 0, "every follow-up arrives as its OWN message (no concatenation)", `${composed.length} composed`)
ok(dupes.length === 0, "no follow-up is delivered twice (the retry cannot double-send)", `dupes=${JSON.stringify(dupes)}`)
ok(missing.length === 0, `all ${SENDS} follow-ups reached Claude Code`, `${missing.length} missing: ${JSON.stringify(missing)}`)

// ── NEGATIVE CONTROL 1: the operator's own draft is never submitted ──────────────────────────────
if (!LEGACY) {
  const outstanding = "STEER-HUMAN a follow-up that will sit unsent"
  const draft = "HUMAN-DRAFT do not send this on my behalf"
  // A follow-up fray injected AND an operator draft typed after it: the composer is no longer
  // exclusively fray's, so both the confirmer and the pre-inject flush must keep hands off entirely.
  appendDelivery(storage, SLUG, { id: "deliv-human", text: outstanding })
  tmuxRaw("send-keys", "-t", TARGET, "-l", `${outstanding} ${draft}`)
  const before = readRecords().length
  await sleep(7000) // ≫ the grace window + a dozen confirmer ticks
  const after = readRecords()
  const submitted = after.slice(before).some((r) => r.text.includes("HUMAN-DRAFT"))
  ok(!submitted, "a draft the operator typed into the pane is never submitted", submitted ? "IT WAS SUBMITTED" : "")
  ok(/HUMAN-DRAFT/.test(capture()), "the operator's draft is left sitting in the composer, untouched")
  const human = parseDeliveryLedger(storage.getSession(SLUG)?.delivery_ledger).find((i) => i.id === "deliv-human")
  ok((human?.submitAttempts ?? 0) === 0, "no Enter is pressed while the operator's text is in the composer",
    `submitAttempts=${human?.submitAttempts ?? 0}`)
  // And the flush must decline too, even though it is about to paste on top.
  await flushStuckComposer({ storage, board }, SLUG)
  ok(/HUMAN-DRAFT/.test(capture()), "the pre-inject flush also declines an operator draft")

  for (let i = 0; i < 25 && /HUMAN-DRAFT|STEER-HUMAN/.test(capture()); i++) {
    tmuxRaw("send-keys", "-t", TARGET, "C-u")
    await sleep(150)
  }
  await sleep(500)
  ok(!/HUMAN-DRAFT/.test(capture()), "the harness cleared the draft before the next control")
  storage.setDeliveryLedger(SLUG, null) // the human-control item is deliberately never delivered
}

// ── NEGATIVE CONTROL 2: a follow-up whose first Enter LANDED gets no second copy ─────────────────
if (!LEGACY) {
  const text = "STEER-LANDED this one submits on the first Enter"
  const before = readRecords().filter((r) => r.text.includes("STEER-LANDED")).length
  resumeThread(deps, SLUG, text)
  // The ledger entry is left PENDING on purpose (nothing folds the JSONL in this harness), so the
  // confirmer sees an outstanding item for a dozen ticks with the composer already cleared. If it were
  // willing to press Enter on anything but our own text, this is where a second copy would appear.
  appendDelivery(storage, SLUG, { id: "deliv-landed", text })
  await sleep(10_000)
  const hits = readRecords().filter((r) => r.text.includes("STEER-LANDED"))
  // A mid-turn submit writes an `enqueue`; a rested one writes a plain `user` record; a drained queue
  // writes both for the SAME message. Duplication is therefore >1 of either kind, or two copies inside
  // one record — not simply "more than one record".
  const enqHits = hits.filter((r) => r.kind === "enqueue")
  const userHits = hits.filter((r) => r.kind === "user")
  const twiceInOne = hits.some((r) => (r.text.match(/STEER-LANDED/g) ?? []).length > 1)
  ok(before === 0 && hits.length >= 1 && enqHits.length <= 1 && userHits.length <= 1 && !twiceInOne,
    "a follow-up that landed on its first Enter is delivered exactly once",
    `enqueue=${enqHits.length} user=${userHits.length} twiceInOne=${twiceInOne}`)
  const landed = parseDeliveryLedger(storage.getSession(SLUG)?.delivery_ledger).find((i) => i.id === "deliv-landed")
  ok((landed?.submitAttempts ?? 0) === 0, "no Enter is re-pressed for a send that already submitted",
    `submitAttempts=${landed?.submitAttempts ?? 0}`)
}

if (confirmTimer) clearInterval(confirmTimer)
// stop the turn so the queue is discarded rather than billed
tmuxRaw("send-keys", "-t", TARGET, "Escape"); await sleep(1200)
tmuxRaw("send-keys", "-t", TARGET, "Escape"); await sleep(1200)
storage.close()
cleanup()
console.log(`\n${failures.length ? `FAILED: ${failures.join(" | ")}` : "ALL CHECKS PASSED"}`)
process.exit(failures.length ? 1 : 0)
