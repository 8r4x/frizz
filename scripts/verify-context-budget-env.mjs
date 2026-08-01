// Verifies END TO END that a fray Claude worker is TOLD its token budget — through the REAL spawn
// path, against the REAL claude binary, with a REAL failing control.
//
// WHY THIS EXISTS: Claude Code injects nothing at all about remaining context (no system-reminder in
// 2.1.220 mentions tokens; "Context is N% full" is `/context` TUI text the model never sees). Given no
// signal, workers GUESS, and they guess downward — nub session 5258ebe4 wrote "I'm near my context
// limit, so I'm not starting the linker change here" at a live fill of 667,277 tokens against
// auto-compact boundaries that fired at ~1,000,000. `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=infinite` is the
// harness-native answer: it emits `<total_tokens>Infinite tokens left</total_tokens>` into the system
// prompt and after every tool-result batch. See CLAUDE_WORKER_CONTEXT_ENV in backend/types.ts.
//
// The seam a unit test cannot see is the whole chain: claudeWorkerEnvironment() -> BuiltCommand.env ->
// tmux `new-session -e` -> the child's real environment -> Claude Code's own reminder emitter. So this
// harness reads the env of a REAL tmux-spawned process, then makes a REAL claude run prove the block
// actually appears — and runs the SAME prompt WITHOUT the variable to prove the block is ours and not
// something the binary was doing anyway. A green result with no failing control is not evidence.
//
// The reminder rides a tool-result batch, so the prompt must force a tool call; a text-only turn
// produces no attachment and the check would pass or fail for the wrong reason.
//
// Everything runs on a UNIQUE tmux socket, so it can never touch the maintainer's live fray panes.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setSocket, spawn, socketName } from "../packages/server/src/tmux.ts"
import { createClaudeBackend } from "../packages/server/src/backend/claude.ts"
import { CLAUDE_WORKER_CONTEXT_ENV } from "../packages/server/src/backend/types.ts"

const SOCKET = `frayvctx${process.pid}`
const work = mkdtempSync(join(tmpdir(), "fray-context-budget-"))
const [REMINDER_KEY] = Object.keys(CLAUDE_WORKER_CONTEXT_ENV)
const REMINDER_VALUE = CLAUDE_WORKER_CONTEXT_ENV[REMINDER_KEY]
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

// The reminder lands as a `total_tokens_reminder` attachment record. Read the transcript Claude Code
// wrote for this exact session id rather than parsing stdout, which never carries attachments.
const transcriptFor = (sessionId) => {
  const projects = join(process.env.HOME, ".claude", "projects")
  return readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((p) => existsSync(p))
}
const reminderBlocksIn = (sessionId) => {
  const path = transcriptFor(sessionId)
  if (!path) return { path: undefined, blocks: [], toolUses: 0 }
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const blocks = records.flatMap((r) => {
    const found = JSON.stringify(r.attachment ?? r.attachments ?? "").match(/<total_tokens>[^<]*<\/total_tokens>/g)
    return found ?? []
  })
  const toolUses = records.filter((r) => {
    const content = r.message?.content
    return Array.isArray(content) && content.some((b) => b?.type === "tool_use")
  }).length
  return { path, blocks, toolUses }
}

setSocket(SOCKET)
const backend = createClaudeBackend({ logDir: work, claudeBin: "claude" })
const PROMPT = "Run exactly one Bash command: `echo hello`. Then reply DONE and stop."

try {
  console.log(`socket=${socketName()} work=${work}\n`)

  // ---- A. The variable fray builds lands in a real child process's environment -------------------
  const built = backend.buildSpawn({
    sessionId: randomUUID(), cwd: work, prompt: "noop", workerContract: "", permissionMode: "acceptEdits",
  })
  const envDump = join(work, "child-env.txt")
  spawn("context-budget-a", ["/bin/sh", "-c", `env > ${envDump}; sleep 30`], work, built.env, {})
  const dumped = waitFor(() => existsSync(envDump), 20000, "child env dump")
  const childEnv = dumped ? readFileSync(envDump, "utf8").split("\n") : []
  const line = childEnv.find((l) => l.startsWith(`${REMINDER_KEY}=`))
  check(
    "the spawned child's REAL environment carries the token-budget reminder",
    line === `${REMINDER_KEY}=${REMINDER_VALUE}`,
    `got ${line ?? "<absent>"}`,
  )
  // Negative control on the record itself: the pre-existing entries must survive the new one.
  check(
    "the existing worker environment still reaches the child",
    childEnv.includes("CLAUDE_CODE_SUBAGENT_MODEL="),
    childEnv.find((l) => l.startsWith("CLAUDE_CODE_SUBAGENT_MODEL")) ?? "<absent>",
  )

  // ---- B. Claude Code actually emits the block, through that same real path ----------------------
  const runs = [
    { name: "with", label: "a worker spawned by fray SEES the token budget", env: built.env, want: true },
    // The control: byte-identical prompt and flags, the reminder variable REMOVED. Without this a
    // pass proves nothing — the binary could have been emitting the block on its own all along.
    { name: "without", label: "the control run WITHOUT the variable sees no block", env: { ...built.env, [REMINDER_KEY]: "" }, want: false },
  ]
  for (const run of runs) {
    const sessionId = randomUUID()
    const done = join(work, `claude-${run.name}.done`)
    spawn(`context-budget-b-${run.name}`, ["/bin/sh", "-c",
      `claude -p ${JSON.stringify(PROMPT)} --model haiku --allowedTools Bash --session-id ${sessionId} `
      + `> ${join(work, `claude-${run.name}.out`)} 2>&1; echo finished > ${done}`,
    ], work, run.env, {})
    const finished = waitFor(() => existsSync(done), 180000, `the real claude run (${run.name})`)
    const { path, blocks, toolUses } = finished ? reminderBlocksIn(sessionId) : { path: undefined, blocks: [], toolUses: 0 }
    // Guard the guard: a run that never called a tool produces no attachment batch, so an absent
    // block would be meaningless rather than informative.
    check(`the ${run.name} run actually issued a tool call (so an attachment batch existed)`, toolUses > 0, `tool_use records=${toolUses}`)
    check(
      run.label,
      run.want ? blocks.includes(BLOCK) : blocks.length === 0,
      `blocks=${blocks.length ? [...new Set(blocks)].join(" ") : "<none>"}`,
    )
    if (path) console.log(`   transcript: ${path}`)
  }
} finally {
  // Scoped to THIS harness's own socket — never a broad kill that could reap a live fray worker.
  try { tmux("kill-server") } catch {}
  rmSync(work, { recursive: true, force: true })
  console.log(`\ncleanup: killed tmux server on ${SOCKET}, removed ${work}`)
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
