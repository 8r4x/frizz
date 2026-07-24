import type { ChatMessage } from "../hooks.ts"

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
// Small ON PURPOSE (it was 240, a third of a pane): this is the distance at which a landing message
// still hauls the reader to the bottom, so a generous band means someone who nudged up a few lines to
// re-read something gets yanked back mid-turn. It only has to absorb fractional layout and a nudge.
export const TAIL_FOLLOW_PX = 64

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

  messages.forEach((message, messageIndex) => {
    if (message.queued || rendersNothing(message)) return
    const baseKey = message.sourceId ?? legacyMessageKey(message)
    const duplicate = keyCounts.get(baseKey) ?? 0
    keyCounts.set(baseKey, duplicate + 1)
    rows.push({
      key: duplicate === 0 ? baseKey : `${baseKey}:${duplicate}`,
      message,
      messageIndex,
      gap: previousTailIsMeta === null ? 0 : previousTailIsMeta && headIsMeta(message) ? 6 : step,
    })
    previousTailIsMeta = tailIsMeta(message)
  })

  return rows
}
