// LIVE END-TO-END: a worker heartbeat wakes a REAL resting agent WHILE ITS BACKGROUND SHELL IS STILL
// RUNNING — the exact case Claude Code's own in-session cron cannot serve.
//   nub packages/server/src/backend/_live_heartbeat.mts
//
// This is the proof for the heartbeat feature, and the background shell is the whole point of it.
// Measured 2026-08-01 against a headless `claude` (the runtime fray spawns), one session, everything
// else constant: an every-minute `CronCreate` job fired 3 times in 150s with no background work and
// 0 times with a background shell alive. The headless run does not end when the turn ends — it spins a
// drain loop while any background task is outstanding — and the cron gate reads the busy flag that
// loop holds. So the thread parked behind a sub-agent that will never report is precisely the one its
// own scheduler cannot rescue. This probe runs the same shape through fray's outbox instead.
//
// Everything in the chain is the shipping thing: real `claude` broker session → real tailer fold →
// real scheduler pass → real broker followUp → real agent turn.
//
// WHAT IS SIMULATED, AND WHY THAT IS THE RIGHT LINE. The heartbeat is armed by writing the session row
// directly (storage.setHeartbeat) rather than by the agent calling `mcp__fray__heartbeat`, and
// `armed_at` is backdated so the first beat is due at once instead of a minute in. The tool → RPC half
// of the chain is covered for real in fray-mcp.test.ts (real stdio transport, real HTTP server,
// asserting the calling thread's slug reaches the request body); what only a live run can prove is the
// half below — that a beat reaches a resting agent whose background work is still outstanding, and
// that the agent ACTS on it.
//
// The assertion that matters is the last one: not "fray sent a message" but "the agent did the thing
// the beat asked for, while the shell was still running".
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { createScheduler } from "../scheduler.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"

// A token the agent can only produce by acting on the BEAT. Nothing else in the session mentions it.
const SENTINEL = `BEAT-SENTINEL-${randomUUID().slice(0, 8).toUpperCase()}`

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "hbeat-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hbeat-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const beatPath = join(cwd, "beat.txt")
const shellLog = join(cwd, "bg.log")

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** How many heartbeats the background shell has written — its liveness, read from outside the agent. */
const shellTicks = (): number =>
  existsSync(shellLog) ? readFileSync(shellLog, "utf8").trim().split("\n").filter(Boolean).length : 0

const project: Project = { dir: cwd, id: "hb", name: "hb", label: "o/hb", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"))
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
      .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
  ),
  onEvent: (slug, sid, event) => ingest.onEvent(slug, sid, event),
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false, capturePane: () => "",
  runtimeLiveness: (sid) => ingest.liveness(sid),
  runtimeTasks: (sid) => ingest.tasks(sid),
})

const slug = "heartbeat-live"
const delivered: string[] = []
const scheduler = createScheduler({
  storage, tailer,
  resume: async (s, message) => {
    delivered.push(message)
    await bridge.followUp({ threadSlug: s, sessionId, cwd, text: message })
  },
  log: (m) => console.log(`    ${m}`),
})

const BEAT_PROMPT =
  `Run exactly this one bash command and then stop, saying nothing else: printf '%s\\n' ${SENTINEL} >> ${beatPath}`

try {
  // Turn 1: launch a long background shell, then come to rest with it still running. This is the
  // state that silences Claude Code's own cron.
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd,
    prompt:
      "Do exactly these two steps and nothing else. 1. Call Bash with run_in_background set to TRUE and " +
      `this command: for i in $(seq 1 200); do date +%s >> ${shellLog}; sleep 3; done  ` +
      "2. Reply with exactly READY. Do not check on the background shell, do not run anything else.",
  })
  storage.upsertSession({
    slug, session_id: sessionId, tmux_name: `fray-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")

  const bootBy = Date.now() + 180_000
  while (Date.now() < bootBy) {
    await sleep(2_000)
    tailer.tick()
    if (tailer.get(slug)?.turn === "idle" && shellTicks() > 0) break
  }
  ok("the live session booted, started its background shell and came to rest",
    tailer.get(slug)?.turn === "idle" && shellTicks() > 0,
    `turn=${tailer.get(slug)?.turn} shellTicks=${shellTicks()}`)

  const ticksBeforeBeat = shellTicks()

  // Arm the heartbeat, backdated so the first beat is due immediately (see the header note). The
  // interval is the shipping floor, so nothing here exercises a cadence the product cannot produce.
  storage.setHeartbeat(slug, BEAT_PROMPT, 60_000, new Date(Date.now() - 120_000).toISOString())

  // The real scheduler pass: due → enqueue → deliver over the real broker.
  await scheduler.tick()
  await sleep(1_000)
  await scheduler.tick()
  ok("the scheduler DELIVERED the beat verbatim", delivered.some((m) => m.includes(SENTINEL)),
    delivered.length ? JSON.stringify(delivered[0].slice(0, 120)) : "nothing delivered")

  // THE ASSERTION THAT MATTERS: the agent acted on the beat — and the shell was alive the whole time.
  const actedBy = Date.now() + 240_000
  while (Date.now() < actedBy) {
    await sleep(3_000)
    tailer.tick()
    if (existsSync(beatPath) && readFileSync(beatPath, "utf8").includes(SENTINEL)) break
  }
  const acted = existsSync(beatPath) && readFileSync(beatPath, "utf8").includes(SENTINEL)
  ok("the AGENT acted on the beat", acted, `beat file: ${existsSync(beatPath) ? "written" : "absent"}`)
  ok("…and its background shell was STILL RUNNING throughout — the case Claude Code's cron cannot serve",
    shellTicks() > ticksBeforeBeat,
    `shell ticks ${ticksBeforeBeat} → ${shellTicks()}`)

  // At most ONE beat outstanding: ticking again before the interval has elapsed since the DELIVERED
  // beat must not stack a second nudge onto a thread that just got one.
  const afterFirst = delivered.length
  await scheduler.tick()
  await sleep(500)
  await scheduler.tick()
  ok("no SECOND beat is queued before the interval elapses", delivered.length === afterFirst,
    `${delivered.length - afterFirst} extra`)

  // Pause drops a pending beat rather than banking it: arm the next beat as due, pause, and confirm
  // nothing is delivered.
  storage.setHeartbeat(slug, BEAT_PROMPT, 60_000, new Date(Date.now() - 120_000).toISOString())
  storage.setHeartbeatPausedIfCurrent(slug, sessionId, 0, true)
  const beforePause = delivered.length
  await scheduler.tick()
  await sleep(500)
  await scheduler.tick()
  ok("a PAUSED heartbeat delivers nothing", delivered.length === beforePause,
    `${delivered.length - beforePause} delivered while paused`)

  console.log(`\nrepo        ${cwd}`)
  console.log(`beat file   ${beatPath}`)
  console.log(`sentinel    ${SENTINEL}`)
} finally {
  try { await scheduler.stop() } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
