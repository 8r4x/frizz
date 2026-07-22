import { canonicalSnoozeInstant, isValidAwaitingTimer, type AwaitingHint } from "@fray-ui/shared"
import { formatSnoozeWake } from "./snooze.ts"

/** What the awaiting card's park button offers for these hints, or null when no hint is parkable
 *  (legacy pr/ci/session, or an elapsed/malformed timer) — there is then nothing to confirm.
 *
 *  A future `timer` → "Confirm snooze" until that exact instant; `github-review` → "Confirm watcher"
 *  (its own verb — the watcher is activity-based, so there is no instant to show); a plain `human`
 *  gate → "Confirm snooze". For github-review/human there's no declared time, so the caller parks for
 *  the user's default snooze preset (a "remind me if it's still quiet" fallback; the watcher still
 *  wakes on activity), signalled by a null `timerUntil`.
 *
 *  `timerUntil` is CANONICALIZED, never the raw hint: the fence grammar admits instants the durable
 *  snooze grammar rejects (no millis, a numeric offset), and setThreadSnooze rejects those as invalid
 *  input. */
export function awaitingParkAction(
  hints: readonly AwaitingHint[],
  nowMs = Date.now(),
): { label: string; toastVerb: string; timerUntil: string | null } | null {
  const timerUntil = hints
    .flatMap((hint) => (hint.kind === "timer" ? [canonicalSnoozeInstant(hint.value)] : []))
    .find((instant): instant is string => instant !== null && Date.parse(instant) > nowMs)
  if (timerUntil) return { label: "Confirm snooze", toastVerb: "Snoozed", timerUntil }
  if (hints.some((hint) => hint.kind === "github-review")) return { label: "Confirm watcher", toastVerb: "Parked", timerUntil: null }
  if (hints.some((hint) => hint.kind === "human")) return { label: "Confirm snooze", toastVerb: "Snoozed", timerUntil: null }
  return null
}

function lowerCalendarLead(value: string): string {
  return value.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
}

export function awaitingHintSentence(hints: readonly AwaitingHint[], nowMs = Date.now()): string | null {
  const timer = hints.find((hint) => hint.kind === "timer" && isValidAwaitingTimer(hint.value))
  if (timer && Date.parse(timer.value) > nowMs) {
    return `Snooze until ${lowerCalendarLead(formatSnoozeWake(timer.value, nowMs))}`
  }

  const review = hints.find((hint) => hint.kind === "github-review")
  if (review) return `Watch ${review.value} for new human review activity`

  const human = hints.find((hint) => hint.kind === "human")
  if (human) return `Wait for ${human.value}`

  if (timer) return `Scheduled for ${lowerCalendarLead(formatSnoozeWake(timer.value, nowMs))}`
  if (hints.some((hint) => hint.kind === "timer")) return "Snooze schedule unavailable"

  const legacy = hints.find((hint) => hint.kind === "pr" || hint.kind === "ci" || hint.kind === "session")
  if (!legacy) return null
  if (legacy.kind === "pr") return `Wait for PR ${legacy.value}`
  if (legacy.kind === "ci") return `Wait for CI ${legacy.value}`
  return `Wait for session ${legacy.value}`
}

export function awaitingPresentationLine(body: string, hint: string | null): string {
  const prose = body.trim()
  if (!prose) return hint ?? "Waiting for an external update."
  if (!hint) return prose
  const separator = /[.!?…][*_~`"')\]]*$/.test(prose) ? " " : " — "
  return `${prose}${separator}${hint}`
}
