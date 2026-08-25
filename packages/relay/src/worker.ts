import { importClaimPublicKey, relayHandshakeInput, type RelayHandshake } from "@frizz/shared"
import { BoardSocket } from "./board-socket.ts"

/**
 * The relay: one wildcard hostname in front of every board.
 *
 * `*.frizz.sh` resolves here. A board dials in over a WebSocket and holds it open; a visitor's request
 * for that board's hostname is routed to the Durable Object holding that socket and framed down it.
 * No per-user DNS record and no per-user tunnel, which is what removes the 200-name ceiling the
 * tunnel design could never get past.
 *
 * WE ARE ON THE DATA PATH HERE, unlike the registrar. That is the trade this design makes deliberately:
 * unlimited names cost us the traffic. Nothing in the board is trusted to us — the visitor still meets
 * Frizz's own single-use access gate on the far side — but the bytes do pass through.
 */

export interface RelayEnv {
  BOARD: DurableObjectNamespace
  /** The apex boards hang off, e.g. `frizz.sh`. A hostname outside it is not ours to serve. */
  FRIZZ_ZONE: string
  /** Registry written by the registrar: `claim:<name>` → the record naming the owning pubkey. */
  CLAIMS: { get(key: string): Promise<string | null> }
}

/** How long a handshake may sit before the relay stops believing it. Matches the claim protocol. */
const HANDSHAKE_MAX_AGE_MS = 5 * 60_000

/** The label to the left of the zone, or null when the host is not one of ours. */
export function boardNameFor(hostname: string, zone: string): string | null {
  const suffix = `.${zone}`
  if (!hostname.endsWith(suffix)) return null
  const name = hostname.slice(0, -suffix.length)
  // One level only: Universal SSL covers `*.frizz.sh` and nothing deeper, so `a.b.frizz.sh` would
  // arrive with a certificate error anyway and must not be treated as a board.
  return name.length > 0 && !name.includes(".") ? name : null
}

/**
 * Is this handshake signed by the key that owns the name?
 *
 * The relay holds no secret of its own — it reads the pubkey the REGISTRAR recorded and checks the
 * signature against it. So a board proves itself with the same identity that claimed the name, and a
 * relay compromise leaks no credential capable of taking anyone's hostname.
 */
export async function handshakeAccepted(
  handshake: unknown,
  ownerPubkey: string | null,
  now: number
): Promise<boolean> {
  if (typeof handshake !== "object" || handshake === null) return false
  const candidate = handshake as Partial<RelayHandshake>
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.pubkey !== "string" ||
    typeof candidate.sig !== "string" ||
    typeof candidate.issuedAt !== "number"
  ) {
    return false
  }
  // The key must be the one on record. Without this any well-formed self-signed handshake would be
  // accepted, and a board could serve a name it never claimed.
  if (!ownerPubkey || candidate.pubkey !== ownerPubkey) return false
  if (Math.abs(now - candidate.issuedAt) > HANDSHAKE_MAX_AGE_MS) return false

  const key = await importClaimPublicKey(candidate.pubkey)
  if (!key) return false
  let signature: Uint8Array<ArrayBuffer>
  try {
    const binary = atob(candidate.sig.replace(/-/g, "+").replace(/_/g, "/"))
    signature = new Uint8Array(new ArrayBuffer(binary.length))
    for (let i = 0; i < binary.length; i++) signature[i] = binary.charCodeAt(i)
  } catch {
    return false
  }
  if (signature.byteLength !== 64) return false
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signature,
    relayHandshakeInput(candidate.name, candidate.pubkey, candidate.issuedAt)
  )
}

/** The owning pubkey the registrar recorded for a name, or null if the name is unclaimed. */
export async function ownerPubkeyFor(env: RelayEnv, name: string): Promise<string | null> {
  const raw = await env.CLAIMS.get(`claim:${name}`)
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as { pubkey?: unknown }
    return typeof record.pubkey === "string" ? record.pubkey : null
  } catch {
    return null
  }
}

/** One board's Durable Object: it holds the socket and answers visitors from it. */
export class Board {
  private readonly relay = new BoardSocket({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // The board dialling in.
    if (url.pathname === "/_relay/connect" && request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair()
      const server = pair[1]!
      server.accept()
      // ONE adapter object, attached and detached. BoardSocket compares by identity so a stale socket
      // closing late cannot tear down its replacement — handing detach a freshly built object with the
      // same methods therefore matches nothing, and the board stays "connected" forever after it has
      // gone. Every visitor then waits out the full request timeout instead of being told it is down.
      const adapter = {
        send: (data: string) => server.send(data),
        close: (code?: number, reason?: string) => server.close(code, reason),
      }
      this.relay.attach(adapter)
      server.addEventListener("message", (event) => {
        if (typeof event.data === "string") this.relay.handleFrame(event.data)
      })
      const drop = () => this.relay.detach(adapter)
      server.addEventListener("close", drop)
      server.addEventListener("error", drop)
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    // A visitor's WebSocket — a terminal. The board opens its own end locally and the two are linked
    // frame by frame. Without this a relayed board renders and streams but cannot be worked in, which
    // is most of what Frizz is for.
    if (request.headers.get("upgrade") === "websocket") {
      if (!this.relay.connected) return new Response("This Frizz board is not running right now.", { status: 502 })
      const pair = new WebSocketPair()
      const visitor = pair[1]!
      visitor.accept()
      const adapter = {
        send: (data: string) => visitor.send(data),
        close: (code?: number, reason?: string) => visitor.close(code, reason),
      }
      const id = await this.relay.openWebSocket({ url: url.toString(), headers: [...request.headers] }, adapter)
      if (!id) {
        // Refuse the upgrade outright rather than accepting a socket that will never carry anything.
        // A terminal pane that opens and stays silent is far harder to diagnose than one that fails.
        try {
          visitor.close(1011, "the board did not open a terminal")
        } catch {
          // Already gone.
        }
        return new Response("The board did not open a terminal.", { status: 502 })
      }
      visitor.addEventListener("message", (event) => {
        if (typeof event.data === "string") this.relay.sendWebSocketMessage(id, event.data)
      })
      const shut = () => this.relay.closeWebSocket(id)
      visitor.addEventListener("close", shut)
      visitor.addEventListener("error", shut)
      return new Response(null, { status: 101, webSocket: pair[0]! })
    }

    if (!this.relay.connected) {
      // The name exists but nothing is serving it. Said plainly, because "this board is offline" is a
      // different problem from "no such board" and the visitor can act on one of them.
      return new Response("This Frizz board is not running right now.", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      })
    }

    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    // A stream, so an SSE response reaches the visitor as it is produced rather than when it ends —
    // which for the board's event feed is never.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()

    try {
      const response = await this.relay.request(
        {
          method: request.method,
          url: url.toString(),
          headers: [...request.headers],
          ...(body && body.byteLength > 0 ? { body } : {}),
        },
        {
          push: (chunk) => void writer.write(chunk),
          end: () => void writer.close().catch(() => {}),
        }
      )
      // An inline body is the whole response, so write it and close. Otherwise the writer stays open
      // for chunks still to come — for the board's event feed, that is the normal case and it never
      // closes at all.
      if (response.body !== null) {
        void writer.write(response.body).then(() => writer.close().catch(() => {}))
      }
      return new Response(readable, { status: response.status, headers: response.headers })
    } catch (error) {
      void writer.close().catch(() => {})
      return new Response(`The board did not answer: ${error instanceof Error ? error.message : error}`, {
        status: 504,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      })
    }
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url)
    const name = boardNameFor(url.hostname, env.FRIZZ_ZONE)
    if (!name) {
      // Name the host it refused. A bare "Not found" here is indistinguishable from an unclaimed name
      // and from a routing mistake, which is exactly the confusion worth spending a line to avoid.
      return new Response(`${url.hostname} is not a board name under ${env.FRIZZ_ZONE}.`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }

    const owner = await ownerPubkeyFor(env, name)
    if (!owner) {
      return new Response("No Frizz board has claimed this name.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }

    // A board dialling in proves itself BEFORE reaching the Durable Object, so an unproven socket
    // never occupies a name's object at all.
    if (url.pathname === "/_relay/connect") {
      const raw = url.searchParams.get("h")
      let handshake: unknown = null
      try {
        handshake = raw ? JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) : null
      } catch {
        handshake = null
      }
      if (!(await handshakeAccepted(handshake, owner, Date.now()))) {
        return new Response("handshake rejected", { status: 401 })
      }
      if ((handshake as RelayHandshake).name !== name) {
        return new Response("handshake is for a different name", { status: 401 })
      }
    }

    return env.BOARD.get(env.BOARD.idFromName(name)).fetch(request)
  },
}
