import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSubAgentTranscript } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { ChildDrillSlugContext, Message, VSpace, WorkingIndicator, withMessageSpacers } from "./ChatView.tsx"
import { Composer } from "./Composer.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// One SUB-AGENT layer of the side-drawer stack: a right sheet (same slide/backdrop family as the
// thread sheet — via the shared <Sheet>) showing a live/stale sub-agent's OWN transcript. It overlays
// whatever thread it was drilled into; closing reveals the thread beneath. `depth`/`widthDepth` inset
// each successive layer so the stack reads as one.
//
// IT IS NO LONGER READ-ONLY, and it no longer reads as a log:
//
//  · LIVENESS (always). A running child gets the exact same shimmering "Working…" tail a top-level
//    transcript gets. It belongs after the latest message INSIDE the scroller — not in a special
//    fixed strip above the conversation, which was a needless divergence from regular rendering.
//  · STEERING (only where it is real). A user message addressed with the child's dispatch tool_use id
//    is routed by the CLI INTO that child's own conversation. Measured live against claude 2.1.220 /
//    SDK 0.3.207: the child acted on it and only the CHILD's transcript carried the token, while the
//    same session's unaddressed control reached only the main thread. It is also the ONLY channel —
//    It works for a broker-backed Claude thread's OWN Agent-tool children, and not
//    for a codex child, a tmux thread, or a grandchild. Critically, addressing a child that has
//    already FINISHED does not fail — the CLI falls the message back onto the parent's main thread,
//    where it lands as an instruction nobody aimed there. So the SERVER decides steerability, the box
//    is rendered only off that answer, and where it is absent the drawer states the reason instead of
//    offering an input that cannot deliver.
//  · STOPPING (where the provider has a control API). Claude's SDK exposes `stopTask(taskId)`, and its
//    task registry is session-wide, so the drawer can stop direct children and descendants for a
//    broker thread. This is deliberately separate from the × on a child row: × retires stale tracking;
//    Stop sub-agent terminates real work and waits for the daemon/provider to confirm the request.
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
  startedAt,
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
  const running = state === "running"
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
                {/* GAP-LESS on purpose: the between-message rhythm is withMessageSpacers' explicit
                    spacers, the same ones the thread transcript uses. A flat container `gap` here put
                    14px between two successive tool-only turns while a batch inside ONE turn stayed at
                    6px — and a child's transcript is nearly all tool calls, so the chunking the tailer
                    happens to have chosen was the most visible thing on the surface. */}
                <div data-transcript-column className="flex flex-col px-6 py-5">
                  {withMessageSpacers(messages, (m, i) => <Message key={i} m={m} />)}
                  {/* Exactly the regular transcript's tail treatment: the status follows the latest
                      message inside the scroller, rather than occupying a special fixed strip above
                      the conversation. A sub-agent drawer is a conversation, not a log dashboard. */}
                  {running && <>
                    {messages.length > 0 && <VSpace />}
                    <WorkingIndicator since={startedAt} />
                  </>}
                </div>
              </ChildDrillSlugContext.Provider>
            )}
          </div>

          <SubAgentSteerFooter
            slug={slug}
            subId={subId}
            steerable={q.data?.steerable === true}
            note={q.data?.steerNote ?? null}
            stoppable={q.data?.stoppable === true}
            stopNote={q.data?.stopNote ?? null}
          />
        </>
      )}
    </Sheet>
  )
}

// The drawer's bottom edge: the prompt box when this child can actually be reached, the server's
// one-line reason when it is running but cannot be, and NOTHING once it has settled — a finished
// transcript needs no footer telling you it finished.
//
// Deliberately NOT ThreadComposerBox. That block carries a thread draft key, the model/effort
// controls, and the `/login` intercept; a sub-agent owns none of those, so reusing it would have put
// three controls on screen that do not apply to a child. What is shared is the <Composer> leaf, so
// the box itself is the same box as everywhere else.
function SubAgentSteerFooter({
  slug,
  subId,
  steerable,
  note,
  stoppable,
  stopNote,
}: {
  slug: string
  subId: string
  steerable: boolean
  note: string | null
  stoppable: boolean
  stopNote: string | null
}) {
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const qc = useQueryClient()

  function send() {
    const text = message.trim()
    if (!text || busy) return
    setBusy(true)
    // Cleared optimistically like every other composer here. A FAILED send re-fills the box rather
    // than losing what was typed — the one thing a dropped steer must never do, and the likeliest
    // failure is the honest one: the child settled between the render and the send.
    setMessage("")
    rpc.subAgentSteer({ slug, id: subId, message: text })
      .then(() => {
        // There is no optimistic bubble to append: measured, the CLI hands an addressed message to
        // the child's model WITHOUT persisting a user record in its transcript, so the steer is
        // legitimately invisible until the child reacts. A refetch is the honest signal.
        void qc.invalidateQueries({ queryKey: ["subAgentTranscript", slug, subId] })
        showToast("Steer sent")
      })
      .catch((error: unknown) => {
        setMessage(text)
        showToast(error instanceof Error ? error.message : "Could not steer this sub-agent")
      })
      .finally(() => setBusy(false))
  }

  function stop() {
    if (stopping) return
    setStopping(true)
    rpc.subAgentStop({ slug, id: subId })
      .then(() => {
        showToast("Sub-agent stopped")
        void qc.invalidateQueries({ queryKey: ["subAgentTranscript", slug, subId] })
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Could not stop this sub-agent")
      })
      .finally(() => setStopping(false))
  }

  if (!steerable && !stoppable) {
    const unavailableNote = note ?? stopNote
    if (!unavailableNote) return null
    return (
      <div data-subagent-steer-note className="shrink-0 border-t border-border bg-panel px-4 py-3 text-[11.5px] text-muted/70">
        {unavailableNote}
      </div>
    )
  }

  return (
    <div data-subagent-steer className="shrink-0 border-t border-border bg-panel px-3 py-3">
      {steerable ? (
        <Composer
          value={message}
          onChange={setMessage}
          onSubmit={send}
          surface="subAgentComposer"
          placeholder="Steer this sub-agent…"
          busy={busy || stopping}
        />
      ) : note ? (
        <div className="px-1 pb-2 text-[11.5px] text-muted/70">{note}</div>
      ) : null}
      {steerable && !stoppable && stopNote && (
        <div className="mt-2 px-1 text-[11.5px] text-muted/70">{stopNote}</div>
      )}
      {stoppable && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            data-stop-subagent
            disabled={stopping}
            onClick={stop}
            className="rounded-md border border-border px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-300 disabled:opacity-50"
          >
            {stopping ? "Stopping…" : "Stop sub-agent"}
          </button>
        </div>
      )}
    </div>
  )
}
