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
  /** Hard cap on the selection size (the server's per-batch max). */
  max: number
}

export type RowSelectionResult = {
  selected: ReadonlySet<number>
  anchor: number | null
  /** True when the cap kept the range from selecting every row it covered. */
  capped: boolean
}

export function applyRowSelection({ keys, key, shiftKey, anchor, selected, max }: RowSelectionInput): RowSelectionResult {
  const index = keys.indexOf(key)
  const anchorIndex = anchor === null ? -1 : keys.indexOf(anchor)

  // No usable anchor (first click, or the anchor row is gone) → a shift-click is just a plain click.
  if (!shiftKey || index === -1 || anchorIndex === -1 || anchor === null) {
    const next = new Set(selected)
    let capped = false
    if (next.has(key)) next.delete(key)
    else if (next.size < max) next.add(key)
    else capped = true
    return { selected: next, anchor: index === -1 ? anchor : key, capped }
  }

  // Walk anchor→target so a capped range fills OUT FROM the anchor: the truncation lands at the far
  // end the human was dragging toward, leaving a contiguous block that starts where they started.
  const step = index >= anchorIndex ? 1 : -1
  const selecting = selected.has(anchor)
  const next = new Set(selected)
  let capped = false
  for (let i = anchorIndex; ; i += step) {
    const k = keys[i]!
    if (selecting) {
      if (!next.has(k)) {
        if (next.size < max) next.add(k)
        else capped = true
      }
    } else {
      next.delete(k)
    }
    if (i === index) break
  }
  return { selected: next, anchor, capped }
}
