// Seed a disposable adhoc stack with an EMPTY Active band and populated Done + Plans bands — the exact
// state that renders the Sidebar's "No active threads" placeholder next to its Done/Plans neighbours,
// which is the only way to judge that placeholder's left inset optically.
//
// Every seeded session is ARCHIVED and has NO live tmux pane, so groups.ts sectionOf() files all of
// them under "inactive" (Done) and Active stays empty. Plans come from the project's own .fray/plans.
//
// Usage: node scripts/seed-empty-active.mjs --home=/abs/temp-home
import { globSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-empty-active.mjs --home=/abs/temp-home")
  process.exit(1)
}

const db = globSync(join(home, ".fray/projects/*/ui.db"))[0]
if (!db) throw new Error(`no ui.db under ${home}/.fray/projects`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 90 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

const done = [
  { slug: "done-cache-key", sessionId: "1d0e5000-0000-4000-9000-000000000001", title: "Fix the resolver cache collision" },
  { slug: "done-queue-focus", sessionId: "1d0e5000-0000-4000-9000-000000000002", title: "Restore queue focus after archive" },
  { slug: "done-status-bar", sessionId: "1d0e5000-0000-4000-9000-000000000003", title: "Quota chips move into the status bar" },
]

for (const [i, s] of done.entries()) {
  const records = [
    { parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(i), session_id: s.sessionId, cwd, message: { role: "user", content: `TASK:\n${s.title}` } },
    { parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(i + 1), session_id: s.sessionId, cwd, message: { model: "claude-opus-5", id: `msg_${i}`, type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "```done\n- Landed it on `main`.\n```" }], usage: { input_tokens: 2, output_tokens: 40 } } },
  ]
  writeFileSync(join(jsonlDir, `${s.sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  // NO tmux pane on purpose: an archived-but-running session would be pulled back into Active.
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (slug, session_id, tmux_name, spawned_at, title, backend, model, effort, permission_mode, rested_at, archived, state, exited)
     VALUES ('${s.slug}', '${s.sessionId}', 'fray-${s.slug}', '${at(i)}', '${s.title}', 'claude', 'opus', 'high', 'default', '${at(i + 1)}', 1, 'archived', 1)`,
  ])
  console.log(`seeded ${s.slug} → done`)
}
