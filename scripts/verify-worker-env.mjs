// Verifies END TO END that CLAUDE_WORKER_ENV reaches a real frizz Claude worker and actually changes
// Claude Code's behavior — through the REAL spawn path, against the REAL binary, with REAL failing
// controls. Covers the tmux path; `packages/server/src/backend/_live_sdk_worker_env.mts` is the
// broker/SDK twin.
//
//   nub scripts/verify-worker-env.mjs
//
// The seam a unit test cannot see is the whole chain: claudeWorkerEnvironment() -> BuiltCommand.env ->
// tmux `new-session -e` -> the child's real environment -> Claude Code's own consumers. So this reads
// the env of a REAL tmux-spawned process, then makes REAL claude runs prove each variable BITES —
// each paired with the same run WITHOUT it, because a green result with no failing control is not
// evidence. See CLAUDE_WORKER_ENV in backend/types.ts for why each variable is set.
//
// Everything runs on a UNIQUE tmux socket, so it can never touch the maintainer's live frizz panes.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setSocket, spawn, socketName } from "../packages/server/src/tmux.ts"
import { createClaudeBackend } from "../packages/server/src/backend/claude.ts"
import { CLAUDE_WORKER_ENV } from "../packages/server/src/backend/types.ts"

const SOCKET = `frizzvenv${process.pid}`
const work = mkdtempSync(join(tmpdir(), "frizz-worker-env-"))
const REMINDER_KEY = "CLAUDE_CODE_TOTAL_TOKENS_REMINDER"
const BLOCK = "<total_tokens>Infinite tokens left</total_tokens>"

let failures = 0
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const tmux = (...args) => execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" })
const waitFor = (predicate, ms, label) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    execFileSync("sleep", ["1"])
  }
  console.log(`   (timed out after ${ms}ms waiting for ${label})`)
  return false
}

const transcriptFor = (sessionId) => {
  const projects = join(process.env.HOME, ".claude", "projects")
  return readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((p) => existsSync(p))
}
// Read the transcript Claude Code wrote for this exact session rather than parsing stdout: neither
// attachments nor tool results appear there.
const recordsFor = (sessionId) => {
  const path = transcriptFor(sessionId)
  if (!path) return { path: undefined, records: [] }
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  return { path, records }
}
const reminderBlocks = (records) => records.flatMap((r) =>
  JSON.stringify(r.attachment ?? r.attachments ?? "").match(/<total_tokens>[^<]*<\/total_tokens>/g) ?? [])
const toolUseCount = (records) => records.filter((r) => {
  const content = r.message?.content
  return Array.isArray(content) && content.some((b) => b?.type === "tool_use")
}).length
// Run a real `claude -p` turn in a tmux pane under `env`, and return its transcript records.
const runClaude = (name, env, prompt, tools, waitMs) => {
  const sessionId = randomUUID()
  const done = join(work, `claude-${name}.done`)
  spawn(`worker-env-${name}`, ["/bin/sh", "-c",
    `claude -p ${JSON.stringify(prompt)} --model haiku --allowedTools ${tools} --session-id ${sessionId} `
    + `> ${join(work, `claude-${name}.out`)} 2>&1; echo finished > ${done}`,
  ], work, env, {})
  const finished = waitFor(() => existsSync(done), waitMs, `the real claude run (${name})`)
  return finished ? recordsFor(sessionId) : { path: undefined, records: [] }
}

setSocket(SOCKET)
const backend = createClaudeBackend({ logDir: work, claudeBin: "claude" })

try {
  console.log(`socket=${socketName()} work=${work}\n`)

  // ---- A. Everything frizz builds lands in a real child process's environment ---------------------
  const built = backend.buildSpawn({
    sessionId: randomUUID(), cwd: work, prompt: "noop", workerContract: "", permissionMode: "acceptEdits",
  })
  const envDump = join(work, "child-env.txt")
  spawn("worker-env-a", ["/bin/sh", "-c", `env > ${envDump}; sleep 30`], work, built.env, {})
  const dumped = waitFor(() => existsSync(envDump), 20000, "child env dump")
  const childEnv = dumped ? readFileSync(envDump, "utf8").split("\n") : []
  for (const [key, want] of Object.entries(CLAUDE_WORKER_ENV)) {
    const line = childEnv.find((l) => l.startsWith(`${key}=`))
    check(`the spawned child's REAL environment carries ${key}`, line === `${key}=${want}`, `got ${line ?? "<absent>"}`)
  }
  // Negative control on the record itself: the pre-existing entries must survive the new ones.
  check(
    "the existing worker environment still reaches the child",
    childEnv.includes("CLAUDE_CODE_SUBAGENT_MODEL="),
    childEnv.find((l) => l.startsWith("CLAUDE_CODE_SUBAGENT_MODEL")) ?? "<absent>",
  )

  // ---- B. The token budget actually reaches the model -------------------------------------------
  // The reminder rides a tool-result batch, so the prompt must force a tool call; a text-only turn
  // produces no attachment and the check would pass or fail for the wrong reason.
  // NO BACKTICKS in any prompt: the whole claude invocation runs through `sh -c`, and JSON.stringify
  // yields a DOUBLE-quoted string, inside which the shell still performs command substitution. An
  // earlier version wrapped the command in backticks and the shell executed it before claude ever ran,
  // handing the model the command's OUTPUT as its instruction. Both runs then "passed" having measured
  // nothing. _live_sdk_worker_env.mts guards against that class of bug with explicit preconditions.
  const budgetPrompt = "Run exactly one Bash command: echo hello. Then reply DONE and stop."
  for (const run of [
    { name: "budget-with", label: "a worker spawned by frizz SEES the token budget", env: built.env, want: true },
    // Byte-identical prompt and flags, the variable REMOVED. Without this a pass proves nothing —
    // the binary could have been emitting the block on its own all along.
    { name: "budget-without", label: "the control WITHOUT the variable sees no block", env: { ...built.env, [REMINDER_KEY]: "" }, want: false },
  ]) {
    const { path, records } = runClaude(run.name, run.env, budgetPrompt, "Bash", 180000)
    const blocks = reminderBlocks(records)
    check(`${run.name}: a tool call actually ran (so an attachment batch existed)`, toolUseCount(records) > 0, `tool_use records=${toolUseCount(records)}`)
    check(run.label, run.want ? blocks.includes(BLOCK) : blocks.length === 0, `blocks=${blocks.length ? [...new Set(blocks)].join(" ") : "<none>"}`)
    if (path) console.log(`   transcript: ${path}`)
  }

  // NOT ASSERTED HERE: that BASH_DEFAULT_TIMEOUT_MS changes behavior. It is carried to the child
  // (section A) but its EFFECT is not observable on this surface — measured, not assumed: a 150s
  // command completes under `claude -p` at the 120s default, so print mode does not cut it off and a
  // check here would pass identically with and without the variable. The behavioral assertion lives
  // in _live_sdk_worker_env.mts, against the streaming session a real worker actually runs as.
} finally {
  // Scoped to THIS harness's own socket — never a broad kill that could reap a live frizz worker.
  try { tmux("kill-server") } catch {}
  rmSync(work, { recursive: true, force: true })
  console.log(`\ncleanup: killed tmux server on ${SOCKET}, removed ${work}`)
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
