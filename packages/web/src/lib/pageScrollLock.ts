// The PAGE scroll lock and the one thing that has to survive it.
//
// While any overlay is open, App pins the page with the body-fixed dance (`body{position:fixed;
// top:-y}` — see App.tsx for why it isn't `overflow:hidden`). Two consequences bite anything that
// wants to scroll the page WHILE a drawer is on screen or sliding out:
//
//   1. `window.scrollY` reads 0 and the document collapses to viewport height, so `window.scrollTo`
//      is silently clamped to a no-op. Every measurement has to come off the lock's own offset.
//   2. The unlock RESTORES the captured offset, so even a scroll that did land would be undone.
//
// So a scroll requested under the lock doesn't scroll — it parks its landing here, and the unlock
// lands there instead of where the page was. That is what lets a queued sidebar row dismiss the open
// drawer and still auto-scroll to its card (maintainer 2026-08-11): the dismissal holds the lock for
// the whole ~210ms slide-out, which is exactly the window the click happens in.

// The document scroll offset, whether or not the page is locked. Under the lock the body is shifted
// up by the captured offset, so `-body.style.top` is the real scrollY and every getBoundingClientRect
// is already relative to it.
export function pageScrollY(): number {
  if (typeof document === "undefined" || !document.body) return typeof window === "undefined" ? 0 : window.scrollY
  const top = isPageScrollLocked() ? Number.parseFloat(document.body.style.top) : Number.NaN
  return Number.isNaN(top) ? window.scrollY : -top
}

export function isPageScrollLocked(): boolean {
  return typeof document !== "undefined" && document.body?.style.position === "fixed"
}

let pendingUnlockScrollY: number | null = null

// Park a landing for the unlock. Overwrites any earlier request: the newest navigation wins.
export function requestScrollAfterUnlock(y: number): void {
  pendingUnlockScrollY = y
}

// Consume the parked landing (the unlock), or clear a stale one (a fresh lock). Returns null when
// nothing is parked, which is the signal to restore the captured offset as usual.
export function takeScrollAfterUnlock(): number | null {
  const y = pendingUnlockScrollY
  pendingUnlockScrollY = null
  return y
}
