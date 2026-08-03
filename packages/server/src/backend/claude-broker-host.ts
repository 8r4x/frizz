// The parent side of the Claude session broker: derive its socket/record paths, fork it as a detached
// daemon, and — after a fray restart — ADOPT an already-running one instead of cold-starting. Mirrors
// codex-app-server-host.ts (fork/record/adopt), keyed per Claude session id (one broker per thread).
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { resolveDetachedDaemonEntry } from "../detached-daemons.ts"
import type { BrokerRecord, ClaudeBrokerConfig } from "./claude-agent-broker.ts"
import { claudeBrokerDiagnosticLogPath } from "./claude-broker-diagnostics.ts"

// The Claude Agent SDK REQUIRES an absolute `pathToClaudeCodeExecutable` (validateExecutablePath rejects
// a bare name), unlike the tmux path where execvp resolves "claude" on PATH. When the dispatch layer
// hands us a bare "claude" (the default when no --claude-bin is configured — the promoted-artifact case),
// resolve it to an absolute path on PATH here, or the forked daemon dies on startup ("executablePath must
// be absolute") before it can publish its record and every dispatch times out with "did not become ready".
//
// WINDOWS is a different problem, and the naive scan below got it wrong. `npm i -g` writes THREE files
// into the bin dir — `claude` (a `#!/bin/sh` script), `claude.cmd`, and `claude.ps1` — because Windows
// cannot symlink the way POSIX npm does. The bare-name scan therefore found the SH SCRIPT and returned
// it: nothing on Windows can run that (spawning it is ENOENT, and `node` reads it as JavaScript and
// dies on line 2). Measured on Windows Server 2022 with claude 2.1.220:
//
//   spawn(<bin>\claude)      -> ENOENT          node <bin>\claude   -> SyntaxError at line 2
//   spawn(<bin>\claude.cmd)  -> EINVAL          (Node refuses .cmd/.bat without shell since CVE-2024-27980)
//   spawn(<real claude.exe>) -> exit 0 "2.1.220 (Claude Code)"
//
// So `.cmd` is not the answer either. The real executable is a NATIVE claude.exe that ships inside the
// package and is NOT itself on PATH — the `.cmd` shim is just a stub that calls it. Hence: prefer a
// real `.exe` on PATH, else find the `.cmd` shim and follow it to the target it invokes.
const WINDOWS_SHIM_TARGET = /^\s*"%dp0%\\(.+?)"/mu

/** Read a `.cmd` shim and return the absolute path of the executable it actually invokes. */
function windowsShimTarget(shimPath: string): string | undefined {
  let body: string
  try { body = readFileSync(shimPath, "utf8") } catch { return undefined }
  const target = WINDOWS_SHIM_TARGET.exec(body)?.[1]
  if (!target) return undefined
  const full = join(dirname(shimPath), target)
  try { accessSync(full, fsConstants.F_OK); return full } catch { return undefined }
}

export function resolveClaudeExecutableAbsolute(bin: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = bin && bin.length > 0 ? bin : "claude"
  if (isAbsolute(candidate)) return candidate
  const windows = process.platform === "win32"
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    if (windows) {
      // A real executable wins outright (a standalone install, or a future npm layout that ships one).
      const exe = join(dir, `${candidate}.exe`)
      try { accessSync(exe, fsConstants.F_OK); return exe } catch { /* no .exe here */ }
      // Otherwise follow the npm `.cmd` stub to the binary it calls. Deliberately NEVER return the
      // extensionless sibling: on Windows that is a POSIX shell script and it is unusable.
      const viaShim = windowsShimTarget(join(dir, `${candidate}.cmd`))
      if (viaShim) return viaShim
      continue
    }
    const full = join(dir, candidate)
    try { accessSync(full, fsConstants.X_OK); return full } catch { /* try next PATH entry */ }
  }
  throw new Error(`Claude session broker: could not resolve '${candidate}' to an absolute executable path on PATH (the SDK requires one)`)
}

/** Short, collision-resistant socket path (unix sockets cap ~104 bytes on macOS/BSD). */
export function claudeBrokerSocketPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(sessionId).digest("hex").slice(0, 16)
  if (process.platform === "win32") return `\\\\.\\pipe\\fray-claude-${key}`
  return join(process.env.TMPDIR ?? "/tmp", `fray-claude-${key}.sock`)
}

/** The discovery record lives under the project state dir (long paths are fine here). */
export function claudeBrokerRecordPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  return join(stateDir, "claude-broker", `${key}.json`)
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

export function readBrokerRecord(recordPath: string): BrokerRecord | null {
  try { return JSON.parse(readFileSync(recordPath, "utf8")) as BrokerRecord } catch { return null }
}

/** A record whose daemon is still alive; prunes a stale record as a side effect. */
export function liveBrokerRecord(recordPath: string): BrokerRecord | null {
  const record = readBrokerRecord(recordPath)
  if (record && pidAlive(record.daemonPid)) return record
  if (record) { try { unlinkSync(recordPath) } catch {} }
  return null
}

/** Every broker daemon under this state dir that is still running — the set a booting fray can adopt.
 *
 *  Enumerates the record DIRECTORY rather than probing one path per registry row: the record filename
 *  is a hash of the session id and cannot be inverted, and at boot the live set (a handful of daemons)
 *  is tiny next to a project's session history (hundreds of rows). Stale records are pruned on the way
 *  through, exactly as a single liveBrokerRecord read does. Never throws — a project that has never run
 *  a broker has no such directory, and that is simply "none". */
export function liveBrokerRecords(stateDir: string): BrokerRecord[] {
  const dir = join(stateDir, "claude-broker")
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: BrokerRecord[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue // the .diagnostics.log files live here too
    const record = liveBrokerRecord(join(dir, name))
    if (record) out.push(record)
  }
  return out
}

export interface ForkBrokerOptions {
  stateDir: string
  cwd: string
  sessionId: string
  executablePath: string
  permissionMode?: ClaudeBrokerConfig["permissionMode"]
  env: Record<string, string>
  appendSystemPrompt?: string
  model?: string
  effort?: string
  /** Resume the on-disk session instead of starting fresh (dead-daemon follow-up cold start). */
  resume?: boolean
  /** The fray worker environment (plugin + MCP + per-thread fray vars) — see ClaudeBrokerConfig. */
  pluginDir?: string
  mcpServers?: Record<string, { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }>
  allowedTools?: string[]
  workerEnv?: Record<string, string>
  /** Override the daemon entry (tests). Defaults to the bundled/sibling claude-agent-broker. */
  daemonEntry?: string
  timeoutMs?: number
}

/** Spawn the broker as a detached daemon; resolve once it has published its record (socket listening). */
export function forkBroker(options: ForkBrokerOptions): Promise<BrokerRecord> {
  const socketPath = claudeBrokerSocketPath(options.stateDir, options.sessionId)
  const recordPath = claudeBrokerRecordPath(options.stateDir, options.sessionId)
  mkdirSync(dirname(recordPath), { recursive: true })
  const config: ClaudeBrokerConfig = {
    socketPath, cwd: options.cwd, sessionId: options.sessionId, executablePath: options.executablePath,
    permissionMode: options.permissionMode, env: options.env, recordPath, generation: randomUUID(),
    // The daemon writes its own death forensics here. Same dir as the record, so a session's socket,
    // record and diagnostics stay together and a project teardown removes all three.
    diagnosticLogPath: claudeBrokerDiagnosticLogPath(options.stateDir, options.sessionId),
    appendSystemPrompt: options.appendSystemPrompt, model: options.model, effort: options.effort,
    resume: options.resume,
    pluginDir: options.pluginDir, mcpServers: options.mcpServers, allowedTools: options.allowedTools,
    workerEnv: options.workerEnv,
  }
  const entry = options.daemonEntry ?? resolveDetachedDaemonEntry(import.meta.url, "claude-agent-broker")
  const child = spawn(process.execPath, [entry], {
    cwd: options.cwd,
    env: { ...process.env, FRAY_CLAUDE_BROKER: JSON.stringify(config) },
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  return new Promise<BrokerRecord>((resolve, reject) => {
    const poll = () => {
      const record = readBrokerRecord(recordPath)
      if (record && pidAlive(record.daemonPid)) return resolve(record)
      if (Date.now() > deadline) return reject(new Error(`Claude broker for session ${options.sessionId} did not become ready`))
      setTimeout(poll, 50)
    }
    child.once("error", reject)
    poll()
  })
}

/** Reattach to a live broker if one exists (fray restart), else fork a fresh one. */
export async function adoptOrForkBroker(options: ForkBrokerOptions): Promise<{ record: BrokerRecord; reattached: boolean }> {
  const existing = liveBrokerRecord(claudeBrokerRecordPath(options.stateDir, options.sessionId))
  if (existing) return { record: existing, reattached: true }
  return { record: await forkBroker(options), reattached: false }
}

/** Best-effort terminate: SIGTERM the daemon and drop its record. Detach (client.close) is NOT this.
 *  Returns whether a live daemon record was present (i.e. there was something to stop). */
export function killBroker(stateDir: string, sessionId: string): boolean {
  const recordPath = claudeBrokerRecordPath(stateDir, sessionId)
  const record = liveBrokerRecord(recordPath)
  if (record) { try { process.kill(record.daemonPid, "SIGTERM") } catch {} }
  try { unlinkSync(recordPath) } catch {}
  return record !== null
}
