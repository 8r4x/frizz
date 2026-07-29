import { canonicalSnoozeInstant, isValidAwaitingTimer, type AwaitingHint } from "@fray-ui/shared"
import { formatSnoozeWake } from "./snooze.ts"

/** The awaiting card's TITLE when no hint is parkable (legacy pr/ci/session, or an elapsed/malformed
 *  timer) — the card still wants the heading its `done` sibling has, it just has nothing to offer. */
export const AWAITING_FALLBACK_TITLE = "Awaiting"

/** The verb every park button wears. It is deliberately ONE word for every kind: the card's TITLE
 *  already names the specific wait ("PR watcher armed"), and the explainer already spells out the
 *  effect, so the button only has to say what it does (maintainer 2026-07-24). */
export const AWAITING_PARK_BUTTON = "Snooze"

/** What the awaiting card's park control offers for these hints, or null when no hint is parkable
 *  (legacy pr/ci/session, or an elapsed/malformed timer) — there is then nothing to confirm.
 *
 *  `title` is the card's HEADING, not a button label: a future `timer` → "Scheduled snooze" to that
 *  exact instant; `pr-watch` → "PR watcher armed" — the STATE the thread is already in, since the
 *  scheduler auto-arms off the fence and a pr-watch card is a VISIBLE queue handoff by default; a
 *  plain `human` gate → "Awaiting human". For pr-watch/human there's no declared time, so the caller parks for the user's default
 *  snooze preset — for pr-watch that preset is only a SAFETY timeout: the scheduler clears the snooze
 *  the moment new PR activity arrives (scheduler.ts, the clear-snooze-on-pr-watch-wake), so ACTIVITY
 *  is the real wake and the timeout just guards against a dead PR hiding forever. Signalled by a null
 *  `timerUntil`, and why pr-watch's explainer names PR activity rather than a clock.
 *
 *  NB the title STATES the wait, it does not offer it: the scheduler polls a pr-watch thread whether
 *  or not the button is ever pressed (it auto-arms off the fence), so "PR watcher armed" is the literal
 *  standing fact. The imperative it replaced ("Arm watcher") described the button instead, which read
 *  as an offer to start something that was already running. What the button actually does is PARK the
 *  visible card and let the watcher bring it back (maintainer 2026-07-29).
 *
 *  `timerUntil` is CANONICALIZED, never the raw hint: the fence grammar admits instants the durable
 *  snooze grammar rejects (no millis, a numeric offset), and setThreadSnooze rejects those as invalid
 *  input. */
export function awaitingParkAction(
  hints: readonly AwaitingHint[],
  nowMs = Date.now(),
): { title: string; explainer: string; toastVerb: string; timerUntil: string | null } | null {
  const dismiss = "This will dismiss the card from the queue until"
  const timerUntil = hints
    .flatMap((hint) => (hint.kind === "timer" ? [canonicalSnoozeInstant(hint.value)] : []))
    .find((instant): instant is string => instant !== null && Date.parse(instant) > nowMs)
  if (timerUntil) {
    return {
      title: "Scheduled snooze",
      explainer: `${dismiss} ${lowerCalendarLead(formatSnoozeWake(timerUntil, nowMs))}.`,
      toastVerb: "Snoozed",
      timerUntil,
    }
  }
  if (hints.some((hint) => hint.kind === "pr-watch")) {
    return { title: "PR watcher armed", explainer: `${dismiss} PR activity is detected.`, toastVerb: "Watcher armed", timerUntil: null }
  }
  if (hints.some((hint) => hint.kind === "human")) {
    return { title: "Awaiting human", explainer: `${dismiss} your default snooze elapses.`, toastVerb: "Snoozed", timerUntil: null }
  }
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

  const review = hints.find((hint) => hint.kind === "pr-watch")
  if (review) return `Watch ${review.value} for new reviews, approvals, or comments`

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
