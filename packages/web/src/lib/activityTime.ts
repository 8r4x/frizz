export function activityTimestamp(lastActivityAt: string | undefined, spawnedAt?: string): string | undefined {
  for (const at of [lastActivityAt, spawnedAt]) {
    if (at && Number.isFinite(Date.parse(at))) return at
  }
  return undefined
}

export function formatLastActive(at: string | undefined, nowMs = Date.now()): string | null {
  const age = relativeAge(at, nowMs)
  return age && `Last active ${age}`
}

/** `just now` / `3 days ago` — the phrase without a label, so a caller can supply its own. */
export function relativeAge(at: string | undefined, nowMs = Date.now()): string | null {
  const span = ageSpan(at, nowMs)
  return span === null || span === JUST_NOW ? span : `${span} ago`
}

const JUST_NOW = "just now"

/**
 * The bare SPAN — `just now` / `12 minutes` / `3 days` — with no "ago" on the end.
 *
 * The rail's rest-time column is a COLUMN: every row in it carries one, right-justified, so the
 * position already says "ago" and repeating the word on every row spends the rail's scarcest axis
 * (its width) on three characters that add nothing. Everywhere a reading stands ALONE in prose, use
 * relativeAge above — which is this function plus that word, so the two vocabularies cannot drift.
 */
export function ageSpan(at: string | undefined, nowMs = Date.now()): string | null {
  const activityMs = at ? Date.parse(at) : NaN
  if (!Number.isFinite(activityMs) || !Number.isFinite(nowMs)) return null

  const seconds = Math.max(0, Math.floor((nowMs - activityMs) / 1_000))
  if (seconds === 0) return JUST_NOW
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"}`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} ${weeks === 1 ? "week" : "weeks"}`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`

  const years = Math.floor(days / 365)
  return `${years} ${years === 1 ? "year" : "years"}`
}
