// LIVE probe: can an SDK-hosted Claude session (what fray's broker runs) start a Remote Control
// bridge, and what does it hand back? The auto-start path (`remoteControlAtStartup`) is wired only
// into Claude's REPL + the standalone `claude remote-control` server — an SDK session gets a bridge
// ONLY when the client sends the `remote_control` control request. The SDK implements it as
// `Query.enableRemoteControl(enabled, name?)` but does NOT declare it in sdk.d.ts, so this probe is
// the evidence that the method exists, is reachable through fray's exact query options, and returns
// a connectable session.
//   nub packages/server/src/backend/_live_remote_control.mts
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { query } from "@fray-ui/claude-agent-sdk-runtime"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const cwd = mkdtempSync(join(tmpdir(), "fray-rc-probe-"))
execFileSync("git", ["init", "-q", cwd])

const ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
const env = Object.fromEntries(ALLOWLIST.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]!])) as Record<string, string>
console.log("env passed:", Object.keys(env).join(","))

const sessionId = randomUUID()
async function* prompt(): AsyncGenerator<never, void> {
  // Hold the session open without sending a turn: the control channel is live from initialize.
  await new Promise<void>(() => {})
}

const q = query({
  prompt: prompt(),
  options: {
    cwd,
    env,
    pathToClaudeCodeExecutable: claudeBin,
    permissionMode: "default",
    sessionId,
    settingSources: ["project", "local"],
    persistSession: true,
    stderr(data: string) { process.stderr.write(`[claude stderr] ${data}`) },
  },
} as never) as never as {
  initializationResult(): Promise<unknown>
  enableRemoteControl(enabled: boolean, name?: string): Promise<unknown>
  interrupt(): Promise<unknown>
  return(v?: unknown): Promise<unknown>
}

const pump = (async () => { for await (const _m of q as never as AsyncIterable<unknown>) { /* drain */ } })()
pump.catch((e) => console.log("pump ended:", e instanceof Error ? e.message : String(e)))

try {
  const init = await q.initializationResult()
  console.log("initialized:", JSON.stringify(init).slice(0, 400))

  console.log("typeof enableRemoteControl:", typeof q.enableRemoteControl)
  try {
    const res = await q.enableRemoteControl(true, "fray probe")
    console.log("ENABLE OK:", JSON.stringify(res, null, 2))
    await new Promise((r) => setTimeout(r, 4000))
    const off = await q.enableRemoteControl(false)
    console.log("DISABLE OK:", JSON.stringify(off))
  } catch (e) {
    console.log("ENABLE FAILED:", e instanceof Error ? e.message : String(e))
  }
} finally {
  await q.return(undefined).catch(() => {})
  rmSync(cwd, { recursive: true, force: true })
  process.exit(0)
}
