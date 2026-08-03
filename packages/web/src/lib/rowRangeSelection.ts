// Shift-click range selection for a checkbox row list (the GitHub picker's issue/PR table).
//
// Semantics mirror github.com's own issue list / Finder / Gmail: a PLAIN click toggles one row and
// drops the anchor there; a SHIFT click paints the whole inclusive anchor→row range with the ANCHOR's
// current state, so shift-clicking after a check selects the span and shift-clicking after an uncheck
// clears it. The anchor STAYS PUT across shift-clicks, which is what makes "shift-click again to
// widen/narrow the span" work. Selection is additive — rows outside the range are never disturbed.
//
// The anchor is the row's KEY (its issue/PR number), never its index: the list refetches under the
// open picker, and an index would silently re-point at a different row after a reorder. A key that
// has left the list resolves to "no anchor" and the shift-click degrades to a plain toggle.

export type RowSelectionInput = {
  /** Row keys in RENDER order — the range is a slice of this. */
  keys: readonly number[]
  /** Key of the clicked row. */
  key: number
  shiftKey: boolean
  /** Key of the last plainly-clicked row, or null when there is none yet. */
  anchor: number | null
  selected: ReadonlySet<number>
}

export type RowSelectionResult = {
  selected: ReadonlySet<number>
  anchor: number | null
}

export function applyRowSelection({ keys, key, shiftKey, anchor, selected }: RowSelectionInput): RowSelectionResult {
  const index = keys.indexOf(key)
  const anchorIndex = anchor === null ? -1 : keys.indexOf(anchor)

  // No usable anchor (first click, the anchor row is gone, or the anchor is on ANOTHER PAGE) → a
  // shift-click is just a plain click. Selection itself survives paging; only the range gesture,
  // which is a span of ADJACENT rendered rows, is scoped to the page you can see.
  if (!shiftKey || index === -1 || anchorIndex === -1 || anchor === null) {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return { selected: next, anchor: index === -1 ? anchor : key }
  }

  // Walk anchor→target rather than low→high so the block always reads as growing out FROM where the
  // human started, in the direction they dragged.
  const step = index >= anchorIndex ? 1 : -1
  const selecting = selected.has(anchor)
  const next = new Set(selected)
  for (let i = anchorIndex; ; i += step) {
    const k = keys[i]!
    if (selecting) next.add(k)
    else next.delete(k)
    if (i === index) break
  }
  return { selected: next, anchor }
}
