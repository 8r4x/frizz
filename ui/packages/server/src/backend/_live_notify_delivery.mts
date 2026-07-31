// LIVE REPRO: does a background sub-agent's completion <task-notification> actually REACH the model?
//   nub packages/server/src/backend/_live_notify_delivery.mts [fleetSize] [replyChars]
//
// THE REPORT (2026-07-30, measured on the operator's own corpus): across two real threads, ~33% of
// `status=completed` sub-agent notifications were enqueued into Claude Code's queue and then removed
// WITHOUT ever materializing into the model's context — no user record, no `queued_command`
// attachment, nothing. 39/117 on one thread. Those were finished review reports (3k–24k chars of real
// verdicts) that the orchestrator never read, while fray's timeline rendered no completion at all.
//
// Size was the obvious suspect and is NOT the mechanism: 3,318 chars was dropped while 12,299 was
// delivered. What the corpus DOES show is that drops arrive in BATCHES — several ids removed at one
// identical timestamp — which points at CONCURRENCY, not payload size. So this harness reproduces the
// real-world shape rather than a size sweep: a FLEET of background children finishing at roughly the
// same moment while the parent is deliberately held BUSY in the foreground, so every completion has to
// sit in the queue before it can be delivered.
//
// It prints the RAW per-notification ledger first. Read the dump; the PASS/FAIL lines are a summary.
//
// Classification, straight off the session JSONL (the same three carriers transcript.ts reads):
//   DELIVERED — the task-id appears in a `user` record or a `queued_command` attachment.
//   DROPPED   — the task-id appears ONLY in queue-operation records (enqueue/remove/dequeue).
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"

const FLEET = Number(process.argv[2] ?? 5)
const CHARS = Number(process.argv[3] ?? 8000)
const HOLD_S = Number(process.argv[4] ?? 150)
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bnotif-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bnotif-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const jsonlPath = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const project: Project = { dir: cwd, id: "notif", name: "notif", label: "o/notif", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"))
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })
let results = 0
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]!]),
  ),
  onEvent: (slug, sid, event) => {
    if (event.kind === "result") results++
    ingest.onEvent(slug, sid, event)
  },
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false, capturePane: () => "",
  runtimeLiveness: (sid) => ingest.liveness(sid),
  runtimeTasks: (sid) => ingest.tasks(sid),
})

const slug = "notify-delivery-live"

// The workload. Every child does the SAME trivial thing and returns a payload of a known size, so the
// only variable that matters is that they all land at once. The foreground sleep is what forces the
// completions to queue instead of being handed straight to an idle parent — that is the shape the
// corpus drops.
const PROMPT = [
  `Dispatch ${FLEET} background sub-agents AT ONCE using the Agent tool with run_in_background set to true.`,
  `Give each a short description like "payload probe N".`,
  `Each one's task is exactly: run this Bash command`,
  `    printf 'y%.0s' $(seq 1 ${CHARS})`,
  `and then reply with the FULL output of that command and nothing else.`,
  ``,
  `IMPORTANT: immediately after dispatching all ${FLEET}, and WITHOUT waiting for any of them, run this`,
  `EXACT command in the FOREGROUND with Bash (timeout 200000):`,
  `    end=$(( $(date +%s) + ${HOLD_S} )); until [ $(date +%s) -ge $end ]; do sleep 2; done; echo HELD`,
  `Then reply with exactly FLEET-DISPATCHED.`,
].join("\n")
// The hold is load-bearing and it is NOT a stylistic choice. A background child is torn down when the
// parent's turn ends, so a parent that rests immediately after dispatching kills its own fleet before
// any of them can notify — the first run of this harness did exactly that (5 children truncated at
// 5–10 records, ZERO notifications) and would have been read as a 100% drop rate when it was really
// just a dead harness. The parent must stay inside one turn until the fleet finishes.
//
// It is written as an until-loop rather than `sleep ${HOLD_S}` because a user-level PreToolUse hook on
// this machine BLOCKS a standalone sleep ("Blocked: standalone sleep 100 … use Monitor with an
// until-loop"), which is what silently ended that first run's turn.

try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: PROMPT })
  storage.upsertSession({
    slug, session_id: sessionId, tmux_name: `fray-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  tailer.tick()

  // Run until the transcript stops growing well past the last completion, so a late delivery is not
  // mistaken for a drop. Never a fixed sleep: the settle window is what makes DROPPED trustworthy.
  const deadline = Date.now() + 600_000
  let lastSize = -1
  let stableFor = 0
  while (Date.now() < deadline) {
    await sleep(3_000)
    tailer.tick()
    const size = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8").length : 0
    stableFor = size === lastSize ? stableFor + 3 : 0
    lastSize = size
    const notifs = countNotifications()
    process.stdout.write(`\r  t+${Math.round((Date.now() - (deadline - 600_000)) / 1000)}s  jsonl=${size}B  notifications=${notifs}  stable=${stableFor}s   `)
    if (notifs >= FLEET && stableFor >= 45) break
  }
  console.log("\n")

  report()
} finally {
  try { bridge.close() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

function records(): Array<Record<string, unknown>> {
  if (!existsSync(jsonlPath)) return []
  const out: Array<Record<string, unknown>> = []
  for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as Record<string, unknown>) } catch { /* partial tail */ }
  }
  return out
}

// A hoisted declaration, not a `const` arrow: the watch loop above runs during module evaluation and
// calls this the moment the first notification lands, which is BEFORE a `const` below it initializes.
function taskIds(s: string): string[] {
  return [...s.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1])
}

/** Every child's own transcript, and whether it actually reached a terminal turn. */
function childTranscripts(): Array<{ id: string; records: number; endTurn: boolean }> {
  const dir = join(jsonlPath.replace(/\.jsonl$/, ""), "subagents")
  if (!existsSync(dir)) return []
  const out: Array<{ id: string; records: number; endTurn: boolean }> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue
    const lines = readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim())
    let endTurn = false
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as { message?: { stop_reason?: string } }
        if (r.message?.stop_reason === "end_turn") endTurn = true
      } catch { /* partial */ }
    }
    out.push({ id: name.replace(/^agent-|\.jsonl$/g, ""), records: lines.length, endTurn })
  }
  return out
}

function countNotifications(): number {
  const seen = new Set<string>()
  for (const r of records()) {
    if (r.type === "queue-operation" && typeof r.content === "string" && r.content.includes("<task-notification>"))
      for (const id of taskIds(r.content)) seen.add(id)
  }
  return seen.size
}

function report(): void {
  interface Row { id: string; chars: number; status: string; ops: string[]; carriers: string[] }
  const rows = new Map<string, Row>()
  for (const r of records()) {
    const ts = typeof r.timestamp === "string" ? r.timestamp.slice(11, 23) : "-"
    if (r.type === "queue-operation" && typeof r.content === "string" && r.content.includes("<task-notification>")) {
      for (const id of taskIds(r.content)) {
        if (!rows.has(id)) {
          const res = /<result>([\s\S]*?)<\/result>/.exec(r.content)
          const st = /<status>([^<]*)</.exec(r.content)
          rows.set(id, { id, chars: res ? res[1].length : 0, status: st ? st[1] : "(none)", ops: [], carriers: [] })
        }
        rows.get(id)!.ops.push(`${String(r.operation)}@${ts}`)
      }
    }
    // The two carriers that put a notification into the MODEL's context.
    let body = ""
    if (r.type === "user") {
      const c = (r.message as Record<string, unknown> | undefined)?.content
      body = typeof c === "string" ? c : JSON.stringify(c ?? "")
    } else if (r.type === "attachment") {
      body = JSON.stringify(r.attachment ?? "")
    }
    if (body.includes("<task-notification>"))
      for (const id of taskIds(body)) rows.get(id)?.carriers.push(`${String(r.type)}@${ts}`)
  }

  const all = [...rows.values()]
  const dropped = all.filter((r) => r.carriers.length === 0)
  console.log("── raw per-notification ledger ──────────────────────────────────────────────────")
  for (const r of all)
    console.log(
      `  ${(r.carriers.length ? "DELIVERED" : "DROPPED  ")}  ${r.id.padEnd(19)} ${String(r.chars).padStart(6)}ch  ${r.status.padEnd(9)}` +
        `  ops=[${r.ops.join(" ")}]  carriers=[${r.carriers.join(" ")}]`,
    )
  console.log("")
  console.log(`fleet requested   ${FLEET}   payload ${CHARS} chars each`)
  console.log(`notifications     ${all.length}`)
  console.log(`delivered         ${all.length - dropped.length}`)
  console.log(`DROPPED           ${dropped.length}`)
  console.log(`session jsonl     ${jsonlPath}`)
  console.log("")
  // HARNESS SELF-CHECK, and it comes FIRST because without it this probe reports a dead run as a
  // perfect 100% drop rate. Run 1 did exactly that: the parent's `sleep` was hook-blocked, its turn
  // ended, every child was torn down at 5–10 records, and "0 delivered / 0 notifications" looked like
  // catastrophic loss when nothing had actually completed. A child that never reached `end_turn` had
  // no report to lose, so its silence is evidence about the HARNESS, not about delivery.
  const kids = childTranscripts()
  const finished = kids.filter((k) => k.endTurn).length
  ok("HARNESS VALID: the fleet ran to completion (children reached end_turn)", kids.length > 0 && finished === kids.length,
    `${finished}/${kids.length} children finished — a truncated child proves nothing about delivery`)
  ok("every completion notification reached the model", dropped.length === 0,
    `${dropped.length}/${all.length} dropped: ${dropped.map((d) => d.id).join(", ")}`)
  ok("the fleet actually ran (notifications observed)", all.length > 0, `${all.length} seen`)
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}  (results=${results})`)
}
