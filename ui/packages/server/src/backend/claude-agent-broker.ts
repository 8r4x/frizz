// The Claude session broker: a DETACHED daemon that owns one Claude Agent SDK session and relays it
// over a local socket. This is the piece Claude Code does not ship (codex's app-server is the same
// shape): it lets the session OUTLIVE fray, so fray reconnects to the LIVE session after a restart
// instead of cold-resuming from disk — and it keeps structured, TYPED control (no TUI scraping, no
// tmux). The SDK stays, but as this daemon's implementation detail: fray talks a small typed socket
// protocol, never the SDK directly.
//
// Wire protocol — newline-delimited JSON, each line one typed frame:
//   fray -> broker:  {t:"input", message}        a user turn (ClaudeInputMessage)
//                    {t:"permission", requestId, decision}   answer a permission request
//                    {t:"interrupt"} | {t:"set-mode", mode}
//   broker -> fray:  {t:"hello", sessionId}      sent on every (re)connect
//                    {t:"event", event}          a ClaudeQueryEvent (init/assistant/user/result/…)
//                    {t:"permission-request", requestId, request}   ClaudePermissionRequest, answer required
//                    {t:"diagnostic", diagnostic}
import net from "node:net"
import { createClaudeQueryFactory } from "./claude-agent-sdk.ts"
import type {
  ClaudeDiagnostic,
  ClaudeInputMessage,
  ClaudePermissionDecision,
  ClaudePermissionRequest,
  ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"

export interface ClaudeBrokerConfig {
  socketPath: string
  cwd: string
  sessionId: string
  executablePath: string
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"
  /** Allowlisted keys only — the SDK validates and rejects anything else. */
  env: Record<string, string>
}

// Env allowlist the SDK enforces; the broker forwards only these.
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]

export function runClaudeBroker(config: ClaudeBrokerConfig): { close: () => Promise<void> } {
  let client: net.Socket | null = null
  const eventBacklog: string[] = [] // events that arrive while no client is attached (flushed on connect)
  const pendingPermissions = new Map<string, { request: ClaudePermissionRequest; resolve: (d: ClaudePermissionDecision) => void }>()
  let permSeq = 0

  const write = (sock: net.Socket, frame: unknown) => sock.write(JSON.stringify(frame) + "\n")
  const emitEvent = (event: ClaudeQueryEvent) => {
    if (client) write(client, { t: "event", event })
    else eventBacklog.push(JSON.stringify({ t: "event", event }) + "\n")
  }

  const factory = createClaudeQueryFactory({ enabled: true, executablePath: config.executablePath })
  const handle = factory.start({
    cwd: config.cwd,
    session: { kind: "new", sessionId: config.sessionId },
    permissionMode: config.permissionMode ?? "default",
    env: Object.fromEntries(ENV_ALLOWLIST.filter((k) => config.env[k] != null).map((k) => [k, config.env[k]!])),
    persistSession: true, // write the tailer-readable transcript JSONL
    canUseTool: async (request) => {
      // Turn the permission request into a socket round-trip. If no client is attached the promise
      // simply stays pending — the session is "blocked", exactly like waiting on a human — and the
      // request is re-delivered when a client (re)connects.
      const requestId = `perm-${++permSeq}`
      return await new Promise<ClaudePermissionDecision>((resolve) => {
        pendingPermissions.set(requestId, { request, resolve })
        if (client) write(client, { t: "permission-request", requestId, request })
      })
    },
    onDiagnostic: (diagnostic: ClaudeDiagnostic) => { if (client) write(client, { t: "diagnostic", diagnostic }) },
  })

  // Pump the SDK event stream to the attached client (or backlog).
  const pump = (async () => { for await (const event of handle) emitEvent(event) })().catch(() => {})

  const server = net.createServer((sock) => {
    client = sock
    write(sock, { t: "hello", sessionId: handle.sessionId })
    // Re-deliver any permission requests still awaiting an answer, then flush buffered events.
    for (const [requestId, { request }] of pendingPermissions) write(sock, { t: "permission-request", requestId, request })
    while (eventBacklog.length) sock.write(eventBacklog.shift()!)

    let buf = ""
    sock.on("data", (chunk) => {
      buf += chunk
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.t === "input") void handle.send(msg.message as ClaudeInputMessage).catch(() => {})
        else if (msg.t === "permission") {
          const entry = pendingPermissions.get(msg.requestId as string)
          if (entry) { pendingPermissions.delete(msg.requestId as string); entry.resolve(msg.decision as ClaudePermissionDecision) }
        } else if (msg.t === "interrupt") void handle.interrupt().catch(() => {})
        else if (msg.t === "set-mode") void handle.setPermissionMode(msg.mode as never).catch(() => {})
      }
    })
    sock.on("close", () => { if (client === sock) client = null }) // fray gone; session stays alive
    sock.on("error", () => {})
  })
  server.listen(config.socketPath)

  return {
    close: async () => {
      server.close()
      await handle.close().catch(() => {})
      await pump
    },
  }
}

// Standalone daemon entry: `node claude-agent-broker.ts` with config in FRAY_CLAUDE_BROKER.
if (process.env.FRAY_CLAUDE_BROKER) {
  const config = JSON.parse(process.env.FRAY_CLAUDE_BROKER) as ClaudeBrokerConfig
  runClaudeBroker(config)
}
