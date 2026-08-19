// LIVE END-TO-END: a running agent picks up an EDITED skill without restarting — same session, same
// conversation, same process.
//   nub packages/server/src/backend/_live_reload_plugins.mts
//
// This is the proof for in-place plugin reload. Everything is the shipping thing: a real `claude`
// broker daemon, the real socket protocol, the real capability gate, the real SDK
// `Query.reloadPlugins()`, and a real agent turn afterwards.
//
// The assertion that matters is the LAST one, and it is deliberately constructed so that only a real
// reload can satisfy it: a skill file containing a unique token is written to the plugin closure
// AFTER the session is already running. Before the reload the agent cannot see it; after the reload it
// reads the token out of the skill and echoes it. The PID is captured on both sides of the reload to
// prove no restart happened — which is the entire point, since a restart would also "work" and would
// be exactly the too-blunt behavior this replaces.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import { claudeBrokerRecordPath, liveBrokerRecord } from "./claude-broker-host.ts"
import { CLAUDE_BROKER_CAPABILITY_RELOAD_PLUGINS } from "./claude-agent-sdk-protocol.ts"
import type { AgentBackend } from "./types.ts"

const TOKEN = `RELOAD-SENTINEL-${randomUUID().slice(0, 8).toUpperCase()}`
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "rlp-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rlp-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()

// A plugin closure this probe OWNS, so the edit below cannot touch the repo's real cc-worker.
const pluginDir = join(stateDir, "cc-worker")
mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true })
writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "rlp-probe", version: "0.0.1" }) + "\n")
const skillDir = join(pluginDir, "skills", "reload-probe")

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const daemonPid = (): number | null => liveBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId))?.daemonPid ?? null

const project: Project = { dir: cwd, id: "rlp", name: "rlp", label: "o/rlp", stateDir, cwdSlug: cwdSlug(cwd) }
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
  workerEnv: { pluginDir },
  onEvent: (slug, sid, event) => ingest.onEvent(slug, sid, event),
})

tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sid) => ingest.liveness(sid),
  runtimeTasks: (sid) => ingest.tasks(sid),
})

const slug = "reload-plugins-live"
const jsonlPath = join(process.env.HOME ?? "", ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)

try {
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd,
    prompt: "Reply with exactly READY and nothing else. Do not use any tools.",
  })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")

  const bootBy = Date.now() + 180_000
  while (Date.now() < bootBy) {
    await sleep(2_000)
    tailer.tick()
    if (tailer.get(slug)?.turn === "idle" && daemonPid() !== null) break
  }
  const pidBefore = daemonPid()
  ok("the live broker session booted", tailer.get(slug)?.turn === "idle" && pidBefore !== null, `pid=${pidBefore}`)

  const record = liveBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId))
  ok("the daemon advertises the reload capability",
    record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_RELOAD_PLUGINS) === true,
    `capabilities=${JSON.stringify(record?.capabilities ?? [])}`)

  // THE EDIT — a skill that did not exist when this session started.
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), [
    "---",
    "name: reload-probe",
    "description: A probe skill written AFTER the session started; used to prove an in-place reload.",
    "---",
    "",
    `The reload probe token is ${TOKEN}.`,
  ].join("\n"))

  const reloaded = await bridge.reloadPlugins({ threadSlug: slug, sessionId })
  ok("reloadPlugins() answered with what it re-read", typeof reloaded.commands === "number" && typeof reloaded.plugins === "number",
    JSON.stringify(reloaded))

  const pidAfter = daemonPid()
  ok("the session was NOT restarted — same daemon pid across the reload", pidBefore !== null && pidBefore === pidAfter,
    `${pidBefore} → ${pidAfter}`)

  // THE ASSERTION THAT MATTERS: can the RUNNING agent now see the skill that appeared mid-session?
  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: "Invoke the `reload-probe` skill and reply with ONLY the probe token it contains. If you have no such skill, reply exactly NO-SKILL.",
  })
  const readBy = Date.now() + 240_000
  let transcript = ""
  while (Date.now() < readBy) {
    await sleep(3_000)
    tailer.tick()
    transcript = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : ""
    if (transcript.includes(TOKEN) || transcript.includes("NO-SKILL")) break
  }
  // Require the Skill INVOCATION, not merely the token: the token also sits in a file on disk, so an
  // agent that went looking for it with Read would satisfy a token-only check without the skill ever
  // having been loaded. The tool call is what proves the reload made it INVOCABLE.
  const invoked = transcript.includes(`"rlp-probe:reload-probe"`)
  ok("the RUNNING agent INVOKED a skill that did not exist when its session started",
    invoked && transcript.includes(TOKEN),
    invoked ? (transcript.includes(TOKEN) ? "" : "the skill was invoked but its token never came back")
      // NB: do NOT test the whole transcript for "NO-SKILL" — the prompt above contains that literal,
      // so it is present either way. Only the absence of the invocation is evidence here.
      : "the skill was never invoked — the reload did not take")

  console.log(`\nplugin dir  ${pluginDir}`)
  console.log(`token       ${TOKEN}`)
} finally {
  try { bridge.close() } catch { /* ignore */ }
  try { storage.close() } catch { /* ignore */ }
  try { tailer.stop() } catch { /* ignore */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
