/**
 * The workerd globals this package uses, and nothing else.
 *
 * Declared here rather than pulling in `@cloudflare/workers-types`, for the same reason the registrar
 * declares its KV binding structurally: this package is typechecked by the repo's ordinary Node
 * tsconfig alongside its own tests, and the full Workers types replace the Node globals those tests
 * need. A real workerd runtime satisfies every one of these.
 */

interface DurableObjectId {
  toString(): string
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

interface DurableObjectState {
  readonly id: DurableObjectId
}

/** A message event as workerd delivers it: `data` is a string for a text frame. */
interface WorkerMessageEvent extends Event {
  readonly data: string | ArrayBuffer
}

/** workerd's WebSocket: the server half must be `accept()`ed before it will deliver events. */
interface WorkerWebSocket extends EventTarget {
  accept(): void
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", listener: (event: WorkerMessageEvent) => void): void
  addEventListener(type: "close" | "error", listener: (event: Event) => void): void
}

declare class WebSocketPair {
  0: WorkerWebSocket
  1: WorkerWebSocket
}

interface ResponseInit {
  /** workerd's extension: the client half of a pair, returned with a 101. */
  webSocket?: WorkerWebSocket | null
}
