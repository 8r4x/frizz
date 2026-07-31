// Seed a disposable adhoc stack with two SIMULATED workers that differ in exactly one axis — one is
// archived (Done), one is still open — so the lifecycle footer can be judged on the REAL app: real
// tailer, real board projection of the `state` column, real push, real browser.
//
// The pair exists because the footer's behavior on a DONE thread is the whole question. Before
// 2026-07-29 an archived thread rendered NO lifecycle strip, which left its /full view with nothing
// anywhere that said the thread was finished. It now keeps the strip and reads "Done" where the verbs
// were. Both threads carry the same ```done fence in their transcript, so the same run also proves the
// in-transcript fence card drops its redundant Mark-as-done button once the thread is actually archived.
//
// Archiving goes through the REAL setThreadState mutation rather than a hand-written UPDATE: that is
// the only writer of state='archived' in production, and using it keeps the fixture honest about the
// board refresh + SSE delta that follow it.
//
// Follows the adhoc-cdp recipe: a session row + a live dummy tmux pane + a JSONL the tailer reads.
// Usage: node scripts/seed-done-thread.mjs --home=/abs/temp-home --socket=fray-adhoc-NNNN-PID --port=NNNN
import { execFileSync } from "node:child_process"
import { globSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, socket, port, cwd = process.cwd() } = flags
if (!home || !socket || !port) {
  console.error("usage: node seed-done-thread.mjs --home=/abs/temp-home --socket=<tmux-socket> --port=NNNN")
  process.exit(1)
}

const db = globSync(join(home, ".fray/projects/*/ui.db"))[0]
if (!db) throw new Error(`no ui.db under ${home}/.fray/projects`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 40 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

// The fence body is what the ```done card renders, so keep it shaped like a real handoff.
const FENCE = [
  "Landed the tier-boundary rounding fix.",
  "",
  "```done",
  "- Fixed the rounding at the tier boundary in `src/pricing.ts` — the cents now round half-up.",
  "- Added a regression test; the suite is green.",
  "```",
].join("\n")

function seed({ slug, sessionId, title, prompt }) {
  const tmuxName = `fray-${slug}`
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: sessionId, cwd,
      message: { role: "user", content: `TASK:\n${prompt}` },
    },
    {
      parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(3), session_id: sessionId, cwd,
      message: {
        model: "claude-opus-5", id: "msg_done", type: "message", role: "assistant", stop_reason: "end_turn",
        content: [{ type: "text", text: FENCE }],
        usage: { input_tokens: 41_000, output_tokens: 320 },
      },
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  try {
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", tmuxName, "sleep 7200"], { stdio: "ignore" })
  } catch { /* already up */ }
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (slug, session_id, tmux_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES ('${slug}', '${sessionId}', '${tmuxName}', '${at(0)}', '${title}', 'claude', 'opus', 'high', 'default', '${at(3)}')`,
  ])
  console.log(`seeded ${slug} → ${sessionId}`)
}

seed({
  slug: "done-thread",
  sessionId: "d0e77e57-0000-4000-9000-00000000001a",
  title: "Fix the tier-boundary rounding",
  prompt: "Fix the tier-boundary rounding in the pricing parser and land it.",
})
seed({
  slug: "open-thread",
  sessionId: "0be77e57-0000-4000-9000-00000000002a",
  title: "Fix the tier-boundary rounding",
  prompt: "Fix the tier-boundary rounding in the pricing parser and land it.",
})

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
// Wait for the board to pick the rows up before archiving — setThreadState requires a registered session.
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  if (board.threads.some((t) => t.id === "done-thread")) break
  await new Promise((r) => setTimeout(r, 250))
}
await api.mutate("setThreadState", { slug: "done-thread", state: "archived" })
const board = await api.query("board")
console.log(JSON.stringify(board.threads
  .filter((t) => t.id === "done-thread" || t.id === "open-thread")
  .map((t) => ({ id: t.id, state: t.state, archived: t.archived, kind: t.kind, foreign: t.foreign, runtime: t.runtime }))))
