// LIVE end-to-end gate for the operator's CONTEXT WINDOW setting: proves the value stored in fray's
// Settings actually lands in a REAL dispatched worker's process environment, through the whole
// production chain — storage → getSettings → the bridge's contextWindow getter → claudeWorkerEnv →
// the broker daemon's SDK env allowlist → the claude process the worker runs in. Run:
//   nub packages/server/src/backend/_live_broker_context_window_env.mts
//
// WHY A LIVE PROBE AND NOT A UNIT TEST: the unit tests in claude.test.ts pin what claudeWorkerEnv
// RETURNS. They cannot see the two gates between that record and the running process, and both of
// them fail silently-ish in ways a returned record looks fine through:
//   · buildEnvironment()'s EXPLICIT_CLAUDE_ENV_KEYS THROWS on an unlisted key, killing the daemon at
//     startup before it publishes its record — every dispatch then times out "did not become ready".
//     CLAUDE_CODE_AUTO_COMPACT_WINDOW is covered only because it is a KEY OF CLAUDE_WORKER_ENV; move
//     it out of that record and this probe is what notices.
//   · the bridge applies workerEnv only when the attach FORKS a daemon, so a stale live daemon would
//     serve the old window. The probe forks fresh.
//
// The other half of the chain — env var ⇒ Claude Code actually compacts there — is verified against
// the real CLI rather than here: with CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000 the TUI's /context
// reports "33.6k/600k tokens · Auto-compact window: 600k tokens", and the same pane without it
// reports "33.5k/1m". That is a claude behavior, not a fray one, so it is pinned in the comment on
// WORKER_CONTEXT_WINDOW in types.ts and not re-driven on every run.
//
// Deliberately probes a NON-default window (400_000): asserting the shipped 600_000 would pass
// identically if the setting were ignored and the record's own default rode through.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "../context.ts"
import { resolveProject } from "../project.ts"
import { setSettings, getSettings } from "../settings.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

process.env.FRAY_CLAUDE_BROKER_BRIDGE = "1"
const PROBE_WINDOW = 400_000
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const repo = mkdtempSync(join(tmpdir(), "brk-ctxwin-repo-"))
execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
const project = resolveProject(repo)
const reportFile = join(repo, "window.txt")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let daemonPid: number | undefined

try {
  const ctx = await createContext({ project, claudeBin })
  // Store the window the way the settings drawer does, then read it back through the SAME accessor the
  // bridge's getter uses — a blob that fails Settings.parse degrades to defaults SILENTLY, which would
  // otherwise show up here as "the default rode through" rather than "my write was rejected".
  setSettings(ctx.storage, { ...getSettings(ctx.storage), contextWindow: PROBE_WINDOW })
  ok("the window round-trips through Settings storage", getSettings(ctx.storage).contextWindow === PROBE_WINDOW,
    `read back ${String(getSettings(ctx.storage).contextWindow)}`)

  const { slug, sessionId } = await ctx.dispatcher.dispatch({
    prompt: `Run exactly this one Bash command and then stop: ` +
      `printf '%s' "\${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-UNSET}" > ${reportFile}`,
  }, { backend: "claude" })
  ok("dispatched a broker thread", !!slug && !!sessionId)
  daemonPid = readBrokerRecord(claudeBrokerRecordPath(project.stateDir, sessionId))?.daemonPid

  const deadline = Date.now() + 180_000
  while (!existsSync(reportFile) && Date.now() < deadline) await sleep(1_000)

  const reported = existsSync(reportFile) ? readFileSync(reportFile, "utf8").trim() : "(no file)"
  ok(`the REAL worker process sees the configured window (${PROBE_WINDOW})`, reported === String(PROBE_WINDOW),
    `worker reported ${JSON.stringify(reported)}`)
  ok("and it is not merely the shipped default riding through", reported !== "600000")

  await ctx.tailer.stop(); ctx.permissionController.stop(); ctx.deliveryConfirmer?.stop(); ctx.profileController?.stop()
  ctx.stopSubscriptions(); await ctx.scheduler.stop(); await ctx.board.stop()
  ctx.claudeBroker?.releaseSession(slug, sessionId, "session-deleted"); ctx.storage.close()
} catch (err) {
  failures++; console.log(`\nERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  try { if (daemonPid) process.kill(daemonPid, "SIGKILL") } catch {}
  rmSync(repo, { recursive: true, force: true })
  try { rmSync(project.stateDir, { recursive: true, force: true }) } catch {}
  try { rmSync(join(process.env.HOME ?? "", ".claude", "projects", project.cwdSlug), { recursive: true, force: true }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
