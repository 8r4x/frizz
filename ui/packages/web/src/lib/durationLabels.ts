// Compact labels are rendered in small caps in status rows. Spell units out enough that an
// uppercase M cannot be read as "million" (for example, `128 min`, not `128m`).
export function formatToolDuration(ms: number): string {
  if (ms < 1) return "<1 ms"
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${ms < 10_000 ? (ms / 1_000).toFixed(1) : Math.round(ms / 1_000)} sec`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1_000)
  return secs ? `${mins} min ${secs} sec` : `${mins} min`
}

export function formatElapsedMinutes(minutes: number): string {
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}

// COMPACT elapsed, for the dense child-op row only: "38s", "12m", "1hr 5m" (maintainer 2026-07-28).
//
// This deliberately breaks the house rule at the top of this file — spell units out so an uppercase M
// cannot read as "million" — and the exception is scoped to exactly one reading for two reasons. It is
// a DURATION on a row that already says what the thing is, so there is no quantity it could be confused
// with; and that row is the tightest horizontal budget in the app, sharing a line with a title, a ×, a
// live step and two counters, where four characters of unit spelling is the difference between the step
// rendering and being clipped. Every other surface keeps the spelled-out forms.
//
// Sub-minute resolves to SECONDS rather than the "just now" the recency formatters use: a child that
// has been working 38 seconds is meaningfully different from one at 5 seconds, and this reading exists
// precisely to answer "how long has this been going".
export function formatCompactElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const totalSeconds = Math.floor(ms / 1_000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}hr ${minutes}m` : `${hours}hr`
}

/** Compact elapsed since an ISO instant, measured against an injectable clock so a live tick drives it. */
export function compactElapsedSince(startedAt: string | undefined, nowMs = Date.now()): string {
  if (!startedAt) return ""
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return ""
  return formatCompactElapsed(nowMs - started)
}

export function formatFixedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return "<1 min"
  return formatElapsedMinutes(mins)
}

// Human-friendly elapsed since an ISO timestamp, measured against NOW: "just now", "12 min",
// "1 hr 3 min". Empty when absent or unparseable. Distinct from formatFixedDuration, which formats an
// already-COMPLETED span (a dispatch→completion elapsed, in ms). This was written twice verbatim — in
// ChatView's ops strip and in BackgroundShellSheet — while every other duration formatter already
// lived here.
export function elapsedSince(startedAt: string | undefined, nowMs = Date.now()): string {
  if (!startedAt) return ""
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return ""
  return formatElapsedMinutes(Math.floor((nowMs - started) / 60_000))
}

// Compact "time since" for a dense status row: "just now", "6 min ago", "1 hr 3 min ago". Distinct
// from elapsedSince (which reads as a DURATION — "running 6 min") by carrying the "ago" that marks it
// as recency, not lifetime. `nowMs` is passed in so a live clock can drive it without re-reading Date.
export function formatAgo(at: string | undefined, nowMs = Date.now()): string {
  if (!at) return ""
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ""
  const mins = Math.floor((nowMs - t) / 60_000)
  if (mins < 1) return "just now"
  return `${formatElapsedMinutes(mins)} ago`
}

export function formatCountdownSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} sec`
  return `${Math.floor(seconds / 3600)} hr ${Math.floor((seconds % 3600) / 60)} min`
}
