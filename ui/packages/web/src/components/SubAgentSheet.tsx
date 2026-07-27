import { useEffect, useMemo, useRef, useState } from "react"
import { useSubAgentTranscript } from "../hooks.ts"
import { ChildDrillSlugContext, Message } from "./ChatView.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// One SUB-AGENT layer of the side-drawer stack: a right sheet (same slide/backdrop family as the
// thread sheet — via the shared <Sheet>) showing a live/stale sub-agent's OWN transcript, READ-ONLY —
// no composer, no answering, no action bar. It overlays whatever thread it was drilled into; closing
// reveals the thread beneath. `depth`/`widthDepth` inset each successive layer so the stack reads as one.
//
// INSTANT OPEN: the frame + header + spinner mount and paint IMMEDIATELY; the heavy transcript body is
// deferred one frame (bodyReady) so the click→sheet-visible latency isn't gated on parsing/rendering a
// large transcript. The spinner covers the gap.
export function SubAgentSheet({
  id,
  slug,
  subId,
  label,
  subagentType: _subagentType,
  startedAt: _startedAt,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  subId: string
  label: string
  subagentType?: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  // Deferred heavy body — mount the shell first, render the transcript one frame later (see header).
  const [bodyReady, setBodyReady] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)

  const q = useSubAgentTranscript(slug, subId)
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  const state = q.data?.state
  // Unavailable = the RPC errored (e.g. a pre-restart server without this endpoint), the id is unknown
  // ("gone"), or a settled child (done/stale) whose transcript file is empty/cleaned. A RUNNING child
  // with no messages yet is just starting → a spinner, not "unavailable".
  const unavailable = q.isError || state === "gone" || (messages.length === 0 && (state === "done" || state === "stale"))

  // Defer the transcript body one frame past the shell's own slide-in (the shared <Sheet> flips `shown`
  // on the first frame; this lands bodyReady on the next) so the sheet paints instantly.
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setBodyReady(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [])

  // Open at the BOTTOM (the child's latest activity) and stick there as new content streams in while
  // the user is already near the bottom — scoped to the sheet's OWN scroller (never the page).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || !bodyReady) return
    let pin = true
    const toBottom = () => {
      if (pin) el.scrollTop = el.scrollHeight
    }
    const onScroll = () => {
      pin = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(toBottom)
    for (const child of el.children) ro.observe(child)
    toBottom()
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [bodyReady])

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* Header shell paints immediately (part of the instant-open shell). Runtime/profile details
              live on the dispatch row that opens this drawer; the drawer header only names the work. */}
          <SheetHeader title={label} onClose={close} />

          <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto">
            {unavailable ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">
                Transcript unavailable (agent completed or cleaned up).
              </div>
            ) : !bodyReady || q.isLoading || messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
              </div>
            ) : (
              // A child that dispatched children of its OWN renders Agent cards and completion
              // dividers in here. Without a slug those titles were dead text — the maintainer's "some
              // scenarios where that's not the case". The PARENT thread's slug is the drill root (the
              // tailer keys every sub-agent lookup by it); a grandchild it can no longer resolve comes
              // back "gone", which the drawer states plainly. This is deliberately NOT
              // ThreadSlugContext — see the note on ChildDrillSlugContext for why.
              <ChildDrillSlugContext.Provider value={slug}>
                <div className="flex flex-col gap-3.5 px-6 py-5">
                  {messages.map((m, i) => (
                    <Message key={i} m={m} />
                  ))}
                </div>
              </ChildDrillSlugContext.Provider>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}
