// LIVE integration test: prove CLAUDE_WORKER_ENV survives the BROKER/SDK spawn path and actually
// changes behavior there.
//   nub packages/server/src/backend/_live_sdk_worker_env.mts
//
// WHY THIS IS THE HARNESS THAT MATTERS: fray dispatches on the broker path by default, and both
// observed early-quit sessions ran on it (`entrypoint: "sdk-ts"`). It is also a DIFFERENT chain from
// tmux, with two extra gates that can silently drop a variable — the bridge's `workerEnv` map, and
// buildEnvironment()'s EXPLICIT_CLAUDE_ENV_KEYS allowlist, which THROWS on a key it does not know.
//
// It asserts only what it can actually demonstrate — see the NOT ASSERTED note below for the
// Bash-timeout half, which no harness on this machine reproduces.
//
// Each check is paired with the same run WITHOUT the variable. A green result with no failing control
// is not evidence.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import { CLAUDE_WORKER_ENV } from "./types.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "fray-sdk-worker-env-"))
execFileSync("git", ["init", "-q", cwd])
const BLOCK = "<total_tokens>Infinite tokens left</total_tokens>"
const BASH_TIMEOUT_KEY = "BASH_DEFAULT_TIMEOUT_MS"

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

// Mirror the broker's own env construction: ambient values it allowlists, plus the per-thread
// `workerEnv` overrides merged on top. See claude-agent-broker.ts and the bridge's `workerEnv`.
const AMBIENT = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
const ambient = Object.fromEntries(AMBIENT.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>

type Rec = Record<string, any>
const recordsFor = (sessionId: string): { path?: string; records: Rec[] } => {
  const projects = join(process.env.HOME!, ".claude", "projects")
  const path = readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((p) => existsSync(p))
  if (!path) return { records: [] }
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Rec] } catch { return [] }
  })
  return { path, records }
}
const reminderBlocks = (records: Rec[]) => records.flatMap((r) =>
  JSON.stringify(r.attachment ?? r.attachments ?? "").match(/<total_tokens>[^<]*<\/total_tokens>/g) ?? [])
const blocksOfType = (records: Rec[], type: string, name?: string) => records.flatMap((r) => {
  const content = r.message?.content
  return Array.isArray(content) ? content.filter((b: Rec) => b?.type === type && (name === undefined || b.name === name)) : []
})
const runTurn = async (env: Record<string, string>, prompt: string, ms = 300_000): Promise<string> => {
  const sessionId = randomUUID()
  const handle = createClaudeQueryFactory({ enabled: true, executablePath: claudeBin }).start({
    cwd, session: { kind: "new", sessionId }, permissionMode: "default", env,
    persistSession: true, // the reminder is an ATTACHMENT; only the transcript carries it
    canUseTool: async () => ({ behavior: "allow" }),
  })
  let resolveTurn: () => void = () => {}
  const done = new Promise<void>((r) => { resolveTurn = r })
  const pump = (async () => {
    try {
      for await (const ev of handle as AsyncIterable<ClaudeQueryEvent>) if (ev.kind === "result") resolveTurn()
    } catch { /* the harness asserts on the transcript, not on stream teardown */ }
  })()
  await handle.send({ id: randomUUID(), text: prompt })
  let timer: NodeJS.Timeout
  await Promise.race([done, new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error("turn timeout")), ms) })]).finally(() => clearTimeout(timer!))
  await handle.close?.()
  await pump
  return sessionId
}

try {
  // No separate assertion for EXPLICIT_CLAUDE_ENV_KEYS: buildEnvironment THROWS on an unlisted key, so
  // the `with` runs below cannot reach a result at all unless the allowlist accepted every key.

  // ---- A. The token budget reaches the model ----------------------------------------------------
  // The reminder rides a tool-result batch, so the turn must force a tool call. Each control drops
  // ONLY the variable under test, keeping the other one, so the two checks stay independent.
  const budgetPrompt = "Run exactly one Bash command: echo hello. Then reply DONE and stop."
  for (const run of [
    { name: "budget-with", label: "a broker-path worker SEES the token budget", env: { ...ambient, ...CLAUDE_WORKER_ENV }, want: true },
    { name: "budget-without", label: "the control WITHOUT the variable sees no block", env: { ...ambient, [BASH_TIMEOUT_KEY]: CLAUDE_WORKER_ENV[BASH_TIMEOUT_KEY] }, want: false },
  ]) {
    const { path, records } = recordsFor(await runTurn(run.env, budgetPrompt, 180_000))
    const blocks = reminderBlocks(records)
    ok(`${run.name}: a tool call actually ran (so an attachment batch existed)`, blocksOfType(records, "tool_use").length > 0)
    ok(run.label, run.want ? blocks.includes(BLOCK) : blocks.length === 0, `blocks=${blocks.length ? [...new Set(blocks)].join(" ") : "<none>"}`)
    if (path) console.log(`   transcript: ${path}`)
  }

  // NOT ASSERTED: that BASH_DEFAULT_TIMEOUT_MS changes behavior. Section A proves it reaches the
  // child; its EFFECT could not be reproduced in ANY harness. Measured, not assumed: a 150s command
  // completes in the turn at the 120s default under both `claude -p` (tmux harness) and a raw SDK
  // session here, so neither surface cuts it off and a check would pass identically with and without
  // the variable. Real fray workers ARE bounced ("Command did not complete within its 120s timeout and
  // was moved to the background"), and no CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS is set anywhere on
  // this machine — so the trigger is something these harnesses do not reproduce and the mechanism is
  // not fully characterized. The evidence for the raised value is a real dispatch on the promoted
  // artifact; see the commit. Do not add a check here without a control that actually fails.

} finally {
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
