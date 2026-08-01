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
  /** The claude.ai address this session is reachable at through Remote Control. Fires when the daemon
   *  finishes registering, and again on every reconnect that finds a daemon already registered — so a
   *  fray restart re-learns it rather than dropping the thread's only route to a phone. */
  onRemoteControl?: (url: string) => void
  /** Sent on every (re)connect; carries the broker's session id. */
  onHello?: (sessionId: string) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

export interface ClaudeBrokerClient {
  sendInput(message: ClaudeInputMessage): void
  answerPermission(requestId: string, decision: ClaudePermissionDecision): void
  interrupt(): void
  /**
   * Take a still-queued input back out of the session, by the id `sendInput` supplied. The ONE
   * round-trip in this protocol: resolves with the CLI's own verdict (true ⇒ the agent will never
   * read it), rejects when the daemon does not answer inside the deadline. Never resolves optimistically —
   * a caller that cannot tell "unqueued" from "already delivered" has nothing to tell the operator.
   */
  cancelInput(id: string): Promise<boolean>
  /** Stop one provider background task and resolve only after the daemon confirms the SDK call. */
  stopTask(taskId: string): Promise<void>
  setPermissionMode(mode: string): void
  connected(): boolean
  close(): void
}

interface Options {
  /** Give up (call onDisconnect for good) after this long without a connection. Default 30s. */
  connectDeadlineMs?: number
  retryDelayMs?: number
  /** How long a `cancelInput` waits for the daemon's verdict before rejecting. Default 10s. */
  cancelTimeoutMs?: number
}

export function connectClaudeBroker(
  socketPath: string,
  handlers: ClaudeBrokerClientHandlers,
  options: Options = {},
): ClaudeBrokerClient {
  const retryDelayMs = options.retryDelayMs ?? 250
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 10_000
  let sock: net.Socket | null = null
  let closed = false
  let buf = ""
  const outbound: string[] = [] // frames queued while not connected (e.g. the first prompt sent right after spawn)
  let firstConnectDeadline = Date.now() + (options.connectDeadlineMs ?? 30_000)
  // In-flight cancelInput round-trips, keyed by the request id echoed on the reply.
  const pendingCancels = new Map<string, { settle: (cancelled: boolean) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
  const pendingStops = new Map<string, { settle: () => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>()
  let cancelSeq = 0

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
        case "hello": {
          handlers.onHello?.(frame.sessionId as string)
          if (typeof frame.remoteControlUrl === "string" && frame.remoteControlUrl) handlers.onRemoteControl?.(frame.remoteControlUrl)
          break
        }
        case "remote-control": if (typeof frame.url === "string" && frame.url) handlers.onRemoteControl?.(frame.url); break
        case "event": handlers.onEvent?.(frame.event as ClaudeQueryEvent); break
        case "permission-request": handlers.onPermissionRequest?.(frame.requestId as string, frame.request as ClaudePermissionRequest); break
        case "diagnostic": handlers.onDiagnostic?.(frame.diagnostic as ClaudeDiagnostic); break
        case "cancel-result": {
          const entry = pendingCancels.get(frame.requestId as string)
          if (!entry) break
          pendingCancels.delete(frame.requestId as string)
          clearTimeout(entry.timer)
          // The daemon reports its own failure rather than dropping the request; surface it verbatim
          // so the operator learns WHY their message could not be taken back.
          if (typeof frame.error === "string" && frame.error) entry.fail(new Error(frame.error))
          else entry.settle(frame.cancelled === true)
          break
        }
        case "stop-result": {
          const entry = pendingStops.get(frame.requestId as string)
          if (!entry) break
          pendingStops.delete(frame.requestId as string)
          clearTimeout(entry.timer)
          if (typeof frame.error === "string" && frame.error) entry.fail(new Error(frame.error))
          else entry.settle()
          break
        }
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
    cancelInput: (id: string) => new Promise<boolean>((resolve, reject) => {
      if (closed) { reject(new Error("the broker connection is closed")); return }
      const requestId = `cancel-${++cancelSeq}`
      const timer = setTimeout(() => {
        pendingCancels.delete(requestId)
        reject(new Error("the Claude session did not answer the unqueue request"))
      }, cancelTimeoutMs)
      if (timer.unref) timer.unref()
      pendingCancels.set(requestId, { settle: resolve, fail: reject, timer })
      // Rides the same `send` as every other frame, so a request issued in the sliver between a socket
      // blip and its reconnect is replayed rather than lost — and if the daemon never comes back, the
      // deadline above is what answers instead.
      send({ t: "cancel-input", requestId, id })
    }),
    stopTask: (taskId: string) => new Promise<void>((resolve, reject) => {
      if (closed) { reject(new Error("the broker connection is closed")); return }
      const requestId = `stop-${++cancelSeq}`
      const timer = setTimeout(() => {
        pendingStops.delete(requestId)
        reject(new Error("the Claude session did not answer the stop request"))
      }, cancelTimeoutMs)
      if (timer.unref) timer.unref()
      pendingStops.set(requestId, { settle: resolve, fail: reject, timer })
      send({ t: "stop-task", requestId, taskId })
    }),
    setPermissionMode: (mode: string) => send({ t: "set-mode", mode }),
    connected: () => sock !== null && !sock.destroyed,
    close: () => {
      closed = true
      for (const [, entry] of pendingCancels) { clearTimeout(entry.timer); entry.fail(new Error("the broker connection closed before the unqueue was answered")) }
      pendingCancels.clear()
      for (const [, entry] of pendingStops) { clearTimeout(entry.timer); entry.fail(new Error("the broker connection closed before the stop was answered")) }
      pendingStops.clear()
      sock?.destroy(); sock = null
    },
  }
}
