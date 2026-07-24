export type SidebarSectionGeometry = { id: string; top: number; bottom: number }

// How much of the viewport a card must cover to take the rail from a taller card still hanging above
// it. Half the screen is the point where the reader has demonstrably moved on (maintainer 2026-07-24).
export const SIDEBAR_SPY_COVERAGE = 0.5

// Which queue card the rail's reading rule points at, from card geometry alone.
//
// COVERAGE, not a reading line. This used to pick whichever card crossed a 12px line at the very top
// of the viewport, which meant a tall card kept the rail until it had scrolled ENTIRELY off screen —
// the reader could be looking at a full screen of the next card while the rail still marked the last
// one. The rule now is: the FIRST card that is either wholly on screen or already covering half the
// viewport, and only if no earlier card is still showing more of itself than that.
//
// The two clauses cover the two shapes a queue takes. Cards TALLER than the viewport hand over at the
// halfway point, exactly when the newcomer becomes the bigger half of the screen. Cards SHORTER than
// the viewport hand over when the previous one starts leaving, so the topmost fully-readable card
// holds the rail — which is also what makes a click-to-card landing stick, since that lands the target
// whole at the top of the screen.
//
// Geometry is the CARD ROOT, not the queue slot: the slot carries ~80px of inter-card gutter, and
// crediting a card for empty space would let a card that is visually gone still count as "wholly on
// screen".
export function activeSidebarSection(
  sections: readonly SidebarSectionGeometry[],
  viewportHeight: number,
  atDocumentBottom = false,
): string | null {
  const onScreen = sections
    .map((section) => ({
      id: section.id,
      height: Math.max(0, section.bottom - section.top),
      visible: Math.min(section.bottom, viewportHeight) - Math.max(section.top, 0),
    }))
    .filter((card) => card.visible > 0)
  if (!onScreen.length) return null
  // A short final card can never win on coverage: the browser has exhausted its scroll range while a
  // taller predecessor still fills most of the screen. At that real boundary the reader has arrived at
  // the last queue item, so it takes the rail. Kept out of normal scrolling so an upcoming final card
  // cannot claim the rail merely for being near the viewport bottom.
  if (atDocumentBottom) return onScreen[onScreen.length - 1].id
  const dominant = viewportHeight * SIDEBAR_SPY_COVERAGE
  let leader = onScreen[0]
  for (const card of onScreen) {
    if (card.visible > leader.visible) leader = card
    // `>= leader.visible` (the running maximum, this card included) keeps a small card lower down from
    // stealing the rail just for fitting on screen while more of a partly-scrolled card is still shown.
    if (card.visible >= Math.min(dominant, card.height) && card.visible >= leader.visible) return card.id
  }
  return leader.id
}

// Keep the active marker reachable without disturbing the page's scroll position. The result is a
// delta for the rail's own scrollTop, with a small breathing margin around the highlighted row.
export function railRevealDelta(
  railTop: number,
  railBottom: number,
  itemTop: number,
  itemBottom: number,
  margin = 8,
): number {
  if (itemTop < railTop + margin) return itemTop - railTop - margin
  if (itemBottom > railBottom - margin) return itemBottom - railBottom + margin
  return 0
}
