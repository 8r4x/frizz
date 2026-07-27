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
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import { createClaudeBrokerDiagnosticWriter } from "./claude-broker-diagnostics.ts"
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
  /** When set, the daemon appends its OWN lifecycle/stderr diagnostics here, synchronously. This is
   *  how a crash survives: relaying to an attached client loses every death that happens while fray is
   *  detached (a restart), and an in-memory backlog dies with the process it is recording. */
  diagnosticLogPath?: string
  /** Stable identity of THIS app-server process — unchanged across fray restarts, new only when the
   *  session itself is re-forked. Lets fray tell whether in-flight work survived a reconnect. */
  generation?: string
}

export interface BrokerRecord { daemonPid: number; socketPath: string; sessionId: string; generation: string; createdAt: string }

const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]
const IDLE_EXIT_MS = 6 * 60 * 60 * 1000
const REACHABILITY_CHECK_MS = 30_000
const REACHABILITY_STRIKES = 2
// Consecutive event-stream mapping failures tolerated before the session is treated as genuinely
// broken. One bad event must not end hours of work; an endlessly throwing stream must not spin.
const EVENT_ERROR_TOLERANCE = 5

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

  const writeDiagnostic = config.diagnosticLogPath
    ? createClaudeBrokerDiagnosticWriter(config.diagnosticLogPath, { daemonPid: process.pid, generation })
    : undefined

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
    onDiagnostic: (diagnostic: ClaudeDiagnostic) => {
      // Persist FIRST, then relay. A `crashed` diagnostic is emitted with the process seconds from
      // gone, and relaying only reaches a fray that happens to be attached right now.
      writeDiagnostic?.(diagnostic)
      if (client) write(client, { t: "diagnostic", diagnostic })
    },
  })

  // ASK Claude to name the session, once, from the dispatch prompt.
  //
  // Claude Code normally titles a session by itself on the first user message and appends an
  // `ai-title` record to the session JSONL — the record fray's tailer folds into the board's
  // `aiTitle`, and without which the board shows "Spinning up a thread…" for 60s and then falls back
  // to a truncation of the raw dispatch prompt forever. That automatic titling is SUPPRESSED on the
  // Agent-SDK (headless) transport whenever a `SessionStart` hook is registered — and fray's broker
  // always loads the cc-worker plugin, whose hooks.json registers SessionStart. Bisected live against
  // 2.1.220: a plugin carrying ONLY a no-op `SessionStart` hook yields NO ai-title and never even
  // dispatches the titler's API request, while the same plugin carrying only PreToolUse / PostToolUse
  // / PermissionRequest hooks titles normally. It is provider behavior fray cannot switch off without
  // giving up the worker seeding, so the broker asks explicitly instead: the SDK's
  // `generate_session_title` control request with `persist: true` runs the SAME titler and writes the
  // SAME `ai-title` record, so nothing downstream of the JSONL changes.
  //
  // Fired on the FIRST input only, and only for a session this daemon STARTED: a resume re-attaches to
  // a transcript that already carries its title, and a follow-up must never rename the thread.
  // Deliberately not awaited by the caller (a title must never delay the turn) but tracked here so a
  // failure is a diagnostic rather than an unhandled rejection.
  let titleSeeded = config.resume === true
  const seedSessionTitle = (message: ClaudeInputMessage): void => {
    if (titleSeeded) return
    const text = typeof message?.text === "string" ? message.text.trim() : ""
    if (!text) return
    titleSeeded = true
    void handle.generateSessionTitle(text).catch((error: unknown) => {
      writeDiagnostic?.({ kind: "stderr", message: `session-title request failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false })
    })
  }

  // The session ending (claude exits) tears the daemon down — there is nothing left to hold.
  // The session ending (claude exits) tears the daemon down — there is nothing left to hold. But an
  // error out of the ITERATOR is a different thing entirely and used to be conflated with it: any
  // failure mapping one event to fray's typed shape landed in this `.catch` and killed the daemon,
  // the claude process, and every in-flight sub-agent. Live on 2026-07-27 a single control character
  // in a Bash command did exactly that to a multi-hour orchestrator thread.
  //
  // The mapper no longer throws for that case (claude-agent-sdk.ts degrades an unrepresentable tool
  // input instead), but the conflation itself was the deeper bug: losing one telemetry event must
  // never be a reason to destroy hours of an operator's work. So a mapping failure is now recorded
  // and the pump continues; only the stream genuinely ENDING tears the session down.
  // `handle` is its own async iterator (claude-agent-sdk.ts: `[Symbol.asyncIterator]() { return this }`),
  // so pulling with next() is exactly what `for await` did — it just lets ONE bad event be survivable.
  // Bounded: a stream that keeps throwing is genuinely broken, and retrying it forever would spin the
  // daemon at 100% CPU, which is a worse failure than the one being fixed.
  const pump = (async () => {
    let consecutiveErrors = 0
    for (;;) {
      let next: IteratorResult<ClaudeQueryEvent>
      try {
        next = await handle.next()
      } catch (error) {
        writeDiagnostic?.({
          kind: "stderr",
          message: `event stream error ${++consecutiveErrors}/${EVENT_ERROR_TOLERANCE} (session continues): ${error instanceof Error ? error.message : String(error)}`,
          truncated: false,
        })
        if (consecutiveErrors >= EVENT_ERROR_TOLERANCE) return // genuinely broken → end the session
        continue
      }
      consecutiveErrors = 0
      if (next.done) return
      emitEvent(next.value)
    }
  })().then(() => shutdown(0)).catch(() => shutdown(0))

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
        if (msg.t === "input") { const message = msg.message as ClaudeInputMessage; void handle.send(message).catch(() => {}); seedSessionTitle(message) }
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

  // A bind failure used to be an UNHANDLED 'error' event: node prints a stack and exits, and the host
  // spawns this daemon with stdio:"ignore" — so the stack goes nowhere, fray sees only a 30s "did not
  // become ready", and the operator gets "the thread went quiet". Note the `claude` child is already
  // running by this point, so this is also the moment it leaks. Record the cause, then shut down.
  // Reachable via a swept stateDir, EACCES, a >104-byte socket path on macOS, or an EADDRINUSE race.
  server.on("error", (error) => {
    writeDiagnostic?.({ kind: "lifecycle", phase: "crashed", message: `socket listen failed: ${error instanceof Error ? error.message : String(error)}` })
    void shutdown(1)
  })
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

/** Was node pointed AT THIS FILE, rather than this module being imported by something else?
 *
 *  Both sides go through realpath because the two are not otherwise comparable: node resolves ESM
 *  module URLs through the real path, while `process.argv[1]` is whatever string the spawner passed.
 *  On macOS a daemon spawned under a temp dir arrives as `/var/folders/…` and reports itself as
 *  `/private/var/folders/…` — a naive URL comparison silently answers "not the entry point" there,
 *  which is precisely the artifact-vs-dev divergence class that has bitten this daemon before. */
function startedAsProcessEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

// Standalone daemon entry: `node claude-agent-broker.ts` with config in FRAY_CLAUDE_BROKER.
if (process.env.FRAY_CLAUDE_BROKER) {
  const config = JSON.parse(process.env.FRAY_CLAUDE_BROKER) as ClaudeBrokerConfig
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => process.exit(0))
  runClaudeBroker(config)
} else if (startedAsProcessEntry()) {
  // Node was pointed AT THIS FILE and there is no configuration to broker. Exiting 0 here reports
  // success for a session that never started — the silent-death shape the detached-daemon closure
  // test exists to catch, and the reason that test has been red. Codex's daemon already fails this
  // way (readConfig throws when FRAY_CODEX_APP_SERVER_DAEMON is absent); match it.
  //
  // Gated on being the process ENTRY POINT, not merely on the env being absent: claude-broker-host
  // spawns `node <this file>` so argv[1] is exactly this module, while a test that IMPORTS
  // runClaudeBroker runs under the test runner's argv[1] and must keep loading cleanly.
  throw new Error("claude session broker started without FRAY_CLAUDE_BROKER")
}
