// Client side of the detached Codex app-server daemon (codex-app-server-daemon.ts): discover an
// already-running daemon for this project or fork a new one, then attach to it over its local socket
// and present the attachment as an ordinary `CodexAppServerProcess` so the bridge's JSON-RPC layer is
// unchanged.
//
// The whole point is the lifetime split. `kill()` on this adapter DETACHES the socket; it never kills
// the daemon. So when the disposable fray runtime is recycled by Update & Restart, the app-server —
// and every turn running inside it — keeps going, and the next runtime generation reattaches to the
// SAME process. Compare session-broker.ts, which does exactly this for PTY agent sessions.
import { spawn } from "node:child_process"
import { createConnection, type Socket } from "node:net"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PassThrough, Writable, type Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import type { CodexAppServerProcess } from "./codex-app-server.ts"

export interface CodexAppServerDaemonRecord {
  projectId: string
  /** Identity of the app-server PROCESS. Unchanged across a fray restart; new only when the
   *  app-server itself died and a fresh daemon replaced it. This is what tells the bridge whether
   *  in-flight turns survived. */
  generation: string
  daemonPid: number
  childPid: number
  socketPath: string
  createdAt: string
}

export interface CodexAppServerAttachment {
  process: CodexAppServerProcess
  generation: string
  /** True when we joined an app-server that was ALREADY running (i.e. it outlived a fray restart). */
  reattached: boolean
  daemonPid: number
}

export interface CodexAppServerHostOptions {
  projectId: string
  stateDir: string
  cwd: string
  codexBin: string
  env: NodeJS.ProcessEnv
  clientInfo: Record<string, unknown>
  capabilities: Record<string, unknown>
  /** Test seam: override the forked daemon entry. */
  daemonEntry?: string
  timeoutMs?: number
}

/** Resolves an attachment to a live app-server, forking a daemon only when there is not one already. */
export type CodexAppServerHost = (options: CodexAppServerHostOptions) => Promise<CodexAppServerAttachment>

const daemonEntry = fileURLToPath(new URL("./codex-app-server-daemon.ts", import.meta.url))

function daemonDir(stateDir: string): string {
  return join(stateDir, "codex-app-server")
}

function recordPath(stateDir: string, projectId: string): string {
  return join(daemonDir(stateDir), `${projectId}.json`)
}

/** Unix domain sockets have a hard ~104-byte path limit on macOS/BSD and a project state dir can be
 *  long, so hash the identity into a short name under the OS temp dir (same trick as the session
 *  broker). Windows named pipes have their own namespace and no length limit. */
export function codexAppServerSocketPath(stateDir: string, projectId: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(projectId).digest("hex").slice(0, 16)
  if (process.platform === "win32") return `\\\\.\\pipe\\fray-codex-${key}`
  return join(process.env.TMPDIR ?? "/tmp", `fray-codex-${key}.sock`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function readDaemonRecord(stateDir: string, projectId: string): CodexAppServerDaemonRecord | null {
  try {
    const value = JSON.parse(readFileSync(recordPath(stateDir, projectId), "utf8")) as Partial<CodexAppServerDaemonRecord>
    if (typeof value.daemonPid !== "number" || typeof value.socketPath !== "string" || typeof value.generation !== "string") return null
    return {
      projectId,
      generation: value.generation,
      daemonPid: value.daemonPid,
      childPid: typeof value.childPid === "number" ? value.childPid : 0,
      socketPath: value.socketPath,
      createdAt: value.createdAt ?? "",
    }
  } catch {
    return null
  }
}

/** A daemon is live only while its process is running; a stale record is pruned. */
export function liveDaemonRecord(stateDir: string, projectId: string): CodexAppServerDaemonRecord | null {
  const record = readDaemonRecord(stateDir, projectId)
  if (!record) return null
  if (pidAlive(record.daemonPid)) return record
  try { unlinkSync(recordPath(stateDir, projectId)) } catch {}
  return null
}

/** Terminate the daemon AND its app-server. Only for an explicit teardown — never for a restart. */
export function killCodexAppServerDaemon(stateDir: string, projectId: string): void {
  const record = liveDaemonRecord(stateDir, projectId)
  if (!record) return
  try { process.kill(record.daemonPid, "SIGTERM") } catch {}
  try { unlinkSync(recordPath(stateDir, projectId)) } catch {}
}

function forkDaemon(options: CodexAppServerHostOptions): Promise<CodexAppServerDaemonRecord> {
  const { stateDir, projectId } = options
  mkdirSync(daemonDir(stateDir), { recursive: true })
  const record = recordPath(stateDir, projectId)
  try { unlinkSync(record) } catch {}
  const socketPath = codexAppServerSocketPath(stateDir, projectId)
  const generation = randomUUID()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value

  const payload = JSON.stringify({
    projectId, socketPath, recordPath: record, codexBin: options.codexBin, cwd: options.cwd,
    env, generation, clientInfo: options.clientInfo, capabilities: options.capabilities,
  })
  const child = spawn(process.execPath, [options.daemonEntry ?? daemonEntry], {
    cwd: options.cwd,
    // The daemon's OWN environment only needs the handoff; the app-server's environment travels in
    // the payload and is applied by the daemon, keeping the audited env allowlist authoritative.
    env: { ...process.env, FRAY_CODEX_APP_SERVER_DAEMON: payload },
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  return new Promise<CodexAppServerDaemonRecord>((resolve, reject) => {
    const poll = (): void => {
      const found = readDaemonRecord(stateDir, projectId)
      if (found && pidAlive(found.daemonPid)) return resolve(found)
      if (!pidAlive(child.pid ?? -1) && !found) return reject(new Error("codex app-server daemon exited before it became ready"))
      if (Date.now() > deadline) return reject(new Error("codex app-server daemon did not become ready"))
      setTimeout(poll, 50)
    }
    child.once("error", reject)
    poll()
  })
}

/**
 * A `CodexAppServerProcess` backed by a socket to the daemon rather than by a child's stdio.
 * `kill()` closes THIS attachment only — the daemon and its app-server keep running.
 */
function attach(record: CodexAppServerDaemonRecord, timeoutMs: number): Promise<CodexAppServerProcess> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socketPath)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const listeners = { exit: [] as (() => void)[], error: [] as ((error: Error) => void)[] }
    let settled = false
    let ended = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error("codex app-server daemon attach timed out"))
    }, timeoutMs)
    timer.unref?.()

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        socket.write(chunk as Buffer, (error) => callback(error ?? null))
      },
    })

    const handle: CodexAppServerProcess = {
      stdin,
      stdout: stdout as unknown as Readable,
      stderr: stderr as unknown as Readable,
      on(event: "exit" | "error", listener: never) {
        if (event === "exit") listeners.exit.push(listener as unknown as () => void)
        else listeners.error.push(listener as unknown as (error: Error) => void)
        return handle as never
      },
      // DETACH, never kill. This one line is the difference between a codex turn surviving Update &
      // Restart and dying mid-sentence.
      kill() { socket.destroy(); return true },
    } as CodexAppServerProcess

    // Control lines (a reserved `fray` key) are the daemon's own; everything else is verbatim
    // app-server JSON-RPC and must reach the bridge's parser untouched.
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      for (;;) {
        const index = buffer.indexOf("\n")
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith("{\"fray\":")) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(handle)
          }
          continue
        }
        stdout.write(`${trimmed}\n`)
      }
    })

    const finish = (error?: Error): void => {
      if (ended) return
      ended = true
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error ?? new Error("codex app-server daemon closed the attachment"))
        return
      }
      // Surface a lost attachment as an `exit`: from the bridge's point of view a connection it can
      // no longer speak on is exactly a dead process, and its reconnect path already handles that.
      for (const listener of listeners.exit) listener()
    }
    socket.on("close", () => finish())
    socket.on("error", (error) => { for (const l of listeners.error) l(error); finish(error) })
  })
}

/** The production host: reattach to this project's daemon, or fork one if there is none. */
export const daemonCodexAppServerHost: CodexAppServerHost = async (options) => {
  const existing = liveDaemonRecord(options.stateDir, options.projectId)
  const timeoutMs = options.timeoutMs ?? 30_000
  if (existing) {
    try {
      return { process: await attach(existing, timeoutMs), generation: existing.generation, reattached: true, daemonPid: existing.daemonPid }
    } catch {
      // The record outlived its socket (a daemon killed between the pid check and connect). Drop it
      // and fall through to a fresh fork rather than failing the whole connect.
      try { unlinkSync(recordPath(options.stateDir, options.projectId)) } catch {}
    }
  }
  if (process.platform !== "win32") {
    const stale = codexAppServerSocketPath(options.stateDir, options.projectId)
    if (existsSync(stale) && !liveDaemonRecord(options.stateDir, options.projectId)) { try { unlinkSync(stale) } catch {} }
  }
  const record = await forkDaemon(options)
  return { process: await attach(record, timeoutMs), generation: record.generation, reattached: false, daemonPid: record.daemonPid }
}

/** Test/harness seam: keep the historical direct-child behavior, where every connect is a NEW
 *  app-server process (so `reattached` is false and the generation always changes). */
export function directChildHost(
  spawnChild: (binary: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CodexAppServerProcess,
  generationId: () => string = randomUUID,
): CodexAppServerHost {
  return async (options) => ({
    process: spawnChild(options.codexBin, ["app-server", "--stdio"], { cwd: options.cwd, env: options.env }),
    generation: generationId(),
    reattached: false,
    daemonPid: process.pid,
  })
}

export { recordPath as codexAppServerDaemonRecordPath }
