import { useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useBoard, useSubAgentTranscript } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { showToast, threadBySlug } from "../store.ts"
import { childProgressLabel } from "../lib/childOps.ts"
import { elapsedSince } from "../lib/durationLabels.ts"
import { ChildDrillSlugContext, Message, withMessageSpacers } from "./ChatView.tsx"
import { Composer } from "./Composer.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// One SUB-AGENT layer of the side-drawer stack: a right sheet (same slide/backdrop family as the
// thread sheet — via the shared <Sheet>) showing a live/stale sub-agent's OWN transcript. It overlays
// whatever thread it was drilled into; closing reveals the thread beneath. `depth`/`widthDepth` inset
// each successive layer so the stack reads as one.
//
// IT IS NO LONGER READ-ONLY, and it no longer reads as a log. The maintainer's question — "why don't
// sub-agents opened in a drawer have the Working shimmer or a prompt box?" — split into two answers
// that are independent on purpose:
//
//  · LIVENESS (always). A running child gets the same shimmering "Working…" a top-level thread gets,
//    plus the provider's own reading of the step it is on. This never depended on being able to talk
//    to the child — fray already knew it was live — so it lands for every provider.
//  · STEERING (only where it is real). A user message addressed with the child's dispatch tool_use id
//    is routed by the CLI INTO that child's own conversation. Measured live against claude 2.1.220 /
//    SDK 0.3.207: the child acted on it and only the CHILD's transcript carried the token, while the
//    same session's unaddressed control reached only the main thread. It is also the ONLY channel —
//    the SDK exposes no per-agent control request (`stopTask` and `backgroundTasks` are the whole
//    per-task surface). It works for a broker-backed Claude thread's OWN Agent-tool children, and not
//    for a codex child, a tmux thread, or a grandchild. Critically, addressing a child that has
//    already FINISHED does not fail — the CLI falls the message back onto the parent's main thread,
//    where it lands as an instruction nobody aimed there. So the SERVER decides steerability, the box
//    is rendered only off that answer, and where it is absent the drawer states the reason instead of
//    offering an input that cannot deliver.
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

  // The board's LIVE reading of this exact child (the provider's typed task stream: the tool it is
  // running right now, what that step IS in words, and its tool/token counters). Absent for a tmux or
  // codex child and for an older CLI — every field renders only when set, so those read as before.
  const board = useBoard()
  const liveChild = threadBySlug(board, slug)?.subAgents?.find((child) => child.id === subId)

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

          {/* The child's own liveness banner — the thread transcript's treatment, at drawer scale.
              Only while it is actually RUNNING: a settled child's transcript already reads as
              finished, and a stale one is explicitly not claimed to be working. */}
          {running && (
            <SubAgentWorking
              startedAt={liveChild?.startedAt ?? startedAt}
              activity={liveChild?.activity}
              detail={liveChild?.activityDetail}
              toolUses={liveChild?.toolUses}
              tokens={liveChild?.tokens}
            />
          )}

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
                </div>
              </ChildDrillSlugContext.Provider>
            )}
          </div>

          <SubAgentSteerFooter
            slug={slug}
            subId={subId}
            steerable={q.data?.steerable === true}
            note={q.data?.steerNote ?? null}
          />
        </>
      )}
    </Sheet>
  )
}

// The child's liveness strip: the SAME shimmering "Working…" the thread transcript uses, an elapsed
// timer off the dispatch, and — when the provider reported them — what this step IS in words plus how
// far the child has got. Everything after "Working…" is optional and simply absent when unreported;
// nothing here is a placeholder standing in for a reading fray does not have.
function SubAgentWorking({
  startedAt,
  activity,
  detail,
  toolUses,
  tokens,
}: {
  startedAt?: string
  activity?: string
  detail?: string
  toolUses?: number
  tokens?: number
}) {
  // Ticks once a second, exactly like the thread banner, so the elapsed reading advances instead of
  // freezing at whatever it was when the drawer opened. Unmounts with the strip.
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(iv)
  }, [])
  const elapsed = elapsedSince(startedAt)
  const progress = childProgressLabel(toolUses, tokens)
  // `activityDetail` is the provider's per-tool-call sentence and the richest live field; the bare
  // tool name is the fallback for a stream that carried only that.
  const step = detail ?? activity
  return (
    <div data-subagent-working className="shrink-0 border-b border-border bg-panel px-6 py-2.5">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="shimmer-text">Working…</span>
        {elapsed && <span className="tabular-nums text-[12px] text-muted/60">{elapsed}</span>}
      </div>
      {(step || progress) && (
        <div className="mt-0.5 flex min-w-0 items-baseline gap-2 text-[11.5px] text-muted/70">
          {step && <span className="min-w-0 truncate" title={step}>{step}</span>}
          {progress && <span className="shrink-0 tabular-nums text-muted/50">{progress}</span>}
        </div>
      )}
    </div>
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
}: {
  slug: string
  subId: string
  steerable: boolean
  note: string | null
}) {
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
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

  if (!steerable) {
    if (!note) return null
    return (
      <div data-subagent-steer-note className="shrink-0 border-t border-border bg-panel px-4 py-3 text-[11.5px] text-muted/70">
        {note}
      </div>
    )
  }

  return (
    <div data-subagent-steer className="shrink-0 border-t border-border bg-panel px-3 py-3">
      <Composer
        value={message}
        onChange={setMessage}
        onSubmit={send}
        surface="subAgentComposer"
        placeholder="Steer this sub-agent…"
        busy={busy}
      />
    </div>
  )
}
