import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/Popover.tsx"
import { GithubRefCardBody } from "./GithubRefCardBody.tsx"
import {
  githubCardEntry,
  isGithubCardStale,
  noteGithubRefs,
  revalidateGithubRef,
  subscribeGithubCards,
} from "../lib/githubHovercards.ts"

// ONE hovercard layer for the whole app, mounted once at the root.
//
// WHY ONE DELEGATED LISTENER AND NOT A COMPONENT PER ANCHOR. The anchors live inside prose that is
// injected as an HTML STRING (`dangerouslySetInnerHTML`, see lib/markdown.ts) — there is no React
// element around a `#123` to wrap, and there never can be without re-parsing every rendered message
// into a React tree. A `pointerover` on the document reaches every one of them, on every surface that
// renders prose, at the cost of a single `closest()` per pointer move onto a new element.
//
// The card is anchored by a zero-size element positioned over the link's own rect, which is what buys
// Radix's collision handling — a reference on the last line of the viewport flips its card above.

/** How long a pointer must rest on a reference before its card opens. GitHub's own feel. */
const OPEN_DELAY_MS = 250

// The grace period after the pointer leaves. It has to be long enough to cross the gap between the
// link and the card — otherwise a card you are deliberately reaching for closes on the way — and
// short enough that brushing past a reference does not leave a panel hanging.
const CLOSE_DELAY_MS = 180

interface Target {
  ref: string
  rect: { top: number; left: number; width: number; height: number }
}

function rectOf(el: Element): Target["rect"] {
  // A reference that WRAPS across two lines has two client rects; the first is where the pointer
  // entered the run, and anchoring to the union of both would place the card diagonally off the text.
  const box = el.getClientRects()[0] ?? el.getBoundingClientRect()
  return { top: box.top, left: box.left, width: box.width, height: box.height }
}

export function GithubHovercards() {
  const [target, setTarget] = useState<Target | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Set while the pointer is inside the card itself, so leaving the LINK does not close a card the
  // reader has moved into (to click a label, or just to finish reading the excerpt).
  const overCard = useRef(false)

  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    openTimer.current = undefined
    closeTimer.current = undefined
  }, [])

  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (!overCard.current) setTarget(null)
    }, CLOSE_DELAY_MS)
  }, [])

  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      // TOUCH AND PEN ARE EXCLUDED. A tap fires `pointerover` before the click, so honouring it would
      // pop a card over the very link the finger is about to follow.
      if (event.pointerType !== "mouse") return
      const el = (event.target as Element | null)?.closest?.("a[data-gh-ref]") ?? null
      const ref = el?.getAttribute("data-gh-ref")
      if (!el || !ref) return
      clearTimeout(closeTimer.current)
      if (target?.ref === ref) return
      clearTimeout(openTimer.current)
      // Ask for it NOW as well as at render time. Normally the batch has already answered and this is
      // a no-op; it is the safety net for an anchor that arrived by some path the render hook did not
      // see (a drawer opening mid-flight), so a hover is never simply blank.
      noteGithubRefs([ref])
      openTimer.current = setTimeout(() => setTarget({ ref, rect: rectOf(el) }), OPEN_DELAY_MS)
    }

    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      if (!(event.target as Element | null)?.closest?.("a[data-gh-ref]")) return
      clearTimeout(openTimer.current)
      scheduleClose()
    }

    document.addEventListener("pointerover", onPointerOver)
    document.addEventListener("pointerout", onPointerOut)
    return () => {
      document.removeEventListener("pointerover", onPointerOver)
      document.removeEventListener("pointerout", onPointerOut)
    }
  }, [target?.ref, scheduleClose])

  // The anchor is a viewport rect captured at open time, so anything that MOVES the link out from
  // under it — scrolling the transcript, resizing, a new message arriving — must close rather than
  // leave a card pointing at empty space. Capture phase so a scroll inside the transcript container
  // (which does not bubble) is seen too.
  useEffect(() => {
    if (!target) return
    const close = () => {
      overCard.current = false
      clearTimers()
      setTarget(null)
    }
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [target, clearTimers])

  useEffect(() => clearTimers, [clearTimers])

  return (
    <Popover open={target !== null}>
      {/* A zero-size element pinned over the link's rect. `fixed` because the rect is in viewport
          coordinates, and `pointer-events-none` so it can never intercept a click on the link under
          it. `aria-hidden` — the card is a redundant preview of a link the reader can simply follow,
          so it is deliberately not announced. */}
      <PopoverAnchor asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed"
          style={{
            top: target?.rect.top ?? 0,
            left: target?.rect.left ?? 0,
            width: target?.rect.width ?? 0,
            height: target?.rect.height ?? 0,
          }}
        />
      </PopoverAnchor>
      {target ? (
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          alignOffset={-8}
          aria-hidden
          // Radix focuses its content on open — which would yank the caret out of the composer every
          // time a pointer drifted over a reference. Nothing here is a focus target.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={() => {
            overCard.current = true
            clearTimeout(closeTimer.current)
          }}
          onPointerLeave={() => {
            overCard.current = false
            scheduleClose()
          }}
          className="overflow-hidden"
        >
          <HovercardPanel refKey={target.ref} />
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

// Reads ONE reference out of the store. Subscribing per-panel rather than lifting the whole map into
// state is what keeps a page of anchors from re-rendering every time a batch lands.
function HovercardPanel({ refKey }: { refKey: string }) {
  const entry = useSyncExternalStore(
    subscribeGithubCards,
    () => githubCardEntry(refKey),
    () => githubCardEntry(refKey),
  )

  // Stale-while-revalidate: the cached card is already on screen: this only refreshes it underneath.
  useEffect(() => {
    if (isGithubCardStale(githubCardEntry(refKey))) revalidateGithubRef(refKey)
  }, [refKey])

  if (entry?.card) return <GithubRefCardBody card={entry.card} />
  // Everything else — still loading, not found, a batch that failed — renders a fixed-size waiting
  // panel rather than nothing. A card that never resolves is a small quiet box; a card that pops in
  // at a different size each frame is worse than no card at all.
  return (
    <div className="flex h-[64px] w-[220px] items-center px-3 text-[12px] text-muted">
      {entry?.missing ? "Not found on GitHub" : "Loading…"}
    </div>
  )
}
