// LIVE integration test: prove the worker token-budget reminder survives the BROKER/SDK spawn path,
// not just the tmux one.
//   nub packages/server/src/backend/_live_sdk_context_budget.mts
//
// WHY A SECOND HARNESS: scripts/verify-context-budget-env.mjs covers the tmux path
// (claudeWorkerEnvironment -> `tmux new-session -e` -> child). The broker path is a DIFFERENT chain
// with two extra gates that can silently drop a variable: the bridge's `workerEnv` map, and
// buildEnvironment()'s EXPLICIT_CLAUDE_ENV_KEYS allowlist, which THROWS on a key it does not know. It
// is also the path fray dispatches on by default, and the path both observed early-quit sessions ran
// on (`entrypoint: "sdk-ts"`). Asserting the tmux path and assuming this one is exactly the seam this
// harness exists to close.
//
// The reminder rides a tool-result batch, so the turn must force a tool call — a text-only turn
// produces no attachment and the check would pass or fail for the wrong reason. The control run
// repeats the identical turn with the variable removed.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import { CLAUDE_WORKER_CONTEXT_ENV } from "./types.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "fray-sdk-context-budget-"))
execFileSync("git", ["init", "-q", cwd])
const BLOCK = "<total_tokens>Infinite tokens left</total_tokens>"
const PROMPT = "Run exactly one Bash command: `echo hello`. Then reply DONE and stop."

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

// Mirror the broker's own env construction: ambient values it allowlists, plus the per-thread
// `workerEnv` overrides merged on top. See claude-agent-broker.ts and the bridge's `workerEnv`.
const AMBIENT = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
const ambient = Object.fromEntries(AMBIENT.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>

const reminderBlocks = (sessionId: string): { path?: string; blocks: string[]; toolUses: number } => {
  const projects = join(process.env.HOME!, ".claude", "projects")
  const path = readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((p) => existsSync(p))
  if (!path) return { blocks: [], toolUses: 0 }
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] }
  })
  const blocks = records.flatMap((r) => JSON.stringify(r.attachment ?? r.attachments ?? "").match(/<total_tokens>[^<]*<\/total_tokens>/g) ?? [])
  const toolUses = records.filter((r) => {
    const content = (r.message as { content?: unknown } | undefined)?.content
    return Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === "tool_use")
  }).length
  return { path, blocks, toolUses }
}

const runTurn = async (env: Record<string, string>): Promise<string> => {
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
  await handle.send({ id: randomUUID(), text: PROMPT })
  let timer: NodeJS.Timeout
  await Promise.race([done, new Promise<void>((_, rej) => { timer = setTimeout(() => rej(new Error("turn timeout")), 180_000) })]).finally(() => clearTimeout(timer!))
  await handle.close?.()
  await pump
  return sessionId
}

try {
  // No separate assertion for EXPLICIT_CLAUDE_ENV_KEYS: buildEnvironment THROWS on an unlisted key, so
  // the `with` run below cannot reach a result at all unless the allowlist accepted it. A standalone
  // check here would restate the constant rather than exercise the gate.
  for (const run of [
    { name: "with", label: "a broker-path worker SEES the token budget", env: { ...ambient, ...CLAUDE_WORKER_CONTEXT_ENV }, want: true },
    { name: "without", label: "the control run WITHOUT the variable sees no block", env: ambient, want: false },
  ]) {
    const sessionId = await runTurn(run.env)
    const { path, blocks, toolUses } = reminderBlocks(sessionId)
    ok(`the ${run.name} run actually issued a tool call (so an attachment batch existed)`, toolUses > 0, `tool_use records=${toolUses}`)
    ok(run.label, run.want ? blocks.includes(BLOCK) : blocks.length === 0, `blocks=${blocks.length ? [...new Set(blocks)].join(" ") : "<none>"}`)
    if (path) console.log(`   transcript: ${path}`)
  }
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
