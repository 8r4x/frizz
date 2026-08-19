import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { ChevronsUpDown, Hourglass, Inbox } from "lucide-react"
import type { ThreadView, BoardSnapshot, TranscriptMessage } from "@frizz/shared"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { queueCardTargetY, showToast } from "../store.ts"
import { pageScrollY } from "../lib/pageScrollLock.ts"
import { rpc } from "../api/rpc.ts"
import { useBoard, asThreads, useTranscript } from "../hooks.ts"
import { orderQueue, queued, displayTitle, lastActiveLabelAt } from "../groups.ts"
import { useLiveAnswering } from "../lib/answering.ts"
import { hasQuestionBlock } from "../lib/questionBlocks.ts"
import { collapseMiddleRuns, opensQueueSegment, queueCollapseSegments, segmentFolds, supersededAskIndices, survivesQueueCollapse } from "../lib/queueCollapse.ts"
import { pairAllAnswers } from "../lib/answersMessage.ts"
import { Message, NativeInputRequiredCard, PermPolicyDenialCard, PermPromptBanner, PendingAskCard, StickyUserBand, VSpace, STEP, messageTailIsMeta, messageHeadIsMeta, messageRendersNothing, messageHasRenderableText } from "./ChatView.tsx"
import { BLOCK_RADIUS, BLOCK_RADIUS_TOP, CARD_ACTION_EXPLAINER, CARD_PRIMARY_ACTION } from "./TranscriptCard.tsx"
import { AwaitingBackgroundCard } from "./AwaitingBackgroundCard.tsx"
import { agentCompletionCall } from "../lib/subAgentCompletion.ts"
import { coalesceToolActivityMessages } from "../lib/toolActivity.ts"
import { prefs } from "../lib/prefs.ts"
import { ThreadComposerBox } from "./ThreadComposerBox.tsx"
import { BackgroundOpsStrip, ThreadSlugContext, QueueDismissContext } from "./ChatView.tsx"
import { HeaderActions } from "./HeaderActions.tsx"
import { ThreadLifecycleFooter } from "./ThreadLifecycleFooter.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { StatusRow } from "./StatusRow.tsx"
import { InteractionStack } from "./InteractionCards.tsx"
import { QueueSubAgentLines, hasQueueSubAgentLines } from "./QueueSubAgentLines.tsx"
import { WakeDivider } from "./WakeDivider.tsx"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { LastActive } from "./LastActive.tsx"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { CopyTerminalCommandButton, useCopyTerminalCommand } from "./ExternalTerminalCommand.tsx"
import {
  captureTranscriptViewportAnchor,
  prependEarlierPage,
  previousUserBoundary,
  resolveVisibleStart,
  restoreTranscriptViewportAnchor,
  transcriptAnchorCorrection,
  type TranscriptViewportAnchor,
} from "../lib/transcriptPagination.ts"
import type { TranscriptData } from "../hooks.ts"

// The Queue: everything currently waiting on the human, rendered as a SCROLLING LIST of cards — every
// pending item visible at once, one per card, in one vertical column that scrolls when it overflows.
// (This replaced a one-at-a-time pager/stack: with everything visible there is no paging, no peek, and
// no auto-advance — an item simply leaves the list when the board update drops its needs-action flag.)
//
// Each card's own header is STICKY (top-0 within the scroll container, opaque bg + bottom rule) so it
// pins to the viewport top while any part of the card is on screen and the body scrolls under it. The
// navigation/diagnostic actions remain in that header. Snooze and Archive have one compact,
// persistent footer row so completion hydration never moves or duplicates them.
//
// The exit budget (styles.css .frizz-card-slot). A resolved card FADES + recedes (scale/blur) at full
// height, then TodosView UNMOUNTS it and adjusts the viewport (user dismissal → auto-scroll the next
// card to the top; board departure → pin a visible neighbour so nothing on screen shifts). There is
// no height-collapse phase (it drifted the neighbour — see styles.css). Keep in sync with the CSS fade.
const QUEUE_DISSOLVE_MS = 200
// How long a resolved card is KEPT MOUNTED after the board has dropped it, so the fade can finish before
// the unmount + neighbour pin. completeThread / setThreadStatus call ctx.board.refresh() SYNCHRONOUSLY
// (board.ts publish()), so the board delta that removes the thread races the RPC response — without this
// retention the card unmounts the instant the delta lands and no fade ever plays. 120ms of slack past the
// fade leaves margin in both exit paths (board-drop, or the next-frame arm when the board hasn't dropped).
const QUEUE_EXIT_MS = QUEUE_DISSOLVE_MS + 120

// Pick the on-screen neighbour whose position we hold fixed across a card's unmount — the PURE BOARD
// DEPARTURE path only (a card the agent/another client resolved, not a local action): a reader mid-card
// elsewhere must not have their viewport moved. Prefer the card IMMEDIATELY BEFORE the departing one
// (keeps the top of the reader's view stable while the cards below rise to fill), else the card
// IMMEDIATELY AFTER (the top-card case: nothing precedes it, so hold the successor). Only a
// currently-visible, non-leaving card qualifies; null when neither neighbour is on screen (e.g. the
// departing card fills the viewport) — then there is nothing to keep from shifting.
function captureNeighborPin(removingSlug: string): { slug: string; top: number } | null {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-queue-card]")]
  const i = cards.findIndex((el) => el.dataset.queueCard === removingSlug)
  if (i < 0) return null
  const vh = window.innerHeight
  const stableVisible = (el: HTMLElement | undefined): el is HTMLElement => {
    if (!el || el.dataset.queueLeaving === "true" || !el.dataset.queueCard) return false
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < vh
  }
  const anchor = stableVisible(cards[i - 1]) ? cards[i - 1] : stableVisible(cards[i + 1]) ? cards[i + 1] : null
  if (!anchor) return null
  return { slug: anchor.dataset.queueCard!, top: anchor.getBoundingClientRect().top }
}

// Pick the card the USER-INITIATED dismissal auto-scroll lands at the viewport top (maintainer
// 2026-07-21: "some card should be at the top of the screen after any action that dismisses a card").
// SUCCESSOR first — the nearest non-leaving card after the departing one, i.e. the card that rises to
// fill its place — else the nearest predecessor (end-of-list case). Deliberately NOT limited to
// visible cards: when the departing card filled the viewport there is no visible neighbour, and the
// old hold-in-place pin left the reader stranded mid-card; the off-screen successor must still be
// brought to the top. null → queue emptied.
function captureScrollTarget(removingSlug: string): string | null {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-queue-card]")]
  const i = cards.findIndex((el) => el.dataset.queueCard === removingSlug)
  if (i < 0) return null
  const eligible = (el: HTMLElement): boolean => el.dataset.queueLeaving !== "true" && !!el.dataset.queueCard
  for (let j = i + 1; j < cards.length; j++) if (eligible(cards[j])) return cards[j].dataset.queueCard!
  for (let j = i - 1; j >= 0; j--) if (eligible(cards[j])) return cards[j].dataset.queueCard!
  return null
}

// THE one owner of the document's overflow-anchor suspension. TWO machineries in this file suspend
// Chrome's native scroll anchoring around a deliberate viewport correction (the dismissal landing in
// TodosView, the load-earlier anchor dance in QueueCard); if each captured the prior style value with
// its own ref, one could catch the other's "none" as the value to restore and leave anchoring off
// document-wide for the rest of the session. Reference-counted instead: the FIRST suspend captures the
// real prior policy, the LAST release restores it. Every suspend must be paired with exactly one release.
let anchorSuspendCount = 0
let anchorPrevPolicy = ""
function suspendNativeAnchoring(): void {
  if (anchorSuspendCount++ === 0) {
    anchorPrevPolicy = document.documentElement.style.overflowAnchor
    document.documentElement.style.overflowAnchor = "none"
  }
}
function resumeNativeAnchoring(): void {
  if (anchorSuspendCount > 0 && --anchorSuspendCount === 0) {
    document.documentElement.style.overflowAnchor = anchorPrevPolicy
  }
}

// The QUEUE's awaiting-background banner: the shared resting card (AwaitingBackgroundCard, which the
// drawer and the full-screen page render too) plus the one affordance only the queue gets — a one-click
// event-snooze that hides the card until the work returns (the parent comes to a NEW rest). NO session
// is stopped — the thread is already at rest and stays alive; the card simply drops out of the queue and
// re-surfaces on its own when a shell finishes and the worker acts on it. Distinct from the footer's
// wall-clock Snooze (a fixed deadline); this one has no deadline and expires itself on the next rest.
//
// The shapes that reach here are the shell-only rest and — since 2026-08-13 — the pr-watch park, whose
// own fence card no longer offers a Snooze (lib/awaitingPresentation). A rest on a live sub-agent is
// excused from the queue outright.
//
// IT HAS TO FIT ON ONE LINE beside the button, and that is a hard constraint rather than a preference:
// the pair reads as one control with its caption, and a caption that wraps stops being one
// (maintainer 2026-08-13: "I hate that the 'removes this from the queue…' label is breaking onto two
// lines here"). The wording is theirs, verbatim. It also stopped naming a kind, which is what let it
// shrink — the card above it has already said what is out, so the caption only has to say what the
// button does and what brings the card back.
const BG_SNOOZE_EXPLAINER = "Hides card until new activity is detected"

function AwaitingBackgroundBanner({ thread, onSnooze, onSnoozeFailed }: {
  thread: ThreadView
  onSnooze: () => void // optimistically dismiss the card (fade it out now)
  onSnoozeFailed: () => void // reinstate the card if the server declines
}) {
  const [pending, setPending] = useState(false)
  const snooze = () => {
    setPending(true)
    onSnooze() // fade the card immediately, like every other queue dismissal
    rpc
      .snoozeAwaitingBackground({ slug: thread.id, sessionId: thread.sessionId ?? "" })
      .then(() => showToast("Snoozed until the background work returns"))
      .catch((error) => {
        onSnoozeFailed() // roll the card back into the queue
        showToast(`Couldn’t snooze: ${(error as Error).message.slice(0, 80)}`)
        setPending(false)
      })
  }
  return (
    <AwaitingBackgroundCard
      thread={thread}
      actions={
        // Button FIRST, explainer immediately to its right and centered against it (maintainer
        // 2026-07-29, and the same shape as the awaiting card's park button this stacks under): the pair
        // reads as one control with its caption. The explainer is not decoration here — a snooze whose
        // wake condition is an EVENT rather than a clock is unguessable from the verb alone, and the
        // maintainer asked for it in as many words (2026-08-04: "the snooze button should indicate that
        // this will remove the item from the queue until one of the background shells completes").
        <>
          <button
            type="button"
            onClick={snooze}
            disabled={pending}
            onMouseDown={(e) => e.preventDefault()}
            title={BG_SNOOZE_EXPLAINER}
            // The shared card-action chrome, same as the awaiting card's Snooze it stacks under: parking
            // is this banner's one verb, and the recessed outline it used to wear read as a disabled
            // affordance sitting right below an identical white one. Taking CARD_PRIMARY_ACTION rather
            // than restating it is what keeps the two stacked Snoozes from drifting apart on a corner or
            // a fill — they had already been hand-copied once.
            className={`disabled:opacity-45 ${CARD_PRIMARY_ACTION}`}
          >
            {/* Measured, not guessed: the icon read 1.58px LOW here. See lib/iconAlign.ts for why box
                centering leaves a descender-free label's ink high, and why leading-none is not the fix. */}
            <Hourglass size={12} className={ICON_LABEL_NUDGE} />
            Snooze
          </button>
          <span className={CARD_ACTION_EXPLAINER}>{BG_SNOOZE_EXPLAINER}</span>
        </>
      }
    />
  )
}

// Keyboard: a card's inputs are ordinary DOM focus — click in to type, Esc blurs, Enter submits (the
// composer's own handlers). The old focus-machine step-in/arrow-walk was deleted with the mouse-only
// sidebar. The header buttons are mouse-driven (always visible atop each card).
export function TodosView() {
  const board = useBoard()
  // The queue is EXACTLY the server-derived Needs-you session threads (t.needsYou) — legacy .frizz rows
  // never card anymore. One strictly time-ordered list (no priority band): every card orders by
  // last-active alone, FIFO (oldest-first) by default or LIFO per the queueOrder preference.
  const items = orderQueue(asThreads(board?.threads ?? []).filter(queued), useSnapshot(prefs).queueOrder)
  const itemKey = items.map((i) => i.id).join(",")

  // The queue does NO passive/observer-driven scrolling — no on-mount focus, no re-anchor machine
  // (maintainer 2026-07-15: "go back to the drawing board, use the classic approach"). The ONLY viewport
  // adjustments are one-shot and deterministic: (1) at a card's unmount (the useLayoutEffect below) — a
  // USER-INITIATED dismissal auto-scrolls the next card to the viewport top (maintainer 2026-07-21),
  // while a pure board departure only holds a visible neighbour in place — and (2) the sidebar's
  // scroll-to-card (scrollToQueueCard in store.ts), a direct response to a click. Neither is a background
  // auto-scroll or a running observer; the browser's native scroll anchoring handles ordinary reflow.

  // OPTIMISTIC EXIT: a dismissed card leaves the list the instant the human acts, without waiting for the
  // board push (which lags seconds behind on some paths — a sent message clears the queue only once the
  // agent's turn starts). EVERY dismissal funnels here: Mark-as-done, Snooze, an awaiting-card confirm,
  // and steering the agent by sending a message all set `leaving` (via resolve()), and a card the board
  // drops on its own is caught by the departed path below — both run the IDENTICAL board-independent exit
  // (fade → unmount + neighbour pin on a QUEUE_EXIT_MS timer). SAFETY: if the board STILL reports the
  // thread as needs-action a few seconds later (the mutation didn't actually resolve it), resolve()'s 8s
  // guard un-hides it rather than leaving it silently vanished.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const itemsRef = useRef<ThreadView[]>(items)
  itemsRef.current = items
  // Latest-ref mirror so the finalize timer (armed in an effect whose closure may predate a resolve())
  // reads the CURRENT leaving set when deciding user-initiated vs board-departed at unmount time.
  const leavingRef = useRef(leaving)
  leavingRef.current = leaving
  const presentIds = new Set(items.map((i) => i.id))

  // DEPARTED path — a card the board drops WITHOUT (or before) an optimistic resolve(): a confirm-snooze
  // that only publishes server-side, or a thread that resolves a tick before `leaving` records it. If the
  // card unmounted in that gap it would never play its fade (it "just disappears"). So we (1) snapshot each
  // departed thread's frozen view + last position by diffing the previous board against the current one —
  // independent of `leaving` timing — and (2) keep rendering it for one opaque frame, then arm its fade on
  // the next frame so the opacity 1→0 transition has a real from-state. A card already mid-fade when it
  // departs (the optimistic path, board catching up) is armed immediately so it never snaps back to opaque.
  // The finalize timer (below) then unmounts + pins it exactly as the optimistic path does. Bounded FIFO so
  // a long session can't grow the snapshot without limit.
  // (These refs are advanced in the render body — the same pattern as itemsRef above — because the
  // departure must be detected in the SAME render the board drops the thread; deferring to a commit-time
  // effect would give one render where the card is already unmounted, reopening the exact gap this fixes.
  // Idempotent under a StrictMode double-invoke. The one caveat is concurrent Suspense/transitions, which
  // this queue path does not use.)
  const prevItemsRef = useRef<ThreadView[]>([])
  const prevRenderRef = useRef<string[]>([]) // ids of the PREVIOUS render's order (board + still-held cards)
  const departedRef = useRef<Map<string, { view: ThreadView; index: number }>>(new Map())
  const armedRef = useRef<Set<string>>(new Set()) // departed slugs whose fade is armed (leaving=true)
  const goneRef = useRef<Set<string>>(new Set()) // slugs whose fade elapsed → excluded from render (unmounted)
  const finalizeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const reappearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map()) // resolve()'s per-slug 8s guard
  // A dismissed card is unmounted INSTANTLY (no height collapse). We pick an anchor card the instant
  // BEFORE the unmount (in the finalize callback) and adjust the viewport the instant AFTER (the layout
  // effect below). Two modes: "top" (user-initiated dismissal) lands the successor at the viewport-top
  // landing; "hold" (pure board departure) re-pins a visible neighbour exactly where it was, using its
  // pre-unmount `top`. One-shot, at the unmount frame — never a running observer.
  const pinRef = useRef<{ kind: "hold"; slug: string; top: number } | { kind: "top"; slug: string } | null>(null)
  const [exitTick, forceExitRender] = useState(0)
  {
    prevItemsRef.current.forEach((it) => {
      // A board departure snapshots the card so its fade still plays even though the board dropped it.
      // Skip a slug that already finished its exit (goneRef) — it must not be resurrected as a held card.
      if (!presentIds.has(it.id) && !goneRef.current.has(it.id)) {
        // Capture the slot from the PREVIOUS RENDER order (which still holds any earlier-departed cards),
        // NOT from the shrinking board — else two cards departing in separate renders both resolve to the
        // same board index and swap while fading.
        const at = prevRenderRef.current.indexOf(it.id)
        departedRef.current.delete(it.id) // re-insert at the tail so eviction is by most-recent departure
        departedRef.current.set(it.id, { view: it, index: at >= 0 ? at : prevRenderRef.current.length })
        if (leaving.has(it.id)) armedRef.current.add(it.id) // already fading → keep it fading
      }
    })
    prevItemsRef.current = items
    // goneRef housekeeping. (a) Board dropped a gone card that was NOT optimistically dismissed
    // (departed/awaiting-confirm — never in `leaving`): fully retire it. (b) Board dropped a gone card that
    // IS still in `leaving` (a slow-board optimistic dismiss the board just confirmed): keep it hidden here
    // and let the prune effect below drain it — retiring it here would let the exit effect re-arm a second
    // finalize for the same slug. (c) Board still lists a gone card that was NOT dismissed: the board
    // RE-ADDED it after its exit (a spurious drop, or a thread that went actionable again) — un-hide it.
    for (const slug of [...goneRef.current]) {
      if (!presentIds.has(slug)) {
        if (!leaving.has(slug)) {
          goneRef.current.delete(slug)
          departedRef.current.delete(slug)
          armedRef.current.delete(slug)
        }
      } else if (!leaving.has(slug)) {
        goneRef.current.delete(slug)
        armedRef.current.delete(slug)
      }
    }
    while (departedRef.current.size > 32) {
      const oldest = departedRef.current.keys().next().value
      if (oldest === undefined) break
      departedRef.current.delete(oldest)
      armedRef.current.delete(oldest)
      const orphan = finalizeTimersRef.current.get(oldest)
      if (orphan) { clearTimeout(orphan); finalizeTimersRef.current.delete(oldest) }
    }
  }
  // A card's data-queue-leaving: on-board cards read the optimistic set; departed (held) cards read the
  // arm set so their first held frame is full-height and the transition can run.
  const isLeaving = (slug: string) => (presentIds.has(slug) ? leaving.has(slug) : armedRef.current.has(slug))

  // Render list = the board's queue, PLUS any held (departed, mid-fade) card re-inserted at its
  // last-known position so it stays mounted and fades in place instead of vanishing. Cards that finished
  // their exit (goneRef) are excluded whether or not the board has caught up — that instant removal is
  // what the neighbour pin compensates. Spliced low-index-first so each stored index still addresses the
  // right slot as the list grows.
  // Recomputed with `items` itself (NOT the membership-only itemKey it once keyed on): keying on itemKey
  // froze every card's ThreadView at the last membership change, so field-level board deltas on a mounted
  // card (lastActivityAt, lastAssistant, statusText) never reached it — the card rendered a stale snapshot
  // (and its activity-edge transcript refetch below never fired). Recomputing per render is O(queue size)
  // splice work on a tiny list; the memoized CardSlot/QueueCard boundary (JSON-compare on thread) is what
  // actually prevents re-render churn, and it only passes threads that genuinely changed.
  const renderItems = useMemo(() => {
    const list = items.filter((it) => !goneRef.current.has(it.id))
    const held = [...departedRef.current.entries()]
      .filter(([s]) => !presentIds.has(s) && !goneRef.current.has(s))
      .map(([, v]) => v)
      .sort((a, b) => a.index - b.index)
    for (const { view, index } of held) list.splice(Math.min(index, list.length), 0, view)
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, leaving, exitTick])
  // Remember this render's exact order (board + held) so the NEXT departure captures a stable slot.
  prevRenderRef.current = renderItems.map((i) => i.id)

  // Drive EVERY exiting card through the SAME board-independent exit, so all dismissal paths (Mark done,
  // Snooze, an awaiting-confirm snooze, or steering the agent by sending a message) behave identically:
  // (1) ARM a board-departed card's fade on the next frame (one opaque frame must paint first, else there
  // is no transition), (2) FINALIZE — pin a neighbour, then un-mount — QUEUE_EXIT_MS after the card BEGAN
  // exiting. "Exiting" = optimistically dismissed (in `leaving`, the board may still list it) OR
  // board-departed. Gating finalize on the timer (not the board drop) is what stopped a slow-board path
  // (a sent message clears the queue only once the agent's turn starts) from leaving a lingering blank.
  useEffect(() => {
    const departedHeld = [...departedRef.current.keys()].filter((s) => !presentIds.has(s) && !goneRef.current.has(s))
    const toArm = departedHeld.filter((s) => !armedRef.current.has(s))
    let raf: number | undefined
    if (toArm.length) {
      raf = requestAnimationFrame(() => {
        // Re-check membership: a slug whose finalize timer already fired (rare — rAF starved past
        // QUEUE_EXIT_MS in a backgrounded tab) must not be re-added as a stale arm entry.
        toArm.forEach((s) => { if (departedRef.current.has(s)) armedRef.current.add(s) })
        forceExitRender((n) => n + 1)
      })
    }
    const exiting = new Set<string>()
    for (const s of leaving) if (!goneRef.current.has(s)) exiting.add(s)
    for (const s of departedHeld) exiting.add(s)
    for (const slug of exiting) {
      if (finalizeTimersRef.current.has(slug)) continue
      const timer = setTimeout(() => {
        finalizeTimersRef.current.delete(slug)
        // Snapshot the anchor BEFORE the unmount renders — consumed in the layout effect below. A
        // user-initiated dismissal (`leaving` is fed ONLY by resolve(), i.e. a local action on the
        // card) auto-scrolls the next card to the viewport top; a pure board departure keeps the
        // hold-in-place neighbour pin so a reader mid-card elsewhere is never yanked.
        if (leavingRef.current.has(slug)) {
          const target = captureScrollTarget(slug)
          pinRef.current = target ? { kind: "top", slug: target } : null
        } else {
          const pin = captureNeighborPin(slug)
          pinRef.current = pin ? { kind: "hold", ...pin } : null
        }
        goneRef.current.add(slug) // exclude from render → unmount, regardless of whether the board dropped it
        armedRef.current.delete(slug)
        // Deliberately do NOT drain `leaving` here — keep the slug in it (goneRef hides the card) so
        // resolve()'s 8s guard can still reappear it if the mutation never actually resolved. The single
        // drain is the prune effect below, once the board CONFIRMS the drop.
        forceExitRender((n) => n + 1)
      }, QUEUE_EXIT_MS)
      finalizeTimersRef.current.set(slug, timer)
    }
    return () => { if (raf !== undefined) cancelAnimationFrame(raf) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, leaving, exitTick])
  // The SINGLE drain for optimistically-dismissed cards: once a gone slug has also LEFT the board (the
  // mutation resolved), retire every trace of it and drop it from `leaving`. This is what keeps the
  // optimistic set from growing across a long session; a still-listed gone slug stays (hidden) so the 8s
  // guard can rescue a never-resolving dismiss. A departed (never-in-`leaving`) card is retired inline in
  // the render body instead, so it is not handled here.
  useEffect(() => {
    const stale = [...leaving].filter((slug) => goneRef.current.has(slug) && !presentIds.has(slug))
    if (stale.length === 0) return
    for (const slug of stale) {
      goneRef.current.delete(slug)
      departedRef.current.delete(slug)
      armedRef.current.delete(slug)
    }
    setLeaving((prev) => {
      const next = new Set(prev)
      for (const slug of stale) next.delete(slug)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, exitTick])
  useEffect(() => () => {
    for (const t of finalizeTimersRef.current.values()) clearTimeout(t)
    for (const t of reappearTimersRef.current.values()) clearTimeout(t)
  }, [])

  // The UNMOUNT-FRAME viewport adjustment: runs after every exit render (keyed on exitTick), but only
  // acts when the finalize callback just armed a pin. Both modes are one instant correction
  // (`behavior:"auto"` — the queue's idiom is deterministic one-shot moves, never an animation):
  //   • "hold" (pure board departure): restore the visible neighbour to its pre-unmount viewport top.
  //     Anchoring-COMPATIBLE — the browser's anchor node ends up exactly where it was, so Chrome's
  //     native scroll anchoring (which settles AFTER layout effects) computes a no-op.
  //   • "top" (user-initiated dismissal): land the successor at the standard viewport-top landing —
  //     the deliberate auto-scroll (maintainer 2026-07-21: "some card should be at the top of the
  //     screen after any action that dismisses a card"). Anchoring-HOSTILE — we MOVE the content the
  //     browser's anchor was tracking, and native anchoring would silently scroll it right back (the
  //     observed bug: the viewport "landed mid-card" at its old offset). So suspend overflow-anchor
  //     and re-assert the landing across the two settle frames, exactly like the load-earlier anchor
  //     dance in QueueCard below.
  useLayoutEffect(() => {
    const pin = pinRef.current
    if (!pin) return
    pinRef.current = null
    const el = document.querySelector<HTMLElement>(`[data-queue-card="${CSS.escape(pin.slug)}"]`)
    if (!el) return
    if (pin.kind === "hold") {
      const delta = el.getBoundingClientRect().top - pin.top
      if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, left: 0, behavior: "auto" })
      return
    }
    suspendNativeAnchoring()
    const land = () => {
      const targetY = queueCardTargetY(pin.slug)
      // pageScrollY(), to stay on the same axis queueCardTargetY measures in. Identical to
      // window.scrollY on the unlocked page this dance actually runs on; it just can't disagree with
      // the target if an overlay ever holds the lock through a card's exit.
      if (targetY !== null && Math.abs(pageScrollY() - targetY) > 0.5) window.scrollTo({ top: targetY, left: 0, behavior: "auto" })
    }
    land()
    requestAnimationFrame(() => {
      land()
      requestAnimationFrame(() => {
        land()
        resumeNativeAnchoring()
      })
    })
  }, [exitTick])

  // useCallback([]): identity-stable so the memoized QueueCard's props don't churn per render — it
  // closes only over stable refs + setLeaving, and takes the slug as its argument.
  // Resolving flags the slug as leaving → the card FADES + recedes in place, then unmounts. resolve()
  // itself does NOT scroll: the viewport adjustment is the one-shot unmount effect above, which (for
  // this user-initiated path) auto-scrolls the next card to the viewport top once the fade completes.
  const resolve = useCallback((slug: string) => {
    setLeaving((prev) => new Set(prev).add(slug))
    // Reappear if the board still insists it needs action after the exit + a grace window. 8s (not
    // 4s): a replied card only clears once the agent's turn STARTS (humanBlocked+running → not
    // actionable, per needsAction), and message-paste → turn-start can lag a couple seconds through the
    // 1s tailer poll — a tighter window would flicker the card back before the board confirmed the exit.
    // Tracked per slug and REPLACED on a re-dismiss of the same slug: a stale guard from an earlier dismiss
    // must not fire and un-hide a card the human just dismissed again.
    const prior = reappearTimersRef.current.get(slug)
    if (prior) clearTimeout(prior)
    const guard = setTimeout(() => {
      reappearTimersRef.current.delete(slug)
      if (itemsRef.current.some((t) => t.id === slug)) {
        // Still needed → un-hide (goneRef) and un-fade (leaving) so the card returns opaque.
        goneRef.current.delete(slug)
        armedRef.current.delete(slug)
        setLeaving((prev) => {
          if (!prev.has(slug)) return prev
          const next = new Set(prev)
          next.delete(slug)
          return next
        })
        forceExitRender((n) => n + 1)
      }
    }, 8000)
    reappearTimersRef.current.set(slug, guard)
  }, [])

  // Undo an OPTIMISTIC dismissal at once — the counterpart to resolve(). A card that faded on click
  // (Mark-as-done before its RPC returned) calls this when the server declines to complete it (it now
  // wants a confirmation dialog, or the mutation errored), so the card must snap back into the queue
  // instead of waiting out resolve()'s 8s reappear guard. Cancels that pending guard AND the pending
  // finalize (unmount) timer — so if the decline arrives before the card has unmounted, the card and its
  // (dialog-owning) Mark-as-done button stay mounted rather than being torn down a beat later — then
  // clears every exit-state bit for the slug (the guard's own un-hide branch, fired immediately).
  const unresolve = useCallback((slug: string) => {
    const prior = reappearTimersRef.current.get(slug)
    if (prior) { clearTimeout(prior); reappearTimersRef.current.delete(slug) }
    const finalize = finalizeTimersRef.current.get(slug)
    if (finalize) { clearTimeout(finalize); finalizeTimersRef.current.delete(slug) }
    goneRef.current.delete(slug)
    armedRef.current.delete(slug)
    setLeaving((prev) => {
      if (!prev.has(slug)) return prev
      const next = new Set(prev)
      next.delete(slug)
      return next
    })
    forceExitRender((n) => n + 1)
  }, [])

  // The thread LISTING moved out of this column into the left SIDEBAR (Active / Plans / Inactive
  // sections — see Sidebar.tsx + groups.ts sectionThreads). The queue keeps only the cards + the
  // dispatch box. An empty queue over a populated board just shows the dispatch box (top-anchored).
  // Only a BRAND-NEW board — zero threads of ANY status (a board with only done/dismissed threads is
  // NOT a new user) — centers the prompt box as the whole screen; App hides the sidebar in lockstep
  // on this same predicate, so the fresh-user experience is just the prompt + corner chrome.
  // Foreign (terminal) sessions DO count, since 2026-08-19 — they have a rail band now, and a project
  // whose only content is your own terminal sessions is not a blank slate, it is the one place that
  // band has something to say. Kept in lockstep with lib/sidebarPresence.ts, which decides whether the
  // rail mounts at all; the two disagreeing would centre the prompt beside a populated sidebar.
  const nothingAtAll = (board?.threads.length ?? 0) === 0 && (board?.plans?.length ?? 0) === 0

  return (
    // The queue column, top to bottom: queue cards (or the empty-inbox state) → rule → dispatch box.
    // NO scroll container here — the PAGE scrolls. my-auto (NOT justify-center, whose top overflow
    // would be unreachable): the column vertically CENTERS in the viewport while its content is
    // shorter (App's <main> is a min-h-screen flex column), and degrades safely to normal
    // top-anchored flow the moment it grows past — margins collapse to 0, nothing clips.
    <div className="my-auto w-full min-w-0 flex flex-col py-8">
      {/* Source-of-truth failures are LOUD: a board that can't be read renders as this banner, never
          as a silently empty listing (a truncated shell-out once blanked a 700-thread board with the
          error hidden in an unrendered field). */}
      <BoardErrorsBanner board={board} />

      {renderItems.length > 0 && (
        <div className="flex flex-col [&>*:last-child_hr]:hidden">
          {renderItems.map((item) => (
            <CardSlot key={item.id} slug={item.id} leaving={isLeaving(item.id)}>
              <QueueCard thread={item} leaving={isLeaving(item.id)} onResolve={resolve} onUnresolve={unresolve} />
            </CardSlot>
          ))}
        </div>
      )}

      {nothingAtAll ? (
        // BRAND-NEW repo (zero threads of any status; the sidebar is hidden in lockstep): the prompt
        // box IS the whole screen, centered. The FIRST dispatch adds an active thread → the sidebar
        // appears and this same box shunts to its top; this column then holds only the queue.
        <div className="w-full flex flex-col gap-3">
          <h2 className="text-[15px] font-medium text-center">What should the agent do?</h2>
          {/* The status row rides the top of the PROMPT BOX, and on a brand-new project this is the
              prompt box — the sidebar that normally carries it is hidden here. Without this the one
              screen a fresh install starts on would have no project identity, no way to settings, no
              reload and no quota reading at all. It sits below the heading rather than above it: the
              heading is this screen's title, the row belongs to the composer under it. */}
          <StatusRow />
          {/* The GitHub picker's door rides inside DispatchForm's composer now (a small icon left of
              the send button), so no separate trigger here. */}
          <DispatchForm autoFocus />
        </div>
      ) : renderItems.length === 0 ? (
        // Nothing's queued: the calm empty-inbox (NO dispatch box — the prompt box lives in the
        // sidebar). It STANDS whether or not anything is currently active — a board whose threads are
        // all busy and a board whose threads are all finished both read as inbox-zero, not as a blank
        // column (it used to vanish with the last active thread, leaving the workpane empty). Only the
        // brand-new board above opts out, since its centered prompt says the same thing better. Gated
        // on renderItems (not items) so the empty state can't flash UNDER the last card while it
        // dissolves.
        <div className="flex flex-col items-center gap-2 pt-2">
          <Inbox size={40} strokeWidth={1.25} className="text-muted/30" />
          <div className="text-[13px] text-muted/80">No threads awaiting human input</div>
        </div>
      ) : null}
    </div>
  )
}

// The board-errors banner: source-of-truth failures rendered LOUD (never a silently empty listing).
// A REPAIRABLE error (a thread .md with no YAML frontmatter — invisible to the queue/status system)
// gets a one-click Repair button that prepends minimal frontmatter and rebuilds the board; the entry
// clears on the next snapshot. Non-repairable errors render exactly as before. Falls back to the plain
// `errors` strings when the structured `errorItems` is absent (a pre-restart server).
function BoardErrorsBanner({ board }: { board: BoardSnapshot | null }) {
  const items = board?.errorItems ?? []
  const legacy = board?.errors ?? []
  if (items.length === 0 && legacy.length === 0) return null
  return (
    <div className={`mb-6 ${BLOCK_RADIUS} border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-[12px] text-amber-200/90`}>
      <div className="font-medium mb-0.5">Board errors</div>
      {items.length > 0
        ? items.slice(0, 6).map((it, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate" title={`${it.file ? `${it.file}: ` : ""}${it.message}`}>
                {it.file ? `${it.file}: ` : ""}
                {it.message}
              </span>
              {it.kind === "no-frontmatter" && <RepairButton file={it.file} />}
            </div>
          ))
        : legacy.slice(0, 3).map((e, i) => (
            <div key={i} className="truncate" title={e}>
              {e}
            </div>
          ))}
    </div>
  )
}

// The per-error Repair action. Each button owns its own mutation so its pending/disabled state is
// isolated. On success the fix has landed on disk + a board rebuild is in flight — the banner entry
// disappears on the next snapshot; a toast confirms. On refusal (server-side guard) the toast carries
// the reason.
function RepairButton({ file }: { file: string }) {
  const repair = useMutation({
    mutationFn: () => rpc.repairThread({ file }),
    onSuccess: ({ slug }) => showToast(`Repaired ${slug} — verify its status`),
    onError: (err) => showToast(err instanceof Error ? err.message : "Repair failed"),
  })
  return (
    <button
      onClick={() => repair.mutate()}
      disabled={repair.isPending}
      className="shrink-0 rounded border border-amber-400/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-100 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
      title="Prepend minimal frontmatter (title + status: active) so this thread becomes visible again"
    >
      {repair.isPending ? "Repairing…" : "Repair"}
    </button>
  )
}

// (AgentRow / StatusChip / InactiveSection moved OUT of this column: the left Sidebar's ThreadRow +
// sections replaced the in-column listing wholesale — see Sidebar.tsx.)

// One card's row in the list. On exit the card FADES + recedes (content blurs + scales from its centre,
// fading out AT FULL HEIGHT), then TodosView unmounts it. There is no height-collapse phase: the row is
// removed instantly and TodosView's one-shot unmount effect adjusts the viewport (auto-scroll next card
// to top, or hold a neighbour in place). The `.frizz-card-slot` rules in styles.css carry the
// fade/scale/blur. `data-queue-card=<slug>` is the anchor a sidebar row uses to jump to its queue card
// instead of opening a drawer (scrollToQueueCard in store.ts), and the unmount anchors use it too;
// `data-queue-leaving` drives the fade CSS.
function CardSlot({ leaving, slug, children }: { leaving: boolean; slug: string; children: ReactNode }) {
  return (
    // min-w-0 at EVERY level: grid items and flex children default to min-width:auto, so one wide
    // diff line inside a card would otherwise widen the whole queue column and make it pan sideways
    // (~346px of horizontal overflow before this) instead of letting the diff body's own
    // overflow-x:auto engage.
    <div data-queue-card={slug} data-queue-leaving={leaving} className="frizz-card-slot min-w-0">
      {/* .frizz-card-clip: a plain min-h-0/min-w-0 wrapper (no overflow:hidden — an overflow ancestor at
          rest would establish a scroll container that neuters the sticky header). */}
      <div className="frizz-card-clip min-h-0 min-w-0">
        {/* .frizz-card-body carries the fade's blur/scale (transform-origin: centre — it recedes uniformly). */}
        <div className="frizz-card-body min-w-0">
          {children}
          {/* Generous inter-card space with a hairline rule; removed with the card on exit. The
              list container hides the LAST card's rule. */}
          <hr className="my-10 border-0 border-t border-border/60" />
        </div>
      </div>
    </div>
  )
}

// The higher-level, turn-level collapse: ONE HAIRLINE DIVIDER standing in for the entire intermediate
// run between the pinned user ask and the agent's final message. It wears the very chrome every other
// divider in the transcript wears (WakeDivider) rather than the bordered, full-width panel it used to
// be — an ELISION between two pieces of prose is a section break, and as a box it read as a card
// competing with the messages it sits between (maintainer 2026-07-31). It keeps the stacked-chevron
// ChevronsUpDown expand glyph, which is now the divider's `icon` and so inherits the one measured
// petite-caps nudge instead of a second hand-rolled correction.
//
// The STEP COUNT went with the box (same ask). Tool calls are the scale a reader actually judges an
// elided run by, and a hairline label carrying two numbers plus its own affordance text is a rule with
// a sentence on it. Steps still decide WHETHER to collapse (see collapseIntermediate) — a prose-only
// intermediate run is still worth hiding — so a zero-tool divider simply reads "Click to expand".
//
// Clicking is ONE-WAY: it reveals the full log and the divider unmounts; there is no re-collapse
// (the maintainer's ask).
/** The MIDDLE runs, as one line. Distinct from `IntermediateSummary` because it stands for whole ROUNDS
 *  — rest, wake, work, rest again — rather than the calls inside one of them, and the count a reader
 *  wants is how many times the agent went round, not how many records that took. */
function MiddleRunsSummary({ runs, toolCount, onExpand }: { runs: number; toolCount: number; onExpand: () => void }) {
  const tools = toolCount > 0 ? `${toolCount} tool call${toolCount === 1 ? "" : "s"}` : ""
  const label = `${runs} more round${runs === 1 ? "" : "s"}`
  return (
    <WakeDivider
      icon={ChevronsUpDown}
      marker="middle-runs-summary"
      onClick={onExpand}
      ariaLabel={`Expand ${label}${tools ? ` and ${tools}` : ""} of intermediate agent activity`}
    >
      <span className="shrink-0 tabular-nums">{label}</span>
      {tools && (
        <>
          <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
          <span className="shrink-0 tabular-nums">{tools}</span>
        </>
      )}
      <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
      <span className="shrink-0">Click to expand</span>
    </WakeDivider>
  )
}

function IntermediateSummary({ toolCount, onExpand }: { toolCount: number; onExpand: () => void }) {
  const tools = toolCount > 0 ? `${toolCount} tool call${toolCount === 1 ? "" : "s"}` : ""
  return (
    <WakeDivider
      icon={ChevronsUpDown}
      marker="intermediate-summary"
      onClick={onExpand}
      ariaLabel={`Expand ${tools ? `${tools} of ` : ""}intermediate agent activity`}
    >
      {tools && (
        <>
          <span className="shrink-0 tabular-nums">{tools}</span>
          <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
        </>
      )}
      <span className="shrink-0">Click to expand</span>
    </WakeDivider>
  )
}

// MEMOIZED like AgentRow (same replace-semantics safety: an unchanged thread keeps snapshot identity, a
// changed one is a whole new object): a board delta re-renders only the card whose thread actually
// changed, instead of every mounted card — and each card's transcript is further guarded by the
// memoized Message. `onResolve` takes the slug (stable useCallback in TodosView) so this card's props
// never churn identity render-to-render.
const QueueCard = memo(function QueueCard({ thread, leaving, onResolve, onUnresolve }: { thread: ThreadView; leaving: boolean; onResolve: (slug: string) => void; onUnresolve: (slug: string) => void }) {
  const [collapsed, setCollapsed] = useState(false)
  // Higher-level (turn-level) collapse: the whole run of INTERMEDIATE steps between the pinned last
  // user message and the final agent message is hidden behind a single summary divider by default, so a
  // triage card shows "what I asked" + "what the agent is saying NOW" without the wall of tool calls
  // in between. Deliberately ONE-WAY — expanding is a commitment to read the full log; there is no
  // re-collapse (the maintainer's ask). Distinct from the per-message ToolCalls collapse, which is
  // unaffected. Reset when a replacement session swaps the transcript out (see the transcriptKey effect).
  const [intermediateExpanded, setIntermediateExpanded] = useState(false)
  // Mark-as choreography: the card DIMS the instant a status mutation starts (immediate visual
  // acknowledgment), then collapses via onResolve once the server confirms. A failure un-dims.
  const [resolving, setResolving] = useState(false)
  const [visibleStartId, setVisibleStartId] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [bottomScrollReserve, setBottomScrollReserve] = useState(0)
  const messageListRef = useRef<HTMLDivElement>(null)
  // The card header is sticky at the page top; the pinned user message (StickyUserBand) must stick
  // just BELOW it. Its height is dynamic (title + timestamp + optional status line), so measure it and
  // feed the pixel offset into the band's sticky `top`. (The header's own top offset — 0, or 40px under
  // 800px where a fixed nav bar sits — is added by the band's own responsive class.)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerH, setHeaderH] = useState(0)
  // `reserved` marks that this anchor already spent its ONE bottom-reserve growth (see the layout effect):
  // the reserve adds exactly the pixels the correction was short, so a second ask means it is not
  // converging — retrying instead of abandoning is what let a scroll-locked document loop forever.
  const pendingViewportAnchor = useRef<{ anchor: TranscriptViewportAnchor; targetStartId: string; reserved?: boolean } | null>(null)
  // True while THIS card holds one suspension of the shared native-anchoring owner (see
  // suspendNativeAnchoring at module top) for its load-earlier viewport-anchor dance.
  const anchoringHeld = useRef(false)
  const anchorSettlementScheduled = useRef(false)
  const transcriptKeyRef = useRef<string | null>(null)
  const queryClient = useQueryClient()
  const copyTerminalCommand = useCopyTerminalCommand(thread.id)
  // Client view pref: how (or whether) to pin the current ask to the pane top. `off` → plain flow.
  const { stickyUserMessage } = useSnapshot(prefs)

  // Track the sticky header's height so the pinned user message can stick directly beneath it.
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const measure = () => setHeaderH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed])

  // The queue card is a simplified thread: by default the most recent messages, with "View more"
  // revealing progressively older ones above. statusText is the fallback before any transcript exists.
  const q = useTranscript(thread.id, { poll: false })
  // Freshness (subscription within the socket budget, activity-edge refetch beyond it) is centrally
  // managed by transcript-live.ts keyed on this hook's cache observer — the card wires nothing itself.
  // Raw server order — each message renders its `parts` in block order (fidelity). Memoized so the
  // windowing/useLiveAnswering below line up on identity.
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  // Question↔answer pairing for "Answers:" user messages, precomputed over the FULL list (the lookback
  // may need messages above the visible window). Indexed by GLOBAL message index — the same one the
  // Message key uses. null at ordinary indices keeps the memoized Message's props stable.
  const paired = useMemo(() => pairAllAnswers(messages), [messages])
  // Default window: everything back to (and INCLUDING) the most recent message THE HUMAN wrote — a
  // built-in reminder of what they last asked for. No such message yet → the whole transcript.
  //
  // `role === "user"` alone is not the human. Frizz writes as the user: the Goal delivery, the sign-off
  // reminder, a watcher wake are all user records carrying `wake` (the server's own tell, set by the
  // build that composed them). Anchoring on those cut the card at frizz's own boilerplate and hid the
  // task — the card opened on an answer to a question the reader could no longer see (maintainer
  // 2026-08-12: "queue cards STILL need to go all the way back to the last user message. that's
  // important context that needs to be surfaced").
  //
  // A queued send is skipped too: it has not been delivered, so nothing after it is a reply to it.
  const lastUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "user" && !m.wake && !m.queued) return i
    }
    return 0
  }, [messages])
  // Where the CURRENT TURN starts: one past the most recent `rest` divider that still has renderable
  // content after it — an agent that rested and was then woken again (a background task, a timer, a
  // sub-agent returning) carries the whole PREVIOUS turn above that line. The TRAILING rest is
  // deliberately not a candidate: nothing renders after it, so a cut there would leave an empty card.
  // 0 when no rest is followed by anything.
  //
  // It used to CUT the window here (maintainer 2026-08-11) and then to anchor the collapse. It does
  // neither now — both reach back to the human's ask instead — and all that survives is its use as the
  // collapse's "there is something above this" gate, for a wake-driven turn with no ask of its own.
  const restTurnStart = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].boundary !== "rest") continue
      for (let g = i + 1; g < messages.length; g++) {
        const after = messages[g]
        if (after.queued || after.boundary === "rest" || messageRendersNothing(after)) continue
        return i + 1
      }
    }
    return 0
  }, [messages])
  // Which message gets pinned to the pane top (StickyUserBand). The most recent LANDED user message —
  // queued/optimistic follow-ups pin to the card bottom and aren't the "current ask", and are skipped
  // by the first render pass anyway, so anchoring the band on one would drop it entirely. -1 → none.
  const stickyUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && !messages[i].queued) return i
    return -1
  }, [messages])
  // What a summary divider hides. Each RUN's opening and closing prose render TEXT ONLY (the maintainer:
  // the tool calls batched into them "are almost never useful"), so everything else in that run
  // collapses — the fully-hidden middle messages, the tool bands batched into those two, and any calls
  // made after the closing prose.
  //
  // A RUN'S ANCHORS REQUIRE PROSE (messageHasRenderableText), not merely "renders something": they are
  // rendered `textOnly`, so a tools-only message has nothing to show and must not become one. When the
  // agent asked and then RESTED, the closing message IS the ```question carrying the answer chips; when
  // it kept working past its ask, the ask is answered per-message via answeringForMessage regardless of
  // which message anchors the run.
  //
  // THE FIRST RUN STARTS AT THE HUMAN'S LAST ASK (lastUserIdx), which is the same message the window is
  // anchored on. It used to start at the CURRENT TURN (`Math.max(stickyUserIdx + 1, restTurnStart)`),
  // from a build whose window was cut at the previous rest, so the two agreed. Once the window reached
  // back past every rest to the human's task (2026-08-12) they no longer did, and the gap between them
  // rendered RAW: a thread frizz had driven across seven rests painted all seven turns in full. Measured
  // on the maintainer's zod board: one card at 122 messages and 17,854px with no summary divider in it.
  //
  // NOT `visibleStart`: that moves when the reader clicks "View more", and loaded-earlier history is
  // deliberately shown in full around the collapse rather than swallowed by it.
  //
  // BACKGROUND TASKS AND SUB-AGENT DISPATCHES ARE COUNTED AND HIDDEN LIKE ANY OTHER CALL. They used to
  // be lifted out into their own row (maintainer 2026-08-01: "It's important that those show up in the
  // chat"), and that is reversed here for the QUEUE CARD only — the thread view still shows every one.
  // The card is a triage surface, and its shape is "your last message, a bit of text, the fold, more
  // text" (maintainer 2026-08-12: "I don't know why the bash calls weren't folded in to the click to
  // expand section that's kind of weird"). Nothing is lost by folding them: a task still RUNNING is
  // already listed under the card's own prompt box (BackgroundOpsStrip / QueueSubAgentLines, which read
  // live board telemetry rather than the transcript), and a FINISHED one is history the fold carries.
  //
  // Whole MESSAGES are still lifted out, but only two: an open ask, and the scheduler wake that says
  // what re-invoked the agent. See lib/queueCollapse.survivesQueueCollapse, which this walk and the
  // render loop both go through so the divider can't promise the expansion a message it already shows.
  // Zero when the agent answered in a single message (firstRenderedIdx === lastRenderedIdx → nothing
  // intermediate). The pinned ask and loaded-earlier history sit outside this range.
  const supersededAsks = useMemo(() => supersededAskIndices(messages), [messages])
  // The per-message facts the segment walk needs, evaluated here because they need the transcript schema
  // and this card's own render predicates. The walk itself is pure — see lib/queueCollapse.
  const collapseSteps = useMemo(() => messages.map((m, g) => {
    if (!m || m.queued || messageRendersNothing(m)) return { skip: true }
    // THE REST DIVIDER: dropped by the render loop outright, expanded or not (see below) — the card's own
    // premise, so it may not anchor a run's opening or closing prose and may not count as a hidden step,
    // since expanding reveals nothing where it stood. It is still the CUT: `closes` ends the run whose
    // last prose the agent rested on, which is the message the maintainer asked to always see.
    if (m.boundary === "rest") return { skip: true, closes: true }
    // A sub-agent completion marker carries a tool call but renders as a wake DIVIDER, not a card
    // (see ChatView.agentCompletionCall) — counting it would promise a tool the expansion never shows.
    // It still counts as a step, exactly like the background-shell wake divider beside it.
    const completion = agentCompletionCall(m)
    const tools = completion ? 0 : m.tools.length
    return {
      text: messageHasRenderableText(m),
      tools,
      countable: messageHasRenderableText(m) || tools > 0 || completion !== undefined || m.kind !== undefined,
      // A middle message that survives the collapse keeps its own row (see the render loop) — counting it
      // as a hidden step would promise the expansion a message it already shows.
      survives: survivesQueueCollapse(m, g, supersededAsks),
      opens: opensQueueSegment(m),
      // BOTH spellings of "a child finished": the transcript's own `boundary:"wake"` divider (a background
      // shell, a Monitor) and a sub-agent completion carried as a tool call. They render identically — a
      // wake hairline — so the segment walk treats them as one thing when deciding a run's waker.
      completion: m.boundary === "wake" || completion !== undefined,
    }
  }), [messages, supersededAsks])
  // ONE FOLD PER REST. Every run between the human's ask and the agent's rest, and between each
  // subsequent wake and the rest it produced, is its own segment with its own divider. See
  // lib/queueCollapse for why a rest CUTS, and why cutting on the wake alone was not enough.
  // FIRST RUN, THEN ONE LINE, THEN THE LAST RUN. One fold per rest reads well for two or three rests and
  // is unreadable at thirty: `investigate-nubjs-nub-642` rested 30+ times against a single ask, and since
  // a rested message always survives its own run's fold, the card painted thirty near-identical
  // restatements in full. The middle runs collapse whole — prose, wakes and all — while the first rested
  // message (which is the answer to whatever the human last asked) and the last one stay intact.
  // Computed over ALL runs, not the folding ones, so a middle run with nothing of its own to fold cannot
  // leave a stray restatement inside the span this is hiding.
  const allSegments = useMemo(
    () => queueCollapseSegments(collapseSteps, lastUserIdx + 1),
    [collapseSteps, lastUserIdx],
  )
  const { kept, middle } = useMemo(() => collapseMiddleRuns(allSegments), [allSegments])
  // THE LAST THING THE AGENT SAID, for the same reason the thread view computes it: any ```awaiting fence
  // above it states a wait that has already resolved, and must not keep drawing as a live card.
  const lastAgentIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i
    return -1
  }, [messages])
  const isStaleAwaiting = (idx: number) => lastAgentIdx >= 0 && idx < lastAgentIdx
  const segments = useMemo(() => kept.filter(segmentFolds), [kept])
  // Index → the segment folding it, for the render loop. Only folding segments are indexed: a run with
  // nothing worth hiding renders exactly as it did before.
  const segmentAt = useMemo(() => {
    const at = new Map<number, number>()
    segments.forEach((seg, si) => { for (let i = seg.start; i <= seg.end; i++) at.set(i, si) })
    return at
  }, [segments])
  // Collapse unless the reader has opted into the full log. Gated on there being something ABOVE the
  // first fold to anchor it — a pinned ask, or a rest divider a wake-driven turn opens on.
  const collapseIntermediate =
    !intermediateExpanded && (stickyUserIdx >= 0 || restTurnStart > 0) && segments.length > 0
  // THE HUMAN'S LAST MESSAGE WINS, even when the agent has rested since. It used to be capped at the
  // current turn (`Math.max` with `restTurnStart`) on the reasoning that a closed turn is history the
  // drawer already holds — but with frizz driving threads across many rests, "the current turn" is a
  // stretch the reader never saw the start of, and the card was opening mid-conversation. The COLLAPSE
  // above now reaches back to the same message, so the two agree; anchoring only one of them there is
  // what left seven turns of a Goal-driven thread painted out in full.
  const visibleStart = resolveVisibleStart(messages, visibleStartId, lastUserIdx)
  const visible = useMemo(() => messages.slice(visibleStart), [messages, visibleStart])
  // The SAME presentation-only coalescing the thread view and the sub-agent drawer run (ChatView's
  // coalescedActivityMessages): a provider that chunks one burst into 26 assistant records must not
  // mint 26 `Ran 1 tool call` disclosures, and a quiet event line in the middle of that burst must not
  // split it in two (maintainer 2026-07-31: "I don't think it makes sense for us to interleave tool
  // calls and thinking like this"). Expanding this card's intermediate divider used to be exactly that
  // wall, because the card was the one transcript surface still rendering raw server order.
  // Each entry keeps its ORIGINAL index so every index-addressed prop below — paired answers, the
  // sticky ask, the collapse span — keeps addressing server truth rather than the compacted array.
  //
  // ONE pass, uncut. It used to be cut after the last agent prose, because a fold that stopped at that
  // message left the calls made AFTER it outside the span — absorbing them into a `textOnly` row would
  // have dropped them from the page with nothing standing in for them. A segment now spans its whole run
  // (queueCollapseSegments), so those calls are counted and hidden like every other call in the run, and
  // the cut has nothing left to protect. A wake ends a coalescing run by itself (it is not a pure-tool
  // message), so no run can span a segment boundary either.
  const coalescedVisible = useMemo(
    () => coalesceToolActivityMessages(visible).map((entry) => ({ ...entry, messageIndex: entry.messageIndex + visibleStart })),
    [visible, visibleStart],
  )
  const hasMore = visibleStart > 0 || q.data?.hasEarlier === true

  useLayoutEffect(() => {
    const pending = pendingViewportAnchor.current
    const root = messageListRef.current
    if (!pending || !root) return
    const targetIsRendered = [...root.querySelectorAll<HTMLElement>("[data-transcript-source-id]")]
      .some((node) => node.dataset.transcriptSourceId === pending.targetStartId)
    // React Query's external-store update and this component's visible-start state can commit
    // separately. Wait for the commit that actually renders the requested prefix; consuming the anchor
    // on the cache-only intermediate commit is the exact race that caused the viewport jump.
    if (!targetIsRendered) return
    const correct = () => {
      restoreTranscriptViewportAnchor(root, pending.anchor, (delta) => {
        if (delta !== 0) window.scrollBy({ top: delta, left: 0, behavior: "auto" })
      })
      let remaining = 0
      restoreTranscriptViewportAnchor(root, pending.anchor, (delta) => { remaining = delta })
      return remaining
    }
    const remaining = correct()
    // "reserve" RE-ARMS THIS EFFECT (bottomScrollReserve is a dependency), so the decision is factored
    // out and unit-tested in transcriptPagination.ts — a geometry it can never stop reserving on is an
    // infinite render loop, which is exactly what a scroll-locked document used to produce here.
    const decision = transcriptAnchorCorrection({
      remaining,
      scrollY: window.scrollY,
      maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      alreadyReserved: pending.reserved === true,
    })
    if (decision === "reserve") {
      // A short queue is vertically centered by `my-auto`; once prepended history makes it taller than
      // the viewport those auto margins collapse. At the document's new maximum scroll position there
      // may therefore be no physical space left to keep the old message at its original screen Y. Keep
      // an equivalent external reserve below this card, then the next layout pass can restore exactly.
      pending.reserved = true
      setBottomScrollReserve((current) => current + Math.ceil(remaining))
      return
    }
    if (anchorSettlementScheduled.current) return
    anchorSettlementScheduled.current = true
    // Chrome's native scroll anchoring settles after React's layout effects. It is suspended while the
    // prefix changes, then two pre-paint corrections cover that browser phase plus late font/layout
    // resolution before restoring the document's prior policy.
    requestAnimationFrame(() => {
      correct()
      requestAnimationFrame(() => {
        correct()
        pendingViewportAnchor.current = null
        anchorSettlementScheduled.current = false
        if (anchoringHeld.current) {
          anchoringHeld.current = false
          resumeNativeAnchoring()
        }
      })
    })
  }, [bottomScrollReserve, messages, visibleStartId])

  useEffect(() => {
    const transcriptKey = q.data?.transcriptKey
    if (!transcriptKey) return
    const priorKey = transcriptKeyRef.current
    transcriptKeyRef.current = transcriptKey
    if (!priorKey || priorKey === transcriptKey) return

    // A replacement session deliberately discards the old transcript projection. Discard its local
    // reveal point and any exact-anchor reserve too, so view-only pagination state cannot leak into the
    // new session that now owns this card.
    setVisibleStartId(null)
    setBottomScrollReserve(0)
    // The one-way intermediate expand is view-only too — a new session starts collapsed again.
    setIntermediateExpanded(false)
    pendingViewportAnchor.current = null
    anchorSettlementScheduled.current = false
    if (anchoringHeld.current) {
      anchoringHeld.current = false
      resumeNativeAnchoring()
    }
  }, [q.data?.transcriptKey])

  useEffect(() => () => {
    if (anchoringHeld.current) {
      anchoringHeld.current = false
      resumeNativeAnchoring()
    }
  }, [])

  const armViewportAnchor = (targetStartId: string | undefined) => {
    const anchor = captureTranscriptViewportAnchor(messageListRef.current)
    if (!targetStartId || !anchor) return
    if (!anchoringHeld.current) {
      anchoringHeld.current = true
      suspendNativeAnchoring()
    }
    pendingViewportAnchor.current = { anchor, targetStartId }
  }

  const loadEarlier = async () => {
    if (loadingEarlier || !hasMore) return
    const boundary = previousUserBoundary(messages, visibleStart)
    const localUserBoundary = boundary !== null && messages[boundary]?.role === "user" ? boundary : null
    if (localUserBoundary !== null) {
      const targetStartId = messages[localUserBoundary].sourceId
      armViewportAnchor(targetStartId)
      setVisibleStartId(targetStartId ?? null)
      return
    }

    const cursor = q.data?.beforeCursor
    if (!cursor) {
      if (visibleStart > 0) {
        const targetStartId = messages[0]?.sourceId
        armViewportAnchor(targetStartId)
        setVisibleStartId(targetStartId ?? null)
      }
      return
    }

    const expectedKey = q.data?.transcriptKey
    if (!expectedKey) return
    setLoadingEarlier(true)
    try {
      const earlier = await rpc.threadTranscriptEarlier({ slug: thread.id, cursor })
      const current = queryClient.getQueryData<TranscriptData>(["transcript", thread.id])
      if (!current?.transcriptKey || current.transcriptKey !== expectedKey || earlier.transcriptKey !== expectedKey) {
        await q.refetch()
        setVisibleStartId(null)
        showToast("Transcript changed while loading history; refreshed the current session")
        return
      }
      const targetStartId = earlier.messages[0]?.sourceId ?? messages[0]?.sourceId
      armViewportAnchor(targetStartId)
      const next = prependEarlierPage(current as Parameters<typeof prependEarlierPage>[0], earlier)
      queryClient.setQueryData(["transcript", thread.id], next)
      setVisibleStartId(targetStartId ?? null)
    } catch (error) {
      await q.refetch()
      setVisibleStartId(null)
      showToast(error instanceof Error ? error.message : "Could not load earlier transcript history")
    } finally {
      setLoadingEarlier(false)
    }
  }

  const markComplete = useMutation({ mutationFn: () => rpc.markComplete({ slug: thread.id }) })

  // (A doc-body-in-card + adopt-from-card composite was built here and REMOVED the same day: the
  // maintainer ruled session-less threads NEVER card — needsAction gates on runtime !== "none" — so
  // a card can always render its transcript. The composite lives on the SIDEBAR click-through
  // surface, ThreadDrawer. This also mooted a review finding about the adopt path clearing the
  // typed message on failure.)

  // The SHARED answering controller — the SAME scope as the thread view, so every question the card
  // renders is answerable in place, not just the one still standing at the tail (maintainer 2026-08-03).
  // `answerable` is now only the chrome signal ("the agent is waiting on you right now"), which is why
  // the Send button below also shows on `anyAnswered`: staging an answer on an older question must have
  // something to click. Queue sends deliberately suppress the generic chat bottom-pin: it fights card
  // exit/reorder. Both keyboard and button submits run this same onSent, which dissolves the card in
  // place — TodosView's unmount effect then auto-scrolls the next card to the viewport top (like every
  // user-initiated dismissal).
  const { answeringForMessage, answerable, anyAnswered, sendAnswers, sendMessage } = useLiveAnswering(thread.id, messages, () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    onResolve(thread.id)
  }, { scrollToBottom: false })
  // The card-level "Send answers" action shows for the standing ask (the common case) OR the moment the
  // human touches an OLDER question's chips — an answer you can stage but not send would be a dead end.
  const showSendAnswers = answerable || anyAnswered

  // Dismiss THIS card through the same user-initiated auto-scroll exit the footer/header/answer paths
  // use, exposed to the in-transcript fence buttons (done Mark-as-done, awaiting park) via context so
  // EVERY card-dismissing control lands the next card at the viewport top — not just the ones that can
  // reach onResolve directly. `cancel` reinstates it when an optimistic Mark-as-done is declined by the
  // server. Stable identity (onResolve/onUnresolve are []-useCallbacks, thread.id is fixed per card) so
  // the memoized value below never churns and context consumers don't re-render each frame.
  const dismissThisCard = useCallback(() => onResolve(thread.id), [onResolve, thread.id])
  const cancelThisCard = useCallback(() => onUnresolve(thread.id), [onUnresolve, thread.id])
  const queueDismiss = useMemo(() => ({ dismiss: dismissThisCard, cancel: cancelThisCard }), [dismissThisCard, cancelThisCard])

  return (
    // Provide the thread slug so this card's transcript matches the thread view: sub-agent blocks go
    // live (spinner + drill-in) and a done/awaiting fence card resolves its thread to show the confirm button.
    <ThreadSlugContext.Provider value={thread.id}>
    <QueueDismissContext.Provider value={queueDismiss}>
    {/* NO overflow-hidden: it would clip the sticky header out of stickiness. The header carries
        rounded-t so the card's top corners still look clipped; the root's BLOCK_RADIUS handles the bottom. */}
    <div
      data-queue-card-root={thread.id}
      data-queue-leaving={leaving}
      style={bottomScrollReserve ? { marginBottom: bottomScrollReserve } : undefined}
      className={`flex flex-col min-w-0 max-w-full ${BLOCK_RADIUS} border border-border-strong bg-panel shadow-lg shadow-black/25 transition-opacity ${resolving ? "opacity-40" : ""}`}
    >
      {/* Sticky-header CONTAINING BLOCK, deliberately EXCLUDING the footer: position:sticky is clamped
          to its containing block, so wrapping only the header + body here stops the header at the
          footer's top edge as the card scrolls off. Without it the header rides all the way to the
          card-root bottom, where its square bottom corners jut past the root's rounded border — the
          sticky header "breaking out" of the card border during the scroll-off unstick. The footer sits
          BELOW this wrapper, so the root's rounded bottom corners are always the footer's, never the
          square-cornered header's. (No overflow here — that would neuter the header's stickiness.) */}
      <div className="flex flex-col min-w-0">
      {/* STICKY header: title + backing-doc filename + status_text on the left, whole-item icon actions
          on the right. Pins to the scroll container's top (opaque bg + bottom rule) as the body scrolls
          under it, so the actions stay reachable through a long card. Rounding is STATE-DEPENDENT:
          collapsed with no footer (a foreign/archived card) the header IS the whole card and takes the full
          block radius; otherwise it is rounded-top-only + a border-b, the root's radius carrying the
          bottom corners (a rounded-top + border-b would read as squared/doubled edges inside the shell). */}
      <div ref={headerRef} className={`sticky top-0 z-10 flex items-center gap-2 bg-panel px-5 py-3.5 max-[800px]:top-10 ${collapsed ? BLOCK_RADIUS : `${BLOCK_RADIUS_TOP} border-b border-border/60`}`}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 flex-1 truncate font-semibold text-[15px] leading-snug" title={displayTitle(thread)}>
              {displayTitle(thread)}
            </div>
          </div>
          <LastActive at={lastActiveLabelAt(thread)} fallbackAt={thread.spawnedAt} className="mt-0.5 block truncate text-[11px] leading-tight text-muted/75" />
          {/* status_text is worker-authored frontmatter prose — only decision-relevant when the
              thread is actually waiting on the human, so it renders ONLY for needs-human threads (the
              declared awaiting-you state; blocked is now a pure machine-wait and never cards). */}
          {thread.statusText && thread.status === "needs-human" && (
            <div className="text-[11px] text-muted/80 mt-0.5 truncate" title={thread.statusText}>
              {thread.statusText}
            </div>
          )}
        </div>
        {/* SHARED navigation actions: collapse and open-in-new-tab, plus Retry — which HeaderActions
            itself now gates on `offersRetry` (stalled OR usage-limit-held; groups.ts). Queue cards only
            ever exist for needsYou threads, and a usage-limit park is NOT needsYou, so the only
            offersRetry case that cards here is a STALL — its sidebar row wears the yellow [!]. Sharing
            that ONE predicate across every surface is load-bearing: each time a surface kept its own
            gate, a thread ended up carrying a Retry button while reading as calm at-rest elsewhere
            (maintainer 2026-07-23, twice). A card that stalled out is the one queue state with an obvious
            recovery verb, so it surfaces here rather than forcing you to open the thread; other lifecycle actions
            (Mark as done / Snooze) stay in the footer. (Rename lives by the title in the thread drawer,
            not here — the queue is a triage surface.) The open arrow is a LINK to the
            standalone thread page and opens it in a NEW TAB (maintainer 2026-08-03) — it used to slide
            the side drawer over the card, re-painting the panel you were already reading. Either way
            the queue's own scroll position is untouched. */}
        {/* Every Frizz-owned card carries the copy-resume-command affordance: queue cards are at rest
            by default, so opening the same session in your own terminal is entirely safe (and both CLIs
            allow it live too). Foreign/legacy rows have no Frizz-owned provider session to resume. */}
        {thread.kind === "session" && thread.foreign !== true && <CopyTerminalCommandButton slug={thread.id} />}
        <HeaderActions
          thread={thread}
          collapsed={collapsed}
          onCollapse={() => setCollapsed((c) => !c)}
          openHref={standaloneThreadHref(thread.id)}
          onDone={() =>
            markComplete.mutate(undefined, {
              onSuccess: () => onResolve(thread.id),
              onError: () => setResolving(false),
            })
          }
          doneBusy={markComplete.isPending}
          onStatusMutate={() => setResolving(true)}
          onStatusApplied={() => onResolve(thread.id)}
          onStatusFailed={() => setResolving(false)}
        />
      </div>

      {collapsed ? null : (
      <>
      {/* Message body — the same chat renderer ChatView uses, tail-first with "Load earlier messages"
          above. The card grows to its content; the PAGE is what scrolls.
          The bottom pad TIGHTENS while an ask is open: the "Send answers" action below belongs to the
          question stack it answers, so it has to hang CLOSE off the last question block and leave the
          bigger gap for the prompt box under it. At the standard pb-5 the button floated midway and read
          as an appendage of the prompt box instead. */}
      <div className={`px-5 pt-5 ${showSendAnswers ? "pb-2" : "pb-5"}`}>
        <InteractionStack
          thread={thread}
          className="mb-4"
        />
        {/* A frozen native AskUserQuestion (safety net) renders the REAL question read-only so the human
            knows exactly what's asked without opening anything; it takes precedence over the generic
            perm banner. Otherwise a permission-blocked agent has NO message to show (turn parked
            mid-tool_use) — say so explicitly. Both route the answer to the terminal tab. */}
        {/* Stands down when frizz OWNS the question: a broker-path AskUserQuestion is journaled as an
            answerable interaction and already rendered by InteractionStack above, so pointing the
            operator at a terminal here would duplicate it with worse advice. */}
        {(thread.pendingInteraction ? undefined : thread.pendingAsk) ? (
          <div className="mb-4">
            <PendingAskCard ask={thread.pendingAsk!} onTerminal={copyTerminalCommand} />
          </div>
        ) : thread.nativeInputRequired ? (
          <div className="mb-4">
            <NativeInputRequiredCard input={thread.nativeInputRequired} onTerminal={copyTerminalCommand} />
          </div>
        ) : thread.runtime === "perm-prompt" ? (
          <div className="mb-4">
            <PermPromptBanner onTerminal={copyTerminalCommand} />
          </div>
        ) : null}
        {/* What frizz's permission policy REFUSED on the worker's behalf. Sits BELOW the gates above:
            those are things waiting on the human, this is something already handled for them. */}
        {thread.permPolicy ? (
          <div className="mb-4">
            <PermPolicyDenialCard policy={thread.permPolicy} denies={thread.permDenies} />
          </div>
        ) : null}
        {messages.length === 0 ? (
          <p className="text-[13px] text-muted">{q.isLoading ? "Loading…" : thread.statusText || "No message yet."}</p>
        ) : (
          // Adjacency-based message spacing IDENTICAL to the thread drawer (messageTailIsMeta/HeadIsMeta
          // → 6px when a CARD abuts a meta row, else STEP — see messageGap) —
          // so a batched vs split tool run reads the same here as in the drawer. No flex gap; explicit
          // spacers between rendered messages.
          <div ref={messageListRef} className="flex flex-col">
            {hasMore && (
              <button
                className="mb-3.5 self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-fg hover:bg-panel-2 outline-none"
                onClick={() => void loadEarlier()}
                onMouseDown={(e) => e.preventDefault()}
                disabled={loadingEarlier}
              >
                {loadingEarlier
                  ? "Loading earlier messages…"
                  : q.data?.reachedTurnBoundary === false
                    ? "Continue loading this turn"
                    : "Load earlier messages"}
              </button>
            )}
            {(() => {
              const base = visibleStart
              const out: ReactNode[] = []
              let prevTailIsMeta: boolean | null = null
              // Higher-level turn collapse, ONE FOLD PER RUN. Each segment is [what re-invoked the agent
              // → the prose it rested on]: its opening and closing prose render TEXT ONLY, and everything
              // else in the run — the fully-hidden middle messages, the tool bands batched into those two,
              // and any calls made after the closing prose — is replaced by that segment's own summary
              // divider. The wake hairlines sit BETWEEN the segments, where the reader can read each one
              // against the work it caused. The pinned ask and loaded-earlier history render in full.
              const barEmitted = new Set<number>()
              coalescedVisible.forEach(({ message: m, messageIndex: globalIdx }, i) => {
                if (m.queued) return
                if (messageRendersNothing(m)) return
                // "Agent rested" is the queue card's own PREMISE, not news: every card here is a rested
                // thread, the row states how long ago it rested, and the window is already cut at the
                // previous rest — so the rule can only ever restate the frame around it (maintainer
                // 2026-08-11). The thread drawer keeps the ONE position where it still says something
                // the reader cannot already see — above the human's own next message, where it tells a
                // reply to a finished agent apart from a steer typed mid-turn (lib/restDividers.ts).
                // Everywhere else the drawer now drops it for the same reason this card drops all of it.
                if (m.boundary === "rest") return
                // THE GOAL'S BUMP, HOWEVER, NOW DRAWS ITS HAIRLINE — it used to be dropped here beside the
                // rest divider as "machinery", and that was a mistake this card could not survive: the
                // Goal is how most frizz-driven threads are resumed, so suppressing it left the card
                // showing work resuming for no stated reason at all. The maintainer read his own thread's
                // three Goal wakes as a PR watcher firing and asked why nothing marked them (2026-08-16:
                // "there's not a hairline notification rendered for that, which is also weird to me").
                // It renders through the ordinary path below as the transcript's own RecurringPromptLine
                // ("Goal · at rest"), one rule under the message the agent rested on — the position the
                // 2026-08-12 call was really objecting to it NOT being in.
                // THE MIDDLE ROUNDS, swallowed whole. This runs BEFORE every other branch — including the
                // lifted-wake and waker paths — because those are exactly what it is hiding: the
                // maintainer asked for "all of the awakenings that happened in the middle" to go with the
                // work, leaving the first rested message and the last one facing each other across one
                // line. Emitted once, at the span's first index.
                if (collapseIntermediate && middle && globalIdx >= middle.start && globalIdx <= middle.end) {
                  if (globalIdx === middle.start) {
                    if (prevTailIsMeta !== null) out.push(<VSpace key="middle-runs-space" h={STEP} />)
                    out.push(
                      <MiddleRunsSummary
                        key="middle-runs-summary"
                        runs={middle.runs}
                        toolCount={middle.tools}
                        onExpand={() => setIntermediateExpanded(true)}
                      />,
                    )
                    prevTailIsMeta = false
                  }
                  return
                }
                const segIdx = collapseIntermediate ? segmentAt.get(globalIdx) : undefined
                const seg = segIdx === undefined ? undefined : segments[segIdx]
                const inSpan = seg !== undefined
                const isFirst = seg !== undefined && globalIdx === seg.open
                const isLast = seg !== undefined && globalIdx === seg.close
                // A lifted-out WAKE takes the ORDINARY path at the foot of this loop instead of the
                // collapse branch's textOnly render. Its content IS a card or a rule — a FrizzWake
                // built from `wakeSteer`, a sub-agent or background-shell completion divider — and
                // messageHasRenderableText reports all of those as no prose at all, so the textOnly path
                // would drop it on the floor rather than show it.
                const liftedWake = inSpan && !isFirst && !isLast && !hasQuestionBlock(m.text) && survivesQueueCollapse(m, globalIdx, supersededAsks)
                // THIS RUN'S WAKER — the background task or sub-agent whose completion re-invoked the
                // agent while it was at rest. It takes the ordinary path too, and it must be handled
                // BEFORE the summary bar below: the bar is emitted at the first row after the opening
                // prose, and a waker that fell through to it would print the fold ABOVE the narration it
                // summarizes — the same inversion the `isLast` anchor once produced.
                if (seg !== undefined && globalIdx === seg.waker) {
                  // The SAME pitch the ordinary path charges, spelled the same way: a waker is a wake
                  // hairline like any other, and a second spelling here is how the rhythm drifts.
                  if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsMeta && messageHeadIsMeta(m) ? 6 : STEP} />)
                  const wakerKey = m.sourceId ?? `legacy-${globalIdx}`
                  out.push(
                    <div key={wakerKey} data-transcript-source-id={wakerKey} className="flex flex-col">
                      <Message m={m} dense />
                    </div>,
                  )
                  prevTailIsMeta = messageTailIsMeta(m)
                  return
                }
                if (inSpan && !liftedWake) {
                  // Fully-hidden middle message — UNLESS survivesQueueCollapse lifts it out. Same rule as
                  // the background tasks and sub-agent dispatches below: lifecycle content (an open ask,
                  // and the wake that says what re-invoked the agent) is lifted OUT of the collapsed span,
                  // chatter is not. It renders textOnly like the first/last anchors, so its batched tool
                  // calls stay counted in the summary rather than doubling up as a visible band.
                  if (!isFirst && !isLast && !survivesQueueCollapse(m, globalIdx, supersededAsks)) return
                  // This RUN's divider, emitted once, before the FIRST thing in the run that renders after
                  // the opening prose — not at the closing prose.
                  //
                  // `isLast` was wrong and it showed. Anything lifted OUT of the collapse — an open ask, or
                  // the wake hairline that says what re-invoked the agent — renders at its own position,
                  // which is BEFORE the closing prose. Deferring the divider to `isLast` therefore printed
                  // the work AFTER the thing that came after it: a card read "…let me set that up" → "Frizz
                  // asked for a sign-off" → "18 tool calls" → the done card, when the eighteen calls had of
                  // course all happened before the sign-off (maintainer 2026-08-13, with a screenshot: "the
                  // opposite of what actually happened").
                  //
                  // Anchoring on `!isFirst` puts it against the hidden span's END instead, which is what it
                  // is a summary OF. With no lifted message in between, the first non-opening row IS the
                  // closing prose and the divider lands exactly where it used to.
                  if (!isFirst && segIdx !== undefined && !barEmitted.has(segIdx)) {
                    if (prevTailIsMeta !== null) out.push(<VSpace key={`im-space-${segIdx}`} h={STEP} />)
                    out.push(
                      <IntermediateSummary
                        key={`intermediate-summary-${segIdx}`}
                        toolCount={seg.tools}
                        onExpand={() => setIntermediateExpanded(true)}
                      />,
                    )
                    prevTailIsMeta = false
                    barEmitted.add(segIdx)
                  }
                  // A first/last message that is pure batched tool calls (no prose) contributes no row —
                  // its calls are already folded into the divider — so skip it and leave no dangling spacer.
                  if (!messageHasRenderableText(m)) return
                  if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={STEP} />)
                  const textKey = m.sourceId ?? `legacy-${globalIdx}`
                  out.push(
                    <div key={textKey} data-transcript-source-id={textKey} className="flex flex-col">
                      <Message m={m} dense textOnly answering={answeringForMessage(m)} paired={paired[globalIdx]} staleAwaiting={isStaleAwaiting(globalIdx)} />
                    </div>,
                  )
                  // Text-only → the row ends in prose (tool band dropped), so the next gap is a full STEP.
                  prevTailIsMeta = false
                  return
                }
                if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsMeta && messageHeadIsMeta(m) ? 6 : STEP} />)
                const sourceKey = m.sourceId ?? `legacy-${globalIdx}`
                // The most recent user message sticks just below the header (StickyUserBand carries the
                // source-id + sticky marker itself) unless the pref is off, and collapses as a hover-to-
                // expand bubble; everything else — and the ask when sticky is off — flows in a plain wrapper.
                const isSticky = globalIdx === stickyUserIdx && stickyUserMessage
                const msg = (
                  <Message
                    m={m}
                    dense
                    staleAwaiting={isStaleAwaiting(globalIdx)}
                    answering={answeringForMessage(m)}
                    paired={paired[globalIdx]}
                    sticky={isSticky}
                  />
                )
                out.push(
                  isSticky ? (
                    <StickyUserBand key={sourceKey} sourceId={sourceKey} stickyTopPx={headerH}>
                      {msg}
                    </StickyUserBand>
                  ) : (
                    <div key={sourceKey} data-transcript-source-id={sourceKey} className="flex flex-col">
                      {msg}
                    </div>
                  ),
                )
                prevTailIsMeta = messageTailIsMeta(m)
              })
              // Queued (optimistic) messages pinned to the bottom, same as the drawer.
              visible.forEach((m, i) => {
                if (!m.queued) return
                out.push(<VSpace key={`qs${i}`} />)
                out.push(<Message key={`q${base + i}`} m={m} dense paired={paired[base + i]} />)
              })
              return out
            })()}
          </div>
        )}
        {/* AFTER the transcript, not before it (maintainer 2026-07-24). This banner describes the state
            the thread reached by resting at the END of that transcript — it is the newest thing on the
            card, so it belongs at the bottom, adjacent to the composer, where every other trailing
            control lives. Above the messages it read as a header for a turn that hadn't happened yet.
            The gates above (pendingAsk / nativeInputRequired / perm-prompt) stay pinned at the top: they
            exist precisely because the turn parked mid-tool_use and there IS no message to sit under.
            No priority guard needed here — deriveAwaitingBackground already returns false for every one
            of those states (board.ts). */}
        {thread.awaitingBackground && (
          <div className="mt-4">
            <AwaitingBackgroundBanner thread={thread} onSnooze={dismissThisCard} onSnoozeFailed={cancelThisCard} />
          </div>
        )}
      </div>

      {/* Bottom of the card. Answerable question blocks add a "Send answers" action that composes the
          per-block answers into one reply — but the free-form composer stays PRESENT underneath it
          (maintainer 2026-07-22): answering the question is the primary path, not the only one, and
          ignoring the options to steer with a plain prompt has to stay one keystroke away. The button
          sits above the box so it stays adjacent to the question it answers, and the card's bottom edge
          is the same prompt box in every state. Its spacing is deliberately ASYMMETRIC — 8px up to the
          last question block, 16px down to the prompt box — so it reads as hanging off the questions
          rather than hovering over the box. */}
      {showSendAnswers && (
        <div className="shrink-0 px-5 pt-0">
          <div className="mb-4 flex items-center justify-start gap-2">
            <button
              disabled={!anyAnswered}
              onClick={() => sendAnswers()}
              onMouseDown={(e) => e.preventDefault()}
              className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
            >
              Send answers
            </button>
          </div>
        </div>
      )}
      {/* THE standard prompt box — the exact block the drawer renders (ThreadActionBar), differing only
          in its padding wrapper, the ops rows beneath it, and the send. `submitOverride` routes this
          box through the card's own answering controller so a free-form reply and a "Send answers"
          reply are one send: same optimistic dissolve, same suppressed bottom-pin. */}
      <ThreadComposerBox
        slug={thread.id}
        surface="queueComposer"
        className="shrink-0 px-5 pb-3 pt-0"
        // With an open ask the box is the deliberate escape hatch, so say so — otherwise "Reply to the
        // agent…" reads as a second way to answer the question rather than a way around it.
        placeholder={answerable ? "Or skip the questions and reply…" : "Reply to the agent…"}
        submitOverride={sendMessage}
        ops={
          <>
            {/* ONE column, two positional paddings, whichever of the two lists happen to be present:
                6px hanging off the prompt box, 2px between rows. NEITHER list carries a bottom pad —
                the gap to the lifecycle footer is the composer box's own `pb-3` and nothing else
                (maintainer 2026-08-01: the space under the last row read as too much). It used to be
                that pb-3 PLUS an 8px `pb-2` on whichever list came last, which put 20px under a
                column that hangs off the prompt at 6px. With the extra pad gone the bottom inset is
                12px — exactly the drawer footer's inset above and beside its composer — and the
                "which list is last" conditional this className used to carry goes with it. */}
            <QueueSubAgentLines slug={thread.id} subAgents={thread.subAgents ?? []} className="px-1 pt-1.5" />
            {/* Background shells / Monitors remain a runtime strip below the reply area. Live sub-agents are
                intentionally excluded here because their compact ⤷ child lines sit directly above it.
                It HANGS off the composer at the same pt-1.5 as those child lines — the prompt box's own
                bottom padding already supplies the optical air, so a larger gap here reads as a break —
                and carries NO pb of its own: the box's pb-3 is the whole gap to the lifecycle footer.

                UNLESS the sub-agent lines are already there. Then this strip is not hanging off the
                composer at all, it is CONTINUING the column those lines opened, so it takes the rows'
                own 2px pitch instead of the 6px hang. With pt-1.5 in that case the ⤷ agent row sat 6px
                off the ⤷ shell row beneath it while the shell rows sat 2px apart from each other —
                three times the pitch, inside one column of identical rows, which read as a group break
                that means nothing (maintainer 2026-07-30). MEASURED in queue-ops-spacing-fixture:
                6/2/2 before, 2/2/2 after. The drawer never had the split — it renders agents and
                shells inside ONE BackgroundOpsStrip, so its column has always been a flat 2px. */}
            <BackgroundOpsStrip
              slug={thread.id}
              includeAgents={false}
              className={`px-1 ${hasQueueSubAgentLines(thread.subAgents ?? []) ? "pt-0.5" : "pt-1.5"}`}
            />
          </>
        }
      />
      </>
      )}
      </div>
      <ThreadLifecycleFooter
        thread={thread}
        onArchived={() => onResolve(thread.id)}
        onDismissCancel={() => onUnresolve(thread.id)}
        onSnoozed={() => onResolve(thread.id)}
      />
    </div>
    </QueueDismissContext.Provider>
    </ThreadSlugContext.Provider>
  )
}, queueCardPropsEqual)

// Board keyframes can replace every ThreadView object even when a card did not change. Keep that card
// mounted (and its draft/collapse/transcript state intact) unless its actual server payload changed.
// Deltas retain identity for untouched rows, so the JSON path is only the reconnect/keyframe fallback.
function queueCardPropsEqual(
  previous: Readonly<{ thread: ThreadView; leaving: boolean; onResolve: (slug: string) => void; onUnresolve: (slug: string) => void }>,
  next: Readonly<{ thread: ThreadView; leaving: boolean; onResolve: (slug: string) => void; onUnresolve: (slug: string) => void }>,
): boolean {
  return previous.leaving === next.leaving && previous.onResolve === next.onResolve && previous.onUnresolve === next.onUnresolve && (previous.thread === next.thread || JSON.stringify(previous.thread) === JSON.stringify(next.thread))
}
