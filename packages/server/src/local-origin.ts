import { isIP } from "node:net"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

// Fray deliberately binds its control plane to loopback. These are the only browser authorities the
// product serves; DNS names that merely begin with "localhost" and alternate 127/8 spellings are not
// equivalent trust identities. Browser Origin serialization is canonical, so requiring the exact
// serialized origin also rejects paths, credentials, trailing dots, and numeric-IP tricks.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"])
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const

type HeaderValue = string | string[] | undefined

export interface LocalRequestHeaders {
  host?: HeaderValue
  origin?: HeaderValue
  forwarded?: HeaderValue
  "x-forwarded-for"?: HeaderValue
  "x-forwarded-host"?: HeaderValue
  "x-forwarded-port"?: HeaderValue
  "x-forwarded-proto"?: HeaderValue
}

export interface ParsedLocalAuthority {
  /** Loopback by default; an IP literal or an allowed name once the operator exposes the port. */
  hostname: string
  port: number
  authority: string
}

/**
 * Which browser authorities this server answers to.
 *
 * Omitted (or `exposed: false`) is Fray's historical and default posture: loopback only, because the
 * port is bound to 127.0.0.1 and nothing else can reach it. `--host` deliberately breaks that
 * assumption, so an exposed server has to decide what a legitimate authority looks like without the
 * kernel deciding for it.
 *
 * The rule is Vite's `allowedHosts` rule, and for the same reason: the attack a non-loopback bind
 * newly enables is DNS rebinding, where an attacker's DOMAIN is made to resolve to this machine so a
 * victim's browser treats an attacker page as same-origin with Fray. That requires a NAME. An IP
 * literal cannot be rebound — the browser never asks a resolver — so every IP literal is accepted and
 * every DNS name must be named explicitly.
 */
export interface LocalAuthorityPolicy {
  /** True once the bind address is not loopback, which is the only thing that widens the rule. */
  exposed?: boolean
  /** DNS names accepted as this server's authority. `*` accepts any name (opt-in, never a default). */
  allowedHosts?: readonly string[]
}

function acceptsHostname(hostname: string, policy: LocalAuthorityPolicy | undefined): boolean {
  if (LOCAL_HOSTNAMES.has(hostname)) return true
  if (!policy?.exposed) return false
  // An IP literal is unrebindable, so the numeric address of any interface this server is bound to
  // (and, harmlessly, any other) is a legitimate authority the moment the operator exposes the port.
  if (isIP(hostname) !== 0) return true
  return (policy.allowedHosts ?? []).some((allowed) => allowed === "*" || allowed.toLowerCase() === hostname)
}

function oneHeader(value: HeaderValue): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower
}

function explicitPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" ? 443 : 80
}

function validExpectedPort(port: number | undefined): port is number {
  return Number.isInteger(port) && port! >= 1 && port! <= 65_535
}

/** Parse the browser's serialized Origin, accepting only authorities `policy` admits for this port. */
export function parseLocalHttpOrigin(
  value: HeaderValue,
  expectedPort: number,
  policy?: LocalAuthorityPolicy,
): ParsedLocalAuthority | null {
  const raw = oneHeader(value)
  if (!raw || !validExpectedPort(expectedPort) || raw !== raw.trim()) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // Origin is defined as a serialized origin, not an arbitrary URL. This exact comparison rejects a
  // trailing slash/path, case-normalization trick, userinfo, an explicit default port, or IP shorthand.
  if (url.protocol !== "http:" || url.origin !== raw) return null
  const hostname = normalizedHostname(url.hostname)
  if (!acceptsHostname(hostname, policy) || explicitPort(url) !== expectedPort) return null
  return { hostname, port: expectedPort, authority: url.host }
}

/** Parse an HTTP Host authority independently of Origin; forwarded headers are never authority here. */
export function parseLocalHost(
  value: HeaderValue,
  expectedPort: number,
  policy?: LocalAuthorityPolicy,
): ParsedLocalAuthority | null {
  const raw = oneHeader(value)
  if (!raw || !validExpectedPort(expectedPort) || raw !== raw.trim() || raw.includes(",")) return null
  let url: URL
  try {
    url = new URL(`http://${raw}`)
  } catch {
    return null
  }
  // Host is an authority only. URL parsing plus the exact host comparison prevents userinfo, paths,
  // encoded separators and canonicalized numeric aliases from becoming a trusted local host.
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null
  if (url.host.toLowerCase() !== raw.toLowerCase()) return null
  const hostname = normalizedHostname(url.hostname)
  if (!acceptsHostname(hostname, policy) || explicitPort(url) !== expectedPort) return null
  return { hostname, port: expectedPort, authority: url.host.toLowerCase() }
}

function hasForwardedAuthority(headers: LocalRequestHeaders): boolean {
  return FORWARDED_HEADERS.some((name) => headers[name] !== undefined)
}

/**
 * HTTP policy: Host must be this exact loopback server and any PRESENT Origin must name the SAME
 * canonical loopback hostname + actual port. Treating localhost, 127.0.0.1, and ::1 as interchangeable
 * would let an unrelated service bound to another loopback family on the same numeric port become an
 * authorized browser origin. Callers must explicitly opt a route/request into missing Origin compatibility
 * (the app does so for the read-only CLI health probe and browser-forbidden `Sec-Fetch-Site: same-origin`
 * requests); it is never accepted by the WebSocket policy below.
 */
export function isTrustedLocalHttpRequest(
  headers: LocalRequestHeaders,
  expectedPort: number,
  allowMissingOrigin = false,
  policy?: LocalAuthorityPolicy,
): boolean {
  if (hasForwardedAuthority(headers)) return false
  const host = parseLocalHost(headers.host, expectedPort, policy)
  if (!host) return false
  if (headers.origin === undefined) return allowMissingOrigin
  const origin = parseLocalHttpOrigin(headers.origin, expectedPort, policy)
  return !!origin && host.hostname === origin.hostname && host.port === origin.port
}

/** Return the exact origin for CORS reflection, or undefined for every non-local/prefix/port trick. */
export function allowedLocalCorsOrigin(
  origin: string,
  expectedPort: number,
  policy?: LocalAuthorityPolicy,
): string | undefined {
  return parseLocalHttpOrigin(origin, expectedPort, policy) ? origin : undefined
}

/**
 * Browser WebSockets are privileged control channels, so they require an Origin and it must be the
 * SAME canonical loopback host+port as the actual Host header. The socket's local port is authoritative;
 * Host and all forwarded claims are untrusted input. There is intentionally no production no-Origin
 * exception—non-browser test/CLI clients must send the same explicit Origin a browser would.
 */
export function isTrustedLocalWebSocketRequest(
  req: IncomingMessage,
  expectedPort = req.socket.localPort,
  policy?: LocalAuthorityPolicy,
): boolean {
  if (!validExpectedPort(expectedPort)) return false
  const headers = req.headers as LocalRequestHeaders
  if (hasForwardedAuthority(headers)) return false
  const host = parseLocalHost(headers.host, expectedPort, policy)
  const origin = parseLocalHttpOrigin(headers.origin, expectedPort, policy)
  return !!host && !!origin && host.hostname === origin.hostname && host.port === origin.port
}

/** Fray's default bind address. Nothing off this machine can reach a port bound here. */
export const LOOPBACK_BIND_HOST = "127.0.0.1"
/** What a bare `--host` means, matching Vite, Next, and every other dev server: every interface. */
export const ALL_INTERFACES_BIND_HOST = "0.0.0.0"

// Bind addresses that are still private to this machine. `::` and `0.0.0.0` are wildcards and are
// emphatically NOT here — a wildcard bind reaches every interface, which is the whole point of --host.
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"])

/**
 * Validate an operator-supplied `--host` / `FRAY_HOST` value and canonicalize it for `listen()`.
 *
 * Deliberately narrow: an IP literal or one of the loopback spellings. A DNS name is rejected rather
 * than resolved, because `listen()` would silently pick one A record and the operator would have no
 * way to see which interface they actually exposed.
 */
export function normalizeBindHost(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("--host requires an address")
  const bare = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed
  const lower = bare.toLowerCase()
  if (lower === "localhost") return LOOPBACK_BIND_HOST
  if (isIP(bare) === 0) {
    throw new Error(`invalid --host address: ${value} (use an IP address such as 0.0.0.0, :: or 127.0.0.1)`)
  }
  return bare
}

/** Does binding here put Fray on a network any other machine can reach? */
export function bindHostIsExposed(host: string): boolean {
  return !LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase())
}

/** Parse `--allowed-host a --allowed-host b` / `FRAY_ALLOWED_HOSTS=a,b` into a deduped lowercase list. */
export function normalizeAllowedHosts(values: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    for (const entry of value.split(",")) {
      const host = entry.trim().toLowerCase()
      if (host) seen.add(host)
    }
  }
  return [...seen]
}

/** Claim a sensitive upgrade with a small explicit denial instead of letting another WS router try it. */
export function rejectWebSocketUpgrade(socket: Duplex, status = 403, reason = "Forbidden"): void {
  const body = `${reason}\n`
  const response = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n")
  try {
    socket.end(response)
  } catch {
    try {
      socket.destroy()
    } catch {
      // The peer already disappeared while the policy rejected it.
    }
  }
}
