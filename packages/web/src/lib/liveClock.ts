import { useSyncExternalStore } from "react"

// ONE ticking wall-clock for every "X ago" / "X min" reading in the UI. A single module-level timer
// wakes all subscribers on a 30s cadence aligned to the wall clock, so a screenful of relative-time
// labels update together on one timer instead of each owning its own setInterval. Extracted from
// LastActive, which was the first such reading; the child-op rows are the second, and a second private
// copy of this loop is exactly the duplication this codebase is trying to stop growing.
//
// The cadence is coarse on purpose: these readings render at minute granularity, so 30s guarantees the
// displayed minute is never more than ~30s stale while costing one timer for the whole page. Aligning
// the delay to the wall clock (TICK_MS - now % TICK_MS) keeps every mounted label transitioning on the
// same edge rather than drifting apart by mount time.
const TICK_MS = 30_000
const listeners = new Set<() => void>()
let nowMs = Date.now()
let timer: ReturnType<typeof setTimeout> | undefined

function tick(): void {
  nowMs = Date.now()
  for (const listener of listeners) listener()
  schedule()
}

function schedule(): void {
  if (listeners.size === 0) return
  const delay = TICK_MS - (nowMs % TICK_MS)
  timer = setTimeout(tick, delay || TICK_MS)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    // A newly mounted label must not inherit the clock value from the last time this singleton was used.
    nowMs = Date.now()
    schedule()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }
}

function getNow(): number {
  return nowMs
}

/** The current wall-clock ms, re-rendering the caller every ~30s so relative-time labels stay fresh. */
export function useNowMs(): number {
  return useSyncExternalStore(subscribe, getNow, getNow)
}
