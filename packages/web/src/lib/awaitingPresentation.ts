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

// THE CARD'S PROSE, and under the structural grammar the BODY IS NOT PART OF IT.
//
// A fence is now six known line kinds and nothing else, so anything left in `body` is a line the parser
// did NOT recognise — a worker still writing the deleted `watch:`, or a typo. Joining that into the
// card's sentence printed raw fence syntax at the human: "watch: bvg44v4ij — CI on #1227 is running…"
// (maintainer 2026-08-16: "why the fuck is the awaiting block looking like this?"). It is not prose, it
// is a malformed declaration — the worker gets BUMPED for it (scheduler SOURCE 12), which is where that
// belongs, and the card says what it can rather than showing the machinery.
//
// `body` is still taken when there is no `reason:` at all: an OLD fence, written before the grammar had
// one, put its whole handoff there, and those threads must not card as blank.
export function awaitingPresentationLine(body: string, hint: string | null): string {
  if (hint) return hint
  const prose = body.trim()
  return prose ? prose : "Waiting for an external update."
}

/** What the fence says it is waiting ON, as short readable labels — the structure the card renders
 *  instead of the raw `kind: value` lines. PRs are excluded: they get real LINKS of their own
 *  (`prWatchRefs`), and listing them twice is the duplication this card has been trimmed for twice. */
export function awaitingItemLabels(hints: readonly AwaitingHint[]): string[] {
  const out: string[] = []
  for (const h of hints) {
    const value = h.value.trim()
    if (!value) continue
    if (h.kind === "shell") out.push(`shell ${value}`)
    else if (h.kind === "agent") out.push(`sub-agent ${value}`)
    else if (h.kind === "timer") out.push("a timer")
  }
  return out
}

/** The `for:` duration as the card shows it — "for 40m". Null when the fence carries none, which is a
 *  malformed park rather than an unbounded one: frizz refuses it, so the card does not imply otherwise. */
export function awaitingForLabel(hints: readonly AwaitingHint[]): string | null {
  const value = hints.find((h) => h.kind === "for")?.value.trim()
  return value ? `for ${value}` : null
}

/** WHAT THIS THREAD IS WAITING ON, as a CLAUSE — the middle of a sentence the row's popover finishes.
 *
 *  The rail's rows carry a TITLE and nothing else (maintainer 2026-08-19: "there should never ever be
 *  any fucking thing in the sidebar except for the fucking title"), so every fence detail that used to
 *  ride a subtitle moved into the row's popover — and it has to READ there, not merely be present. The
 *  first cut printed one fragment per hint kind, stacked ("Watching acme/app#391 — new activity wakes
 *  it" over "Waiting on a background shell" over the reason), which is a machine dumping its record
 *  rather than a sentence telling you anything (maintainer, same day: "that popover text looks fucking
 *  terrible").
 *
 *  So: ONE verb over ONE list. "waiting on" is what a person actually says about all of it — a PR, a
 *  shell, a child, a clock — and a single conjoined list is what makes four facts read as one thought.
 *  The PR keeps its REF because that names a thing you might go look at; everything else is COUNTED,
 *  because a runtime id ("bzvtnt3ig") means nothing on a hover and three of them is a wall.
 *
 *  Order is fixed by KIND, not by the order the worker wrote the fence in, so two fences naming the
 *  same things read identically. Null when the fence names nothing — a park the server refuses anyway,
 *  so the popover says what it knows and invents no wait. */
export function awaitingWaitClause(hints: readonly AwaitingHint[]): string | null {
  const count = (kind: AwaitingHint["kind"]) => hints.filter((h) => h.kind === kind && h.value.trim()).length
  const parts = [
    ...prWatchRefs(hints).map((pr) => pr.ref),
    plural(count("shell"), "background shell", "background shells"),
    plural(count("agent"), "sub-agent", "sub-agents"),
    plural(count("timer"), "timer", "timers"),
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `waiting on ${joinList(parts)}` : null
}

/** "a timer" / "2 timers" / nothing at all — the counted form, because the ids themselves are noise. */
function plural(n: number, one: string, many: string): string | null {
  if (n <= 0) return null
  return n === 1 ? `a ${one}` : `${n} ${many}`
}

/** "a", "a and b", "a, b and c" — the Oxford comma is deliberately absent; this is one short spoken
 *  list in a hover label, not a specification. */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("")
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** THE MOBILE BOARD'S one-line gloss, and the LAST inline caption frizz draws under a thread title.
 *
 *  The desktop rail dropped its subtitle entirely (maintainer 2026-08-19) and moved every fence detail
 *  into the row's hover popover. A phone has no hover, so the mobile row keeps the one fragment worth a
 *  line without one: a PR ref names a THING rather than describing a wait, and it exists nowhere else on
 *  that row. Everything else the fence carries — the ids, the duration, the worker's `reason:` — stays
 *  off it, exactly as it does on the rail. */
export function hintGloss(hints: readonly AwaitingHint[]): string | null {
  const pr = hints.find((h) => h.kind === "pr")
  return pr ? `PR ${pr.value}` : null
}
