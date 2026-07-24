import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactElement, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { store, markDrawerClosing, removeDrawerAfterExit } from "../../store.ts"
import { registerDrawerClose } from "../../lib/overlays.ts"
import {
  SHEET_CLOSE_MS,
  SHEET_PANEL_CLASS,
  SHEET_SCRIM_CLASS,
  prefersReducedMotion,
  sheetWidth,
} from "../../lib/sheet.ts"

// The shared lifecycle of ONE drawer-stack layer: the slide-in-on-mount `shown` flag, the animated
// `close()` (mark the stack entry closing → slide out → remove after the transition), the Esc-handler
// registration (App unwinds topmost-first), and the rapid re-open re-arm (a second open cancels the
// store's exit; re-show the still-mounted sheet). Every plain right-sheet AND ThreadSheet's Radix
// variant drive their animation from this, so the timing/removal can never drift between them.
//
// `initiallyOpen` (URL/deep-link-created layers) begins visible — no slide-in — so a cold page never
// mounts a full-screen opacity-0 backdrop that swallows the first click. `closingRef` is exposed so a
// consumer deferring a heavy body (ThreadSheet) can skip revealing it once the layer is already exiting.
export function useSheetLayer(
  id: number,
  initiallyOpen = false,
): { shown: boolean; close: () => void; closingRef: MutableRefObject<boolean> } {
  const [shown, setShown] = useState(initiallyOpen)
  const closingRef = useRef(false)
  const snap = useSnapshot(store)

  // Slide-in on the next frame (interaction-opened only). A background/occluded tab can report
  // visibilityState "visible" while starving requestAnimationFrame entirely, so a 120ms timer backstops
  // the RAF — never leave an interaction-opened sheet an invisible, click-swallowing backdrop forever.
  useEffect(() => {
    if (initiallyOpen) return
    let done = false
    const show = () => {
      if (done || closingRef.current) return
      done = true
      setShown(true)
    }
    const raf = requestAnimationFrame(show)
    const fallback = window.setTimeout(show, 120)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(fallback)
    }
  }, [initiallyOpen])

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    markDrawerClosing(id) // stop URL/topThreadSlug counting this layer the instant it slides out
    setShown(false)
    window.setTimeout(() => removeDrawerAfterExit(id), prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
  }, [id])

  // Register the animated close for App's Esc handler (topmost-first unwinding).
  useEffect(() => {
    registerDrawerClose(id, close)
    return () => registerDrawerClose(id, null)
  }, [id, close])

  // A rapid second open cancels the exit in the store. Re-arm the mounted sheet and leave its old
  // timeout harmless (removeDrawerAfterExit only removes entries that are still closing).
  useEffect(() => {
    if (snap.drawers.find((drawer) => drawer.id === id)?.closing || !closingRef.current) return
    closingRef.current = false
    setShown(true)
  }, [snap.drawers, id])

  return { shown, close, closingRef }
}

// A plain right-side sheet layer (thread doc / plan / sub-agent / background-shell). Owns the scrim,
// the sliding panel, and the stack geometry; the body is a render-prop so the caller can wire close()
// into its own header/actions. ThreadSheet does NOT use this — it needs a Radix focus-scope plus
// pointer/focus-outside exemptions the plain sheets don't — but it consumes useSheetLayer + the same
// class constants so nothing (timing, width, scrim) drifts.
export function Sheet({
  id,
  depth,
  widthDepth,
  widthOffset = 0,
  children,
}: {
  id: number
  depth: number
  widthDepth: number
  widthOffset?: number
  children: (close: () => void) => ReactNode
}): ReactElement {
  const { shown, close } = useSheetLayer(id)
  return (
    <div
      className={`${SHEET_SCRIM_CLASS} flex justify-end ${shown ? "opacity-100" : "opacity-0"}`}
      style={{ zIndex: 50 + depth * 2 }}
      onMouseDown={close}
    >
      <div
        className={`${SHEET_PANEL_CLASS} ${shown ? "translate-x-0" : "translate-x-full"}`}
        style={{ width: sheetWidth(widthDepth, widthOffset) }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children(close)}
      </div>
    </div>
  )
}
