// THE READER'S PLACE, carried through the fullscreen door.
//
// A queue card and the /full page draw the same thread, and until now the door threw away everything
// the reader had in front of them: /full mounts its own transcript and scrolls to the END, so someone
// parked at turn 15 of a long card arrived at turn 24 with none of what they were reading still on
// screen (maintainer 2026-09-02: "the contents that are currently visible in the cue card, their
// scroll position is totally lost"). Measured on a 24-turn fixture before this existed: eight messages
// on screen before the click, ZERO of them after it.
//
// So the door notes which message is at the top of the reader's view and how far down the screen it
// sits, and the /full transcript puts that same message back at that same height instead of jumping to
// the tail. The message is named by its `sourceId`, which is the ONE identifier both surfaces already
// stamp on their rows (`data-transcript-source-id`) — the card in TodosView, the virtualized rows in
// ChatView — so no new plumbing is needed on either side to find it again.
//
// It is a one-shot hand-off, not state: the door writes it, the next /full transcript to mount reads it
// and clears it. A module-level slot rather than the valtio store for that reason, and the same shape
// `primeFullscreenReturn` already uses for the reverse leg.

export interface FullscreenAnchorCandidate {
  sourceId: string
  /** Where this message's top edge sat in the WINDOW when the door was pressed. Restoring to the same
   *  absolute Y is what makes the expand read as the same page getting bigger. */
  screenTop: number
}

export interface FullscreenEnterAnchor {
  slug: string
  /** The visible messages, TOP-DOWN. The destination takes the first one it can actually place: the two
   *  surfaces draw the same thread but not the same row list — a queue card collapses whole spans, and a
   *  message the projection never gave a `sourceId` is keyed there by its position instead, which names
   *  nothing on the other side. One candidate meant any of those fell back to the tail. */
  candidates: FullscreenAnchorCandidate[]
  at: number
}

let pending: FullscreenEnterAnchor | null = null

// Longer than the 200ms view transition and any render the new page needs, short enough that a door
// press whose navigation never landed cannot steer a later, unrelated visit to /full.
const HANDOFF_TTL_MS = 5_000

// Enough to get past a run of rows the destination does not draw, few enough that the fallback is still
// the TOP of the reader's view rather than something halfway down it.
const MAX_CANDIDATES = 6

// The box the reader is actually reading through: a drawer's transcript has its own scroller, a queue
// card scrolls with the window. Walk up from the message to the surface looking for the former, and
// fall back to the latter — this is what keeps the drawer from anchoring on a message that is scrolled
// up behind its own header, where the rect is still on screen but the content is clipped away.
function readingBox(node: HTMLElement, surface: HTMLElement): { top: number; bottom: number } {
  for (let el = node.parentElement; el && el !== surface.parentElement; el = el.parentElement) {
    // The scroll parent is a matter of `overflow-y`, NOT of whether it happens to be overflowing right
    // now: a drawer whose thread is short still reads through its pane, and testing scrollHeight there
    // would fall through to the window and measure against a box the reader cannot see through.
    const overflowY = getComputedStyle(el).overflowY
    if (overflowY === "auto" || overflowY === "scroll") {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}

export interface MessageBand {
  sourceId: string | undefined
  top: number
  bottom: number
}

/**
 * WHICH MESSAGES THE READER HAS, top-down — the whole decision, as arithmetic over bands, so it can be
 * tested without a browser. Empty means "no hand-off": either nothing identifiable is on screen, or the
 * reader can already see the END of the transcript, in which case the tail is what they want and /full's
 * own scroll-to-end is already right (anchoring there would also take a live thread out of tail-follow).
 */
export function anchorCandidates(bands: readonly MessageBand[], box: { top: number; bottom: number }): FullscreenAnchorCandidate[] {
  if (bands.length === 0 || bands[bands.length - 1].bottom <= box.bottom) return []
  const candidates: FullscreenAnchorCandidate[] = []
  for (const band of bands) {
    if (band.bottom <= box.top + 1) continue
    if (band.top >= box.bottom) break
    if (band.sourceId) candidates.push({ sourceId: band.sourceId, screenTop: band.top })
    if (candidates.length >= MAX_CANDIDATES) break
  }
  return candidates
}

/**
 * Note where the reader is in `surface` (the board surface the door was pressed in — a queue card or a
 * drawer panel), for the /full page about to mount.
 */
export function captureFullscreenEnterAnchor(surface: HTMLElement | null, slug: string): void {
  pending = null
  if (!surface || typeof window === "undefined") return
  const nodes = [...surface.querySelectorAll<HTMLElement>("[data-transcript-source-id]")]
  if (nodes.length === 0) return
  const box = readingBox(nodes[0], surface)
  const candidates = anchorCandidates(
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { sourceId: node.dataset.transcriptSourceId, top: rect.top, bottom: rect.bottom }
    }),
    box,
  )
  if (candidates.length === 0) return
  pending = { slug, candidates, at: performance.now() }
}

/** Read and CLEAR the hand-off, if one was left for this thread and is still fresh. */
export function takeFullscreenEnterAnchor(slug: string): FullscreenEnterAnchor | null {
  const anchor = pending
  if (!anchor) return null
  pending = null
  if (anchor.slug !== slug || performance.now() - anchor.at > HANDOFF_TTL_MS) return null
  return anchor
}

/** Test seam: drop a hand-off the navigation is no longer going to consume. */
export function clearFullscreenEnterAnchor(): void {
  pending = null
}
