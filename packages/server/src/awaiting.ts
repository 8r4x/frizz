import { createHash } from "node:crypto"
import { GithubWatchStatus, isValidAwaitingTimer, type AwaitingHint } from "@frizz/shared"

// The PR-reference vocabulary shared by the pr-watch scheduler and the awaiting-confirmation RPC.
// It lives here rather than in scheduler.ts so the router can validate a confirmation without pulling
// in the whole waker; scheduler.ts re-exports parsePrRef/PrRef for its existing callers and tests.

export interface PrRef {
  owner: string
  repo: string
  number: number
}

// Parse a PR reference out of a hint value: `owner/repo#123` or a GitHub PR URL. Undefined when neither
// shape matches (e.g. an actions-run URL with no PR number) → that hint is simply not actionable.
// Deliberately NOT anchored (cf. the strict isValidGithubReviewTarget): a fence hint line legitimately
// carries trailing prose after the ref, and anchoring here would make those hints unparseable.
const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/

export function parsePrRef(value: string): PrRef | undefined {
  const m = value.trim().match(PR_REF_RE)
  if (!m) return undefined
  const number = Number.parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}

// Which hints the operator can actually ARM. Only `timer` (a real future instant) and `pr-watch` (a
// parseable PR) are machine-actionable. `human:` names a person, and the legacy pr/ci/session kinds are
// presentation-only compatibility — none can be bound to a durable wait, so a confirmation against one
// is refused rather than parking the thread on something nothing will ever fire.
export function isActionableAwaitingHint(hint: AwaitingHint | undefined): hint is AwaitingHint {
  if (!hint) return false
  if (hint.kind === "timer") return isValidAwaitingTimer(hint.value)
  if (hint.kind === "pr-watch") return parsePrRef(hint.value) !== undefined
  return false
}

// One exact final-message generation, identified by the fence instant plus the hint it proposed.
// Confirmation binds THIS identity, so a later fence — or an edited hint at the same instant — no
// longer matches and the operator is asked again rather than inheriting a stale approval.
export function awaitingFenceIdentity(hint: AwaitingHint, fenceAt: string): string {
  return createHash("sha256")
    .update(fenceAt)
    .update("\0")
    .update(hint.kind)
    .update("\0")
    .update(hint.value)
    .digest("hex")
}

// ---- THE WATCHED-PR STATUS BOOK -------------------------------------------------------------------
// One reading per PR, published by the scheduler's poller and read by the board. It lives in a setting
// rather than a table because it is a pure CACHE of GitHub's own answer: every entry is replaceable,
// nothing reconciles against it, and an entry for a PR nobody watches any more is a few stale bytes.
//
// The KEY and the parser live here, beside `parsePrRef`, so the board can read the book without pulling
// in the whole waker — the same reason `parsePrRef` moved here in the first place.
export const GITHUB_STATUS_SETTING = "waker.github.status.v1"

export type GithubStatusBook = Record<string, GithubWatchStatus>

/** The book as stored, validated entry by entry. A malformed entry is DROPPED rather than failing the
 *  whole read: this decides a queue rule, and one bad row must not take a whole board's worth of PR
 *  status with it. An older frizz's book simply reads as fewer entries. */
export function readGithubStatusBook(raw: unknown): GithubStatusBook {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: GithubStatusBook = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = GithubWatchStatus.safeParse(value)
    if (parsed.success) out[key] = parsed.data
  }
  return out
}

/** The book's key for a ref — the same `owner/repo#N` string the fence's watch row is targeted by, so
 *  the card, the queue rule and the poller all name one PR one way. */
export function githubStatusKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}
