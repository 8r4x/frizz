import { createHash } from "node:crypto"
import { isValidAwaitingTimer, type AwaitingHint } from "@frizz/shared"

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
