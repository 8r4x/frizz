import { createHash } from "node:crypto"
import { AWAITING_FOR_MAX_MS, GithubWatchStatus, isAwaitingItemKind, parseAwaitingDuration, type AwaitingHint, type AwaitingItemKind } from "@frizz/shared"

// The PR-reference vocabulary shared by the PR-watching scheduler and the awaiting-confirmation RPC.
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

// NOTHING IN AN AWAITING FENCE IS OPERATOR-ARMABLE ANY MORE, so this is now always false.
//
// It used to answer "can the human turn this hint into a durable park?" — true for a `timer:` naming a
// real future instant, and for a `pr-watch:` naming a parseable PR. The 2026-08-15 grammar has neither
// kind: a timer is a registered row the worker sets through its own tool, and a PR is a registered
// watcher. The fence now only NAMES things that already exist, so there is nothing left for the operator
// to arm from one, and the "Confirm snooze" affordance those two kinds fed disappears with them. The
// human's lever is the ordinary Snooze button, which never depended on a fence.
//
// Kept as a predicate rather than deleted outright because the confirmation RPC and its storage
// compare-and-swap are still wired; returning false makes that path inert (every confirmation is refused
// as "no longer current") without ripping a whole RPC out from under a running server. Removing the
// plumbing is mechanical follow-up.
export function isActionableAwaitingHint(hint: AwaitingHint | undefined): hint is AwaitingHint {
  return hint !== undefined && false
}


// ---- THE PARK, READ OUT OF A FENCE AND CHECKED ----------------------------------------------------
// One reader for the 2026-08-15 grammar, used by BOTH the scheduler (which bumps) and the board (which
// decides Held), so the two can never disagree about whether a thread is parked.

export interface AwaitingItem {
  kind: AwaitingItemKind
  /** The runtime handle or registry id as the worker wrote it. */
  value: string
}

export interface AwaitingPark {
  items: AwaitingItem[]
  /** `for:` in ms, or null when it is missing or not a duration. NULL IS NOT A PARK. */
  forMs: number | null
  reason: string
}

/** Read the structural fence. Unknown lines are already dropped by the tailer's parse, so everything
 *  arriving here is one of the six kinds. */
export function readAwaitingPark(hints: readonly AwaitingHint[]): AwaitingPark {
  const items: AwaitingItem[] = []
  let forMs: number | null = null
  let reason = ""
  for (const h of hints) {
    const value = h.value.trim()
    if (isAwaitingItemKind(h.kind)) {
      if (value) items.push({ kind: h.kind, value })
    } else if (h.kind === "for") {
      forMs = parseAwaitingDuration(value)
    } else if (h.kind === "reason" && !reason) {
      reason = value
    }
  }
  return { items, forMs, reason }
}

/** What frizz can see running for one thread, in the shape the check needs. Every id a fence may name
 *  comes from one of these four sets, and each is authoritative for its own kind. */
export interface LiveActivity {
  /** Every handle a live background shell answers to — its runtime task id, its launch id, its label. */
  shells: ReadonlySet<string>
  /** Same, for live sub-agents. */
  agents: ReadonlySet<string>
  /** Armed timer ids on this thread. */
  timers: ReadonlySet<string>
  /** Registered PR watcher ids on this thread. */
  prs: ReadonlySet<string>
}

const LIVE_SET: Record<AwaitingItemKind, keyof LiveActivity> = {
  shell: "shells", agent: "agents", timer: "timers", pr: "prs",
}

/** The items this fence names that frizz CANNOT account for — dead, unknown, or another thread's.
 *
 *  This is the whole safety property of the grammar. A park is honoured only when this comes back empty;
 *  anything in it means the worker declared a wait that cannot resolve, and gets bumped rather than
 *  parked. Three separate stalls in one day came from the old grammar having no equivalent (see the
 *  AwaitingHint doc block in @frizz/shared). */
export function unaccountedItems(items: readonly AwaitingItem[], live: LiveActivity): AwaitingItem[] {
  return items.filter((i) => !live[LIVE_SET[i.kind]].has(i.value))
}

/** Is this a park frizz will honour — at least one item, every item live, and a usable `for:`?
 *
 *  AT LEAST ONE ITEM is not pedantry. An awaiting fence naming nothing is a worker claiming to wait with
 *  no way to be woken, which is precisely the silent stall the grammar exists to make impossible. */
export function parkIsHonoured(park: AwaitingPark, live: LiveActivity): boolean {
  if (park.items.length === 0) return false
  if (park.forMs === null) return false
  return unaccountedItems(park.items, live).length === 0
}

/** When a park that landed at `fenceAtMs` runs out. Capped by the grammar itself, so this cannot
 *  return an instant beyond AWAITING_FOR_MAX_MS from the fence. */
export function parkExpiresAt(park: AwaitingPark, fenceAtMs: number): number | null {
  if (park.forMs === null || !Number.isFinite(fenceAtMs)) return null
  return fenceAtMs + Math.min(park.forMs, AWAITING_FOR_MAX_MS)
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
