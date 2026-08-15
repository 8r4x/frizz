import { type AwaitingHint } from "@frizz/shared"
import { githubRefUrl } from "./githubRef.ts"
import { formatSnoozeWake } from "./snooze.ts"

/** The awaiting card's TITLE when no hint is parkable (legacy pr/ci/session, or an elapsed/malformed
 *  timer) — the card still wants the heading its `done` sibling has, it just has nothing to offer. */
export const AWAITING_FALLBACK_TITLE = "Awaiting"

/** The verb every park button wears. It is deliberately ONE word for every kind: the card's TITLE
 *  already names the specific wait ("Awaiting human"), and the explainer already spells out the
 *  effect, so the button only has to say what it does (maintainer 2026-07-24). */
export const AWAITING_PARK_BUTTON = "Snooze"
/** NO AWAITING FENCE OFFERS A PARK ACTION ANY MORE, so this is always null.
 *
 *  It used to turn two hint kinds into a button: a future `timer: <instant>` became "Scheduled snooze",
 *  and `human:` became "Awaiting human". Both kinds are deleted (2026-08-15) — nothing ever fired a human
 *  gate, and a timer is now a row a worker creates through `mcp__frizz__timer` and names by id. The
 *  human's lever is the ordinary Snooze on the resting card, which never depended on a fence.
 *
 *  Kept as a function rather than deleted at every call site so the card keeps ONE shape; every caller
 *  already handles null (that is the pr-watch path, which has rendered without a button since
 *  2026-08-13). */
export function awaitingParkAction(
  _hints: readonly AwaitingHint[],
  _nowMs = Date.now(),
): { title: string; explainer: string; toastVerb: string; timerUntil: string | null } | null {
  return null
}

function lowerCalendarLead(value: string): string {
  return value.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())
}

/** The PRs this fence is parked on, in fence order, deduped — clickable, because the fence line is the
 *  only place the ref exists and a card that names a PR without reaching it is a dead end (maintainer
 *  2026-07-31: "obviously this should have a link to the PR being watched").
 *
 *  `url` is null when the value is not `owner/repo#N`. A malformed ref still names what the worker
 *  meant, so the card shows it as plain text rather than hiding it or offering a broken link — and the
 *  server refuses to park on it either way, so it cannot pass silently. */
export function prWatchRefs(hints: readonly AwaitingHint[]): { ref: string; url: string | null }[] {
  const seen = new Set<string>()
  return hints.flatMap((hint) => {
    if (hint.kind !== "pr") return []
    const ref = hint.value.trim()
    if (!ref || seen.has(ref)) return []
    seen.add(ref)
    return [{ ref, url: githubRefUrl(ref) }]
  })
}

/** The one line of worker prose the card shows: the fence's `reason:`.
 *
 *  The fence used to carry a free-text BODY, and this function's job was to synthesize a sentence out of
 *  whichever hint kinds it recognized ("Wait for Alice", "Scheduled for tomorrow at 9"). The 2026-08-15
 *  grammar has one prose field and the worker writes it deliberately, so there is nothing left to
 *  synthesize — and nothing to get wrong. The ITEMS are rendered as rows, not as a sentence. */
export function awaitingHintSentence(hints: readonly AwaitingHint[], _nowMs = Date.now()): string | null {
  const reason = hints.find((hint) => hint.kind === "reason")?.value.trim()
  return reason ? reason : null
}

export function awaitingPresentationLine(body: string, hint: string | null): string {
  const prose = body.trim()
  if (!prose) return hint ?? "Waiting for an external update."
  if (!hint) return prose
  const separator = /[.!?…][*_~`"')\]]*$/.test(prose) ? " " : " — "
  return `${prose}${separator}${hint}`
}
