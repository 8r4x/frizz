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
 *  plain `human` gate → "Awaiting human". A `pr-watch` OUTRANKS a co-declared timer here, because the
 *  watcher is the live wake and the instant is only its backstop — reading the clock first titled a
 *  watching thread "Scheduled snooze" and hid the watcher outright. Without a declared time (the usual
 *  pr-watch/human fence) the caller parks for the user's default snooze preset — for pr-watch that
 *  preset is only a SAFETY timeout: the scheduler clears the snooze the moment new PR activity arrives
 *  (scheduler.ts, the clear-snooze-on-pr-watch-wake), so ACTIVITY is the real wake and the timeout just
 *  guards against a dead PR hiding forever. That is why pr-watch's explainer leads with PR activity
 *  rather than a clock, and only names the instant when the fence actually declared one.
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
  if (hints.some((hint) => hint.kind === "pr-watch")) {
    const backstop = timerUntil ? `, or until ${lowerCalendarLead(formatSnoozeWake(timerUntil, nowMs))}` : ""
    return {
      title: "PR watcher armed",
      explainer: `${dismiss} PR activity is detected${backstop}.`,
      toastVerb: "Watcher armed",
      timerUntil: timerUntil ?? null,
    }
  }
  if (timerUntil) {
    return {
      title: "Scheduled snooze",
      explainer: `${dismiss} ${lowerCalendarLead(formatSnoozeWake(timerUntil, nowMs))}.`,
      toastVerb: "Snoozed",
      timerUntil,
    }
  }
  if (hints.some((hint) => hint.kind === "human")) {
    return { title: "Awaiting human", explainer: `${dismiss} your default snooze elapses.`, toastVerb: "Snoozed", timerUntil: null }
  }
  return null
}

function lowerCalendarLead(value: string): string {
  return value.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
}

/** How many watched PRs the sentence NAMES before it counts the rest. The card's line is one line of
 *  prose, so three refs is about what fits before it stops reading as a sentence. */
const WATCH_NAME_CAP = 3

/** "a", "a and b", "a, b and c", "a, b, c and 4 more" — the watched-PR list for the sentence below. */
function watchList(refs: readonly string[]): string {
  const named = refs.slice(0, WATCH_NAME_CAP)
  const tail = refs.length - named.length
  const parts = tail > 0 ? [...named, `${tail} more`] : named
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

export function awaitingHintSentence(hints: readonly AwaitingHint[], nowMs = Date.now()): string | null {
  const timer = hints.find((hint) => hint.kind === "timer" && isValidAwaitingTimer(hint.value))
  const futureTimer = timer && Date.parse(timer.value) > nowMs ? timer : undefined

  // EVERY pr-watch ref, not just the first: a fence legitimately carries one line per PR and the
  // scheduler polls all of them (scheduler.ts evalThread loops the whole hint list). Naming only
  // hints[0] read as "this thread watches a single PR" — the same misreading that sends a worker
  // tracking a SET of PRs to a periodic timer sweep instead of arming a watcher on each.
  // The watch also outranks a co-declared timer here, because activity is the earlier, live wake and
  // the timer is the backstop; leading with the clock hid the watcher entirely.
  const watched = hints.flatMap((hint) => (hint.kind === "pr-watch" ? [hint.value] : []))
  if (watched.length) {
    // A SEMICOLON and a fresh verb, not ", or <instant>": the sentence already ends in an or-list
    // ("reviews, approvals, or comments"), so a comma-or tail attaches to it and the backstop reads as
    // a fourth kind of PR activity. An em-dash is out too — awaitingPresentationLine uses one to join
    // this sentence onto the body prose, and two in a row read as one run-on.
    const backstop = futureTimer ? `; otherwise resume ${lowerCalendarLead(formatSnoozeWake(futureTimer.value, nowMs))}` : ""
    return `Watch ${watchList(watched)} for new reviews, approvals, or comments${backstop}`
  }

  if (futureTimer) {
    return `Snooze until ${lowerCalendarLead(formatSnoozeWake(futureTimer.value, nowMs))}`
  }

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
