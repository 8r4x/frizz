// Seed an adhoc stack (scripts/adhoc-stack.mjs) with a realistic board: N simulated Claude workers
// (real tmux panes on the sandbox socket, real session rows, real JSONL transcripts) so a board-scale
// behavior — steering latency, board-refresh cost, rail rendering — can be exercised against something
// that looks like a working operator's board rather than one empty thread. Pairs with steer-stack.sh,
// which boots the stack and calls this. Kept in-tree because "the board is slow" recurs and reproducing
// it needs a populated board.
//
//   node scripts/seed-steer.mjs <tempHome> <tmuxSocket> <projectDir> [count=25]
import { mkdirSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

const [home, socket, projectDir, countArg] = process.argv.slice(2)
const count = Number(countArg ?? 25)
if (!home || !socket || !projectDir) {
  console.error("usage: node seed-steer.mjs <tempHome> <tmuxSocket> <projectDir> [count]")
  process.exit(1)
}

const projRoot = join(home, ".fray", "projects")
const projId = readdirSync(projRoot)[0]
const db = join(projRoot, projId, "ui.db")
const cwdSlug = projectDir.replace(/\//g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = Date.now()
const ts = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString()

const sql = []
for (let i = 0; i < count; i++) {
  const slug = i === 0 ? "steer-demo" : `worker-${i}`
  const sessionId = `${String(i).padStart(8, "0")}-2222-3333-4444-555555555555`
  const title = i === 0 ? "Steering latency demo" : `Worker thread ${i}`

  const rows = [
    { type: "user", timestamp: ts(600), message: { content: `Task ${i}: refactor the pricing table so the tiers line up on narrow viewports.` } },
  ]
  // A realistic tail: a long run of tool calls interleaved with prose, like a worker mid-effort.
  const depth = i === 0 ? 3 : 30
  for (let k = 0; k < depth; k++) {
    rows.push({ type: "assistant", timestamp: ts(590 - k * 10), message: { id: `t${k}`, content: [{ type: "tool_use", name: "Read", input: { file_path: `/src/component-${k}.tsx` } }] } })
    rows.push({ type: "assistant", timestamp: ts(589 - k * 10), message: { id: `x${k}`, content: [{ type: "text", text: `Checked component ${k} — the spacing scale is consistent there.` }] } })
  }
  rows.push({
    type: "assistant",
    timestamp: ts(20),
    message: { id: "z", content: [{ type: "text", text: i === 0 ? "Done — the tiers now wrap cleanly at 420px and the CTA stays optically centered." : `Finished task ${i}.` }], stop_reason: "end_turn" },
  })
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n")

  try {
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", `fray-${slug}`, "sleep 7200"], { stdio: "ignore" })
  } catch {}
  sql.push(
    `INSERT OR REPLACE INTO session (slug, session_id, tmux_name, spawned_at, title, backend, model, effort, permission_mode, state) ` +
    `VALUES ('${slug}','${sessionId}','fray-${slug}','${ts(700)}','${title}','claude','opus','high','default','active');`,
  )
}
execFileSync("sqlite3", [db, sql.join("\n")], { stdio: "inherit" })
console.log(JSON.stringify({ seeded: count, db, jsonlDir }))
