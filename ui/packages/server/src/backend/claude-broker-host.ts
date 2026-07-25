// The parent side of the Claude session broker: derive its socket/record paths, fork it as a detached
// daemon, and — after a fray restart — ADOPT an already-running one instead of cold-starting. Mirrors
// codex-app-server-host.ts (fork/record/adopt), keyed per Claude session id (one broker per thread).
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolveDetachedDaemonEntry } from "../detached-daemons.ts"
import type { BrokerRecord, ClaudeBrokerConfig } from "./claude-agent-broker.ts"

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
