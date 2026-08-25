import {
  decodeBody,
  encodeBody,
  parseFrame,
  serializeFrame,
  stripHopByHop,
  type RelayDownFrame,
  type RelayUpFrame,
} from "@frizz/shared"

/**
 * One board's live connection, and the requests in flight over it.
 *
 * This is the half that runs INSIDE a Durable Object — one instance per claimed name, which is what
 * makes the routing work at all: a visitor's request for `ada.frizz.sh` and Ada's board socket have to
 * meet somewhere, and a DO keyed by the name is the only place in Workers where they reliably can.
 *
 * Kept apart from the Worker entry so it can be tested without workerd: everything it touches is
 * passed in. The DO wrapper is then thin enough to read in one screen.
 */

/** A WebSocket as this file uses it — Node's and workerd's both satisfy it. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface Pending {
  /** Head resolved; the body may still be streaming. */
  settle: (response: { status: number; headers: Array<[string, string]>; body: Uint8Array | null }) => void
  fail: (reason: string) => void
  /** Present once a streamed body is underway. */
  stream?: { push: (chunk: Uint8Array) => void; end: () => void }
}

export interface BoardSocketOptions {
  /** How long a visitor waits before the board is declared unresponsive. */
  requestTimeoutMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * The default is 30s because a board's SSE stream never "finishes" — the HEAD arrives promptly and the
 * body stays open. So the timeout guards the head only, and a stream that has started is never timed
 * out for still being open.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class BoardSocket {
  private socket: SocketLike | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly timers = new Map<string, unknown>()
  private counter = 0
  private readonly options: Required<Pick<BoardSocketOptions, "requestTimeoutMs" | "now">> &
    Pick<BoardSocketOptions, "setTimer" | "clearTimer">

  constructor(options: BoardSocketOptions = {}) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      now: options.now ?? Date.now,
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    }
  }

  get connected(): boolean {
    return this.socket !== null
  }

  /** A board has dialled in. Any previous socket is replaced — a reconnect wins over a corpse. */
  attach(socket: SocketLike): void {
    const previous = this.socket
    this.socket = socket
    if (previous) {
      // The old socket may simply be a stale reconnect from the same board. Requests in flight on it
      // cannot be answered, so fail them now rather than let visitors wait out the full timeout.
      this.failAll("the board reconnected")
      try {
        previous.close(1000, "replaced by a newer connection")
      } catch {
        // Already gone; nothing to do.
      }
    }
  }

  detach(socket: SocketLike): void {
    if (this.socket !== socket) return // a stale socket closing after being replaced
    this.socket = null
    this.failAll("the board disconnected")
  }

  private failAll(reason: string): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      this.clear(id)
      entry.fail(reason)
    }
  }

  private clear(id: string): void {
    const handle = this.timers.get(id)
    if (handle !== undefined) {
      this.timers.delete(id)
      this.options.clearTimer?.(handle)
    }
  }

  private send(frame: RelayDownFrame): boolean {
    if (!this.socket) return false
    try {
      this.socket.send(serializeFrame(frame))
      return true
    } catch {
      return false
    }
  }

  /**
   * Forward a visitor request and wait for the head.
   *
   * Resolves as soon as the STATUS AND HEADERS arrive. A streamed body is delivered through `onChunk`
   * afterwards, which is what lets an SSE response reach the visitor while it is still being produced
   * rather than being buffered until it ends — and it never ends.
   */
  async request(
    input: { method: string; url: string; headers: Array<[string, string]>; body?: Uint8Array },
    stream?: { push: (chunk: Uint8Array) => void; end: () => void }
  ): Promise<{ status: number; headers: Array<[string, string]>; body: Uint8Array | null }> {
    if (!this.socket) throw new Error("the board is not connected")
    const id = `r${++this.counter}`

    return new Promise((resolve, reject) => {
      const entry: Pending = {
        settle: resolve,
        fail: (reason) => reject(new Error(reason)),
        ...(stream ? { stream } : {}),
      }
      this.pending.set(id, entry)

      if (this.options.setTimer) {
        this.timers.set(
          id,
          this.options.setTimer(() => {
            if (!this.pending.delete(id)) return
            this.timers.delete(id)
            entry.fail("the board did not answer in time")
          }, this.options.requestTimeoutMs)
        )
      }

      const sent = this.send({
        t: "req",
        id,
        method: input.method,
        url: input.url,
        headers: stripHopByHop(input.headers),
        ...(input.body && input.body.byteLength > 0 ? { body: encodeBody(input.body) } : {}),
      })
      if (!sent) {
        this.pending.delete(id)
        this.clear(id)
        entry.fail("the board is not connected")
      }
    })
  }

  /** A frame arrived from the board. Unknown ids are ignored — a late answer is not an error. */
  handleFrame(raw: string): void {
    const frame = parseFrame(raw) as RelayUpFrame | null
    if (!frame) return
    const entry = this.pending.get(frame.id)

    switch (frame.t) {
      case "res": {
        if (!entry) return
        this.clear(frame.id)
        // The head is settled here, but the entry STAYS while a body streams — res-chunk and res-end
        // still need somewhere to land. Removing it now is what would drop an SSE body on the floor.
        if (frame.end) this.pending.delete(frame.id)
        entry.settle({
          status: frame.status,
          headers: stripHopByHop(frame.headers),
          body: frame.body ? decodeBody(frame.body) : null,
        })
        return
      }
      case "res-chunk": {
        entry?.stream?.push(decodeBody(frame.data))
        return
      }
      case "res-end": {
        if (!entry) return
        this.pending.delete(frame.id)
        entry.stream?.end()
        return
      }
      default:
        return
    }
  }
}
