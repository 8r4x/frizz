// Verifies the WebSearch-budget lift END TO END through the REAL spawn path, not through a stand-in.
//
// Claude Code stops searching after CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION calls (default 200) and
// returns "this session has used its web search budget" instead of results. Fray raises that for its
// workers in claudeWorkerEnvironment(). The seam that matters is the one a unit test cannot see:
// claudeWorkerEnvironment() -> the backend's BuiltCommand.env -> tmux `new-session -e` -> the actual
// child process environment -> Claude Code's own parser. Asserting the returned record only proves the
// first hop, so this harness reads the env of a REAL process spawned by the REAL tmux path, then makes
// a REAL claude run prove the injected number is the number Claude Code actually enforces.
//
// Everything runs on a UNIQUE tmux socket, so it can never touch the maintainer's live fray panes.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setSocket, spawn, socketName } from "../packages/server/src/tmux.ts"
import { createClaudeBackend } from "../packages/server/src/backend/claude.ts"
import { WORKER_MAX_WEB_SEARCHES, WORKER_MAX_SUBAGENTS, WORKER_MAX_CONCURRENT_SUBAGENTS } from "../packages/server/src/dispatch.ts"

const SOCKET = `frayvwsc${process.pid}`
const work = mkdtempSync(join(tmpdir(), "fray-websearch-cap-"))
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

setSocket(SOCKET)
const backend = createClaudeBackend({ logDir: work, claudeBin: "claude" })
const originalOverride = process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION

try {
  console.log(`socket=${socketName()} work=${work}\n`)

  // ---- A. The env fray builds actually lands in a real child process's environment -------------
  delete process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
  const built = backend.buildSpawn({
    sessionId: randomUUID(), cwd: work, prompt: "noop", workerContract: "", permissionMode: "acceptEdits",
  })
  const envDump = join(work, "child-env.txt")
  spawn("websearch-cap-a", ["/bin/sh", "-c", `env > ${envDump}; sleep 30`], work, built.env, {})
  const dumped = waitFor(() => existsSync(envDump), 20000, "child env dump")
  const childEnv = dumped ? readFileSync(envDump, "utf8").split("\n") : []
  const capLine = childEnv.find((l) => l.startsWith("CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION="))

  // The sub-agent caps ride the same env record and the same tmux hop, so they are asserted on the
  // same real child rather than trusted from the returned object.
  for (const [name, want] of [
    ["CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", WORKER_MAX_SUBAGENTS],
    ["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", WORKER_MAX_CONCURRENT_SUBAGENTS],
  ]) {
    const line = childEnv.find((l) => l.startsWith(`${name}=`))
    check(`the spawned child's REAL environment carries the lifted ${name}`, line === `${name}=${want}`, `got ${line ?? "<absent>"}`)
  }

  check(
    "the spawned child's REAL environment carries the lifted WebSearch budget",
    capLine === `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION=${WORKER_MAX_WEB_SEARCHES}`,
    `got ${capLine ?? "<absent>"}`,
  )
  check(
    "the lifted budget clears Claude Code's 200 default",
    WORKER_MAX_WEB_SEARCHES > 200,
    `WORKER_MAX_WEB_SEARCHES=${WORKER_MAX_WEB_SEARCHES}`,
  )
  // Negative control: the pre-existing profile masking must survive the new entry, or a worker
  // silently inherits a shell's sub-agent model and stops honoring its dispatched profile.
  check(
    "profile masking still reaches the child (CLAUDE_CODE_SUBAGENT_MODEL stays empty)",
    childEnv.includes("CLAUDE_CODE_SUBAGENT_MODEL="),
    childEnv.find((l) => l.startsWith("CLAUDE_CODE_SUBAGENT_MODEL")) ?? "<absent>",
  )

  // ---- B. Claude Code enforces the number fray injected, through that same real path -----------
  // Driven at a cap of 1 (via the operator-override path, exercising that too) because proving the
  // ceiling requires HITTING it — 10000 real searches is not a test. If the transport were broken,
  // Claude Code would fall back to 200 and neither search would be refused.
  process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = "1"
  const sessionId = randomUUID()
  const capped = backend.buildSpawn({
    sessionId, cwd: work, prompt: "noop", workerContract: "", permissionMode: "acceptEdits",
  })
  check(
    "a well-formed operator override rides the same path",
    capped.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION === "1",
    `got ${capped.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION}`,
  )
  const done = join(work, "claude-done.txt")
  const prompt = "Do exactly two WebSearch calls, one after the other, regardless of what the first returns. "
    + "Search 1: 'weather in Oslo'. Search 2: 'weather in Lisbon'. Then reply DONE."
  spawn("websearch-cap-b", ["/bin/sh", "-c",
    `claude -p ${JSON.stringify(prompt)} --model haiku --allowedTools WebSearch --session-id ${sessionId} `
    + `> ${join(work, "claude-out.json")} 2>&1; echo finished > ${done}`,
  ], work, capped.env, {})

  const finished = waitFor(() => existsSync(done), 180000, "the real claude run")
  const projects = join(process.env.HOME, ".claude", "projects")
  const transcript = finished
    ? readdirSync(projects).map((d) => join(projects, d, `${sessionId}.jsonl`)).find((p) => existsSync(p))
    : undefined
  const records = transcript ? readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean) : []
  const resultText = records.flatMap((r) => {
    const content = r.message?.content
    return Array.isArray(content) ? content.filter((b) => b?.type === "tool_result").map((b) => JSON.stringify(b.content)) : []
  })
  const searches = records.flatMap((r) => {
    const content = r.message?.content
    return Array.isArray(content) ? content.filter((b) => b?.type === "tool_use" && b.name === "WebSearch") : []
  })
  const capMessages = resultText.filter((t) => t.includes("used its web search budget"))

  check("the real claude worker actually issued both WebSearch calls", searches.length >= 2, `issued ${searches.length}`)
  check(
    "Claude Code enforced fray's injected cap (refused at 1 of 1, NOT the 200 default)",
    capMessages.some((t) => t.includes("(1 of 1 WebSearch calls)")),
    capMessages.length ? capMessages[0].slice(0, 140) : "no budget message seen",
  )
  check("exactly one search was refused — the first still succeeded", capMessages.length === 1, `refusals=${capMessages.length}`)
  if (transcript) console.log(`   transcript: ${transcript}`)
} finally {
  if (originalOverride === undefined) delete process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
  else process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = originalOverride
  // Scoped to THIS harness's own socket — never a broad kill that could reap a live fray worker.
  try { tmux("kill-server") } catch {}
  rmSync(work, { recursive: true, force: true })
  console.log(`\ncleanup: killed tmux server on ${SOCKET}, removed ${work}`)
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
