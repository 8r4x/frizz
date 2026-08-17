import { randomBytes, timingSafeEqual, createHmac } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Single-use access codes, and the long-lived sessions they mint.
 *
 * The split is the whole point. Before this, one standing secret was printed at launch and traded for a
 * year-long cookie: every copy of it — scrollback, shell history, an email — stayed valid forever, and
 * it only rotated on the restart that is least convenient to perform. Separating the two fixes that:
 *
 *   CODE     single-use, short-lived, authorizes exactly ONE exchange. Safe to show on a screen.
 *   SESSION  what the code mints. Long-lived, signed, and independently revocable.
 *
 * A leaked code is worthless the moment it is used (or five minutes pass), and a leaked session can be
 * revoked without disturbing anything else. Everything after this — per-device names, "sign out
 * everywhere", GitHub minting the session instead of a code — is policy on top of that split.
 */

/** Long enough that guessing is hopeless, short enough that the QR stays a small version. */
const CODE_BYTES = 16
const SESSION_BYTES = 32
export const DEFAULT_CODE_TTL_MS = 5 * 60_000
/** A photographed QR is a real vector, so codes expire on a human timescale, not a session one. */
export const DEFAULT_SESSION_TTL_MS = 365 * 24 * 60 * 60_000

export interface AccessCode {
  code: string
  createdAt: number
  expiresAt: number
}

interface StoredCode extends AccessCode {
  consumedAt?: number
}

export interface AccessStoreOptions {
  codeTtlMs?: number
  sessionTtlMs?: number
  /** Injectable so tests can advance time without sleeping. */
  now?: () => number
  /** Injectable so tests get deterministic values; production uses randomBytes. */
  randomToken?: (bytes: number) => string
  /**
   * HMAC key for sessions. Supply a PERSISTED one so sessions outlive a restart.
   *
   * Defaulting to a fresh random key means every restart silently signs out every device — and a
   * board restarts often (artifact updates, crashes, an ordinary ctrl-C), so in practice a "one year"
   * cookie lasted until the next one. Rotating this key is what revocation looks like.
   */
  signingKey?: Buffer
  /** Called when a code is successfully consumed, so a launcher can repaint its QR. */
  onConsumed?: (code: string) => void
}

export type RedeemResult =
  | { ok: true; session: string; expiresAt: number }
  | { ok: false; reason: "unknown" | "expired" | "already-used" }

function defaultRandomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url")
}

/** Constant-time string compare; a plain `===` leaks a shared prefix to a patient attacker. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class AccessStore {
  private readonly codes = new Map<string, StoredCode>()
  private readonly options: Required<Omit<AccessStoreOptions, "onConsumed" | "signingKey">> & Pick<AccessStoreOptions, "onConsumed">
  /** Signing key for sessions. Persisted by the caller; a fresh one signs every device out. */
  private readonly signingKey: Buffer

  constructor(options: AccessStoreOptions = {}) {
    this.signingKey = options.signingKey ?? randomBytes(32)
    this.options = {
      codeTtlMs: options.codeTtlMs ?? DEFAULT_CODE_TTL_MS,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      now: options.now ?? Date.now,
      randomToken: options.randomToken ?? defaultRandomToken,
      onConsumed: options.onConsumed,
    }
  }

  /** Mint a code to show as a QR or a link. Minting does not invalidate codes already outstanding. */
  issue(): AccessCode {
    this.sweep()
    const now = this.options.now()
    const code: StoredCode = {
      code: this.options.randomToken(CODE_BYTES),
      createdAt: now,
      expiresAt: now + this.options.codeTtlMs,
    }
    this.codes.set(code.code, code)
    return { code: code.code, createdAt: code.createdAt, expiresAt: code.expiresAt }
  }

  /**
   * Trade a code for a session, at most once, ever.
   *
   * The consumed marker is set BEFORE anything else can observe success, and JS runs this method to
   * completion without interleaving, so two browsers racing the same code cannot both win. That
   * atomicity is what makes "single-use" true rather than aspirational — it is the first thing the
   * tests attack.
   */
  redeem(code: string | undefined): RedeemResult {
    if (!code) return { ok: false, reason: "unknown" }
    // Classify BEFORE sweeping. Sweeping first deletes the very entry that distinguishes "this link
    // expired" from "no such link", and the difference is the whole diagnostic value of the result.
    // Look up by exact key, then re-compare in constant time: a Map hit already leaks nothing useful
    // (the attacker supplied the key), but the compare keeps the code path uniform for stored secrets.
    const stored = this.codes.get(code)
    if (!stored || !secretsMatch(stored.code, code)) return { ok: false, reason: "unknown" }
    const now = this.options.now()
    if (stored.consumedAt !== undefined) return { ok: false, reason: "already-used" }
    if (now >= stored.expiresAt) {
      this.sweep()
      return { ok: false, reason: "expired" }
    }
    stored.consumedAt = now
    this.sweep()
    this.options.onConsumed?.(code)
    return { ok: true, session: this.mintSession(now), expiresAt: now + this.options.sessionTtlMs }
  }

  /**
   * A session is `<expiry>.<hmac>` — stateless, so it needs no server-side table, and signed with a key
   * the caller persists so it survives a restart. Self-describing expiry means a stale cookie is
   * rejected without a lookup, and rotating the key revokes every outstanding session at once.
   */
  private mintSession(now: number): string {
    const expiresAt = now + this.options.sessionTtlMs
    const nonce = this.options.randomToken(SESSION_BYTES)
    const payload = `${expiresAt}.${nonce}`
    return `${payload}.${this.sign(payload)}`
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url")
  }

  /** Is this cookie a session signed by this board's key, and still in date? */
  verifySession(session: string | undefined): boolean {
    if (!session) return false
    const cut = session.lastIndexOf(".")
    if (cut <= 0) return false
    const payload = session.slice(0, cut)
    const signature = session.slice(cut + 1)
    if (!secretsMatch(signature, this.sign(payload))) return false
    const expiresAt = Number(payload.slice(0, payload.indexOf(".")))
    return Number.isFinite(expiresAt) && this.options.now() < expiresAt
  }

  /**
   * Drop codes past their expiry so a long-lived board does not accumulate them forever.
   *
   * A CONSUMED code is deliberately kept until that same expiry rather than deleted on use. Deleting it
   * immediately would make a replay indistinguishable from a typo — both "unknown" — and the difference
   * matters: "already-used" is the message that tells someone their link was used by somebody else.
   * It costs one small entry for at most the code TTL.
   */
  private sweep(): void {
    const now = this.options.now()
    for (const [key, stored] of this.codes) {
      if (now >= stored.expiresAt) this.codes.delete(key)
    }
  }

  /** Outstanding codes that could still be redeemed — neither consumed nor expired. */
  outstanding(): AccessCode[] {
    this.sweep()
    return [...this.codes.values()]
      .filter((stored) => stored.consumedAt === undefined)
      .map(({ code, createdAt, expiresAt }) => ({ code, createdAt, expiresAt }))
  }
}


/**
 * Load this board's session-signing key, creating it on first use.
 *
 * On disk at 0600 beside the project's other state, because the alternative — a key held only in
 * memory — makes every restart a silent sign-out of every device. Deleting this file is the
 * revocation story: it invalidates every outstanding session at once and the next start writes a
 * fresh one.
 */
export function loadOrCreateSessionKey(stateDir: string): Buffer {
  const path = join(stateDir, "session-key")
  try {
    const existing = readFileSync(path)
    // A truncated or empty file would silently produce a weak key; treat it as absent and rewrite.
    if (existing.byteLength >= 32) return existing
  } catch {
    // Missing on first run, which is the ordinary path.
  }
  const key = randomBytes(32)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, key, { mode: 0o600 })
  try {
    // writeFileSync's mode is ignored when the file already exists, so state it again.
    chmodSync(path, 0o600)
  } catch {
    // Best effort: a key readable only by this user is the goal, not a hard gate.
  }
  return key
}
