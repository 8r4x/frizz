/**
 * The wire between a board and the relay that fronts it.
 *
 * A board dials OUT to the relay and keeps one WebSocket open. Every visitor request for that board's
 * hostname is then framed down that socket and answered back up it, so the board needs no inbound
 * port, no tunnel binary, and no DNS record of its own — which is the whole reason this exists. One
 * wildcard record serves every name instead of one record per user.
 *
 * DEPENDENCY-FREE, like claim.ts and for the same reason: the board runs this on Node and the relay
 * runs it on workerd.
 *
 * WHAT THIS HAS TO CARRY, and why a plain request/response relay would be useless for Frizz: the board
 * is mostly a live surface. Its event feed is SSE and its terminals are WebSockets. So the protocol
 * frames three things, not one — a unary request, a STREAMED response body, and a nested WebSocket.
 */

export const RELAY_PROTOCOL_VERSION = 1

/** Frames the relay sends DOWN to the board. */
export type RelayDownFrame =
  /** A visitor request. `body` is base64; absent means no body. */
  | { t: "req"; id: string; method: string; url: string; headers: Array<[string, string]>; body?: string }
  /** A visitor wants a WebSocket (a terminal). The board dials its local one and links them. */
  | { t: "ws-open"; id: string; url: string; headers: Array<[string, string]> }
  /** A visitor's WebSocket message. */
  | { t: "ws-msg"; id: string; data: string; binary?: boolean }
  /** The visitor's side closed. */
  | { t: "ws-close"; id: string; code?: number }
  /** Keep-alive. The board answers with `pong` so a dead socket is noticed rather than assumed live. */
  | { t: "ping"; id: string }

/** Frames the board sends UP to the relay. */
export type RelayUpFrame =
  /** Response head. `end` means there is no streamed body to follow. */
  | {
      t: "res"
      id: string
      status: number
      headers: Array<[string, string]>
      body?: string
      end: boolean
    }
  /** A chunk of a streamed body — how SSE reaches a visitor at all. */
  | { t: "res-chunk"; id: string; data: string }
  /** The streamed body is finished. */
  | { t: "res-end"; id: string }
  /** The board accepted (or refused) the nested WebSocket. */
  | { t: "ws-ack"; id: string; ok: boolean; status?: number }
  | { t: "ws-msg"; id: string; data: string; binary?: boolean }
  | { t: "ws-close"; id: string; code?: number }
  | { t: "pong"; id: string }

export type RelayFrame = RelayDownFrame | RelayUpFrame

/**
 * Headers a relay must never forward verbatim.
 *
 * Hop-by-hop headers describe THIS connection, not the message, so replaying them onto a different
 * connection is wrong at best. `content-length` is dropped because a streamed body's length is not
 * known when the head is sent, and a stale one truncates the response.
 */
export const RELAY_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
])

export function stripHopByHop(headers: Array<[string, string]>): Array<[string, string]> {
  return headers.filter(([name]) => !RELAY_STRIPPED_HEADERS.has(name.toLowerCase()))
}

/** base64 for a body, so one JSON frame carries any bytes without a second channel. */
export function encodeBody(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBody(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The largest body carried in ONE frame.
 *
 * A Cloudflare WebSocket message caps at 1 MiB, and base64 costs a third on top, so the real ceiling
 * is well under that. Anything bigger is streamed as chunks instead — which is the same path SSE uses,
 * so there is one streaming implementation rather than two.
 */
export const RELAY_MAX_FRAME_BODY = 512 * 1024

export function parseFrame(raw: string): RelayFrame | null {
  try {
    const value = JSON.parse(raw) as RelayFrame
    if (typeof value !== "object" || value === null) return null
    if (typeof (value as { t?: unknown }).t !== "string") return null
    if (typeof (value as { id?: unknown }).id !== "string") return null
    return value
  } catch {
    return null
  }
}

export const serializeFrame = (frame: RelayFrame): string => JSON.stringify(frame)

/**
 * The handshake a board presents when it dials in.
 *
 * Signed with the SAME Ed25519 identity that claimed the name, so the relay can prove the connection
 * belongs to whoever owns it without holding any secret of its own. `issuedAt` bounds a replay the
 * way a claim does.
 */
export interface RelayHandshake {
  v: number
  name: string
  pubkey: string
  issuedAt: number
  sig: string
}

/**
 * The exact bytes a handshake signs. Fixed order, and no field can contain the separator.
 *
 * Typed to a concrete ArrayBuffer because Web Crypto's `BufferSource` will not take the default
 * `Uint8Array<ArrayBufferLike>` — that also admits a SharedArrayBuffer, which these APIs reject.
 */
export function relayHandshakeInput(name: string, pubkey: string, issuedAt: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    ["frizz-relay", `v${RELAY_PROTOCOL_VERSION}`, name, pubkey, String(issuedAt)].join(":")
  )
}
