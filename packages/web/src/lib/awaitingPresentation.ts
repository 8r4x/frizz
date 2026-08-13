import { canonicalSnoozeInstant, isValidAwaitingTimer, type AwaitingHint } from "@frizz/shared"
import { githubRefUrl } from "./githubRef.ts"
import { formatSnoozeWake } from "./snooze.ts"

/** The awaiting card's TITLE when no hint is parkable (legacy pr/ci/session, or an elapsed/malformed
 *  timer) — the card still wants the heading its `done` sibling has, it just has nothing to offer. */
export const AWAITING_FALLBACK_TITLE = "Awaiting"

/** The verb every park button wears. It is deliberately ONE word for every kind: the card's TITLE
 *  already names the specific wait ("Awaiting human"), and the explainer already spells out the
 *  effect, so the button only has to say what it does (maintainer 2026-07-24). */
export const AWAITING_PARK_BUTTON = "Snooze"

/** What the awaiting card's park control offers for these hints, or null when no hint is parkable
 *  (a `pr-watch`, legacy pr/ci/session, or an elapsed/malformed timer) — there is then nothing to confirm.
 *
 *  `title` is the card's HEADING, not a button label: a future `timer` → "Scheduled snooze" to that
 *  exact instant; a plain `human` gate → "Awaiting human". Without a declared time the caller parks for
 *  the user's default snooze preset.
 *
 *  `pr-watch` USED TO BE HERE, titling the card "PR watcher armed" and carrying the thread's Snooze.
 *  Both moved on 2026-08-13: the watcher is listed under the prompt box beside the sub-agents and
 *  background shells, and the snooze is the generic resting card's event-snooze, which every other
 *  background wait already uses. One control, not one per kind. See the branch note below.
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
  // ---- `pr-watch` NO LONGER PARKS FROM HERE (2026-08-13) ------------------------------------------
  // This branch titled the card "PR watcher armed" and hung the thread's Snooze off it. Both moved:
  // the watcher is now listed under the prompt box beside the sub-agents and background shells
  // (ChildOpRow's GITHUB kind, fed by board.githubWatchViews), and the SNOOZE is the generic resting
  // card's event-snooze, which every other background wait already uses. The maintainer chose that
  // consolidation over keeping a second, kind-specific park control: "the user can just use the generic
  // snooze card that shows up any time an agent rests while there are background tasks like shells or
  // subagents, and now GitHub watchers can be included in the ranks of those."
  //
  // A pr-watch fence that ALSO declares a `timer:` still parks on the clock below — that instant is a
  // real declared wait and nothing else offers it. A pr-watch fence alone falls through to `null`, so
  // the card renders under AWAITING_FALLBACK_TITLE with no button, which is honest: there is nothing
  // left for it to offer that the strip and the resting card do not already carry.
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

/** The PRs a `pr-watch` fence is watching, in fence order, deduped — the one thing the card is ABOUT.
 *  A card titled "PR watcher armed" that offers no way to REACH the PR is a dead end: the hint is the
 *  only place the ref exists (awaitingHintSentence deliberately keeps pr-watch out of the prose, and
 *  the worker's own body often names a bare "#15524" or nothing at all), so the ref has to reach the
 *  human as a structured, clickable thing rather than as more copy (maintainer 2026-07-31: "obviously
 *  this should have a link to the PR being watched").
 *
 *  `url` is null when the value isn't `owner/repo#N` — a worker can write anything on that line, and a
 *  malformed one still names what is being watched, so the card shows it as plain text rather than
 *  hiding it or offering a broken link. Empty for every non-pr-watch fence. */
export function prWatchRefs(hints: readonly AwaitingHint[]): { ref: string; url: string | null }[] {
  const seen = new Set<string>()
  return hints.flatMap((hint) => {
    if (hint.kind !== "pr-watch") return []
    const ref = hint.value.trim()
    if (!ref || seen.has(ref)) return []
    seen.add(ref)
    return [{ ref, url: githubRefUrl(ref) }]
  })
}

export function awaitingHintSentence(hints: readonly AwaitingHint[], nowMs = Date.now()): string | null {
  // A pr-watch hint is an instruction to frizz, not additional copy for the human. The card title
  // already says the watcher is armed and the worker-authored body names the useful status/wake
  // condition; echoing the parsed hint as "Watch owner/repo#N for…" mixed implementation mechanics
  // into that explanation and usually repeated it. Keep the hints intact for the scheduler and park
  // action, but do not render them — including a co-declared timer backstop — into the card body.
  if (hints.some((hint) => hint.kind === "pr-watch")) return null

  const timer = hints.find((hint) => hint.kind === "timer" && isValidAwaitingTimer(hint.value))
  const futureTimer = timer && Date.parse(timer.value) > nowMs ? timer : undefined

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
