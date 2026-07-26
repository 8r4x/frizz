// The Claude session broker DAEMON: a detached process that owns one Claude Agent SDK session and
// relays it over a local socket. This is the piece Claude Code doesn't ship (codex's app-server is
// the same shape): the session OUTLIVES fray, so fray reconnects to the LIVE session after a restart
// instead of cold resume-from-disk, while keeping structured TYPED control (no TUI scraping, no tmux,
// no PTY — stream-json is pipes). The SDK stays as this daemon's implementation detail; fray speaks a
// small typed socket protocol (claude-broker-client.ts), never the SDK directly.
//
// Wire protocol — newline-delimited JSON frames:
//   fray -> broker:  {t:"input", message} | {t:"permission", requestId, decision} | {t:"interrupt"} | {t:"set-mode", mode}
//   broker -> fray:  {t:"hello", sessionId, generation} | {t:"event", event} | {t:"permission-request", requestId, request} | {t:"diagnostic", diagnostic}
//
// Lifecycle mirrors codex-app-server-daemon.ts (record-after-listen, owner-checked cleanup, idle
// exit, reachability self-collection). The recovered session-broker daemon's NAIVE unconditional
// cleanup is exactly the corpse-deletes-successor bug this guards against.
import net from "node:net"
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import type {
  ClaudeDiagnostic,
  ClaudeInputMessage,
  ClaudePermissionDecision,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"

export interface ClaudeBrokerConfig {
  socketPath: string
  cwd: string
  sessionId: string
  executablePath: string
  permissionMode?: ClaudePermissionMode
  /** Allowlisted keys only — the SDK validates and rejects anything else. */
  env: Record<string, string>
  /** Appended to Claude's default system prompt — carries the fray worker contract. */
  appendSystemPrompt?: string
  model?: string
  effort?: string
  /** Resume the session from its on-disk transcript instead of starting a fresh one. Set when a
   *  follow-up cold-starts a daemon after the previous one died (the live-daemon reconnect never forks). */
  resume?: boolean
  /** The fray WORKER ENVIRONMENT — the SDK equivalents of the tmux path's plugin/MCP injection. Without
   *  these a broker worker is bare: no fray sub-agent profiles, no fray/chrome-devtools MCP, no cc-worker
   *  hooks. `pluginDir` loads the local cc-worker plugin; `mcpServers`/`allowedTools` mount + pre-approve
   *  the MCP servers; `workerEnv` carries the per-thread fray vars the plugin hooks gate on (FRAY_UI_THREAD,
   *  FRAY_PERM_DIR) — merged into the SDK env AFTER the ambient allowlist. */
  pluginDir?: string
  mcpServers?: Record<string, { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }>
  allowedTools?: string[]
  workerEnv?: Record<string, string>
  /** When set, the daemon writes a discovery record here after its socket is listening. */
  recordPath?: string
  /** Stable identity of THIS app-server process — unchanged across fray restarts, new only when the
   *  session itself is re-forked. Lets fray tell whether in-flight work survived a reconnect. */
  generation?: string
}

export interface BrokerRecord { daemonPid: number; socketPath: string; sessionId: string; generation: string; createdAt: string }

const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]
const IDLE_EXIT_MS = 6 * 60 * 60 * 1000
const REACHABILITY_CHECK_MS = 30_000
const REACHABILITY_STRIKES = 2

export interface RunningBroker { close: () => Promise<void>; sessionId: string; generation: string }

export function runClaudeBroker(config: ClaudeBrokerConfig): RunningBroker {
  const generation = config.generation ?? randomUUID()
  let client: net.Socket | null = null
  const eventBacklog: string[] = []
  const pendingPermissions = new Map<string, { request: ClaudePermissionRequest; resolve: (d: ClaudePermissionDecision) => void }>()
  let permSeq = 0
  let published = false
  let idleTimer: NodeJS.Timeout | undefined
  let strikes = 0

  const write = (sock: net.Socket, frame: unknown) => sock.write(JSON.stringify(frame) + "\n")
  const emitEvent = (event: ClaudeQueryEvent) => {
    if (client) write(client, { t: "event", event })
    else { eventBacklog.push(JSON.stringify({ t: "event", event }) + "\n"); if (eventBacklog.length > 20_000) eventBacklog.shift() }
  }

  const factory = createClaudeQueryFactory({ enabled: true, executablePath: config.executablePath })
  const handle = factory.start({
    cwd: config.cwd,
    session: config.resume ? { kind: "resume", sessionId: config.sessionId } : { kind: "new", sessionId: config.sessionId },
    permissionMode: config.permissionMode ?? "default",
    // Ambient env is allowlist-filtered; the fray worker vars (FRAY_UI_THREAD, FRAY_PERM_DIR) ride
    // workerEnv and are merged on top so the loaded cc-worker hooks actually activate.
    env: { ...Object.fromEntries(ENV_ALLOWLIST.filter((k) => config.env[k] != null).map((k) => [k, config.env[k]!])), ...(config.workerEnv ?? {}) },
    persistSession: true, // write the tailer-readable transcript JSONL
    appendSystemPrompt: config.appendSystemPrompt,
    model: config.model,
    effort: config.effort,
    pluginDir: config.pluginDir,
    mcpServers: config.mcpServers,
    allowedTools: config.allowedTools,
    canUseTool: async (request) => {
      const requestId = `perm-${++permSeq}`
      return await new Promise<ClaudePermissionDecision>((resolve) => {
        pendingPermissions.set(requestId, { request, resolve })
        if (client) write(client, { t: "permission-request", requestId, request })
      })
    },
    onDiagnostic: (diagnostic: ClaudeDiagnostic) => { if (client) write(client, { t: "diagnostic", diagnostic }) },
  })

  // The session ending (claude exits) tears the daemon down — there is nothing left to hold.
  const pump = (async () => { for await (const event of handle) emitEvent(event) })().then(() => shutdown(0)).catch(() => shutdown(0))

  const armIdle = () => { if (client) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => shutdown(0), IDLE_EXIT_MS) }

  const server = net.createServer((sock) => {
    client = sock; clearTimeout(idleTimer)
    write(sock, { t: "hello", sessionId: handle.sessionId, generation })
    for (const [requestId, { request }] of pendingPermissions) write(sock, { t: "permission-request", requestId, request })
    while (eventBacklog.length) sock.write(eventBacklog.shift()!)
    let buf = ""
    sock.on("data", (chunk) => {
      buf += chunk
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue
        let msg: Record<string, unknown>; try { msg = JSON.parse(line) } catch { continue }
        if (msg.t === "input") void handle.send(msg.message as ClaudeInputMessage).catch(() => {})
        else if (msg.t === "permission") { const e = pendingPermissions.get(msg.requestId as string); if (e) { pendingPermissions.delete(msg.requestId as string); e.resolve(msg.decision as ClaudePermissionDecision) } }
        else if (msg.t === "interrupt") void handle.interrupt().catch(() => {})
        else if (msg.t === "set-mode") void handle.setPermissionMode(msg.mode as never).catch(() => {})
      }
    })
    sock.on("close", () => { if (client === sock) { client = null; armIdle() } }) // fray gone; the session stays alive
    sock.on("error", () => {})
  })

  const recordOwner = (): number | null => {
    if (!config.recordPath) return null
    try { return (JSON.parse(readFileSync(config.recordPath, "utf8")) as BrokerRecord).daemonPid } catch { return null }
  }
  let closed = false
  async function shutdown(code: number): Promise<void> {
    if (closed) return; closed = true
    clearTimeout(idleTimer); clearInterval(reach)
    // Owner-checked cleanup: never delete a successor's record/socket. A corpse whose record was
    // already overwritten must leave the live daemon's socket alone.
    const owner = recordOwner()
    if (config.recordPath && owner === process.pid) { try { unlinkSync(config.recordPath) } catch {} }
    if (!(published && owner !== null && owner !== process.pid) && published && process.platform !== "win32") { try { unlinkSync(config.socketPath) } catch {} }
    try { client?.destroy() } catch {}
    try { (server as { closeAllConnections?: () => void }).closeAllConnections?.() } catch {}
    try { server.close() } catch {}
    await handle.close().catch(() => {})
    if (config.recordPath) process.exit(code) // standalone daemon
  }

  // Reachability self-collection: if UNATTACHED and the record no longer names this pid (a successor
  // stole it, or it vanished), strike out and exit — so a claude process can't leak forever.
  const reach = setInterval(() => {
    if (client || !config.recordPath) { strikes = 0; return }
    const owner = recordOwner()
    if (owner === process.pid) { strikes = 0; return }
    if (++strikes >= REACHABILITY_STRIKES) void shutdown(0)
  }, REACHABILITY_CHECK_MS)
  if (reach.unref) reach.unref()

  try { unlinkSync(config.socketPath) } catch {} // sweep a stale unix socket before binding
  server.listen(config.socketPath, () => {
    published = true
    if (config.recordPath) {
      const record: BrokerRecord = { daemonPid: process.pid, socketPath: config.socketPath, sessionId: config.sessionId, generation, createdAt: new Date().toISOString() }
      try { writeFileSync(config.recordPath, JSON.stringify(record), { mode: 0o600 }) } catch {}
    }
    armIdle()
  })

  return { close: async () => { await shutdown(0) }, sessionId: handle.sessionId, generation }
}

// Standalone daemon entry: `node claude-agent-broker.ts` with config in FRAY_CLAUDE_BROKER.
if (process.env.FRAY_CLAUDE_BROKER) {
  const config = JSON.parse(process.env.FRAY_CLAUDE_BROKER) as ClaudeBrokerConfig
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => process.exit(0))
  runClaudeBroker(config)
}
