// LIVE end-to-end test of the whole Claude broker path against real claude:
//   node --experimental-strip-types packages/server/src/backend/_live_broker_bridge.mts
// Proves: bridge.spawnDispatch forks a DETACHED broker daemon that drives real claude; permissions
// auto-allow so a tool runs; the transcript lands at the tailer-readable JSONL path; followUp adds a
// second turn on the SAME live session; the daemon is a separate process that survives the bridge;
// releaseSession kills it.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bbridge-state-"))
const cwd = mkdtempSync(join(tmpdir(), "bbridge-repo-")); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const results: string[] = []
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (_slug, sessionId, event: ClaudeQueryEvent) => { if (event.kind === "result") results.push(sessionId) },
})
const waitResult = async (n: number, ms = 90_000) => { const d = Date.now() + ms; while (results.length < n) { if (Date.now() > d) throw new Error("result timeout"); await new Promise((r) => setTimeout(r, 500)) } }

const slug = "bridge-live"
const sessionId = randomUUID()
const fileA = join(cwd, "a.txt"), fileB = join(cwd, "b.txt")
try {
  // ---- dispatch: forks a detached broker, drives real claude, auto-allows the Write --------------
  const { binding } = await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: `Use the Write tool to create the file at ${fileA} with the text ok. Then stop.` })
  ok("spawnDispatch returned a binding", binding.sessionId === sessionId && binding.state === "active")
  await waitResult(1)
  ok("permission auto-allowed → the tool actually ran (file written)", existsSync(fileA))

  // ---- transcript landed at the tailer-readable path (claude slugifies the REALPATH'd cwd) --------
  const realSlug = realpathSync(cwd).replace(/\//g, "-")
  const jsonl = join(homedir(), ".claude", "projects", realSlug, `${sessionId}.jsonl`)
  const base = join(homedir(), ".claude", "projects")
  const foundBySession = existsSync(base) && readdirSync(base).some((d) => existsSync(join(base, d, `${sessionId}.jsonl`)))
  ok("transcript JSONL written where the tailer reads it", existsSync(jsonl) || foundBySession, jsonl)

  // ---- the broker is a SEPARATE detached process (survives the bridge) ---------------------------
  const record = readBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId))
  const daemonAlive = !!record && (() => { try { process.kill(record.daemonPid, 0); return true } catch { return false } })()
  ok("broker daemon is a live separate process", daemonAlive, record ? `pid ${record.daemonPid}` : "no record")

  // ---- followUp: a second turn on the SAME live session ------------------------------------------
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: `Now use the Write tool to create the file at ${fileB} with the text ok2. Then stop.` })
  await waitResult(2)
  ok("followUp ran a second turn on the same session (second file written)", existsSync(fileB))

  // ---- releaseSession kills the daemon -----------------------------------------------------------
  const released = bridge.releaseSession(slug, sessionId, "session-deleted")
  ok("releaseSession returned true", released)
  await new Promise((r) => setTimeout(r, 1_500))
  const stillAlive = record ? (() => { try { process.kill(record.daemonPid, 0); return true } catch { return false } })() : false
  ok("broker daemon was killed on release", !stillAlive)
} catch (err) {
  failures++; console.log(`\nERROR: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  bridge.close()
  try { const r = readBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
  rmSync(stateDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true })
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
