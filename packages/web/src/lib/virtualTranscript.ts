import type { ChatMessage } from "../hooks.ts"

// The extra air beneath what the human said, on top of the ordinary STEP. A user message opens a turn,
// and a little more room under its bottom edge is what separates "what I asked" from "what happened
// next" (maintainer 2026-07-31: "a little more space underneath each user message, maybe 3 px more").
//
// It lands on the LAST message of a run, never on each one: consecutive user messages are one utterance
// the human split across sends, and spacing them apart internally would break up the very thing this
// exists to set off. Lives HERE rather than beside STEP in ChatView because ChatView imports this
// module, so this is the end of the dependency that both spacing implementations can share.
export const USER_TAIL_EXTRA = 3

export interface VirtualTranscriptMessageRow {
  key: string
  message: ChatMessage
  messageIndex: number
  gap: number
}

// How close to the tail counts as "reading the tail". One constant for THREE things that must never
// drift apart: the virtualizer's own scrollEndThreshold, whether "Jump to latest" is hidden, and
// whether new content pins the reader to the bottom. The invariant the reader actually perceives is
// "if the jump button is hidden, I am attached" — two thresholds would break exactly that.
//
// This is a ROUNDING EPSILON, not a comfort band. It was 240 (a third of a pane), then 64; at both sizes
// a reader who nudged up a line or two to re-read something still counted as attached, so the next thing
// to land hauled them back to the bottom — measured at 24px above the bottom, a single append dragged the
// reader 346px (scripts/verify-full-nudge-threshold.mjs). The rule the reader expects is the literal one:
// if the bottom of the transcript is not at the bottom of the pane, nothing may move them. So the band has
// to cover only what a reader CANNOT have chosen — the sub-pixel residue that fractional layout and
// device-pixel rounding leave at the genuine bottom, which is where the `distance <= 1` write guard below
// already draws the line. A wheel notch is 40px+, so every deliberate scroll now detaches.
export const TAIL_FOLLOW_PX = 4

export interface TailFollowInput {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** The scroll height observed at the previous reconciliation (-1 before the first one). */
  previousScrollHeight: number
  /** Whether the reader was attached to the tail as of that previous reconciliation. */
  following: boolean
  /** The reader is actively driving the scroller (a wheel/touch/key gesture is in flight). */
  readerMoved: boolean
}

export interface TailFollow {
  following: boolean
  /** The scrollTop to write to stay attached, or null to leave the scroller alone. */
  scrollTop: number | null
}

// Reconcile "is the reader attached to the tail?" with the re-pin that keeps them there.
//
// The whole difficulty is telling the two causes of a growing distance-from-bottom apart, because they
// demand opposite responses: the READER scrolled up (leave them alone) versus the CONTENT grew under
// them (pull them back down). Distance alone cannot say which — so compare the scroll height. Same
// height means only the reader can have moved, so the current distance IS their intent and fully
// reclassifies attachment. A changed height means the tail moved under them, so their previous
// attachment carries over; a resize may only ADD attachment, and only by bringing the true bottom back
// to exactly where they already sit (a shrink, e.g. the Working… row retiring).
//
// This is deliberately not "recompute on scroll, follow on render": those two callbacks interleave in
// an order nothing here controls (the virtualizer's own scroll listener re-renders through React
// before our listener runs), and a follow that read a stale attachment yanked a reader who had just
// scrolled up straight back to the bottom.
export function nextTailFollow(input: TailFollowInput): TailFollow {
  const max = Math.max(input.scrollHeight - input.clientHeight, 0)
  const distance = max - input.scrollTop
  const resized = input.scrollHeight !== input.previousScrollHeight
  const following = resized && !input.readerMoved
    ? input.following || distance <= 1
    : distance <= TAIL_FOLLOW_PX
  // Only ever WRITE in response to the content moving. A reader-driven scroll reclassifies attachment
  // and nothing more: correcting one there would mean every small scroll-up inside the threshold gets
  // instantly undone — the scroller literally fighting the wheel. Fractional layout also leaves a
  // sub-pixel residue at the genuine bottom, which must not provoke a write (and a scroll event) on
  // every commit forever; only close a gap a reader could actually see.
  if (!following || !resized || max <= 0 || distance <= 1) return { following, scrollTop: null }
  return { following, scrollTop: max }
}

export interface EarlierLoadGateInput {
  armed: boolean
  scrollTop: number
  readerMoved: boolean
  hasEarlier: boolean
  loading: boolean
}

export function earlierLoadGate(input: EarlierLoadGateInput): { armed: boolean; shouldLoad: boolean } {
  const armed = input.scrollTop > 640 ? true : input.armed
  const shouldLoad = armed
    && input.readerMoved
    && input.scrollTop <= 480
    && input.hasEarlier
    && !input.loading
  return { armed: shouldLoad ? false : armed, shouldLoad }
}

function legacyMessageKey(message: ChatMessage): string {
  return `legacy:${message.role}:${message.kind ?? "message"}:${message.at ?? ""}:${message.text}`
}

export function buildVirtualTranscriptMessageRows(
  messages: readonly ChatMessage[],
  rendersNothing: (message: ChatMessage) => boolean,
  headIsMeta: (message: ChatMessage) => boolean,
  tailIsMeta: (message: ChatMessage) => boolean,
  step: number,
): VirtualTranscriptMessageRow[] {
  const rows: VirtualTranscriptMessageRow[] = []
  const keyCounts = new Map<string, number>()
  let previousTailIsMeta: boolean | null = null
  let previousIsUser = false

  messages.forEach((message, messageIndex) => {
    if (message.queued || rendersNothing(message)) return
    const baseKey = message.sourceId ?? legacyMessageKey(message)
    const duplicate = keyCounts.get(baseKey) ?? 0
    keyCounts.set(baseKey, duplicate + 1)
    const base = previousTailIsMeta === null ? 0 : previousTailIsMeta && headIsMeta(message) ? 6 : step
    // A little extra air under the human's own words — but only where a RUN of them ends, so two
    // messages the human split across sends stay one utterance. See USER_TAIL_EXTRA in ChatView.
    // A row's `gap` renders ABOVE it, so this is charged to the row that FOLLOWS the user message,
    // which is what puts the space under whatever that message ended with — an inlined screenshot
    // included, rather than under its text.
    const extra = base > 0 && previousIsUser && message.role !== "user" ? USER_TAIL_EXTRA : 0
    rows.push({
      key: duplicate === 0 ? baseKey : `${baseKey}:${duplicate}`,
      message,
      messageIndex,
      gap: base + extra,
    })
    previousTailIsMeta = tailIsMeta(message)
    previousIsUser = message.role === "user"
  })

  return rows
}
