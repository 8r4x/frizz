import { useCallback, useEffect, useRef } from "react"

// BACK CLOSES THE SHEET FIRST — a phone's back gesture (Android's edge swipe, the browser's own button)
// must dismiss whatever is floating over the page before it leaves the page. The thread under a phone
// sheet is already a history entry of its own (lib/router pushes one per opened thread layer), so a
// sheet that took no entry of its own would let Back skip straight past it and close the thread, with
// the sheet still up for the 200ms the drawer takes to slide away.
//
// So a sheet PUSHES ONE SAME-URL ENTRY while it is mounted, tagged with a token, and closes when the
// history moves off that entry. Three rules keep it from leaking entries or stepping on the router:
//
//   · SAME URL, router state copied. react-router keeps `{usr, key, idx}` in history.state; the entry
//     carries the router's current values plus our tag, so when Back lands on the router's entry the
//     router sees the location it already has and changes nothing (routes.tsx re-applies the URL only
//     when the PATHNAME changes). Written behind the router's back on purpose: its own navigate()
//     REPLACES on a same-path push, which is exactly the entry this needs.
//   · EVERY OTHER CLOSE GOES THROUGH BACK TOO. A scrim tap, Escape or an action row pops our own entry
//     (`dismiss`), and the popstate is what closes the sheet — so there is one close path, and the entry
//     is gone by the time the caller unmounts. `dismiss(then)` runs `then` only after the pop has
//     landed: an action that itself navigates (Mark as done closes the thread, which REPLACES the
//     current entry) must replace the thread's entry, not the sheet's, or Back would reopen the thread.
//   · NEVER POP AN ENTRY THAT IS NOT OURS. Every `back()` is guarded on the tag still being on top, so a
//     navigation that already replaced it (the thread closing under the sheet) is not answered with a
//     second, wrong step back.
let seq = 0

type SheetHistoryState = { frizzSheet?: number } | null

function currentToken(): number | undefined {
  return (history.state as SheetHistoryState)?.frizzSheet
}

export function useBackDismiss(onDismissed: () => void): (then?: () => void) => void {
  const dismissedRef = useRef(onDismissed)
  dismissedRef.current = onDismissed
  const tokenRef = useRef(0)
  const doneRef = useRef(false)
  const thenRef = useRef<(() => void) | null>(null)
  // A pop that never arrives (a browser that ignores back() on an entry it considers its own) must not
  // leave the sheet stuck open; the fallback finishes it by hand.
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    clearTimeout(fallbackRef.current)
    dismissedRef.current()
    const then = thenRef.current
    thenRef.current = null
    then?.()
  }, [])

  useEffect(() => {
    const token = ++seq
    tokenRef.current = token
    const base = history.state && typeof history.state === "object" ? history.state : {}
    history.pushState({ ...base, frizzSheet: token }, "")
    const onPop = () => {
      if (currentToken() !== token) finish()
    }
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
      clearTimeout(fallbackRef.current)
      // Unmounted by its owner without a Back (the page under it went away): take our entry off if it
      // is still the current one, so it does not sit in the history as a dead step.
      if (currentToken() === token) history.back()
    }
  }, [finish])

  return useCallback((then?: () => void) => {
    if (doneRef.current) return
    thenRef.current = then ?? null
    if (currentToken() !== tokenRef.current) {
      finish()
      return
    }
    history.back()
    fallbackRef.current = setTimeout(finish, 400)
  }, [finish])
}
