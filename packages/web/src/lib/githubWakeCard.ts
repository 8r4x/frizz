// Presentation helpers for the GitHub wake card. The PARSING lives in @fray-ui/shared beside the
// scheduler's formatter (so the two can't drift); this is only about how the parsed shape reads.

// A compact relative age for a wake item: the card already carries the exact ISO instant in a tooltip,
// so the visible label answers "how stale is this?" at a glance. Deliberately terser than
// `formatLastActive` — these sit at the right edge of a dense row, not on their own line.
export function wakeItemAge(at: string | undefined, nowMs = Date.now()): string | null {
  const ms = at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null
  const seconds = Math.max(0, Math.floor((nowMs - ms) / 1_000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

// The card's own heading. One item reads as the WHOLE event in one sentence — the kind and who filed
// it, "New comment from @pullfrog[bot]" (maintainer 2026-07-31) — so the card needs no row beneath it
// and the `@actor …… age` line that used to sit there, reading as a one-row table, is gone. Several
// items read as a count, because naming three kinds in a heading is worse than counting them.
export function wakeCardTitle(count: number, label: string, actor?: string): string {
  if (count !== 1) return `${count} new items`
  return actor ? `New ${label} from @${actor}` : `New ${label}`
}

// `owner/repo#N` → the PR's own URL. Every item normally carries its own permalink, but the ref line
// must stay clickable even when GitHub returned no per-item url (a shape surprise degrades the item
// links, and the card should still get the human to the PR). Null when the ref isn't the expected
// shape, in which case the card renders it as plain text rather than a broken link.
export function wakeRefUrl(ref: string): string | null {
  const m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)#(\d+)$/.exec(ref)
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null
}
