// The durable launcher owns the browser-facing port.  A disposable Frizz control-plane child binds
// only a private loopback port, which means a browser can still ask the owner to recover it after a
// crash.  This intentionally contains no source-watch logic: stable and legacy launchers can share it.
import { request as requestHttp, createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { connect } from "node:net"
import { AccessStore, secretsMatch, type AccessCode } from "./access-codes.ts"
import {
  allowedLocalCorsOrigin,
  authoritySendsFetchMetadata,
  bindHostIsExposed,
  FORWARDED_HEADERS,
  isTrustedLocalHttpRequest,
  LOOPBACK_BIND_HOST,
  parseLocalHost,
  unlistedHostName,
  rejectWebSocketUpgrade,
  type LocalAuthorityPolicy,
} from "./local-origin.ts"
import { resolveLocalImage } from "./local-image.ts"
import { FRIZZ_ROUTE_PREFIX, frizzRoute } from "@frizz/shared"

export const SUPERVISOR_CONTROL_PREFIX = "/_frizz/control"
export const SUPERVISOR_RESTART_PATH = `${SUPERVISOR_CONTROL_PREFIX}/restart`
export const SUPERVISOR_UPDATE_RESTART_PATH = `${SUPERVISOR_CONTROL_PREFIX}/update-restart`
export const SUPERVISOR_STATUS_PATH = `${SUPERVISOR_CONTROL_PREFIX}/status`
export const SUPERVISOR_ACCESS_CODE_PATH = `${SUPERVISOR_CONTROL_PREFIX}/access-code`
export const SUPERVISOR_CONTROL_PROTOCOL = 1

export type RestartControlState = "ready" | "restarting" | "failed"

export interface RestartResult {
  // A durable update must acknowledge before it begins draining/re-execing the process which owns
  // the response socket.  "restarting" is therefore an accepted action, not a failed request.
  state: "ready" | "restarting" | "failed"
  message?: string
}

export interface RestartSupervisorProxyOptions {
  /** Public Frizz port held for the supervisor's whole lifetime. */
  port: number
  /** Bind address for the public port. Defaults to loopback; `--host` moves it onto the network. */
  host?: string
  /** DNS names a browser may use as this server's authority once `host` is not loopback. */
  allowedHosts?: readonly string[]
  /** Serialized origin of a reverse proxy fronting this port (`--public-origin`), if the operator named one. */
  publicOrigin?: string
  /**
   * Shared secret every request arriving AS `publicOrigin` must carry. Loopback is never gated.
   *
   * Frizz has no accounts, and a tunnelled board is a shell on the operator's machine reachable from
   * the internet — so the launcher generates one of these whenever a public origin is declared and
   * there is nothing else in front. It is a bearer secret, not a login: possession is the whole proof.
   * That is a deliberate floor, not the destination — a real session layer is the next step.
   */
  publicToken?: string
  /** Fired when an access code is redeemed, so a launcher can repaint a now-spent QR. */
  onCodeConsumed?: () => void
  /**
   * Persisted HMAC key for sessions. Without one, every restart signs out every device — which made a
   * nominally year-long cookie last only until the next artifact update.
   */
  sessionKey?: Buffer
  /** The current disposable child. Undefined means it is starting, stopped, or failed. */
  childPort: () => number | undefined
  /** Must coalesce work itself or return the same in-flight promise for repeat requests. */
  restart: () => Promise<RestartResult>
  /** Build/validate/promote a new immutable artifact, then restart the child. Omitted for legacy mode. */
  updateRestart?: () => Promise<RestartResult>
  /**
   * Is a NEWER artifact actually available right now? Distinct from `updateRestart`, which only says
   * the verb is WIRED — a distinction the UI needs and could not previously make, so a fully current
   * production Frizz still advertised "Update Frizz" and reinstalled its own version on click.
   *
   * Must be a CHEAP cached read: this runs on every status poll, so it may never touch the network.
   * Omitting it means "assume available", which keeps frizz-dev (where an update rebuilds from source
   * and is always meaningful) behaving exactly as before.
   */
  updateAvailable?: () => boolean
  /**
   * The published package version this launcher is running. Sent only by the registry launcher —
   * frizz-dev runs mutable checkout source, which has no version a user could act on, so it omits
   * this and the client shows no version line at all.
   */
  version?: string
  /**
   * The NEWER registry version `updateAvailable` is reporting, when the launcher has actually
   * observed one. Same contract as `updateAvailable`: a cheap CACHED read, refreshed off the status
   * path. Undefined while the registry has not answered yet or nothing newer exists — the client
   * falls back to its generic update copy rather than claiming a number it does not have.
   */
  updateVersion?: () => string | undefined
  /**
   * Is this Frizz a DEVELOPMENT build — launched from a source checkout by `frizz-dev` (src/index.ts)
   * or `pnpm dev` (server/src/dev.ts), rather than the published `frizz` bin (src/production.ts)?
   *
   * It exists because the web client cannot answer this for itself. `import.meta.env.DEV` is a Vite
   * COMPILE-TIME constant, true only under `vite dev` middleware — and frizz-dev's ordinary route
   * builds an immutable artifact and serves the Vite PRODUCTION bundle, where it is statically
   * `false`. So every dev-only affordance gated on it was dead-code eliminated out of the build the
   * maintainer actually runs all day. The launcher is the only thing that truly knows, so it says so
   * here, on the status the client already polls.
   */
  dev?: boolean
  /** Status is intentionally available without a child, for a useful recovery UI. */
  status?: () => { state: RestartControlState; message?: string; artifactDigest?: string }
}

function responseJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(value))
}

function recoveryPage(url: string, detail = "Frizz is restarting or unavailable."): string {
  // This is deliberately not an auto-refresh page. A broken child must not make a browser spin forever.
  const escaped = url.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
  return `<!doctype html><meta charset="utf-8"><title>Frizz recovering</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:3rem;font:16px system-ui;color:#e7e7e7;background:#171717}main{max-width:36rem;padding:1.5rem;border:1px solid #444;border-radius:.75rem;background:#222}a{color:#f7d64a}</style><main><h1>Frizz is recovering</h1><p>${detail}</p><p><a href="${escaped}">Try this page again</a></p></main>`
}

function proxyHeaders(
  req: IncomingMessage,
  childPort: number,
  vouchSameOrigin = false,
): Record<string, string | string[] | undefined> {
  const headers = { ...req.headers }
  // The child retains Frizz's strict local-origin policy. Translate public browser authority to the
  // private child authority; no external proxy authority is ever trusted.
  headers.host = `127.0.0.1:${childPort}`
  if (typeof headers.origin === "string") headers.origin = `http://127.0.0.1:${childPort}`
  // Whatever a fronting proxy claimed about the caller has already been judged here, and the child
  // refuses these outright — it has no --public-origin policy of its own and must not grow one, since
  // the rewrite above means it can no longer see who really called. Forwarding them 403s every request.
  for (const name of FORWARDED_HEADERS) delete headers[name]
  // The browser could not stamp this one (see RestartSupervisorProxy.vouchesSameOrigin), and the
  // proxy has already checked what the stamp would have proved. Supply it so the child's own
  // missing-Origin rules keep working instead of refusing the app's every read.
  if (vouchSameOrigin) headers["sec-fetch-site"] = "same-origin"
  delete headers.connection
  return headers
}

export const PUBLIC_TOKEN_PARAM = "frizz_token"
export const ACCESS_CODE_PARAM = "frizz_code"
const PUBLIC_TOKEN_COOKIE = "frizz_public"
const SESSION_COOKIE = "frizz_session"
/** Loopback spellings the token gate must never challenge — the operator's own tab on the box. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"])

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=")
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return undefined
}

function unauthorizedPage(reason?: "unknown" | "expired" | "already-used"): string {
  // Deliberately says nothing about what Frizz is or whose machine this is. An unauthenticated
  // visitor should not learn that a shell-capable board lives here. The reason is the one exception:
  // "already used" and "expired" send the operator to very different next actions, and neither
  // discloses anything to somebody who did not already hold a link.
  const detail = reason === "already-used"
    ? "That link has already been used. Generate a fresh one."
    : reason === "expired"
      ? "That link expired. Generate a fresh one."
      : "This address needs a current access link.";
  return `<!doctype html><meta charset="utf-8"><title>Unauthorized</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:3rem;font:16px system-ui;color:#e7e7e7;background:#171717}main{max-width:30rem;padding:1.5rem;border:1px solid #444;border-radius:.75rem;background:#222}</style><main><h1>Unauthorized</h1>${detail ? `<p>${detail}</p>` : ""}</main>`
}

/**
 * The refusal an operator sees after opening an exposed board by a name `--allowed-host` does not
 * list. Unlike unauthorizedPage this SAYS what Frizz is: the board is already open to this network by
 * IP with no gate at all, so naming the flag costs nothing and saves the guess. The name is escaped
 * even though the Host parser already refuses every character that could break markup.
 */
function unlistedHostPage(name: string): string {
  const shown = name.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
  return `<!doctype html><meta charset="utf-8"><title>Not served by this name</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:3rem;font:16px system-ui;color:#e7e7e7;background:#171717}main{max-width:34rem;padding:1.5rem;border:1px solid #444;border-radius:.75rem;background:#222}code{font:14px ui-monospace,monospace;padding:.1em .3em;border-radius:.3em;background:#333;white-space:nowrap}</style><main><h1>Not served by this name</h1><p>Frizz does not answer to <code>${shown}</code>. A name a browser has to resolve is how DNS rebinding makes another site's page count as this board, so an exposed board accepts only its own hostname and the names its operator lists.</p><p>Open the board by its IP address, or relaunch with <code>--allowed-host ${shown}</code> (or <code>FRIZZ_ALLOWED_HOSTS=${shown}</code>) to accept this one.</p></main>`
}

function isControlRequest(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://frizz.invalid")
  return url.pathname === SUPERVISOR_RESTART_PATH
    || url.pathname === SUPERVISOR_UPDATE_RESTART_PATH
    || url.pathname === SUPERVISOR_STATUS_PATH
    || url.pathname === SUPERVISOR_ACCESS_CODE_PATH
}

// `/_frizz/local-image` AND `/_frizz/<project>/local-image` — the client builds it from `apiBase()`,
// which carries the project slug on every prefixed board. Matching only the unprefixed spelling meant
// a prefixed board's inline screenshots were answered with the recovery HTML during a restart while an
// unprefixed one's still rendered.
function isLocalImageRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false
  const { pathname } = new URL(req.url ?? "/", "http://frizz.invalid")
  return LOCAL_IMAGE_PATH.test(pathname)
}
// Anchored on the reserved namespace, so only Frizz's own route matches — never some project file
// that happens to end in the same segment.
const LOCAL_IMAGE_PATH = new RegExp(`^${FRIZZ_ROUTE_PREFIX}(?:/[^/]+)?/local-image$`)

export class RestartSupervisorProxy {
  private server: Server | null = null
  private restartInFlight: Promise<RestartResult> | null = null
  private state: RestartControlState = "ready"
  private message: string | undefined
  private readonly options: RestartSupervisorProxyOptions
  private readonly host: string
  /**
   * The authorities a browser may name for the PUBLIC port. This proxy is the whole boundary: it
   * rewrites Host/Origin to the child's private loopback authority, so the child's own strict gate
   * can never see (or reject) the real browser authority. Everything this class forwards has to be
   * judged here first.
   */
  private readonly policy: LocalAuthorityPolicy
  /**
   * Codes and sessions for the public origin, or null when no public origin is declared (loopback-only
   * boards are never gated, so there is nothing to store).
   */
  private readonly access: AccessStore | null
  /** Both halves of every live upgraded pair, so close() can actually finish. See close(). */
  private readonly upgradedSockets = new Set<import("node:stream").Duplex>()

  constructor(options: RestartSupervisorProxyOptions) {
    this.options = options
    this.host = options.host ?? LOOPBACK_BIND_HOST
    this.access = options.publicOrigin
      ? new AccessStore({
          onConsumed: () => options.onCodeConsumed?.(),
          ...(options.sessionKey ? { signingKey: options.sessionKey } : {}),
        })
      : null
    this.policy = {
      exposed: bindHostIsExposed(this.host),
      allowedHosts: options.allowedHosts ?? [],
      ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
    }
  }

  /**
   * Mint a single-use code for this board, or null when no public origin is declared.
   *
   * Issuing does NOT invalidate codes already outstanding — pressing the key twice, or two people
   * asking at once, must not silently break the first QR somebody is still walking towards.
   */
  issueAccessCode(): AccessCode | null {
    return this.access?.issue() ?? null
  }

  /** The full URL to show as a link or a QR. */
  accessUrl(code: string): string | null {
    const origin = this.options.publicOrigin
    return origin ? `${origin}/?${ACCESS_CODE_PARAM}=${encodeURIComponent(code)}` : null
  }

  async listen(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => this.handle(req, res))
    server.keepAliveTimeout = 5_000
    server.headersTimeout = 10_000
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head))
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(this.options.port, this.host, () => {
        server.off("error", rejectListen)
        resolveListen()
      })
    })
    this.server = server
  }

  /**
   * Is this request allowed to reach the child at all?
   *
   * Deliberately the WEAKER of the two gates: a missing Origin passes here and the child then applies
   * its own per-route rule for it (only /health, /control/stop and `Sec-Fetch-Site: same-origin` may
   * omit one). What this stops is the thing the child cannot: an Origin naming somebody ELSE being
   * laundered into a valid same-origin one by proxyHeaders below.
   */
  private authorityAccepted(req: IncomingMessage, allowMissingOrigin = true): boolean {
    return isTrustedLocalHttpRequest(req.headers, this.options.port, allowMissingOrigin, this.policy)
  }

  /**
   * Is this an Origin-less request that only LOOKS suspicious because the browser could not send
   * Fetch Metadata to a non-loopback authority? See authoritySendsFetchMetadata.
   *
   * Frizz's missing-Origin rules ask for `Sec-Fetch-Site: same-origin`, which Chrome never sends over
   * plain HTTP to a LAN address — so without this, `--host` serves the shell and then 403s every RPC
   * the app makes. Narrow on purpose: the Host must already be an authority this proxy accepts, there
   * must be no Origin at all (a present one still has to match, and is rejected above if it does not),
   * and loopback traffic is never touched, so the default posture keeps the real Sec-Fetch signal.
   *
   * The condition is `authoritySendsFetchMetadata`, not "is the bind address exposed", because those
   * two came apart with `--public-origin`: a tunnelled board stays on loopback yet is reached at a
   * name. An https proxy origin is potentially trustworthy, so the real signal survives and this
   * never fires for it; a plain-http one is in the same boat as a LAN address and needs the vouch.
   *
   * What this gives up, stated plainly: on an exposed board a cross-site GET carries no Origin and no
   * Fetch Metadata, so it is indistinguishable from the app's own read and is allowed. The response is
   * still opaque to the caller (no CORS), Frizz's GET procedures are reads, and every mutation is a POST
   * — which a browser always stamps with an Origin, and which is therefore still refused.
   */
  private vouchesSameOrigin(req: IncomingMessage): boolean {
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) return false
    const host = parseLocalHost(req.headers.host, this.options.port, this.policy)
    return !!host && !authoritySendsFetchMetadata(host)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
      server.closeAllConnections()
      // An upgraded socket is DETACHED from the http server, so closeAllConnections() cannot see it
      // and server.close() waits on it forever. Frizz always has live WebSockets (the board socket and
      // every open terminal), so without this the proxy never finishes closing once a browser has
      // connected. Measured: close() hung indefinitely after a single forwarded upgrade.
      for (const socket of this.upgradedSockets) socket.destroy()
      this.upgradedSockets.clear()
    })
  }

  private status(): { state: RestartControlState; message?: string; artifactDigest?: string; updateRestart: boolean; updateAvailable?: boolean; version?: string; updateVersion?: string; dev?: boolean } {
    const delegated = this.options.status?.()
    const updateVersion = this.options.updateVersion?.()
    // The disposable child can quite correctly still report ready while the durable owner is building
    // a successor. The owner is the authority for that transition; never leak the old child's ready
    // state during it, or clients will send writes to a server that is about to disappear.
    const ownerTransition = this.restartInFlight !== null || this.state === "failed"
    return {
      ...(delegated ?? {}),
      ...(ownerTransition
        ? { state: this.state, ...(this.message ? { message: this.message } : {}) }
        : delegated ?? { state: this.state, ...(this.message ? { message: this.message } : {}) }),
      // Never infer this from the generic protocol: legacy/static supervisors can recover a child
      // but cannot build and promote the canonical Frizz artifact.
      updateRestart: typeof this.options.updateRestart === "function",
      // Sent ONLY when the launcher can actually answer it, so an older client — and frizz-dev, which
      // has no notion of "already current" — keeps today's behaviour on its absence.
      ...(this.options.updateAvailable ? { updateAvailable: this.options.updateAvailable() === true } : {}),
      // Version numbers ride the same launcher-only contract: absent for frizz-dev and legacy
      // supervisors, so their clients render exactly what they render today.
      ...(this.options.version ? { version: this.options.version } : {}),
      ...(updateVersion ? { updateVersion } : {}),
      // Sent only when TRUE, so a published Frizz's payload is byte-identical to what it sends today
      // and an older client is unaffected. Absent therefore means "not a development build".
      ...(this.options.dev ? { dev: true } : {}),
    }
  }

  private async runAction(action: () => Promise<RestartResult>): Promise<RestartResult> {
    if (this.restartInFlight) return this.restartInFlight
    this.state = "restarting"
    this.message = undefined
    // Yield one turn before running the action. The durable update's artifact build is SYNCHRONOUS
    // (execFileSync through the whole typecheck + web build + bundle), so invoking it inline would
    // block this event loop for tens of seconds — and the 202 ack the caller writes right after
    // this returns would not reach the browser until the build was already over, leaving the client
    // unable to arm its reload before the supervisor re-execs. The state flip above is synchronous,
    // so no status read can observe "ready" in the gap.
    const work = (async () => {
      await new Promise<void>((resume) => setImmediate(resume))
      return action()
    })().then(
      (result) => {
        this.state = result.state
        this.message = result.message
        return result
      },
      (error) => {
        const result: RestartResult = { state: "failed", message: error instanceof Error ? error.message : String(error) }
        this.state = result.state
        this.message = result.message
        return result
      },
    ).finally(() => { this.restartInFlight = null })
    this.restartInFlight = work
    return work
  }

  private async handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://frizz.invalid").pathname
    const sameOrigin = req.headers["sec-fetch-site"] === "same-origin" || this.vouchesSameOrigin(req)
    const allowMissingOrigin = pathname === SUPERVISOR_STATUS_PATH && req.method === "GET" && sameOrigin
    if (!this.authorityAccepted(req, allowMissingOrigin)) {
      res.writeHead(403)
      res.end("Forbidden")
      return
    }
    if (pathname === SUPERVISOR_ACCESS_CODE_PATH) {
      // LOOPBACK ONLY, deliberately. Minting is how you let a NEW device in, so it must require
      // presence on the machine — not merely a session, which anyone already through the tunnel has.
      // Otherwise one shared link silently becomes the power to hand out unlimited further links.
      if (this.arrivedPublicly(req)) {
        res.writeHead(403)
        res.end("Forbidden")
        return
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" })
        res.end()
        return
      }
      const link = this.issueAccessCode()
      const url = link && this.accessUrl(link.code)
      if (!link || !url) {
        responseJson(res, 409, { error: "this board has no public origin, so there is nothing to link to" })
        return
      }
      responseJson(res, 200, { url, expiresAt: link.expiresAt })
      return
    }
    if (pathname === SUPERVISOR_STATUS_PATH && req.method === "GET") {
      responseJson(res, 200, { protocol: SUPERVISOR_CONTROL_PROTOCOL, ...this.status() })
      return
    }
    if ((pathname !== SUPERVISOR_RESTART_PATH && pathname !== SUPERVISOR_UPDATE_RESTART_PATH) || req.method !== "POST") {
      res.writeHead(405, { allow: pathname === SUPERVISOR_STATUS_PATH ? "GET" : "POST" })
      res.end()
      return
    }
    if (pathname === SUPERVISOR_UPDATE_RESTART_PATH && !this.options.updateRestart) {
      responseJson(res, 409, { protocol: SUPERVISOR_CONTROL_PROTOCOL, state: "failed", message: "Update & Restart is available only for a stable immutable Frizz artifact" })
      return
    }
    if (pathname === SUPERVISOR_UPDATE_RESTART_PATH) {
      // Building and re-executing the durable owner can outlive (and intentionally close) this
      // response. Acknowledge ownership of the transition immediately; /status remains the source
      // of truth until a successor is ready or the candidate fails.
      void this.runAction(this.options.updateRestart!)
      responseJson(res, 202, { protocol: SUPERVISOR_CONTROL_PROTOCOL, state: "restarting" })
      return
    }
    const result = await this.runAction(this.options.restart)
    responseJson(res, result.state === "ready" ? 202 : 503, { protocol: SUPERVISOR_CONTROL_PROTOCOL, ...result })
  }

  private handleLocalImage(req: IncomingMessage, res: ServerResponse): void {
    const allowMissingOrigin = req.headers.origin === undefined
      && (req.headers["sec-fetch-site"] === "same-origin" || this.vouchesSameOrigin(req))
    if (!this.authorityAccepted(req, allowMissingOrigin)) {
      res.writeHead(403, { "content-type": "text/plain; charset=UTF-8" })
      res.end("Forbidden")
      return
    }

    const url = new URL(req.url ?? "/", "http://frizz.invalid")
    const result = resolveLocalImage(url.searchParams.get("path") ?? undefined)
    const origin = typeof req.headers.origin === "string"
      ? allowedLocalCorsOrigin(req.headers.origin, this.options.port, this.policy)
      : undefined
    const sharedHeaders = {
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      "access-control-expose-headers": "x-frizz-boot",
      vary: "Origin",
    }
    if (result.status !== 200) {
      res.writeHead(result.status, { ...sharedHeaders, "content-type": "text/plain; charset=UTF-8" })
      res.end(String(result.status))
      return
    }
    res.writeHead(200, {
      ...sharedHeaders,
      "content-type": result.contentType,
      "content-length": result.body.length,
      "cache-control": "private, max-age=60",
    })
    res.end(req.method === "HEAD" ? undefined : result.body)
  }

  /**
   * Is this request arriving as the declared public origin rather than over loopback?
   *
   * The token gate keys on this and not on "is the port exposed", because the two are independent:
   * a tunnelled board stays bound to 127.0.0.1 while being reachable from the internet by name.
   */
  private arrivedPublicly(req: IncomingMessage): boolean {
    const declared = this.options.publicOrigin
    if (!declared) return false
    const host = parseLocalHost(req.headers.host, this.options.port, this.policy)
    return !!host && !LOOPBACK_HOSTNAMES.has(host.hostname)
  }

  /**
   * Bearer check for the public origin. Two ways in: the cookie the exchange below sets, or the
   * one-time `?frizz_token=` in the URL the operator was handed at launch.
   *
   * Compared with `timingSafeEqual` on equal-length buffers — a plain `===` on a secret leaks its
   * prefix to a patient attacker, and this secret is the only thing between the internet and a shell.
   */
  /**
   * Is this request carrying a session this process minted?
   *
   * Sessions only. A raw `?frizz_code=` is NOT accepted here — it is redeemed once by exchangeCode()
   * below and traded for a session, so a code that has already been spent cannot keep working just by
   * staying in somebody's URL bar.
   */
  private sessionAccepted(req: IncomingMessage): boolean {
    if (!this.access) return true
    if (this.options.publicToken && this.legacyTokenAccepted(req)) return true
    return this.access.verifySession(readCookie(req.headers.cookie, SESSION_COOKIE))
  }

  /**
   * The standing `FRIZZ_PUBLIC_TOKEN`, for headless boxes where nobody can press a key to mint a code.
   * Deliberately kept as a separate, opt-in path rather than folded into sessions: it has the weaker
   * properties (never rotates, every copy stays valid) and the readout says so.
   */
  private legacyTokenAccepted(req: IncomingMessage): boolean {
    const expected = this.options.publicToken
    if (!expected) return false
    const url = new URL(req.url ?? "/", "http://frizz.invalid")
    const supplied = url.searchParams.get(PUBLIC_TOKEN_PARAM) ?? readCookie(req.headers.cookie, PUBLIC_TOKEN_COOKIE)
    return !!supplied && secretsMatch(supplied, expected)
  }

  /**
   * Trade `?frizz_code=…` (or the legacy `?frizz_token=…`) for a cookie, then bounce to the same URL
   * without the secret, so it never lands in history, a Referer header, or a screenshot.
   */
  private exchangeCode(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://frizz.invalid")
    const code = url.searchParams.get(ACCESS_CODE_PARAM)
    const legacy = url.searchParams.get(PUBLIC_TOKEN_PARAM)
    if (code === null && legacy === null) return false

    let cookie: string
    if (code !== null) {
      const redeemed = this.access?.redeem(code)
      if (!redeemed?.ok) {
        // Say WHICH failure. "This link was already used" and "no such link" send a person to very
        // different next actions, and the store keeps consumed codes precisely so we can tell them apart.
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(unauthorizedPage(redeemed?.reason))
        return true
      }
      cookie = `${SESSION_COOKIE}=${redeemed.session}`
    } else {
      if (!this.legacyTokenAccepted(req)) return false
      cookie = `${PUBLIC_TOKEN_COOKIE}=${this.options.publicToken}`
    }

    url.searchParams.delete(ACCESS_CODE_PARAM)
    url.searchParams.delete(PUBLIC_TOKEN_PARAM)
    const target = `${url.pathname}${url.search}${url.hash}` || "/"
    // Secure + SameSite=Lax: the origin is https through the tunnel, and Lax still permits the
    // top-level navigation that lands here while refusing cross-site writes.
    res.writeHead(302, {
      location: target,
      "set-cookie": `${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
      "cache-control": "no-store",
    })
    res.end()
    return true
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (isControlRequest(req)) {
      void this.handleControl(req, res)
      return
    }
    // Exchange FIRST: the arriving link carries the credential, so judging before redeeming would
    // reject the very request that is meant to establish the session.
    if (this.arrivedPublicly(req) && this.exchangeCode(req, res)) return
    if (this.arrivedPublicly(req) && !this.sessionAccepted(req)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(unauthorizedPage())
      return
    }
    if (!this.authorityAccepted(req)) {
      const name = unlistedHostName(req.headers.host, this.options.port, this.policy)
      if (name) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(req.method === "HEAD" ? undefined : unlistedHostPage(name))
        return
      }
      res.writeHead(403, { "content-type": "text/plain; charset=UTF-8" })
      res.end("Forbidden")
      return
    }
    // Keep screenshots responsive even while the disposable child is parsing large transcripts,
    // restarting, or unavailable. The durable owner applies the same local-origin gate itself.
    if (isLocalImageRequest(req)) {
      this.handleLocalImage(req, res)
      return
    }
    const childPort = this.options.childPort()
    if (!childPort) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "2" })
      res.end(recoveryPage(req.url ?? "/"))
      return
    }
    const upstream = requestHttp({
      host: "127.0.0.1",
      port: childPort,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req, childPort, this.vouchesSameOrigin(req)),
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    upstream.once("error", () => {
      if (res.headersSent) return res.destroy()
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(recoveryPage(req.url ?? "/", "The Frizz application server is unavailable. Use Restart Frizz to recover it."))
    })
    req.pipe(upstream)
  }

  private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    // The board socket and every terminal come through here, so the bearer gate has to cover the
    // upgrade too — otherwise the shell is reachable without the secret the HTML path demands. No
    // query-param exchange here: a browser sends the cookie it was given on the page that opened it.
    if (this.arrivedPublicly(req) && !this.sessionAccepted(req)) {
      rejectWebSocketUpgrade(socket, 401, "Unauthorized")
      return
    }
    // A browser always sends Origin on a WebSocket handshake and the child requires one, so this is
    // the strict form of the gate — the child will never get the chance to apply it itself.
    if (!this.authorityAccepted(req, false)) {
      socket.destroy()
      return
    }
    const childPort = this.options.childPort()
    if (!childPort) {
      socket.destroy()
      return
    }
    const upstream = connect(childPort, "127.0.0.1")
    for (const half of [socket, upstream]) {
      this.upgradedSockets.add(half)
      half.once("close", () => this.upgradedSockets.delete(half))
    }
    upstream.once("connect", () => {
      const headers = proxyHeaders(req, childPort)
      // proxyHeaders drops the hop-by-hop `connection` header (right for the plain-HTTP handle()
      // path). But a WebSocket upgrade REQUIRES it: without `Connection: Upgrade` the child's HTTP
      // parser never emits 'upgrade', answers the SPA with 200, and the handshake fails — silently
      // breaking the terminal and the /ws multiplex through the control-plane proxy. Restore it.
      headers.connection = req.headers.connection ?? "Upgrade"
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.once("error", () => socket.destroy())
    socket.once("error", () => upstream.destroy())
  }
}
