// The fray SIDE of the Claude session broker: a typed client that connects to a broker daemon's
// socket (see claude-agent-broker.ts) and speaks the same newline-delimited typed protocol. It
// auto-reconnects — both while the daemon is still binding right after spawn, and if the connection
// drops — which is exactly what lets fray reattach to a LIVE session after fray itself restarts.
import net from "node:net"
import type {
  ClaudeDiagnostic,
  ClaudeInputMessage,
  ClaudePermissionDecision,
  ClaudePermissionRequest,
  ClaudeQueryEvent,
} from "./claude-agent-sdk-protocol.ts"

export interface ClaudeBrokerClientHandlers {
  /** A session/transcript event (init/assistant/user/result/…) from the live SDK session. */
  onEvent?: (event: ClaudeQueryEvent) => void
  /** A tool-permission request that must be answered with answerPermission(requestId, …). */
  onPermissionRequest?: (requestId: string, request: ClaudePermissionRequest) => void
  onDiagnostic?: (diagnostic: ClaudeDiagnostic) => void
  /** Sent on every (re)connect; carries the broker's session id. */
  onHello?: (sessionId: string) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

export interface ClaudeBrokerClient {
  sendInput(message: ClaudeInputMessage): void
  answerPermission(requestId: string, decision: ClaudePermissionDecision): void
  interrupt(): void
  setPermissionMode(mode: string): void
  connected(): boolean
  close(): void
}

interface Options {
  /** Give up (call onDisconnect for good) after this long without a connection. Default 30s. */
  connectDeadlineMs?: number
  retryDelayMs?: number
}

export function connectClaudeBroker(
  socketPath: string,
  handlers: ClaudeBrokerClientHandlers,
  options: Options = {},
): ClaudeBrokerClient {
  const retryDelayMs = options.retryDelayMs ?? 250
  let sock: net.Socket | null = null
  let closed = false
  let buf = ""
  const outbound: string[] = [] // frames queued while not connected (e.g. the first prompt sent right after spawn)
  let firstConnectDeadline = Date.now() + (options.connectDeadlineMs ?? 30_000)

  const send = (frame: unknown): void => {
    const line = JSON.stringify(frame) + "\n"
    if (sock && !sock.destroyed) sock.write(line)
    else outbound.push(line)
  }

  const onData = (chunk: Buffer): void => {
    buf += chunk
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let frame: Record<string, unknown>
      try { frame = JSON.parse(line) } catch { continue }
      switch (frame.t) {
        case "hello": handlers.onHello?.(frame.sessionId as string); break
        case "event": handlers.onEvent?.(frame.event as ClaudeQueryEvent); break
        case "permission-request": handlers.onPermissionRequest?.(frame.requestId as string, frame.request as ClaudePermissionRequest); break
        case "diagnostic": handlers.onDiagnostic?.(frame.diagnostic as ClaudeDiagnostic); break
      }
    }
  }

  const connect = (): void => {
    if (closed) return
    const next = net.connect(socketPath)
    next.on("connect", () => { sock = next; buf = ""; firstConnectDeadline = Number.POSITIVE_INFINITY; while (outbound.length) next.write(outbound.shift()!); handlers.onConnect?.() })
    next.on("data", onData)
    const drop = (): void => {
      if (next === sock) { sock = null; handlers.onDisconnect?.() }
      if (closed) return
      // Keep retrying: the daemon may still be binding (right after spawn), or the link dropped and
      // the session is still alive behind it. Only give up if we never connected within the deadline.
      if (sock === null && Date.now() > firstConnectDeadline) { closed = true; return }
      setTimeout(connect, retryDelayMs)
    }
    next.on("close", drop)
    next.on("error", () => next.destroy())
  }
  connect()

  return {
    sendInput: (message: ClaudeInputMessage) => send({ t: "input", message }),
    answerPermission: (requestId: string, decision: ClaudePermissionDecision) => send({ t: "permission", requestId, decision }),
    interrupt: () => send({ t: "interrupt" }),
    setPermissionMode: (mode: string) => send({ t: "set-mode", mode }),
    connected: () => sock !== null && !sock.destroyed,
    close: () => { closed = true; sock?.destroy(); sock = null },
  }
}
