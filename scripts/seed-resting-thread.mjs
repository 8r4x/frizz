// Seed a disposable adhoc stack with SIMULATED workers that are AT REST while their own dispatched
// work is still live — the exact state board.deriveAwaitingBackground selects — so the resting card can
// be judged on all three surfaces in the REAL app: real tailer, real board derivation, real push, real
// browser. A fixture page proves the component; only this proves the SERVER actually sets
// `awaitingBackground` and that the drawer / full-screen page read it.
//
// Two threads, because the card's sentence has to be true in more than one shape:
//   resting-both   — a live sub-agent AND a live background shell (the "and" case)
//   resting-shell  — a background shell only (must NOT claim a sub-agent)
//
// Follows the adhoc-cdp recipe: a session row + a live dummy tmux pane + a JSONL the tailer reads.
// Usage: node scripts/seed-resting-thread.mjs --home=/abs/temp-home --socket=fray-adhoc-NNNN-PID
import { execFileSync } from "node:child_process"
import { globSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, socket, cwd = process.cwd() } = flags
if (!home || !socket) {
  console.error("usage: node seed-resting-thread.mjs --home=/abs/temp-home --socket=<tmux-socket>")
  process.exit(1)
}

const db = globSync(join(home, ".fray/projects/*/ui.db"))[0]
if (!db) throw new Error(`no ui.db under ${home}/.fray/projects`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 25 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`

function seed({ slug, sessionId, title, prompt, dispatches, closing }) {
  const tmuxName = `fray-${slug}`
  const assistant = (id, ts, content, stop) => ({
    parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: ts, session_id: sessionId, cwd,
    message: { model: "claude-opus-5", id, type: "message", role: "assistant", stop_reason: stop, content, usage: { input_tokens: 2, output_tokens: 60 } },
  })
  const toolResult = (toolUseId, text, ts) => ({
    parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: ts, session_id: sessionId, cwd,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] },
  })
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(0), session_id: sessionId, cwd,
      message: { role: "user", content: `TASK:\n${prompt}` },
    },
    assistant("msg_dispatch", at(1), dispatches.map((d) => ({ type: "tool_use", name: d.tool, id: d.id, input: d.input })), "tool_use"),
    // The launch ACKs. Deliberately the path-LESS and agentId-LESS ack wordings: launchOutputFile()
    // synthesizes a `subagents/agent-<agentId>.jsonl` path from an agentId, and entryStale() then stats
    // that nonexistent file and reports the child "stale". With neither token there is no outputFile,
    // so these children stay "running" for as long as the stack lives.
    ...dispatches.map((d) => toolResult(d.id, d.ack, at(1))),
    // …and then the parent comes to REST with those children still running. `end_turn` is what makes
    // deriveRuntime say turn-idle, which is the whole precondition for the card.
    assistant("msg_rest", at(2), [{ type: "text", text: closing }], "end_turn"),
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  try {
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", tmuxName, "sleep 7200"], { stdio: "ignore" })
  } catch { /* already up */ }
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (slug, session_id, tmux_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES ('${slug}', '${sessionId}', '${tmuxName}', '${at(0)}', '${title}', 'claude', 'opus', 'high', 'default', '${at(2)}')`,
  ])
  console.log(`seeded ${slug} → ${sessionId}`)
}

seed({
  slug: "resting-both",
  sessionId: "8e577e57-0000-4000-9000-00000000001a",
  title: "Refactor the pricing parser",
  prompt: "Refactor the pricing parser and verify it end-to-end.",
  closing: "Audit dispatched and the dev server is up. I'll fold the findings in when the sub-agent reports back.",
  dispatches: [
    {
      tool: "Agent", id: "toolu_rest_agent", ack: "Async agent launched successfully",
      input: { description: "Audit the pricing parser for tier-boundary rounding", prompt: "Audit it.", run_in_background: true, subagent_type: "fray:opus-high" },
    },
    {
      tool: "Bash", id: "toolu_rest_shell", ack: "Command running in background",
      input: { command: "pnpm --filter web dev --host", description: "Start vite from the web package dir", run_in_background: true },
    },
  ],
})

seed({
  slug: "resting-shell",
  sessionId: "8e577e57-0000-4000-9000-00000000001b",
  title: "Watch the release build",
  prompt: "Kick off the release build and keep an eye on it.",
  closing: "Build is running in the background. Nothing to decide yet.",
  dispatches: [
    {
      tool: "Bash", id: "toolu_rest_shell_only", ack: "Command running in background",
      input: { command: "pnpm build --watch", description: "Build the release artifact", run_in_background: true },
    },
  ],
})
