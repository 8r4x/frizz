import { createContext, Fragment, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useSnapshot } from "valtio"
import * as RadixTabs from "@radix-ui/react-tabs"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUpRight, Check, ChevronRight, FileText, Hash, HelpCircle, Hourglass, KeyRound, ListChecks, Loader2, ShieldCheck, Sparkles, X, type LucideIcon } from "lucide-react"
import type { AwaitingHint, NativeInputRequired as NativeInputRequiredData, PendingAsk, ThreadView as ThreadViewData, TranscriptEdit, TranscriptMessage, TranscriptToolCall } from "@fray-ui/shared"
import { store, threadBySlug, pushDrawer, pushSubAgentDrawer, pushBackgroundShellDrawer, showToast } from "../store.ts"
import { useBoard, useTranscript, type ChatMessage, type TranscriptData } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle, lastActiveLabelAt } from "../groups.ts"
import { mdToHtml, mdInlineToHtml, stripFrontmatter } from "../lib/markdown.ts"
import { splitProseAttachments } from "../lib/imagePaths.ts"
import { DiffBlock, PathLink } from "./DiffBlock.tsx"
import { splitQuestionBlocks, parseQuestionBlock, type QuestionKind, type BlockAnswer, type MessageAnswering } from "../lib/questionBlocks.ts"
import { splitFenceBlocks, type FenceKind } from "../lib/fenceBlocks.ts"
import { parseAnswersCard, pairAllAnswers, type PairedAnswer } from "../lib/answersMessage.ts"
import { useLiveAnswering, type LiveAnswering } from "../lib/answering.ts"
import { sendEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { messagePresentationText } from "../lib/messagePresentation.ts"
import { snoozePresetInstant, formatSnoozeWake } from "../lib/snooze.ts"
import { AWAITING_FALLBACK_TITLE, AWAITING_PARK_BUTTON, awaitingHintSentence, awaitingParkAction, awaitingPresentationLine } from "../lib/awaitingPresentation.ts"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { prefs } from "../lib/prefs.ts"
import { canAdoptThread } from "../lib/adoption.ts"
import { THREAD_TITLE_MAX_LENGTH, aiRenameAvailability, manualThreadTitleSeed, threadTitleToCommit } from "../lib/threadTitle.ts"
import { THREAD_HEADER_CLASS, THREAD_HEADER_CONTROLS_CLASS, THREAD_HEADER_TITLE_CLASS } from "../lib/threadHeaderLayout.ts"
import { ThreadActionBar } from "./ThreadActionBar.tsx"
import { HeaderActions } from "./HeaderActions.tsx"
import { ThreadLifecycleFooter, StateButton } from "./ThreadLifecycleFooter.tsx"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { Tooltip } from "./Tooltip.tsx"
import { ToolDisclosureHeader } from "./ToolDisclosureHeader.ts"
import { hasRunningToolIndicator, liveBackgroundOperationState } from "../lib/operationIndicators.ts"
import { elapsedSince, formatFixedDuration, formatToolDuration } from "../lib/durationLabels.ts"
import { CHILD_OPEN_TITLE, visibleChildOps } from "../lib/childOps.ts"
import { agentCompletionCall, subAgentCompletionOutcome } from "../lib/subAgentCompletion.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { TRANSCRIPT_META_LABEL_CLASS } from "../lib/transcriptMetaLabels.ts"
import { InteractionStack } from "./InteractionCards.tsx"
import { LastActive } from "./LastActive.tsx"
import { CopyTerminalCommandButton, useCopyTerminalCommand } from "./ExternalTerminalCommand.tsx"
import { MessageDebugId } from "./MessageDebugId.tsx"
import { SignInModal } from "./SignInModal.tsx"
import { PROVIDER_LABEL } from "../lib/signIn.ts"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { prependEarlierPage } from "../lib/transcriptPagination.ts"
import { buildVirtualTranscriptMessageRows, earlierLoadGate, nextTailFollow, TAIL_FOLLOW_PX, type VirtualTranscriptMessageRow } from "../lib/virtualTranscript.ts"
import { CodexDirectiveCard, MermaidDiagram } from "./CodexRichOutput.tsx"

// Answer types moved to lib/questionBlocks.ts (shared by the queue card, the thread view, and the
// answering controller). Re-exported here so existing importers keep working.
export type { BlockAnswer, MessageAnswering }

// The thread slug the current message tree belongs to — set by ChatView so a nested AgentBlock can
// resolve its live tracked sub-agent (for the "running Nm" header + drill-in drawer) without threading
// the slug through every intermediate. Null in surfaces that don't provide it (the queue card, a
// sub-agent's own transcript) → AgentBlocks there render as plain (non-live) prompt cards. The QUEUE
// card also provides this now (maintainer 2026-07-15): its sub-agent blocks go live (spinner +
// drill-in) AND its done/awaiting fence cards resolve their thread to show the confirm button.
export const ThreadSlugContext = createContext<string | null>(null)

// The slug a rendered SUB-AGENT REFERENCE resolves its drill-in against, for message trees that are
// NOT the thread's own transcript. Only the sub-agent drawer sets it (with the PARENT thread's slug),
// so an Agent card or completion divider nested inside a child's transcript is still a live link
// instead of dead text — the maintainer's "some scenarios where that's not the case".
//
// Deliberately SEPARATE from ThreadSlugContext rather than reusing it: that context also authorizes
// whole-thread lifecycle actions (FenceCard's Mark-as-done / park buttons resolve their thread from
// it). Handing the sub-agent drawer the parent's ThreadSlugContext would have put a button on a
// ```done fence inside a CHILD's transcript that archives the PARENT thread. Drill-in is a read; the
// fence buttons are writes, and only the thread's own surfaces may offer them.
export const ChildDrillSlugContext = createContext<string | null>(null)

// The slug to resolve a sub-agent id against, from either surface. ThreadSlugContext wins: on a thread
// or queue surface it is both the drill root and the live-lookup root.
function useChildDrillSlug(): string | null {
  const threadSlug = useContext(ThreadSlugContext)
  const drillSlug = useContext(ChildDrillSlugContext)
  return threadSlug ?? drillSlug
}

// A QUEUE card provides this so any in-transcript dismissal control — the ```done fence's Mark-as-done
// button, the ```awaiting fence's park button — routes its OWN card through the queue's user-initiated
// exit (fade → auto-scroll the next card to the viewport top) instead of the passive board-departure
// "hold a neighbour in place" path. `dismiss` is exactly the card's `onResolve(slug)`; `cancel` reinstates
// an OPTIMISTICALLY dismissed card (its `onUnresolve(slug)`) when the completion RPC declines — reached
// without threading either through the fence renderer. Null off the queue (the thread drawer), where there
// is no queue to scroll — there the fence buttons behave as before (archive/snooze, no scroll).
export const QueueDismissContext = createContext<{ dismiss: () => void; cancel: () => void } | null>(null)

// The default thread surface: the session transcript (parsed server-side from the JSONL) rendered
// as a conversation — assistant prose as markdown, tool calls as compact one-liners, a spinner
// while the turn is in flight. The raw terminal is the ⌘T power-user toggle.
//
// LAYOUT: the whole thing is ONE scroll container (the work column itself scrolls) — the chat has NO
// inner overflow region. Content flows at its natural height; the header STICKS to the top and the
// composer STICKS to the bottom (both opaque, so content scrolls cleanly under/over them and replying
// never means scrolling to the end). The scrollbar is hidden. Auto-scroll drives THIS container.
// A thread's full view — the shared composition used BOTH by the main workpane (App, terminal driven by
// the focus machine) and the Open-thread side drawer (ThreadSheet, terminal driven by its own local
// state). Chat is a single scroll column (sticky header + composer); terminal is a fixed-box pane.
// The thread's active surface tab: the conversation, the raw terminal (⌘T power-user), or the
// scratchpad doc (a session thread's compaction-proof working memory — read-only).
export type ThreadTab = "chat" | "scratch"

export function ThreadView({ slug, tab, onTab, onStatusApplied, onClose, virtualized = false, showReturnToQueue = false }: { slug: string; tab: ThreadTab; onTab: (t: ThreadTab) => void; onStatusApplied?: () => void; onClose?: () => void; virtualized?: boolean; showReturnToQueue?: boolean }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  return (
    <RadixTabs.Root
      value={tab}
      onValueChange={(value) => onTab(value as ThreadTab)}
      activationMode="automatic"
      className="flex-1 min-h-0 flex flex-col"
    >
      <ThreadHeader slug={slug} tab={tab} onStatusApplied={onStatusApplied} onClose={onClose} showReturnToQueue={showReturnToQueue} />
      {tab === "scratch" ? (
        <RadixTabs.Content value="scratch" className="flex-1 min-h-0 flex flex-col outline-none">
        <InteractionStack
          thread={thread}
          className="mx-4 mt-3 max-h-[45vh] shrink-0 overflow-y-auto"
        />
        <ScratchpadPane slug={slug} />
        </RadixTabs.Content>
      ) : (
        <ChatView slug={slug} onTab={onTab} virtualized={virtualized} />
      )}
      {thread && <ThreadLifecycleFooter thread={thread} sticky safeArea onArchived={onStatusApplied} />}
    </RadixTabs.Root>
  )
}

function ChatView({ slug, onTab, virtualized }: { slug: string; onTab: (t: ThreadTab) => void; virtualized: boolean }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const running = thread?.runtime === "running" || thread?.runtime === "spawning"
  // Foreign terminals are transcript-only: even if a stale/malformed snapshot happened to carry a
  // native modal field, never offer a terminal control Fray does not own.
  const nativeInputRequired = thread?.foreign ? undefined : thread?.nativeInputRequired
  const copyTerminalCommand = useCopyTerminalCommand(slug)

  // Freshness is centrally managed (transcript-live.ts keeps every observed transcript live); `poll`
  // only gates the SSE-fallback interval for a running thread.
  const q = useTranscript(slug, { poll: running })
  const queryClient = useQueryClient()
  const loadingEarlierRef = useRef(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState<string | null>(null)
  // Raw server order — each message renders its `parts` in block order (fidelity). Memoized so
  // useLiveAnswering's `liveMsg` identity check compares objects from THIS same list.
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  // Question↔answer pairing for "Answers:" user messages, precomputed at the LIST level (the lookback
  // needs the whole list; Message renders per-message). null — a stable primitive — at every ordinary
  // index, so the memoized Message only sees a `paired` prop change on actual answers-messages.
  const paired = useMemo(() => pairAllAnswers(messages), [messages])
  // The most recent LANDED user message (queued/optimistic follow-ups pin to the bottom and aren't the
  // "current ask") — pinned to the top of the pane via StickyUserBand so it stays visible while the
  // agent's reply scrolls under it. -1 when the transcript has no user message yet.
  const lastUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && !messages[i].queued) return i
    return -1
  }, [messages])
  // Client view pref: how (or whether) to pin the current ask to the pane top. `off` → no pin.
  const { stickyUserMessage } = useSnapshot(prefs)
  // Question-block interactivity in the thread view. `multiMessage`: unlike the queue card (live ask
  // only), the drawer keeps EVERY still-open ask answerable — scroll back to a question a sub-agent
  // return / the agent's own continuation buried and answer it in place. answeringForMessage wires each
  // open message's chips AND its own bottom Send button (scoped to just that message's blocks).
  const { answeringForMessage } = useLiveAnswering(slug, messages, undefined, { multiMessage: true })

  // (The SSE-mode lastActivityAt refetch effect that lived here moved into transcript-live.ts: the
  // manager applies the same activity-edge pull to EVERY observed transcript that the push channel
  // doesn't cover, so no surface has to wire its own.)

  // The drawer transcript is the only scrolling region. The composer, selectors, and running
  // operation rows are siblings, so a long draft cannot push any footer control under a boundary.
  const transcriptRef = useRef<HTMLDivElement>(null)
  // The "Jump to latest" affordance floats in the OUTER frame — a sibling of the scroller, not a
  // child of it — so it is genuinely stationary while the transcript scrolls underneath. Held as
  // state (not a ref) so the portal renders as soon as the node mounts.
  const [jumpOverlay, setJumpOverlay] = useState<HTMLDivElement | null>(null)
  const count = q.data?.messages.length ?? 0
  // The EAGER (non-virtualized) fallback's own tail follow. No production surface reaches it — both
  // ThreadView callers virtualize, and this branch only renders when `count === 0` besides — but it shares
  // the SAME `[overflow-anchor:none]` scroller, so its band must not disagree with the virtualized path's:
  // at the 240px it used to carry, a third of a pane, a reader who scrolled up to re-read was hauled back
  // to the bottom by the next append. One constant, one meaning of "at the tail".
  useEffect(() => {
    if (virtualized) return
    const scroller = transcriptRef.current
    if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TAIL_FOLLOW_PX) scroller.scrollTop = scroller.scrollHeight
  }, [count, running, virtualized])

  const loadEarlier = useCallback(async () => {
    if (loadingEarlierRef.current) return
    const current = queryClient.getQueryData<TranscriptData>(["transcript", slug])
    const cursor = current?.beforeCursor
    const expectedKey = current?.transcriptKey
    if (!current?.hasEarlier || !cursor || !expectedKey) return
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    setEarlierError(null)
    try {
      const earlier = await rpc.threadTranscriptEarlier({ slug, cursor })
      const latest = queryClient.getQueryData<TranscriptData>(["transcript", slug])
      if (!latest?.transcriptKey || latest.transcriptKey !== expectedKey || earlier.transcriptKey !== expectedKey) {
        await q.refetch()
        showToast("Transcript changed while loading history; refreshed the current session")
        return
      }
      queryClient.setQueryData(["transcript", slug], prependEarlierPage(latest as Parameters<typeof prependEarlierPage>[0], earlier))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load earlier transcript history"
      setEarlierError(message)
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }, [q, queryClient, slug])

  return (
    <ThreadSlugContext.Provider value={slug}>
    <RadixTabs.Content
      value="chat"
      data-drawer-scroll-ready={q.isPending ? "false" : "true"}
      className="flex-1 min-h-0 flex flex-col overflow-hidden outline-none"
    >
      {/* The scroll viewport's own coordinate frame: `relative` here (rather than on the scroller) is
          what lets the floating "Jump to latest" overlay below sit still while the transcript scrolls.
          The scroller itself carries data-virtualized-transcript-scroll — the drawer virtualizes now
          too, so the old "standalone" name would be a lie.

          `[overflow-anchor:none]` on the scroller below leaves ONE authority over its offset. The
          virtualizer already corrects scrollTop itself every time a row above the reader is re-measured;
          Chrome's native scroll anchoring corrects it too, off its own anchor node, and neither knows
          about the other — so both firing on one layout change moves the reader by that correction
          TWICE. TodosView suspends native anchoring around exactly this hazard for the queue
          (suspendNativeAnchoring, "THE one owner"); the drawer transcript is the same hazard and was
          simply never given the same treatment. */}
      <div className="relative min-h-0 flex-1 flex flex-col">
      <div
        ref={transcriptRef}
        data-drawer-transcript-scroll
        data-virtualized-transcript-scroll={virtualized || undefined}
        tabIndex={virtualized ? 0 : undefined}
        role={virtualized ? "region" : undefined}
        aria-label={virtualized ? "Thread conversation" : undefined}
        aria-busy={virtualized && loadingEarlier ? true : undefined}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none [overflow-anchor:none] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
      >
      {virtualized && count > 0 ? (
        <VirtualizedThreadTranscript
          slug={slug}
          transcriptRef={transcriptRef}
          transcriptKey={q.data?.transcriptKey}
          messages={messages}
          paired={paired}
          answeringForMessage={answeringForMessage}
          thread={thread}
          nativeInputRequired={nativeInputRequired}
          running={running}
          copyTerminalCommand={copyTerminalCommand}
          stickyUserMessage={stickyUserMessage}
          transportFallback={q.transportFallback}
          isFetching={q.isFetching}
          refresh={() => void q.refetch()}
          retryLiveUpdates={q.retryLiveUpdates}
          hasEarlier={q.data?.hasEarlier === true}
          beforeCursor={q.data?.beforeCursor}
          loadingEarlier={loadingEarlier}
          earlierError={earlierError}
          loadEarlier={() => void loadEarlier()}
          jumpOverlay={jumpOverlay}
        />
      ) : (
      <>
      <InteractionStack
        thread={thread}
        className="px-6 pt-5"
        autoFocusFirst
      />
      {q.transportFallback && (
        <div
          data-transcript-sync-fallback
          className="mx-6 mt-3 flex flex-wrap items-center gap-2.5 rounded-md border border-border-strong bg-panel-2 px-3 py-2 text-[12px]"
          title={q.transportFallback.kind === "payload-too-large"
            ? `Live payload ${q.transportFallback.actualBytes} bytes; socket limit ${q.transportFallback.maxBytes} bytes`
            : `Transcript read budget reached (${q.transportFallback.scope}); retry after about ${q.transportFallback.retryAfterMs}ms`}
        >
          <AlertTriangle size={13} className="shrink-0 text-muted" />
          <div className="min-w-[180px] flex-1 leading-snug text-fg/85">
            <span className="font-medium">Live transcript updates paused.</span>{" "}
            {q.transportFallback.kind === "payload-too-large"
              ? "The transcript is too large for push; the last complete HTTP-loaded copy remains visible."
              : "The live read budget was reached; the last complete copy remains visible. Retry in a moment."}
          </div>
          <button
            type="button"
            disabled={q.isFetching}
            onClick={() => void q.refetch()}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel disabled:opacity-40"
          >
            {q.isFetching ? "Refreshing…" : "Refresh once"}
          </button>
          <button
            type="button"
            onClick={q.retryLiveUpdates}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel"
          >
            Retry live
          </button>
        </div>
      )}
      {/* No flex GAP: between-message spacing is adjacency-based explicit spacers (two tool-only
          messages → the tight 6px run; anything involving prose/a bubble/an event → STEP 14px), so a
          tool-card column reads uniformly no matter how the turns were chunked. */}
      <div className="flex min-h-full flex-col px-6 py-5">
        {count === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted">
            {q.isPending ? (
              // The transcript hasn't loaded YET — `count` is 0 only because `q.data` is still
              // undefined, not because the session is empty. For a long-running chat the initial
              // fetch/parse of a large transcript can take a beat, and claiming "Session starting…"
              // there is wrong (it may have been running for hours). Show a neutral load state until
              // the query resolves and we actually know whether there are messages.
              <span className="flex items-center gap-2"><Dots /> Loading…</span>
            ) : running ? (
              <span className="flex items-center gap-2"><Dots /> Session starting…</span>
            ) : canAdoptThread(thread) ? (
              // A thread fray-ui never originated (pre-existing .fray board): no session, no
              // transcript. Cold-adopt it — a fresh worker reads the thread FILE and continues;
              // per the fray contract the doc, not the conversation, is the durable context.
              // (Session language, not "agent": the thing that attaches IS an agent process, but the
              // UI's thread/session vocabulary keeps "agent" for genuine child sub-agents only.)
              <div className="text-center">
                <p className="mb-3">No session is attached to this thread yet.</p>
                <button
                  className="btn-ghost border border-border text-[12px]"
                  onClick={() => rpc.adoptThread({ slug }).catch(() => {})}
                >
                  Start a session on this thread
                </button>
              </div>
            ) : (
              "No conversation yet."
            )}
          </div>
        ) : (
          <>
            {(() => {
              // Interleave messages with adjacency-based spacers (see isToolOnlyMessage): SKIP messages
              // that render nothing (so no orphan/double gap), 6px between two tool-only messages, STEP
              // otherwise. `prevToolOnly === null` marks "no rendered message yet" → no leading spacer.
              const out: ReactNode[] = []
              let prevTailIsMeta: boolean | null = null
              messages.forEach((m, i) => {
                // QUEUED (optimistic, not-yet-in-the-log) messages are pinned to the very BOTTOM
                // (rendered after the working/pending indicators, below) — not interleaved here.
                if (m.queued) return
                if (messageRendersNothing(m)) return
                // 6px when two META rows abut across the boundary — a tool band OR a "Thought for Ns" /
                // reasoning label (see messageTailIsMeta), so the meta-label column reads as one rhythm.
                if (prevTailIsMeta !== null) out.push(<VSpace key={`s${i}`} h={prevTailIsMeta && messageHeadIsMeta(m) ? 6 : STEP} />)
                // The current ask sticks to the pane top (unless the pref is off) as a collapsed,
                // hover-to-expand bubble; every other message flows normally.
                const isSticky = i === lastUserIdx && stickyUserMessage
                const msg = (
                  <Message
                    key={i}
                    m={m}
                    answering={answeringForMessage(m)}
                    showSendButton
                    paired={paired[i]}
                    sticky={isSticky}
                  />
                )
                out.push(isSticky ? <StickyUserBand key={i}>{msg}</StickyUserBand> : msg)
                prevTailIsMeta = messageTailIsMeta(m)
              })
              return out
            })()}
            {(thread?.providerFault || thread?.limitPause || thread?.pendingAsk || nativeInputRequired || thread?.runtime === "perm-prompt" || running) && <VSpace />}
            {/* A frozen native AskUserQuestion takes precedence over the generic perm banner and the
                Working… spinner — it's the salient state (the safety net). Background sub-agents/shells
                are NOT surfaced here anymore: they live in the anchored ops strip (below), which is
                visible even mid-turn. A provider auth fault outranks everything: nothing else in the
                thread can make progress until the credential is restored. */}
            {thread?.providerFault && !thread.foreign ? (
              <ProviderFaultCard
                slug={slug}
                sessionId={thread.sessionId}
                fault={thread.providerFault}
                retryText={lastUserIdx >= 0 ? messages[lastUserIdx]?.text : undefined}
              />
            ) : thread?.limitPause && !thread.foreign ? (
              <LimitPauseCard slug={slug} sessionId={thread.sessionId} pause={thread.limitPause} />
            ) : thread?.pendingAsk ? (
              <PendingAskCard ask={thread.pendingAsk} onTerminal={copyTerminalCommand} />
            ) : nativeInputRequired ? (
              <NativeInputRequiredCard input={nativeInputRequired} onTerminal={copyTerminalCommand} />
            ) : thread?.runtime === "perm-prompt" ? (
              <PermPromptBanner onTerminal={copyTerminalCommand} />
            ) : running ? (
              <WorkingIndicator since={thread?.lastUserAt} />
            ) : null}
            {/* SIBLING of the chain above, not a branch in it. Those are mutually exclusive because they
                all describe the ONE thing currently blocking; a policy decision blocks nothing and can
                coexist with any of them, so it must not compete for the same slot. */}
            {thread?.permPolicy ? (
              <div className="mt-3">
                <PermPolicyNote policy={thread.permPolicy} denies={thread.permDenies} />
              </div>
            ) : null}
            {/* No thread-level Send button anymore: each question-bearing message renders its OWN bottom
                Send button (Message's showSendButton), scoped to just that message's blocks (each block's
                ⌘-Enter also submits that message). Answering is now one message at a time by design. */}
            {/* QUEUED (optimistic) messages pinned to the VERY BOTTOM — below the working/pending
                indicators — until the server echoes them into the transcript (maintainer 2026-07-09:
                "queued messages render underneath everything until they become un-queued and show up
                in the logs"). mergeOptimistic keeps them at the tail of `messages`; here they render
                as a group after everything. Once confirmed, the optimistic copy is consumed and the
                real message renders in its natural place above. */}
            {messages.some((m) => m.queued) && <VSpace />}
            {/* flex flex-col MIRRORS the parent scroll container (line ~162) so each Message root's
                `self-end` engages here exactly as it does for a landed message. Without it this group
                is a plain block, self-end is inert, and a multi-line bubble stretches to 85% and floats
                center-right — the center-then-snap-right jump on materialize.
                gap-3.5 = 14px = STEP (Tailwind can't reference the JS const — keep it in sync by hand):
                successive queued sends carry the same rhythm as any other pair. The gap is STRUCTURAL
                rather than an `mt` keyed off `messages[i-1].queued` — that adjacency test failed
                whenever a message this pass SKIPS (an event, anything messageRendersNothing) sat
                between two queued sends, butting the two bubbles together. */}
            <div className="flex flex-col gap-3.5">
              {messages.map((m, i) => (m.queued ? <Message key={`q${i}`} m={m} paired={paired[i]} /> : null))}
            </div>
          </>
        )}
      </div>
      </>
      )}
      </div>
      {/* Floating-affordance layer, pinned to the bottom-right of the scroll VIEWPORT. It is a
          sibling of the scroller, so nothing here moves when the transcript scrolls; the layer
          itself is click-through and only its children take pointer events. */}
      <div
        ref={setJumpOverlay}
        data-transcript-overlay
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-end p-4 [&>*]:pointer-events-auto"
      />
      </div>
      {/* This entire footer is deliberately non-scrolling: transcript history alone overflows. */}
      {/* Prompt box FIRST, then the background-ops strip UNDERNEATH it at the very bottom (maintainer
          2026-07-09): running sub-agents / shells / monitors sit below the composer, not above it. */}
      <div data-thread-chat-footer className="z-10 shrink-0 border-t border-border bg-panel">
        <ThreadActionBar
          slug={slug}
          onTerminal={copyTerminalCommand}
          ops={<BackgroundOpsStrip slug={slug} className="px-1 pb-2 pt-1.5" />}
        />
      </div>
    </RadixTabs.Content>
    </ThreadSlugContext.Provider>
  )
}

// How long after a wheel/touch/key gesture the reader still owns the scroller. Long enough to cover
// trackpad momentum between discrete events, short enough that it never outlives the gesture itself.
const READER_GESTURE_MS = 700

// How long an anchor restore (a pin move, a head trim) owns the scroller while the rows it disturbed
// settle. The settling lands on a ResizeObserver pass one or more frames after the commit, so the restore
// has to outlive the commit — but it must stay far under READER_GESTURE_MS, since a reader who scrolls
// during it should win the moment it ends.
const ANCHOR_RESTORE_MS = 250

// Opt-in drift diagnostic: `localStorage["fray.debugScroll"] = "1"`, then reload.
//
// The mid-scroll drift this file works to prevent does NOT reproduce headlessly — a scripted wheel has
// no momentum, and a seeded transcript has no images or async-settling cards — so a harness that goes
// green proves only that it did not reproduce, not that the reader is safe. This is the way to catch a
// real occurrence on the machine where it happens: it warns whenever the row under the reader's eye
// moves while the reader is not touching the scroller, and names the pin at that moment, so a live
// sighting comes with its size and its trigger instead of "it jumped again".
const DEBUG_SCROLL = (() => {
  try { return localStorage.getItem("fray.debugScroll") === "1" } catch { return false }
})()

type TranscriptTransportFallback = ReturnType<typeof useTranscript>["transportFallback"]
type VirtualThreadRow =
  | { key: "interactions"; kind: "interactions" }
  | { key: "transport-fallback"; kind: "transport-fallback" }
  | { key: string; kind: "earlier-history" }
  | ({ kind: "message" } & VirtualTranscriptMessageRow)
  | { key: "runtime-status"; kind: "runtime-status" }
  | { key: string; kind: "queued"; message: ChatMessage; messageIndex: number; gap: number }

function VirtualizedThreadTranscript({
  slug,
  transcriptRef,
  transcriptKey,
  messages,
  paired,
  answeringForMessage,
  thread,
  nativeInputRequired,
  running,
  copyTerminalCommand,
  stickyUserMessage,
  transportFallback,
  isFetching,
  refresh,
  retryLiveUpdates,
  hasEarlier,
  beforeCursor,
  loadingEarlier,
  earlierError,
  loadEarlier,
  jumpOverlay,
}: {
  slug: string
  transcriptRef: React.RefObject<HTMLDivElement | null>
  transcriptKey?: string
  messages: ChatMessage[]
  paired: (PairedAnswer[] | null)[]
  answeringForMessage: LiveAnswering["answeringForMessage"]
  thread: ThreadViewData | undefined
  nativeInputRequired: NativeInputRequiredData | undefined
  running: boolean
  copyTerminalCommand: () => void
  stickyUserMessage: boolean
  transportFallback: TranscriptTransportFallback
  isFetching: boolean
  refresh: () => void
  retryLiveUpdates: () => void
  hasEarlier: boolean
  beforeCursor?: string | null
  loadingEarlier: boolean
  earlierError: string | null
  loadEarlier: () => void
  jumpOverlay: HTMLElement | null
}) {
  const messageRows = useMemo(() => buildVirtualTranscriptMessageRows(
    messages,
    messageRendersNothing,
    messageHeadIsMeta,
    messageTailIsMeta,
    STEP,
  ), [messages])
  const lastUserIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && !messages[i].queued) return i
    }
    return -1
  }, [messages])
  const hasRuntimeStatus = Boolean(
    (thread?.providerFault && !thread.foreign)
      || (thread?.limitPause && !thread.foreign)
      || thread?.pendingAsk
      || nativeInputRequired
      || thread?.runtime === "perm-prompt"
      || running,
  )
  const rows = useMemo<VirtualThreadRow[]>(() => {
    const next: VirtualThreadRow[] = [{ key: "interactions", kind: "interactions" }]
    if (transportFallback) next.push({ key: "transport-fallback", kind: "transport-fallback" })
    if (hasEarlier || loadingEarlier || earlierError) {
      next.push({ key: `earlier-history:${beforeCursor ?? "complete"}`, kind: "earlier-history" })
    }
    next.push(...messageRows.map((row) => ({ ...row, kind: "message" as const })))
    if (hasRuntimeStatus) next.push({ key: "runtime-status", kind: "runtime-status" })
    let queuedGap = hasRuntimeStatus || messageRows.length > 0 ? STEP : 0
    messages.forEach((message, messageIndex) => {
      if (!message.queued) return
      const key = `queued:${message.deliveryId ?? message.sourceId ?? messageIndex}`
      next.push({ key, kind: "queued", message, messageIndex, gap: queuedGap })
      queuedGap = STEP
    })
    return next
  }, [beforeCursor, earlierError, hasEarlier, hasRuntimeStatus, loadingEarlier, messageRows, messages, transportFallback])

  // Which row carries the CURRENT ASK — the message the `stickyUserMessage` pref pins to the pane top.
  // -1 when the pref is off or the transcript has no landed user message yet; then nothing is hoisted
  // and every row renders in the absolute layer exactly as it did before.
  const stickyRowIndex = useMemo(() => {
    if (!stickyUserMessage || lastUserIdx < 0) return -1
    return rows.findIndex((row) => row.kind === "message" && row.messageIndex === lastUserIdx)
  }, [lastUserIdx, rows, stickyUserMessage])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => transcriptRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) return 80
      if (row.kind === "interactions") return 1
      if (row.kind === "earlier-history") return 42
      if (row.kind === "transport-fallback") return 76
      if (row.kind === "runtime-status") return 54
      return row.kind === "message" ? 108 + row.gap : 82 + row.gap
    },
    overscan: 8,
    paddingStart: 20,
    paddingEnd: 20,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: TAIL_FOLLOW_PX,
  })
  const [atEnd, setAtEnd] = useState(true)
  // Tail-follow state, in refs because syncTailFollow runs from layout/observer/listener callbacks that
  // must read CURRENT values, not ones closed over from the render that scheduled them.
  const followingTailRef = useRef(true)
  const tailHeightRef = useRef(-1)
  const readerScrollUntilRef = useRef(0)
  // The virtualizer's total-size box. Its height IS getTotalSize(), so observing it catches every way
  // the transcript can grow: a row inserted at its estimate, and each later measurement correction.
  const contentRef = useRef<HTMLDivElement>(null)
  const tailReadyRef = useRef(false)
  const readerMovedRef = useRef(false)
  const nearTopLoadArmedRef = useRef(true)
  const pendingPrependAnchorRef = useRef<{ rowKey: string; viewportTop: number } | null>(null)
  const initialTranscriptKeyRef = useRef<string | undefined>(undefined)
  // THE PIN MOVE (see the layout effect below). `readerAnchorRef` is refreshed at the END of every
  // tail-follow pass, so a layout effect that runs BEFORE that pass still reads the PREVIOUS commit's
  // position — which is exactly the place a pin move has to put the reader back.
  const readerAnchorRef = useRef<{ rowKey: string; viewportTop: number } | null>(null)
  const pinnedRowKeyRef = useRef<string | undefined>(undefined)
  const firstMessageKeyRef = useRef<string | undefined>(undefined)
  const anchorRestoreUntilRef = useRef(0)

  const requestEarlier = useCallback(() => {
    const scroller = transcriptRef.current
    if (scroller) {
      const scrollerTop = scroller.getBoundingClientRect().top
      // `:not([data-transcript-sticky])` is load-bearing: the pinned current-ask band floats AT the
      // scroll-pane top, so it is always the first element whose bottom clears `scrollerTop` — anchoring
      // to it would capture an invariant top and restore a zero correction, silently losing the reader's
      // place across a prepend. Same invariant captureTranscriptViewportAnchor enforces on the queue.
      const firstVisible = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-source-id]:not([data-transcript-sticky])"))
        .find((element) => element.getBoundingClientRect().bottom > scrollerTop + 1)
      const rowKey = firstVisible?.dataset.transcriptRowKey
      if (firstVisible && rowKey) {
        pendingPrependAnchorRef.current = {
          rowKey,
          viewportTop: firstVisible.getBoundingClientRect().top - scrollerTop,
        }
      }
    }
    loadEarlier()
  }, [loadEarlier, transcriptRef])

  useLayoutEffect(() => {
    if (!transcriptKey || rows.length === 0 || initialTranscriptKeyRef.current === transcriptKey) return
    initialTranscriptKeyRef.current = transcriptKey
    tailReadyRef.current = false
    readerMovedRef.current = false
    nearTopLoadArmedRef.current = true
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToEnd({ behavior: "instant" })
      tailReadyRef.current = true
      setAtEnd(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [rows.length, transcriptKey, virtualizer])

  useLayoutEffect(() => {
    const anchor = pendingPrependAnchorRef.current
    const scroller = transcriptRef.current
    if (!anchor || !scroller || loadingEarlier) return
    const alignAnchor = () => {
      const anchoredRow = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
        .find((element) => element.dataset.transcriptRowKey === anchor.rowKey)
      if (!anchoredRow) return
      const nextTop = anchoredRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      scroller.scrollTop += nextTop - anchor.viewportTop
    }
    // Dynamic markdown/tool rows settle after TanStack's ResizeObserver measurement. Correct once
    // synchronously and across the next two frames so the same message stays under the reader's eye.
    alignAnchor()
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      alignAnchor()
      secondFrame = requestAnimationFrame(() => {
        alignAnchor()
        if (pendingPrependAnchorRef.current === anchor) pendingPrependAnchorRef.current = null
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [loadingEarlier, messageRows.length, transcriptRef])

  // Where the reader is actually looking: the first row whose box reaches the pane top, and the offset
  // it sits at. `:not([data-transcript-sticky])` for the same reason requestEarlier needs it — the
  // pinned band floats AT the pane top, so anchoring to it would capture an invariant top and restore a
  // zero correction, silently losing the reader's place.
  const captureReaderAnchor = useCallback((): { rowKey: string; viewportTop: number } | null => {
    const scroller = transcriptRef.current
    if (!scroller) return null
    const scrollerTop = scroller.getBoundingClientRect().top
    const first = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]:not([data-transcript-sticky])"))
      .find((element) => element.getBoundingClientRect().bottom > scrollerTop + 1)
    const rowKey = first?.dataset.transcriptRowKey
    if (!first || !rowKey) return null
    return { rowKey, viewportTop: first.getBoundingClientRect().top - scrollerTop }
  }, [transcriptRef])

  // Put a remembered anchor back under the reader's eye. ABSOLUTE, not a delta: it scrolls to wherever
  // that row now is, so running it after some other corrector already got it right is a no-op rather
  // than a second correction.
  const alignToAnchor = useCallback((anchor: { rowKey: string; viewportTop: number }) => {
    const scroller = transcriptRef.current
    if (!scroller) return
    const row = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
      .find((element) => element.dataset.transcriptRowKey === anchor.rowKey && element.dataset.transcriptSticky !== "true")
    if (!row) return
    const nextTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += nextTop - anchor.viewportTop
  }, [transcriptRef])

  // THE PIN MOVE — the one transcript event that resizes a row ABOVE a reader parked mid-thread.
  //
  // A queued follow-up being DELIVERED is the only thing that moves the current ask: a queued bubble is
  // excluded from lastUserIdx, so an enqueue can't move it and no assistant reply ever can. When it
  // moves, the row that WAS pinned drops out of the hoisted flow layer back into the absolute one and
  // re-renders FULL SIZE instead of the collapsed pinned card — measured at 218px → 366px on a real
  // thread, and every row below it moved by exactly that 148px. A reader reading the agent's output
  // sits BELOW the ask, so that growth is ABOVE them, and staying put depends entirely on the resize
  // being compensated — which the virtualizer skips outright while the reader is scrolling up
  // (virtual-core resizeItem: `!itemSizeCache.has(key) || scrollDirection !== "backward"`), and which
  // the browser's own scroll anchoring used to duplicate. A fixed-size shove, only on a delivery,
  // depending on what the reader happened to be doing — i.e. sporadic.
  //
  // So don't depend on the compensation. Remember where the reader was and put them back, across the
  // next frames, because the re-expansion lands on a later ResizeObserver pass and not in this commit.
  // The pinned row's KEY, not its index — an index shifts under every insert, so it would report a "pin
  // move" on any append. (stickyMessageRow itself is derived further down, after the measure pass.)
  const pinnedRowKey = stickyRowIndex >= 0 ? rows[stickyRowIndex]?.key : undefined
  useLayoutEffect(() => {
    const nextKey = pinnedRowKey
    const previousKey = pinnedRowKeyRef.current
    pinnedRowKeyRef.current = nextKey
    // First commit establishes the baseline; a reader AT the tail is tail-follow's to move, not ours.
    if (previousKey === undefined || previousKey === nextKey || followingTailRef.current) return
    const anchor = readerAnchorRef.current
    if (!anchor || pendingPrependAnchorRef.current) return
    // Claim the scroller for this beat so the tail-follow pass leaves the offset alone while the row
    // above settles (it reconciles against a scroll height that is mid-change until it does).
    anchorRestoreUntilRef.current = performance.now() + ANCHOR_RESTORE_MS
    alignToAnchor(anchor)
    let secondFrame = 0
    let thirdFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      alignToAnchor(anchor)
      secondFrame = requestAnimationFrame(() => {
        alignToAnchor(anchor)
        thirdFrame = requestAnimationFrame(() => {
          alignToAnchor(anchor)
          anchorRestoreUntilRef.current = 0
        })
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
      cancelAnimationFrame(thirdFrame)
      anchorRestoreUntilRef.current = 0
    }
  }, [alignToAnchor, pinnedRowKey])

  // THE HEAD TRIM — the other event that moves content ABOVE a reader parked mid-thread, and the one the
  // virtualizer is structurally unable to see.
  //
  // The server projects at most MAX_MESSAGES (300), so on any thread past that cap every new message also
  // pushes one off the HEAD of the live window. Those rows vanish from above the reader, the content above
  // them shrinks by exactly their height, and scrollTop is left untouched — so the whole transcript slides
  // UP past their eye, which is indistinguishable from being scrolled down. Measured on a real saturated
  // thread at 62-185px per append, cumulative: -975px over 25 appends (verify-full-window-slide.mjs).
  //
  // TanStack cannot compensate it. Its `anchorTo: "end"` preservation is gated on `didEdgeKeysChange` —
  // `count changed || getItemKey(0) changed || getItemKey(count - 1) changed` — and on THIS list row 0 is
  // always the interactions row, the last row is always the runtime-status row, and `count` is pinned by
  // the cap. A trim is therefore entirely interior to the key list, so the library sees nothing, rebuilds
  // no measurements and adjusts no offset. Every other surface that changes the rows above the reader (a
  // prepend, a pin move) already restores the reader explicitly; this one simply never was.
  //
  // The trim has already landed by the time this runs, so realign synchronously — then again across the
  // next frames, because the rows below the removed ones re-measure on later ResizeObserver passes.
  const firstMessageKey = messageRows[0]?.key
  useLayoutEffect(() => {
    const previousKey = firstMessageKeyRef.current
    firstMessageKeyRef.current = firstMessageKey
    // First commit establishes the baseline. A reader AT the tail is tail-follow's to move; a prepend owns
    // the scroller through its own anchor; and the initial scroll-to-end must not be fought.
    if (previousKey === undefined || previousKey === firstMessageKey) return
    if (!tailReadyRef.current || followingTailRef.current || pendingPrependAnchorRef.current) return
    const anchor = readerAnchorRef.current
    if (!anchor) return
    // Deliberately NO scroller claim here, unlike the pin move. A trim lands on EVERY append once the
    // window is full — several times a second on a live turn — and a 250ms claim that often would keep
    // syncTailFollow from refreshing the reader anchor at all, so a reader who scrolled mid-stream would be
    // realigned to where they were BEFORE they moved: their own scroll undone by the next append. Letting
    // the anchor refresh on every pass instead makes this restore a fixed point, and the follow-ups below
    // re-read it, so the reader's live intent always wins.
    alignToAnchor(anchor)
    // The rows below the removed ones re-measure on later ResizeObserver passes, so hold once more across
    // the next frames — against the reader's CURRENT anchor, and never while their own gesture is in flight.
    const holdStill = () => {
      if (performance.now() < readerScrollUntilRef.current) return
      const current = readerAnchorRef.current
      if (current) alignToAnchor(current)
    }
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      holdStill()
      secondFrame = requestAnimationFrame(holdStill)
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [alignToAnchor, firstMessageKey])

  // TAIL FOLLOW — keep a reader who is AT the bottom at the bottom as the conversation grows.
  //
  // TanStack's own `followOnAppend` cannot do this job here: it only fires when the count grows AND the
  // LAST row's key changes (virtual-core setOptions). A live thread's last row is almost never a
  // message — it's the runtime-status row (Working…) or a queued bubble — so a landing reply is
  // INSERTED ABOVE a tail whose key never changes and the follow silently no-ops. `resizeItem` then
  // PRESERVES the distance from the end while the row measures, so the gap that opened at insert time
  // is held forever: the reader is left exactly one row ESTIMATE short of the bottom (122px for a
  // message; ~50-70px for a queued→landed flip, which leaves the row count unchanged and so cannot
  // trigger the library follow at all) — the "it auto-scrolled but stopped 50px short" bug.
  //
  // So own it. Reconciled by nextTailFollow (which decides reader-moved vs content-grew) and driven
  // from three places, because content settles across several frames: the scroll listener, every
  // commit, and every resize of the virtualizer's total-size box.
  const syncTailFollow = useCallback(() => {
    const scroller = transcriptRef.current
    // A prepend in flight owns the scroller: "load earlier" grows the content by a whole page and
    // restores the reader's anchor across the next two frames. Following that growth would race it.
    if (!scroller || pendingPrependAnchorRef.current) return
    // Same for an anchor restore (a pin move, a head trim): the rows above the reader are mid-settle, so
    // the scroll height this would reconcile against is a value in transit. Let the restore land, then
    // resume — and do NOT refresh the reader anchor from a position it is still correcting.
    if (performance.now() < anchorRestoreUntilRef.current) return
    const next = nextTailFollow({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      previousScrollHeight: tailHeightRef.current,
      following: followingTailRef.current,
      readerMoved: performance.now() < readerScrollUntilRef.current,
    })
    followingTailRef.current = next.following
    if (next.scrollTop !== null) scroller.scrollTop = next.scrollTop
    tailHeightRef.current = scroller.scrollHeight
    // "Jump to latest" is exactly the negation of attachment, so the affordance can never disagree
    // with the behavior — and it no longer flickers for one frame while a message lands.
    setAtEnd((current) => current === next.following ? current : next.following)
    // Did the row under the reader's eye move while they weren't touching anything? (see DEBUG_SCROLL)
    if (DEBUG_SCROLL && !next.following && performance.now() >= readerScrollUntilRef.current) {
      const previous = readerAnchorRef.current
      const row = previous && Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
        .find((element) => element.dataset.transcriptRowKey === previous.rowKey && element.dataset.transcriptSticky !== "true")
      if (previous && row) {
        const drift = Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - previous.viewportTop)
        if (Math.abs(drift) > 2) console.warn(`[fray] transcript moved ${drift}px under a still reader — pin=${pinnedRowKeyRef.current ?? "none"} row=${previous.rowKey}`)
      }
    }
    // LAST: refresh where the reader is looking. This runs on every commit, every settle and every
    // scroll, so the pin-move effect above — which is declared EARLIER and therefore runs before this
    // pass — always reads the position from before the pin moved.
    readerAnchorRef.current = captureReaderAnchor() ?? readerAnchorRef.current
  }, [captureReaderAnchor, transcriptRef])

  // Every commit: a row that just mounted at its ESTIMATED height has already pushed the bottom away.
  // A layout effect (not an effect) so the correction lands in the same frame — no visible slip.
  useLayoutEffect(syncTailFollow)

  // Every settle after that: TanStack measures the real DOM one or more frames later, and a big
  // markdown/tool row can keep growing for several. The observed box's height IS getTotalSize().
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(syncTailFollow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [syncTailFollow])

  useEffect(() => {
    const scroller = transcriptRef.current
    if (!scroller) return
    const inspect = () => {
      syncTailFollow()
      const gate = earlierLoadGate({
        armed: nearTopLoadArmedRef.current,
        scrollTop: scroller.scrollTop,
        readerMoved: tailReadyRef.current && readerMovedRef.current,
        hasEarlier,
        loading: loadingEarlier,
      })
      nearTopLoadArmedRef.current = gate.armed
      if (gate.shouldLoad) requestEarlier()
    }
    // A gesture is in flight: for the next beat, treat every scroll as the READER's, so a transcript
    // that happens to be growing at that moment can't claim the movement and haul them back down.
    const markReaderIntent = () => {
      readerMovedRef.current = true
      readerScrollUntilRef.current = performance.now() + READER_GESTURE_MS
      requestAnimationFrame(inspect)
    }
    const markKeyboardIntent = (event: KeyboardEvent) => {
      if (!["ArrowUp", "PageUp", "Home", " "].includes(event.key)) return
      if (scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    const markWheelIntent = (event: WheelEvent) => {
      if (event.deltaY < 0 && scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    const markTouchIntent = () => {
      if (scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    scroller.addEventListener("scroll", inspect, { passive: true })
    scroller.addEventListener("wheel", markWheelIntent, { passive: true })
    scroller.addEventListener("touchstart", markTouchIntent, { passive: true })
    scroller.addEventListener("touchmove", markTouchIntent, { passive: true })
    scroller.addEventListener("pointerdown", markReaderIntent, { passive: true })
    scroller.addEventListener("keydown", markKeyboardIntent)
    const frame = requestAnimationFrame(inspect)
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener("scroll", inspect)
      scroller.removeEventListener("wheel", markWheelIntent)
      scroller.removeEventListener("touchstart", markTouchIntent)
      scroller.removeEventListener("touchmove", markTouchIntent)
      scroller.removeEventListener("pointerdown", markReaderIntent)
      scroller.removeEventListener("keydown", markKeyboardIntent)
    }
  }, [hasEarlier, loadingEarlier, requestEarlier, syncTailFollow, transcriptRef])

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  // THE PINNED CURRENT ASK, virtualized. CSS `position: sticky` is inert on a virtual row: every row is
  // `position: absolute` + translateY, so its containing block is a zero-height point and there is no
  // range to stick over. So that ONE row is HOISTED out of the absolute layer and rendered in NORMAL
  // FLOW — a spacer of exactly its measured `start`, then the row itself — which gives it the
  // full-height scroll container as its containing block, i.e. precisely what the eager path's
  // StickyUserBand relies on. It is still `measureElement`-registered under its own `data-index`, so
  // the virtualizer sizes it from the real DOM exactly like any other row; it is simply always
  // mounted (one extra message, and it must be, since a pinned message stays visible while its slot
  // is far off screen). The absolute layer skips it below so it never renders twice.
  const stickyRow = stickyRowIndex >= 0 ? rows[stickyRowIndex] : undefined
  const stickyMessageRow = stickyRow?.kind === "message" ? stickyRow : undefined
  // `measurementsCache` is the PUBLIC field holding what the private getMeasurements() returns; reading
  // it here is safe because getVirtualItems() above already forced the memoized measure pass this render.
  const stickyStart = stickyMessageRow ? virtualizer.measurementsCache[stickyRowIndex]?.start ?? 0 : 0

  return (
    <div
      ref={contentRef}
      data-virtualized-transcript
      data-virtual-row-count={virtualItems.length}
      className="relative w-full"
      style={{ height: totalSize }}
    >
      {stickyMessageRow && (
        <>
          {/* Flow spacer — parks the pinned row at the same offset its absolute twin would have had, so
              the transcript reads identically until the reader scrolls past it and it lifts to the top. */}
          <div aria-hidden style={{ height: stickyStart }} />
          {/* The pinned row is a SINGLE sticky layer — this IS the StickyUserBand for the virtualized
              path (its classes are inlined here). It must be a direct child of the height:totalSize
              container so `sticky top-0` has the full transcript as its containing block and can pin
              across the whole scroll range; wrapping it in a short flow div would give it a tiny
              containing block and it could never stick. Do NOT also render a nested StickyUserBand —
              two stacked `sticky top-0` layers push the card down by the inner band's box (the 121px
              gap that let transcript content bleed above the "pinned" card). `[&>*]:pointer-events-auto`
              re-enables the bubble (hover-to-expand) while the full-width band stays click-through. */}
          <div
            key={stickyMessageRow.key}
            ref={virtualizer.measureElement}
            data-index={stickyRowIndex}
            data-transcript-row-key={stickyMessageRow.key}
            data-transcript-source-id={stickyMessageRow.message.sourceId}
            data-transcript-sticky="true"
            className="pointer-events-none [&>*]:pointer-events-auto sticky top-0 z-[9] flex w-full flex-col px-6 pt-3 pb-1.5"
          >
            <Message
              m={stickyMessageRow.message}
              answering={answeringForMessage(stickyMessageRow.message)}
              showSendButton
              paired={paired[stickyMessageRow.messageIndex]}
              sticky
            />
          </div>
        </>
      )}
      {virtualItems.map((virtualRow) => {
        const row = rows[virtualRow.index]
        if (!row) return null
        if (virtualRow.index === stickyRowIndex) return null
        return (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            data-transcript-row-key={row.key}
            data-transcript-source-id={row.kind === "message" ? row.message.sourceId : undefined}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {row.kind === "interactions" ? (
              <InteractionStack thread={thread} className="px-6 pt-5" autoFocusFirst />
            ) : row.kind === "transport-fallback" ? (
              transportFallback ? <div className="px-6 pt-3"><div
                data-transcript-sync-fallback
                className="flex flex-wrap items-center gap-2.5 rounded-md border border-border-strong bg-panel-2 px-3 py-2 text-[12px]"
                title={transportFallback.kind === "payload-too-large"
                  ? `Live payload ${transportFallback.actualBytes} bytes; socket limit ${transportFallback.maxBytes} bytes`
                  : `Transcript read budget reached (${transportFallback.scope}); retry after about ${transportFallback.retryAfterMs}ms`}
              >
                <AlertTriangle size={13} className="shrink-0 text-muted" />
                <div className="min-w-[180px] flex-1 leading-snug text-fg/85">
                  <span className="font-medium">Live transcript updates paused.</span>{" "}
                  {transportFallback.kind === "payload-too-large"
                    ? "The transcript is too large for push; the last complete HTTP-loaded copy remains visible."
                    : "The live read budget was reached; the last complete copy remains visible. Retry in a moment."}
                </div>
                <button type="button" disabled={isFetching} onClick={refresh} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel disabled:opacity-40">
                  {isFetching ? "Refreshing…" : "Refresh once"}
                </button>
                <button type="button" onClick={retryLiveUpdates} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel">
                  Retry live
                </button>
              </div></div> : null
            ) : row.kind === "earlier-history" ? (
              <div className="flex min-h-10 items-center justify-center px-6 text-[11px] text-muted" role="status">
                {earlierError ? (
                  <span className="flex flex-wrap items-center justify-center gap-2 text-center">
                    <span>{earlierError}</span>
                    <button type="button" onClick={requestEarlier} className="rounded-md border border-border px-2 py-1 text-fg/90 hover:bg-panel-2">Retry</button>
                  </span>
                ) : loadingEarlier ? (
                  <span className="flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading earlier messages…</span>
                ) : (
                  <button type="button" onClick={requestEarlier} className="rounded-md px-2 py-1 outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60">
                    Load earlier messages
                  </button>
                )}
              </div>
            ) : row.kind === "message" ? (
              <div className="flex flex-col px-6" style={{ paddingTop: row.gap }}>
                <Message
                  m={row.message}
                  answering={answeringForMessage(row.message)}
                  showSendButton
                  paired={paired[row.messageIndex]}
                />
              </div>
            ) : row.kind === "runtime-status" ? (
              <div className="px-6" style={{ paddingTop: STEP }}>
                {thread?.providerFault && !thread.foreign ? (
                  <ProviderFaultCard slug={slug} sessionId={thread.sessionId} fault={thread.providerFault} retryText={lastUserIdx >= 0 ? messages[lastUserIdx]?.text : undefined} />
                ) : thread?.limitPause && !thread.foreign ? (
                  <LimitPauseCard slug={slug} sessionId={thread.sessionId} pause={thread.limitPause} />
                ) : thread?.pendingAsk ? (
                  <PendingAskCard ask={thread.pendingAsk} onTerminal={copyTerminalCommand} />
                ) : nativeInputRequired ? (
                  <NativeInputRequiredCard input={nativeInputRequired} onTerminal={copyTerminalCommand} />
                ) : thread?.runtime === "perm-prompt" ? (
                  <PermPromptBanner onTerminal={copyTerminalCommand} />
                ) : running ? (
                  <WorkingIndicator since={thread?.lastUserAt} />
                ) : null}
                {/* Sibling, not a branch — see the runtime-status block above. */}
                {thread?.permPolicy ? (
                  <div className="mt-3">
                    <PermPolicyNote policy={thread.permPolicy} denies={thread.permDenies} />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col px-6" style={{ paddingTop: row.gap }}>
                <Message m={row.message} paired={paired[row.messageIndex]} />
              </div>
            )}
          </div>
        )
      })}
      <JumpToLatest overlay={jumpOverlay} hidden={atEnd} onJump={() => virtualizer.scrollToEnd({ behavior: "smooth" })} />
    </div>
  )
}

// "Jump to latest" belongs to the transcript's scroll STATE but not to its scroll CONTENT: it is
// portalled into ChatView's viewport-anchored overlay so it simply floats, motionless, over the
// scrolling column. (It used to render inside the virtualized content and chase the viewport by
// recomputing a content-space `top` every render — which meant it drifted with the content on every
// scroll and snapped back a frame later.)
function JumpToLatest({ overlay, hidden, onJump }: { overlay: HTMLElement | null; hidden: boolean; onJump: () => void }) {
  if (!overlay || hidden) return null
  return createPortal(
    <button
      type="button"
      data-jump-to-latest
      onClick={onJump}
      className="flex items-center gap-1.5 rounded-full border border-border-strong bg-elevated px-3 py-1.5 text-[11px] font-medium text-fg shadow-lg shadow-black/30 hover:bg-panel-2"
    >
      <ArrowDown size={12} />
      Jump to latest
    </button>,
    overlay,
  )
}

// The thread's top bar: title, the Chat/Doc tab toggle, and — at the far right — the shared actions.
// non-lifecycle HeaderActions. Snooze and Archive stay in the persistent thread footer. The tab is CONTROLLED
// (tab/onTab) so the drawer drives its own copy. Owned sessions expose a command-copy icon; foreign
// rows do not. The Doc tab appears only when the thread has a provisioned scratchpad.
export function ThreadHeader({ slug, tab, onStatusApplied, onClose, showReturnToQueue = false }: { slug: string; tab: ThreadTab; onStatusApplied?: () => void; onClose?: () => void; showReturnToQueue?: boolean }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const markComplete = useMutation({ mutationFn: () => rpc.markComplete({ slug }) })
  const renameTitle = useMutation({ mutationFn: (title: string) => rpc.renameThread({ slug, title }) })
  const aiRenameTitle = useMutation({
    mutationFn: () => rpc.aiRenameThread({ slug }),
    onSuccess: ({ title }) => showToast(`Renamed to “${title}”`),
    onError: (error) => showToast(error instanceof Error ? error.message : "Could not rename with Claude", { duration: 7000 }),
  })
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const titleInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editingTitle) return
    const frame = requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editingTitle])
  // A drawer can switch slugs without remounting this header. Never carry a half-entered title into
  // another thread; changing selection has the same semantics as cancelling with Escape.
  useEffect(() => {
    setEditingTitle(false)
    setTitleDraft("")
  }, [slug])
  // The "Fray document" header affordance opens .fray/<slug>.md (threadBody). Many session threads have
  // no such file — their working doc is the scratchpad (the Doc tab) — so the button would dead-end on
  // "No thread file found". Gate it on the doc actually having body content (same stripFrontmatter the
  // drawer renders through), so it shows iff there's a real doc to open. Shares the drawer's cached query
  // (identical key), so opening the drawer adds no extra round-trip.
  const docQ = useQuery({ queryKey: ["threadBody", slug], queryFn: () => rpc.threadBody({ slug }) })
  const hasDoc = stripFrontmatter(docQ.data?.markdown ?? "").trim().length > 0
  if (!thread) return null
  const showTerminalCommand = thread.kind === "session" && thread.foreign !== true
  const showScratch = !!thread.scratchpadPath
  // Manual rename is registry metadata for either backend. Claude additionally owns a native AI
  // rename; Codex has no equivalent and must never be shown a fake slash-command affordance.
  const isForeign = thread.foreign === true
  const canRename = thread.kind === "session" && !isForeign
  const shownTitle = displayTitle(thread)
  const aiRename = aiRenameAvailability(thread)
  const aiRenameUnavailable = !aiRename.enabled || aiRenameTitle.isPending
  const aiRenameLabel = aiRenameTitle.isPending
    ? "Claude is generating a title…"
    : aiRename.enabled && aiRenameTitle.error instanceof Error
      ? aiRenameTitle.error.message
      : aiRename.label
  function cancelRename(): void {
    setEditingTitle(false)
    setTitleDraft("")
  }
  function commitRename(): void {
    const title = threadTitleToCommit(titleDraft, shownTitle)
    setEditingTitle(false)
    if (!title) {
      setTitleDraft("")
      return
    }
    renameTitle.mutate(title, {
      onSuccess: () => {
        setTitleDraft("")
        showToast("Thread renamed")
      },
      onError: (error) => {
        setTitleDraft(title)
        setEditingTitle(true)
        showToast(error instanceof Error ? error.message : "Could not rename thread")
      },
    })
  }
  return (
    <header
      data-thread-header
      className={THREAD_HEADER_CLASS}
    >
      <div className={THREAD_HEADER_TITLE_CLASS}>
        <div className="flex min-w-0 items-center gap-1.5">
          {showReturnToQueue && (
            <Tooltip label="Return to queue">
              <a
                href="/"
                aria-label="Return to queue"
                data-standalone-return
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
              >
                <ArrowLeft size={14} />
              </a>
            </Tooltip>
          )}
          <div className="min-w-0 flex-1 leading-tight">
          {/* Keep the title's display wrapper content-sized. Long names still truncate inside the
              remaining header width, but short names do not claim the whole row as a click target. */}
          <div className="flex min-w-0 items-center gap-1">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                aria-label="Thread title"
                value={titleDraft}
                maxLength={THREAD_TITLE_MAX_LENGTH}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    commitRename()
                  } else if (event.key === "Escape") {
                    event.preventDefault()
                    cancelRename()
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-elevated px-1.5 py-1 font-semibold text-[15px] text-fg outline-none focus:border-accent"
              />
            ) : canRename ? (
              <button
                type="button"
                title="Edit title"
                aria-label={`Edit thread title: ${shownTitle}`}
                disabled={renameTitle.isPending || aiRenameTitle.isPending}
                onClick={() => {
                  setTitleDraft(manualThreadTitleSeed(shownTitle, thread.id))
                  setEditingTitle(true)
                }}
                className="min-w-0 max-w-full shrink truncate rounded px-0.5 -mx-0.5 font-semibold text-[15px] text-left outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {shownTitle}
              </button>
            ) : (
              <div className="min-w-0 max-w-full shrink truncate px-0.5 -mx-0.5 font-semibold text-[15px]" title={shownTitle}>
                {shownTitle}
              </div>
            )}
            {aiRename.show && !editingTitle && (
              <Tooltip label={aiRenameLabel}>
                {/* aria-disabled (not native disabled) keeps the reason keyboard-focusable; the guarded
                    click remains a no-op until the runtime is safe. */}
                <button
                  type="button"
                  aria-label={aiRenameTitle.isPending ? "Renaming with Claude" : aiRename.enabled ? "Rename with Claude" : aiRename.label}
                  title={aiRenameLabel}
                  aria-busy={aiRenameTitle.isPending}
                  aria-disabled={aiRenameUnavailable}
                  onClick={() => {
                    if (aiRenameUnavailable) return
                    aiRenameTitle.reset()
                    aiRenameTitle.mutate()
                  }}
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors ${
                    aiRenameUnavailable ? "cursor-not-allowed opacity-40" : ""
                  } ${aiRenameTitle.error ? "text-red-400 hover:bg-red-500/10" : "text-accent hover:bg-accent/10"}`}
                >
                  <Sparkles size={13} strokeWidth={2} className={aiRenameTitle.isPending ? "animate-pulse" : ""} />
                </button>
              </Tooltip>
            )}
          </div>
          <LastActive at={lastActiveLabelAt(thread)} fallbackAt={thread.spawnedAt} className="mt-0.5 block truncate text-[11px] leading-tight text-muted/75" />
          </div>
        </div>
      </div>
      {/* At constrained drawer widths, controls get their own deliberate row. This keeps the
          clickable title and its activity stamp readable instead of competing with fixed-width
          tabs/actions, while the control row itself remains a single unbroken cluster. */}
      <div className={THREAD_HEADER_CONTROLS_CLASS}>
        <RadixTabs.List aria-label="Thread view" className="flex shrink-0 items-center gap-1 rounded-lg bg-panel-2 p-0.5 text-[11px]">
          <Tab value="chat" label="Chat" />
          {showScratch && <Tab value="scratch" label="Doc" />}
        </RadixTabs.List>
        <div className="flex shrink-0 items-center">
          {showTerminalCommand && <CopyTerminalCommandButton slug={slug} />}
          <HeaderActions
            thread={thread}
            onDoc={hasDoc ? () => pushDrawer("doc", thread.id) : undefined}
            onDone={() => markComplete.mutate(undefined, { onSuccess: onStatusApplied })}
            doneBusy={markComplete.isPending}
            onStatusApplied={onStatusApplied}
          />
          {onClose && (
            <Tooltip label="Open in new tab">
              <a
                href={standaloneThreadHref(slug)}
                target="_blank"
                rel="noopener"
                aria-label="Open in new tab"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
              >
                <ArrowUpRight size={14} />
              </a>
            </Tooltip>
          )}
        </div>
        {/* Close-X for the DRAWER context (onClose passed by ThreadSheet) — parity with the Settings,
            sub-agent, and Doc drawers, all of which carry a corner "Close". Wired to the SAME animated
            close() as the backdrop/Esc path (markDrawerClosing + the 210ms slide-out), never an instant
            unmount. Absent in the main workpane (no onClose → no drawer to close). */}
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            data-dialog-initial-focus
            onClick={onClose}
            className="ml-0.5 shrink-0 rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </header>
  )
}

// Chat | Doc — the segmented toggle in the thread header.
function Tab({ value, label }: { value: ThreadTab; label: string }) {
  return (
    <RadixTabs.Trigger
      value={value}
      className="rounded-md px-2.5 py-1 text-muted outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 data-[state=active]:bg-elevated data-[state=active]:text-fg data-[state=active]:shadow-sm data-[state=active]:shadow-black/20"
    >
      {label}
    </RadixTabs.Trigger>
  )
}

// The scratchpad doc tab: a session thread's compaction-proof working memory (.fray/threads/<id>/scratch.md),
// rendered read-only as markdown. Refetched on open (a simple query); the worker rewrites the file as
// it works, so a re-open picks up the latest. Empty when never provisioned.
function ScratchpadPane({ slug }: { slug: string }) {
  const q = useQuery({ queryKey: ["threadScratchpad", slug], queryFn: () => rpc.threadScratchpad({ slug }) })
  const html = useMemo(() => mdToHtml(q.data?.markdown ?? ""), [q.data?.markdown])
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      {q.isLoading ? (
        <div className="text-[13px] text-muted">Loading…</div>
      ) : html ? (
        <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="text-[13px] text-muted">No scratchpad yet.</div>
      )}
    </div>
  )
}

// BETWEEN-BLOCK RHYTHM is expressed as explicit spacer ELEMENTS, never margins/padding/gap on the
// blocks themselves. An explicit element is visible in the tree, one uniform size, and can't collapse
// or double the way adjacent margins silently do. Padding INSIDE a block (its own chrome) is fine;
// the space BETWEEN sibling blocks is always a VSpace. STEP is the single between-block unit.
export const STEP = 14
// Adjacent tool cards must read at the SAME tight 6px run whether they're batched in one message or
// split across messages (the tailer chunks a burst of tool calls arbitrarily). The gap between two
// messages is 6px iff the FIRST ends with a tool band AND the SECOND begins with one (tool-tail →
// tool-head) — so a "let me check:" text-then-tool message sits 6px above the next message's leading
// tool, exactly like two batched tools. Any prose at the boundary keeps STEP (14px). messageTailIsTool
// / messageHeadIsTool inspect the LAST / FIRST rendered block; the legacy (no-parts) path renders the
// tool band FIRST then prose, so its head is tools-if-any and its tail is tools-only-if-no-prose.
// A sub-agent COMPLETION MARKER message (see lib/subAgentCompletion.ts) is transcript punctuation, not
// a tool band: Message renders it as a wake divider, so every spacing predicate must treat it like the
// boundary event it is now a peer of — never as a tool card.
export function messageTailIsTool(m: ChatMessage): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (agentCompletionCall(m)) return false
  if (m.parts && m.parts.length > 0) {
    for (let i = m.parts.length - 1; i >= 0; i--) {
      const p = m.parts[i]
      if (p.kind === "tools" ? p.tools.length > 0 : p.text.trim()) return p.kind === "tools"
    }
    return false
  }
  return (m.tools?.length ?? 0) > 0 && !m.text.trim()
}
export function messageHeadIsTool(m: ChatMessage): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (agentCompletionCall(m)) return false
  if (m.parts && m.parts.length > 0) {
    for (const p of m.parts) {
      if (p.kind === "tools" ? p.tools.length > 0 : p.text.trim()) return p.kind === "tools"
    }
    return false
  }
  return (m.tools?.length ?? 0) > 0
}
// A lightweight single-line META label — a collapsed "Thought for Ns"/"Agent … finished" event or a
// collapsed Codex reasoning row. These share the SAME petite-caps line box as a "N tool calls" batch
// header (TRANSCRIPT_META_LABEL_CLASS), so per the "one rhythm" intent (transcriptMetaLabels.ts) they
// join the tight 6px tool run instead of forcing a 14px break on both sides. A BOUNDARY event is a
// section-break divider, not a quiet label — it keeps STEP.
function isMetaLabelMessage(m: ChatMessage): boolean {
  return (m.kind === "event" && !m.boundary) || m.kind === "reasoning"
}
// Tail/head predicates for the tight-run spacer: a tool band OR a meta label. An event/reasoning
// message is a single row, so its head and tail are the same meta label.
export function messageTailIsMeta(m: ChatMessage): boolean {
  return isMetaLabelMessage(m) || messageTailIsTool(m)
}
export function messageHeadIsMeta(m: ChatMessage): boolean {
  return isMetaLabelMessage(m) || messageHeadIsTool(m)
}
// Matches exactly when Message returns null (an empty/thinking-only assistant turn) — such a message
// takes no slot, so the adjacency-spacer walk must SKIP it (else two spacers stack into a double gap).
export function messageRendersNothing(m: ChatMessage): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) return m.parts.every((p) => (p.kind === "tools" ? p.tools.length === 0 : !p.text.trim()))
  return (m.tools?.length ?? 0) === 0 && !m.text.trim()
}
// Would this message render anything under `textOnly` (tool bands dropped)? Mirrors messageRendersNothing
// but counts ONLY text parts — the queue card uses it to decide whether a first/last agent message that
// is pure batched tool calls (no prose) contributes a visible row, or folds entirely into the bar.
export function messageHasRenderableText(m: ChatMessage): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) return m.parts.some((p) => p.kind === "text" && p.text.trim() !== "")
  return typeof m.text === "string" && m.text.trim() !== ""
}
export function VSpace({ h = STEP }: { h?: number }) {
  return <div aria-hidden className="shrink-0" style={{ height: h }} />
}

// Interleave a list of block-level nodes with explicit spacers. Nullish entries (e.g. an empty prose
// run) are dropped BEFORE interleaving so a spacer never leads, trails, or doubles.
function withSpacers(blocks: ReactNode[], h = STEP): ReactNode[] {
  const real = blocks.filter((b) => b !== null && b !== undefined && b !== false)
  const out: ReactNode[] = []
  real.forEach((b, i) => {
    if (i > 0) out.push(<VSpace key={`vs${i}`} h={h} />)
    out.push(b)
  })
  return out
}

interface CollapsedTool {
  name: string
  detail?: string
  // Set for Edit/Write/MultiEdit entries: the (same-file) edits merged into one diff block. Distinct
  // files never merge; a plain tool call has no edits.
  edits?: TranscriptEdit[]
  // Set for a multi-line / long Bash call: the raw command, rendered as its own code block. Like
  // edits, a command entry stands alone (never folds into a repeat count).
  command?: string
  // The model-authored one-line description for a Bash command block (the collapsed block's header).
  // Falls back to `detail` (the command's first line) when the model gave no description.
  desc?: string
  // A shell command's captured stdout/stderr (codex's exec_command/shell ships its result in the
  // rollout; Claude Bash results aren't recorded). Rendered as a second pane below the command in the
  // BashBlock. Absent for Claude Bash calls → the command shows alone (the prior behavior).
  output?: string
  // Set for a tool whose result carried an image (e.g. chrome-devtools `take_screenshot`): the absolute
  // path to the decoded screenshot, rendered inline via /local-image inside a ToolImageCard. Like the
  // read/command entries it stands alone — never folds into a ×N repeat count.
  outputImage?: string
  // Generic tool input/source plus terminal result metadata. These fields also retain failure context
  // for specialized cards such as Edit, which normally renders only its diff.
  input?: string
  status?: TranscriptToolCall["status"]
  backgroundState?: TranscriptToolCall["backgroundState"]
  exitCode?: number
  cwd?: string
  sessionId?: string | number
  durationMs?: number
  // Set for a Read call whose result shipped an excerpt: the (capped) file content, rendered as its
  // own collapsed card. Like edits/command, a read entry stands alone (never folds into a repeat
  // count). Absent pre-restart / for older transcripts → the Read renders as a header-only card.
  read?: string
  // Set for an Agent dispatch that shipped a prompt: the AgentBlock card (expands to the dispatch
  // prompt; live/finished state + drill-in in the header). Stands alone — never folds into a ×N count.
  prompt?: string
  subagentType?: string
  agentId?: string
  agentStatus?: "completed" | "failed" | "killed"
  agentElapsedMs?: number
  // Set for a SendMessage (peer/agent-to-agent) call: the SendMessageCard. Like the prompt/read/command
  // entries it stands alone — never folds into a ×N count.
  sendTo?: string
  sendSummary?: string
  sendBody?: string
  sendType?: string
  // Set for a SendUserFile (file delivery) call: the SentFilesCard renders the delivered files inline —
  // `sentImages` are servable cache paths shown as pictures, `sentFiles` non-image basenames as openable
  // chips, `caption` the label. Stands alone — never folds into a ×N count.
  sentImages?: string[]
  sentFiles?: string[]
  caption?: string
  count: number
}

// Fold runs of identical (name, detail) tool calls into one entry carrying a repeat count, so a
// burst of e.g. 5 identical Reads renders as one line with a ×5 suffix rather than five rows. Edit
// calls don't fold that way; instead, consecutive edits to the SAME file merge into one entry so a
// MultiEdit fan-out (or adjacent Edits to one file) renders as a single diff block, not a stack of
// near-touching ones. A different file breaks the run.
function collapseTools(tools: TranscriptMessage["tools"]): CollapsedTool[] {
  const out: CollapsedTool[] = []
  for (const t of tools) {
    const last = out[out.length - 1]
    if (t.edit) {
      const hasResultContext = Boolean(t.input || t.output || t.status || t.exitCode !== undefined)
      if (last && last.edits && !hasResultContext && !last.input && !last.output && !last.status && last.edits[0].file === t.edit.file) last.edits.push(t.edit)
      else out.push({ name: t.name, detail: t.detail, edits: [t.edit], input: t.input, output: t.output, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    } else if (t.command) {
      out.push({ name: t.name, detail: t.detail, command: t.command, desc: t.desc, input: t.input, output: t.output, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    } else if (t.read) {
      // A Read that shipped an excerpt renders as its own expandable card — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, read: t.read, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.prompt || t.agentId) {
      // An Agent dispatch renders as its own expandable card — never folds into a ×N run. Keyed on
      // EITHER signal, the same pair ToolCardRouter renders on: a Claude dispatch brings a prompt, a
      // codex one brings only the correlation id (its dispatch message is encrypted) and carries the
      // call's own `input` as the expandable body. Keying on the prompt alone dropped agentId here,
      // silently demoting every codex dispatch to a generic card even after the router accepted it.
      out.push({ name: t.name, detail: t.detail, prompt: t.prompt, input: t.input, subagentType: t.subagentType, agentId: t.agentId, agentStatus: t.agentStatus, agentElapsedMs: t.agentElapsedMs, output: t.output, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.sendTo !== undefined || t.sendBody !== undefined) {
      // A SendMessage (peer message) renders as its own SendMessageCard — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, sendTo: t.sendTo, sendSummary: t.sendSummary, sendBody: t.sendBody, sendType: t.sendType, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.outputImage) {
      // A screenshot / image tool result (chrome-devtools `take_screenshot`, an image Read) renders as its
      // own ToolImageCard showing the picture inline — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, outputImage: t.outputImage, output: t.output, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.sentImages || t.sentFiles) {
      // A SendUserFile delivery renders as its own SentFilesCard (images inline + caption) — never folds.
      out.push({ name: t.name, detail: t.detail, sentImages: t.sentImages, sentFiles: t.sentFiles, caption: t.caption, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.input || t.output) {
      out.push({ name: t.name, detail: t.detail, input: t.input, output: t.output, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    } else if (
      last &&
      !last.edits && !last.command && !last.input && !last.output && !last.read && !last.prompt &&
      !last.outputImage && !last.sentImages && !last.sentFiles &&
      last.sendTo === undefined && last.sendBody === undefined &&
      last.name === t.name && last.detail === t.detail &&
      last.status === t.status && last.backgroundState === t.backgroundState && last.exitCode === t.exitCode && last.cwd === t.cwd &&
      last.sessionId === t.sessionId && last.durationMs === t.durationMs
    ) {
      last.count++
    } else {
      out.push({ name: t.name, detail: t.detail, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    }
  }
  return out
}

// Tool calls render as a SUBORDINATE activity band — never as status. The green ● was retired
// because a filled dot reads as a pending/success indicator; the transcript carries no per-tool
// status, so we imply none. Each call is one quiet mono line: a per-tool lucide icon + the
// Claude-Code grammar `Name(target)`, dimmer and smaller than prose, all consecutive calls bundled
// under one hairline left rule so a burst reads as a single column of activity beside the response.

// Prettify the raw tool name: MCP tools arrive as `mcp__Server__do_thing` — show the last segment.
function prettyToolName(name: string): string {
  const seg = name.split("__").pop() || name
  return seg
}

// Shorten a target for the one-liner: absolute paths collapse to their last two segments (full path
// stays in the title tooltip); commands / patterns / queries pass through (already ≤80 chars from the
// server). Keeps the line scannable without dumping a 60-char absolute path inline.
// Repo-relative display: strip the project prefix (pure noise — every path shares it) but keep the
// REST intact; the line has the card's full width and CSS-ellipsizes only when genuinely too long.
function shortenTarget(detail: string): string {
  const root = store.board?.projectDir
  if (root && detail.startsWith(root + "/")) return detail.slice(root.length + 1)
  return detail
}

// A run of >4 tool lines collapses behind a single "N tool calls" chevron toggle so a long tail of
// activity doesn't dwarf the prose it belongs to.
const COLLAPSE_AT = 4

function ToolCalls({ tools, dense }: { tools: CollapsedTool[]; dense?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const cardsId = useId()
  const total = tools.reduce((n, t) => n + t.count, 0)
  // Dense surfaces (queue cards) condense ANY run of more than one call behind the summary toggle;
  // the full thread view keeps the higher threshold.
  const collapsible = tools.length > (dense ? 1 : COLLAPSE_AT)
  const showItems = !collapsible || expanded

  // Peer blocks in call order: a run of plain tool lines coalesces into ONE tight column (they're
  // sub-lines of a single activity band, not separate blocks), while each diff block stands alone.
  // Peers — the toggle, each line-run, each diff — are separated by explicit spacers (withSpacers).
  const blocks: ReactNode[] = []
  if (collapsible) {
    blocks.push(
      // Small-caps summary label (same treatment as the AGENTS section headings), chevron on the
      // RIGHT, flush-left with the tool lines it reveals.
      <button
        key="toggle"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={cardsId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${total} tool calls`}
        className={`${TRANSCRIPT_META_LABEL_CLASS} flex items-center gap-1 self-start rounded outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60`}
      >
        {/* Label stays "N tool calls" in BOTH states — the rotating chevron alone signals open/closed. */}
        <span className="tabular-nums">{total} tool calls</span>
        {/* No vertical nudge: the 12px icon's ink center already sits on the petite-caps optical center. */}
        <ChevronRight aria-hidden="true" size={12} className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>,
    )
  }
  if (showItems) {
    // EVERY tool call is a card now (the plain `Name(detail)` one-liner rendering was retired). ONE
    // accumulator, ZERO kind-dependent flushing: ADJACENT CARDS ARE ALWAYS 6px APART — Edit next to
    // Bash next to a header-only card all sit at the same tight rhythm — while the whole band sits a
    // full STEP (14px) from surrounding prose. No other spacing values exist inside a tool band.
    const cards = tools.map((t, i) => <ToolCardRouter key={i} t={t} />)
    blocks.push(
      <div key="cards" id={collapsible ? cardsId : undefined} className="flex flex-col">
        {withSpacers(cards, 6)}
      </div>,
    )
  }

  return (
    <div className="flex flex-col">
      {withSpacers(blocks)}
      {/* Keep aria-controls resolvable while the expensive card run is not mounted. */}
      {collapsible && !showItems && <div id={cardsId} hidden />}
    </div>
  )
}

// Route a collapsed tool entry to its card. Edit/Bash/Read/Agent get expandable bodies (chevron);
// everything else (Grep, Glob, Read-without-excerpt, MCP, Monitor, a pre-restart Bash with no command)
// is a header-only card. All share the same bordered card family so no call ever reads as bare text.
function ToolCardRouter({ t }: { t: CollapsedTool }) {
  const slug = useContext(ThreadSlugContext)
  const board = useBoard()
  const thread = slug ? threadBySlug(board, slug) : undefined
  const liveBackgroundState = liveBackgroundOperationState(t, thread?.bgShells ?? [])
  if (t.edits && t.status !== "failed" && t.status !== "cancelled") {
    return <DiffBlock edits={t.edits} meta={<ToolStatusMeta status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} durationMs={t.durationMs} />} />
  }
  if (t.command) {
    return <BashBlock command={t.command} desc={t.desc ?? t.detail} output={t.output} status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} cwd={t.cwd} sessionId={t.sessionId} durationMs={t.durationMs} />
  }
  if (t.read) return <ReadBlock detail={t.detail} read={t.read} status={t.status} durationMs={t.durationMs} />
  // A dispatch renders as an AgentBlock on EITHER signal: a prompt (Claude) or just the correlation id
  // (codex — it encrypts the dispatch message, so there is no prompt to show, but the child is still
  // tracked and drillable). Gating on the prompt alone left every codex sub-agent as a mute generic card.
  if (t.prompt || t.agentId) return <AgentBlock detail={t.detail} prompt={t.prompt} input={t.input} subagentType={t.subagentType} agentId={t.agentId} agentStatus={t.agentStatus} agentElapsedMs={t.agentElapsedMs} status={t.status} durationMs={t.durationMs} output={t.output} />
  if (t.sendTo !== undefined || t.sendBody !== undefined) return <SendMessageCard to={t.sendTo} summary={t.sendSummary} body={t.sendBody ?? ""} type={t.sendType} status={t.status} durationMs={t.durationMs} />
  if (t.outputImage) return <ToolImageCard name={t.name} detail={t.detail} outputImage={t.outputImage} output={t.output} status={t.status} durationMs={t.durationMs} />
  if (t.sentImages || t.sentFiles) return <SentFilesCard images={t.sentImages ?? []} files={t.sentFiles ?? []} caption={t.caption} status={t.status} durationMs={t.durationMs} />
  if (t.input || t.output) {
    return <BashBlock name={t.name} command={t.input ?? ""} desc={t.detail} output={t.output} status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} cwd={t.cwd} sessionId={t.sessionId} durationMs={t.durationMs} inputLabel="input" />
  }
  return <ToolCard name={t.name} detail={t.detail} count={t.count} status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} cwd={t.cwd} sessionId={t.sessionId} durationMs={t.durationMs} />
}

type ToolStatus = NonNullable<TranscriptToolCall["status"]>

export function ToolStatusMeta({ status, backgroundState, liveBackgroundState, exitCode, durationMs, indicator = "shell" }: { status?: ToolStatus; backgroundState?: TranscriptToolCall["backgroundState"]; liveBackgroundState?: "running" | "stale"; exitCode?: number; durationMs?: number; indicator?: "shell" | "agent" }) {
  if (!status && durationMs === undefined) return null
  const label =
    liveBackgroundState === "running"
      ? "background running"
      : liveBackgroundState === "stale"
        ? "background stale"
        : status === "pending"
      ? backgroundState === "unknown"
        ? "background / unknown"
        : "running"
      : status === "failed"
        ? exitCode !== undefined
          ? `exit ${exitCode}`
          : "failed"
        : status === "cancelled"
          ? "cancelled"
          : status === "completed"
            ? "done"
            : undefined
  const duration = durationMs !== undefined ? formatToolDuration(durationMs) : undefined
  const title = [label, duration].filter(Boolean).join(" · ")
  const tone = status === "failed" ? "fray-tool-failed" : status === "cancelled" ? "text-amber-400" : "text-muted/55"
  return (
    <span className={`petite-caps fray-tool-header-caps flex shrink-0 items-center gap-1 text-[11.5px] leading-none ${tone}`} title={title} aria-label={title}>
      {(liveBackgroundState === "running" || hasRunningToolIndicator(status, backgroundState)) && <span aria-hidden className={`fray-live-dot fray-live-dot--${indicator}`} data-running-indicator="tool-disclosure" />}
      <span>{[label, duration].filter(Boolean).join(" · ")}</span>
    </span>
  )
}

function contextualDetail(detail?: string, cwd?: string, sessionId?: string | number): string | undefined {
  const context = cwd ? `in ${shortenTarget(cwd)}` : sessionId !== undefined && !detail?.includes(String(sessionId)) ? `session ${sessionId}` : undefined
  return [detail, context].filter(Boolean).join(" · ") || undefined
}

// A tool detail reads as a file path we can open in the editor when it's a single absolute-path
// token (starts with "/", no spaces, and not the server's 80-char "…" truncation). Commands like
// "git status" and truncated details stay plain text.
function isFilePath(detail: string): boolean {
  return detail.startsWith("/") && !detail.includes(" ") && !detail.includes("…")
}

// A header-only tool card: the IDENTICAL bordered card chrome as Bash/Read/Edit/Agent (same .fray-bash
// container + .fray-bash-header — border, bg, radius, padding, the label↔detail gap, 12.5px mono) but
// with NO expandable body, so it drops only the chevron. This is the fallback for every call without a
// payload — Grep, Glob, a pre-restart command-less Bash / excerpt-less Read, MCP tools, Monitor — the
// COMMON case pre-restart, so it must be indistinguishable from a real card header. petite-caps label
// left, repo-relative detail middle (an editor deep-link for a plain absolute path), ×N fold right. No
// call ever reads as bare `Name(detail)` text again.
function ToolCard({ name, detail, count, status, backgroundState, liveBackgroundState, exitCode, cwd, sessionId, durationMs }: { name: string; detail?: string; count: number; status?: ToolStatus; backgroundState?: TranscriptToolCall["backgroundState"]; liveBackgroundState?: "running" | "stale"; exitCode?: number; cwd?: string; sessionId?: string | number; durationMs?: number }) {
  const shownDetail = contextualDetail(detail, cwd, sessionId)
  const short = shownDetail ? shortenTarget(shownDetail) : undefined
  const linkPath = detail && isFilePath(detail) ? detail : undefined
  return (
    <div className="fray-bash" title={shownDetail}>
      <div className="fray-bash-header">
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">{prettyToolName(name)}</span>
          {short &&
            (linkPath ? (
              // The path link swallows its own click so opening the file doesn't select the card.
              <span className="min-w-0 truncate" onClick={(e) => e.stopPropagation()}>
                <PathLink path={linkPath} className="text-[11.5px] text-muted">
                  {short}
                </PathLink>
              </span>
            ) : (
              <span className="min-w-0 truncate text-[11.5px] text-muted">{short}</span>
            ))}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} backgroundState={backgroundState} liveBackgroundState={liveBackgroundState} exitCode={exitCode} durationMs={durationMs} />
          {count > 1 && <span className="tabular-nums text-[11px] text-muted/45">×{count}</span>}
        </span>
      </div>
    </div>
  )
}

// A tool whose result carried an image (chrome-devtools `take_screenshot`, an image Read) rendered as
// its own card in the Bash/Read family — but OPEN by default, because seeing the screenshot IS the point.
// The header is the petite-caps tool name + detail + status; the body renders the decoded picture inline
// via BlockImage (the same gated /local-image treatment as an agent-authored screenshot path in prose),
// plus any accompanying text result below it. Clicking the header collapses/expands the picture.
function ToolImageCard({ name, detail, outputImage, output, status, durationMs }: { name: string; detail?: string; outputImage: string; output?: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  const short = detail ? shortenTarget(detail) : undefined
  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={bodyId}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${prettyToolName(name)} screenshot${short ? `: ${short}` : ""}`}
        className="fray-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">{prettyToolName(name)}</span>
          {short && <span className="min-w-0 truncate text-[11.5px] text-muted" title={detail}>{short}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} durationMs={durationMs} />
          <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      <div id={bodyId} hidden={!open}>
        {open && (
          <div className="px-2.5 pb-2.5 pt-1.5">
            <BlockImage path={outputImage} />
            {output && <pre className="fray-bash-body fray-bash-output-body mt-1.5">{output}</pre>}
          </div>
        )}
      </div>
    </div>
  )
}

// A SendUserFile delivery — the worker surfacing files to the human. Same card family (`fray-bash`) and
// header as ToolImageCard so it reads as one of the tool cards, but OPEN by default: seeing the delivered
// images IS the point. Body: images inline (stacked, via the gated /local-image route), non-image files as
// openable chips (BlockFile → the gated opener), and the `caption` below in muted prose (capped ~65% wide
// so long captions stay readable against the wide card, not one edge-to-edge line).
function SentFilesCard({ images, files, caption, status, durationMs }: { images: string[]; files: string[]; caption?: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  const summary = [
    images.length ? `${images.length} image${images.length === 1 ? "" : "s"}` : "",
    files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ")
  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={bodyId}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} files sent to you${summary ? `: ${summary}` : ""}`}
        className="fray-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">Sent to you</span>
          {summary && <span className="min-w-0 truncate text-[11.5px] text-muted">{summary}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} durationMs={durationMs} />
          <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      <div id={bodyId} hidden={!open}>
        {open && (
          <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 pt-1.5">
            {images.map((path, i) => <BlockImage key={`i${i}`} path={path} hideCaption altText={caption ?? "delivered image"} />)}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {files.map((f, i) => <BlockFile key={`f${i}`} path={f} />)}
              </div>
            )}
            {caption && <div className="max-w-[65%] text-[12px] leading-snug text-muted">{caption}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

// A multi-line / long Bash command rendered as its own block, COLLAPSED by default: the header is
// the model-authored `description` of the command (falling back to its first line), and clicking
// the header reveals the raw command in mono — pre-wrapped so long lines wrap (wide unbreakable
// content scrolls INSIDE the block, never the page). Past ~16 lines the open body clamps too.
const BASH_MAX_LINES = 16
function BashBlock({
  command,
  desc,
  output,
  name = "Bash",
  status,
  backgroundState,
  liveBackgroundState,
  exitCode,
  cwd,
  sessionId,
  durationMs,
  inputLabel,
}: {
  command: string
  desc?: string
  output?: string
  name?: string
  status?: ToolStatus
  backgroundState?: TranscriptToolCall["backgroundState"]
  liveBackgroundState?: "running" | "stale"
  exitCode?: number
  cwd?: string
  sessionId?: string | number
  durationMs?: number
  inputLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [outExpanded, setOutExpanded] = useState(false)
  const bodyId = useId()
  const lineCount = useMemo(() => command.split("\n").length, [command])
  const long = lineCount > BASH_MAX_LINES
  // Codex ships the command's stdout/stderr in the same rollout (Claude doesn't), so a codex Bash card
  // carries an `output` pane below the command — clamped + independently expandable like the command.
  const outLineCount = useMemo(() => (output ? output.split("\n").length : 0), [output])
  const outLong = outLineCount > BASH_MAX_LINES
  const shownDesc = contextualDetail(desc, cwd, sessionId)
  const expandable = Boolean(command || output)
  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={expandable ? bodyId : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${expandable ? `${open ? "Collapse" : "Expand"} ` : ""}${prettyToolName(name)}${shownDesc ? `: ${shownDesc}` : ""}`}
        className="fray-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">{prettyToolName(name)}</span>
          <span className="min-w-0 truncate text-[11.5px] text-muted" title={shownDesc}>{shownDesc ?? ""}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} backgroundState={backgroundState} liveBackgroundState={liveBackgroundState} exitCode={exitCode} durationMs={durationMs} />
          {expandable && <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
        </span>
      </button>
      {expandable && (
        <div id={bodyId} hidden={!open}>
          {open && command && (
            <>
              {inputLabel && <div className="fray-bash-output-label petite-caps">{inputLabel}</div>}
              <pre className={`fray-bash-body${inputLabel ? " fray-bash-output-body" : ""}${long && !expanded ? " fray-bash-clamp" : ""}`}>{command}</pre>
              {long && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="fray-bash-expand petite-caps px-2.5 pb-1.5"
                >
                  {expanded ? "Collapse" : `Show all ${lineCount} lines`}
                </button>
              )}
            </>
          )}
          {open && output && (
            <>
              <div className="fray-bash-output-label petite-caps">output</div>
              <pre className={`fray-bash-body fray-bash-output-body${outLong && !outExpanded ? " fray-bash-clamp" : ""}`}>{output}</pre>
              {outLong && (
                <button
                  type="button"
                  onClick={() => setOutExpanded((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="fray-bash-expand petite-caps px-2.5 pb-1.5"
                >
                  {outExpanded ? "Collapse" : `Show all ${outLineCount} lines`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// A Read call rendered as a sibling of BashBlock/DiffBlock: a bordered card, COLLAPSED by default,
// whose header is the petite-caps "Read" label + the repo-relative path (an editor deep-link when the
// detail is a plain absolute path). Expanding reveals WHAT was read — the (server-capped) file excerpt
// in mono, with the same clamp + "Show all N lines" affordance as a long Bash body. Reuses the
// fray-bash card classes so Bash / Edit / Read read as one system.
const READ_MAX_LINES = 16
function ReadBlock({ detail, read, status, durationMs }: { detail?: string; read: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const lineCount = useMemo(() => read.split("\n").length, [read])
  const long = lineCount > READ_MAX_LINES
  const short = detail ? shortenTarget(detail) : undefined
  const linkPath = detail && isFilePath(detail) ? detail : undefined
  return (
    <div className="fray-bash">
      <ToolDisclosureHeader
        className="fray-bash-header"
        controls={bodyId}
        expanded={open}
        label={`${open ? "Collapse" : "Expand"} Read${detail ? `: ${detail}` : ""}`}
        onToggle={() => setOpen((v) => !v)}
        meta={<ToolStatusMeta status={status} durationMs={durationMs} />}
      >
        <span className="petite-caps fray-bash-label shrink-0">Read</span>
        {short &&
          (linkPath ? (
            <span className="min-w-0 truncate">
              <PathLink path={linkPath} className="text-[11.5px] text-muted">
                {short}
              </PathLink>
            </span>
          ) : (
            <span className="min-w-0 truncate text-[11.5px] text-muted">{short}</span>
          ))}
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            <pre className={`fray-bash-body${long && !expanded ? " fray-bash-clamp" : ""}`}>{read}</pre>
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                onMouseDown={(e) => e.preventDefault()}
                className="fray-bash-expand petite-caps px-2.5 pb-1.5"
              >
                {expanded ? "Collapse" : `Show all ${lineCount} lines`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// An Agent dispatch rendered as a sibling of BashBlock/ReadBlock: a bordered card COLLAPSED by default,
// header = petite-caps "Agent" + the dispatch description + a dim "[subagent_type]" tag; the chevron
// expands the dispatch PROMPT. TWO affordances, kept distinct: the chevron toggles the prompt body,
// while the DESCRIPTION itself is an underlined link (PathLink treatment) that drills INTO that
// sub-agent's own transcript in a new drawer — for LIVE and COMPLETED children alike (the drawer
// resolves both; an aged-out one degrades to "unavailable"). The header also carries the child's state
// — "running Nm" (+ a spinner) while live, or "finished 35m" / "failed 12m" once completed.
// Exported for operation-indicators-fixture.tsx: the agent row is the one card family with TWO
// independent status sources (its own stateLabel + the shared meta slot), so it needs live fixture
// coverage — the double-indicator bug shipped precisely because the fixture skipped it.
const AGENT_MAX_LINES = 16
export function AgentBlock({
  detail,
  prompt,
  input,
  subagentType,
  agentId,
  agentStatus,
  agentElapsedMs,
  status,
  durationMs,
  output,
}: {
  detail?: string
  // The dispatch prompt — absent for a CODEX dispatch, whose message the provider encrypts. The card
  // then falls back to the call's own input (fork/agent-type details); the header, the live state, and
  // the drill-in all work identically either way.
  prompt?: string
  input?: string
  subagentType?: string
  agentId?: string
  agentStatus?: "completed" | "failed" | "killed"
  agentElapsedMs?: number
  status?: ToolStatus
  durationMs?: number
  output?: string
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const body = prompt ?? input
  const lineCount = useMemo(() => (body ? body.split("\n").length : 0), [body])
  const long = lineCount > AGENT_MAX_LINES
  // Thread surface OR sub-agent drawer (a nested dispatch inside a child's own transcript still drills
  // in — the router maps an id it can no longer resolve to "gone", which the drawer states plainly).
  const slug = useChildDrillSlug()
  const board = useBoard()
  const thread = slug ? threadBySlug(board, slug) : undefined
  // The live tracked sub-agent for this dispatch (matched by tool_use id) — drives the "running Nm"
  // header + spinner. Only present before the transcript records a completion (a finished child has
  // left the live set). The DRAWER, though, resolves live AND completed children, so the title links
  // regardless — it just needs the correlation id + a slug to resolve against.
  const live = !agentStatus && agentId ? (thread?.subAgents ?? []).find((s) => s.id === agentId) : undefined
  const running = !!live && live.state !== "stale"
  const canDrill = !!(slug && agentId)
  const title = detail ?? "sub-agent"

  let stateLabel: string | null = null
  if (agentStatus) {
    const verb = agentStatus === "completed" ? "finished" : agentStatus
    const dur = agentElapsedMs !== undefined ? fmtDurationMs(agentElapsedMs) : ""
    stateLabel = `${verb}${dur ? ` ${dur}` : ""}`
  } else if (live) {
    const e = elapsedSince(live.startedAt)
    stateLabel = live.state === "stale" ? "stale" : `running${e ? ` ${e}` : ""}`
  }

  // ONE running indicator per row (maintainer 2026-07-18). Whenever a live/completed child resolves,
  // stateLabel above already IS this row's status and carries its own dot — and "running 3 min" is
  // strictly richer than ToolStatusMeta's generic "running", so the meta badge would be a second,
  // duller copy of the same fact. The meta slot stays the ONLY status surface for the remaining case:
  // a dispatch with no child record at all, where a terminal status/duration must still render.
  const showStatusMeta = !live && !agentStatus

  function openDrawer() {
    if (!slug || !agentId) return
    pushSubAgentDrawer(slug, agentId, { label: title, subagentType, startedAt: live?.startedAt })
  }

  return (
    <div className="fray-bash">
      <ToolDisclosureHeader
        className="fray-bash-header"
        controls={bodyId}
        expanded={open}
        label={`${open ? "Collapse" : "Expand"} Agent dispatch: ${title}`}
        onToggle={() => setOpen((v) => !v)}
        meta={showStatusMeta && <ToolStatusMeta status={status} durationMs={durationMs} indicator="agent" />}
      >
        <span className="petite-caps fray-bash-label shrink-0">Agent</span>
        {canDrill ? (
          <button
            type="button"
            aria-label={`Open sub-agent transcript: ${title}`}
            title="Open sub-agent transcript"
            onClick={openDrawer}
            className="min-w-[4rem] flex-1 truncate text-left text-[11.5px] text-muted outline-none hover:underline hover:text-fg/80 focus-visible:underline focus-visible:text-fg/80"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-[4rem] flex-1 truncate text-[11.5px] text-muted">{title}</span>
        )}
        {subagentType && <span className="min-w-0 max-w-[9rem] truncate font-mono-keep text-[11px] text-muted/45">[{subagentType}]</span>}
        {stateLabel && <span className="shrink-0 text-[11px] text-muted/55 whitespace-nowrap">{stateLabel}</span>}
        {running && <span aria-hidden className="fray-live-dot fray-live-dot--agent" data-running-indicator="subagent-disclosure" />}
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            {body && <pre className={`fray-bash-body${long && !expanded ? " fray-bash-clamp" : ""}`}>{body}</pre>}
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                onMouseDown={(e) => e.preventDefault()}
                className="fray-bash-expand petite-caps px-2.5 pb-1.5"
              >
                {expanded ? "Collapse" : `Show all ${lineCount} lines`}
              </button>
            )}
            {output && (
              <>
                <div className="fray-bash-output-label petite-caps">output</div>
                <pre className="fray-bash-body fray-bash-output-body">{output}</pre>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// A SendMessage (peer / agent-to-agent messaging) rendered as a sibling of AgentBlock/BashBlock: the
// SAME quiet bordered card family, but purpose-built to read as "this agent sent a message to that
// agent" rather than a generic SendMessage(...) tool line. The header leads with the petite-caps kind
// label ("Sent", or "Shutdown" for a shutdown_request) then the RECIPIENT prominently as "→ <name>"
// (near-fg, so it's the salient token), then the model's one-line `summary` (muted, truncated). The
// chevron expands the MESSAGE BODY, rendered as markdown in a quiet indented block (long bodies clamp
// with a "Show all N lines" affordance, exactly like the Bash/Read/Agent bodies). Default state mirrors
// AgentBlock: COLLAPSED when a summary already conveys the gist, OPEN when there's no summary so a
// bodied message isn't hidden behind a chevron showing nothing but the recipient.
const SEND_MAX_LINES = 16
function SendMessageCard({ to, summary, body, type, status, durationMs }: { to?: string; summary?: string; body: string; type?: string; status?: ToolStatus; durationMs?: number }) {
  const isShutdown = type === "shutdown_request"
  const [open, setOpen] = useState(!summary)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const html = useMemo(() => mdToHtml(body), [body])
  const lineCount = useMemo(() => body.split("\n").length, [body])
  const long = lineCount > SEND_MAX_LINES
  const hasBody = !!body.trim()
  const label = isShutdown ? "Shutdown" : "Sent"
  return (
    <div className="fray-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={hasBody ? bodyId : undefined}
        aria-expanded={hasBody ? open : undefined}
        aria-label={`${hasBody ? `${open ? "Collapse" : "Expand"} ` : ""}${label}${to ? ` to ${to}` : ""}`}
        className="fray-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
        disabled={!hasBody}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">{label}</span>
          {to && <span className="shrink-0 whitespace-nowrap text-[11.5px] text-fg/75">→ {to}</span>}
          {summary && <span className="min-w-0 truncate text-[11.5px] text-muted">{summary}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} durationMs={durationMs} />
          {hasBody && <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
        </span>
      </button>
      {hasBody && (
        <div id={bodyId} hidden={!open}>
          {open && (
            <>
              {/* Quiet indented body: the border-top + 10px/8px padding mirror .fray-bash-body, but the
                  content is MARKDOWN (md-body — sans, 14px) so a peer message reads like prose, not a code
                  dump. The clamp caps a long body at ~320px until "Show all" expands it. */}
              <div className={`border-t border-border px-2.5 py-2${long && !expanded ? " fray-bash-clamp" : ""}`}>
                <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
              {long && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="fray-bash-expand petite-caps px-2.5 pb-1.5"
                >
                  {expanded ? "Collapse" : `Show all ${lineCount} lines`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// The most-recent user message, PINNED to the top of the scroll pane — a persistent reminder of the
// human's latest ask while the agent's (often long) reply scrolls beneath it. Both surfaces render
// the SAME user bubble (Message, role="user") inside this so they match by construction.
//   • The wrapper is TRANSPARENT — the bubble simply FLOATS at the top. Everything else in the scroll
//     pane (agent prose, tool cards) passes BEHIND it and stays visible to the LEFT of the bubble and
//     ABOVE it (in the `pt-3` gap). Only `z-[9]` keeps it above the scrolling content, never masking it.
//   • `pt-3` keeps the rounded bubble off the pane's top edge (flush rounded corners read as broken)
//     and leaves a gap the transcript scrolls through above the floating bubble.
//   • `max-h` + `overflow-y-auto`: a user message taller than the pane scrolls WITHIN the bubble instead
//     of swallowing the whole viewport.
//   • `flex flex-col` re-establishes the column so Message's `self-end` bubble stays right-aligned; the
//     full-width transparent wrapper leaves the left region clear for content to show through.
//   • `pointer-events-none` on the wrapper + `pointer-events-auto` on the bubble: the transparent
//     full-width strip must NOT eat clicks/wheel over the content it floats above (to its left), while
//     the bubble stays selectable and a tall bubble scrolls internally.
// `stickyTopPx` offsets the stick point below the queue card's OWN sticky header (measured, since the
// header height is dynamic); the drawer omits it and sticks flush at the scroll container's top.
// `sourceId` mirrors data-transcript-source-id onto THIS node (the queue card keys its pagination
// anchors off it) while data-transcript-sticky tells captureTranscriptViewportAnchor to skip it — a
// pinned band has an invariant top and must never be chosen as the load-earlier scroll anchor.
// The positioning wrapper only: sticks the floating bubble to the pane top. The HEIGHT/collapse (the
// ~200px cap, the bottom text-fade, and hover-to-expand) live on the bubble itself (UserBubble, driven
// by the `sticky` prop on Message) so the collapsed card stays fully rounded — a wrapper clip can't.
export function StickyUserBand({ children, stickyTopPx, sourceId }: { children: ReactNode; stickyTopPx?: number; sourceId?: string }) {
  const offset = stickyTopPx !== undefined
  return (
    <div
      data-transcript-source-id={sourceId}
      data-transcript-sticky="true"
      style={offset ? ({ "--sticky-user-top": `${stickyTopPx}px` } as CSSProperties) : undefined}
      className={`pointer-events-none [&>*]:pointer-events-auto sticky z-[9] flex flex-col pt-3 pb-1.5 ${
        offset
          ? "top-[var(--sticky-user-top)] max-[800px]:top-[calc(var(--sticky-user-top)_+_2.5rem)]"
          : "top-0"
      }`}
    >
      {children}
    </div>
  )
}

// The user chat bubble, right-justified. When `sticky` (the pinned most-recent ask), it COLLAPSES: a
// fully-rounded ~200px card whose text FADES into the bubble colour near the bottom (no hard clip, no
// ellipsis) with a soft "there's more" cue; hovering expands it to the full message (up to 85vh, then
// it scrolls) and leaving re-collapses. Non-sticky (every historical bubble) is the plain, uncapped
// bubble, unchanged. Its own component so the sticky hover/measure hooks stay out of memoized Message.
function UserBubble({ text, queued, sticky, deliveryUnconfirmed, sourceId }: { text: string; queued?: boolean; sticky?: boolean; deliveryUnconfirmed?: boolean; sourceId?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  // Whether the FULL message is taller than the expanded cap (85vh) — the ONLY case that genuinely
  // needs a scrollbar. Everything shorter expands to fit, so it stays `overflow-hidden` even when
  // expanded: no scrollbar ever appears (not even transiently mid-animation), so no reflow. (A real
  // scrollbar, in the exceeds-cap case, rides a reserved gutter — see scrollbar-gutter in styles.css.)
  const [exceedsCap, setExceedsCap] = useState(false)
  // Scrolling is enabled only AFTER the expand animation finishes. During the grow, the bubble stays
  // `overflow-hidden` — otherwise it's a live scroll container whose content scrolls as it resizes
  // (the reported "card contents scroll during expansion" bug). transitionend flips this on.
  const [scrollReady, setScrollReady] = useState(false)
  // Measure the real content height so max-height animates BOTH ways smoothly (a bare 200px↔85vh
  // transition visibly lags on collapse) and so the fade shows ONLY when the text actually overflows.
  const [maxH, setMaxH] = useState<string | null>(null)
  const measure = useCallback(() => {
    const el = ref.current
    if (!sticky || !el) { setMaxH(null); setOverflows(false); setExceedsCap(false); return }
    const cap = Math.round((typeof window === "undefined" ? 800 : window.innerHeight) * 0.85)
    setOverflows(el.scrollHeight > 205)
    setExceedsCap(el.scrollHeight > cap)
    setMaxH(expanded ? `${Math.min(el.scrollHeight, cap)}px` : "200px")
  }, [sticky, expanded])
  useLayoutEffect(() => { measure() }, [measure, text])
  // Re-measure on viewport resize so the 85vh cap / exceedsCap gate never go stale under a window resize.
  useEffect(() => {
    if (typeof window === "undefined") return
    const onResize = () => measure()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [measure])
  const collapsed = sticky === true && !expanded
  // Scroll ONLY when expanded, over the cap, AND the expand animation has settled.
  const scrollable = sticky === true && expanded && exceedsCap && scrollReady
  return (
    // `self-end` must stay on THIS node: the parent scroll container is a flex column and the bubble's
    // right-justification depends on being its direct child (see the group-container note above the
    // queued-message stack). So the debug chip is hosted here rather than in a wrapper.
    <div data-fray-msg={sourceId} className="group/msg relative self-end flex flex-col items-end gap-0.5 max-w-[85%]">
      {/* Left gutter: a right-aligned bubble leaves empty space to its left, so the chip sits there
          instead of over the human's own words. */}
      <MessageDebugId sourceId={sourceId} side="left" />
      {/* OFF-WHITE bubble, BLACK text — the human's words POP against the dark page + agent prose. bg-user-bubble
          is a tick less white than bg-fg so it reads as a card. whitespace-pre-wrap is load-bearing: user text
          is verbatim, so its line breaks must survive. */}
      <div
        ref={ref}
        onMouseEnter={sticky ? () => setExpanded(true) : undefined}
        onMouseLeave={sticky ? () => { setExpanded(false); setScrollReady(false) } : undefined}
        onTransitionEnd={sticky ? (e) => { if (e.propertyName === "max-height" && expanded && exceedsCap) setScrollReady(true) } : undefined}
        // While NOT scrollable (collapsed, or expanding before it settles) the bubble is `overflow-hidden`
        // and so lacks the scrollbar-gutter the scrollable state reserves — a 7px text shift when scroll
        // turns on. Reserve the SAME width (`--sbw`, the app's scrollbar width) here so the text width is
        // identical across every state: zero reflow even for over-cap messages.
        style={{
          ...(maxH ? { maxHeight: maxH } : {}),
          ...(sticky && exceedsCap && !scrollable ? { paddingRight: "calc(0.875rem + var(--sbw))" } : {}),
        }}
        className={`relative rounded-2xl rounded-br-sm bg-user-bubble px-3.5 py-2 text-[14px] whitespace-pre-wrap [overflow-wrap:anywhere] text-bg ${queued ? "opacity-50" : ""} ${sticky ? `transition-[max-height] duration-200 ease-out ${scrollable ? "overflow-y-auto" : "overflow-hidden"}` : ""}`}
      >
        {text}
        {/* Fade the last ~2.5rem of text into the bubble colour — keeps the box fully rounded + opaque
            (no hard cut, no ellipsis). Only while collapsed AND actually overflowing. */}
        {collapsed && overflows && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-user-bubble to-transparent" />
        )}
      </div>
      {/* Delivery-ledger verdict: no JSONL evidence within the confirmation window — the injection
          likely mutated or never reached the agent. Quiet one-liner (not a modal): the terminal pane
          is the recovery surface, and the bubble stays gray so the send is still legible above it. */}
      {deliveryUnconfirmed && (
        <div className="text-[11px] text-amber-400/80">Delivery unconfirmed — check the terminal</div>
      )}
    </div>
  )
}

// Exported so the Queue card reuses the exact same message rendering (user bubble right, agent prose
// left, compact tool lines) — no duplicate renderer. `answering` (Queue-only, for the live message)
// makes each ```question block answerable in place; without it the blocks render read-only.
//
// MEMOIZED (the render-perf thread's chip-click fix): a queue card re-renders on EVERY chip click /
// composer keystroke (answer + draft state live at card level) and on every board delta (TodosView's
// snapshot scope), and each such render used to re-run every visible Message's whole subtree —
// markdown/diff/tool cards included. Props are memo-friendly by construction: `m` keeps identity for
// unchanged messages (TanStack Query's structural sharing on both the poll and socket write paths),
// `answering` is undefined for all but the live message (and identity-stable via useLiveAnswering's
// useMemo unless answers/blocks actually changed), `dense` is a constant. So only the message whose
// inputs really changed re-renders; everything else bails out at the memo boundary.
// `paired` is the precomputed question↔answer pairing for a composed-answer user message (see
// pairAllAnswers — computed at the LIST level because the lookback needs the whole message list, which
// a per-message component deliberately doesn't get). Memo-friendly by construction: it's null (a stable
// primitive) for every ordinary message, so only actual answers-messages ever see a prop change.
// undefined (a consumer that doesn't precompute, e.g. the sub-agent sheet) → internal unpaired fallback.
// Lifecycle controls never belong to a transcript message: every Done card stays presentation-only,
// while the owning thread surface renders one stable footer.
export const Message = memo(function Message({ m, answering, dense, paired, sticky, textOnly, showSendButton }: { m: ChatMessage; answering?: MessageAnswering; dense?: boolean; paired?: PairedAnswer[] | null; sticky?: boolean; textOnly?: boolean; showSendButton?: boolean }) {
  // An event line (a sub-agent completion) is transcript PUNCTUATION — a quiet full-width line, not a
  // bubble or a tool band. Rendered before the role branches (its role field is nominal).
  if (m.kind === "event") return <EventLine text={m.text} boundary={m.boundary} sourceId={m.sourceId} />
  // A model-reasoning summary (Codex) — quiet punctuation like an event line, but CLICKABLE to expand
  // the full reasoning. Rendered before the role branches (its role field is nominal, like an event).
  if (m.kind === "reasoning") return <ReasoningBlock text={m.text} durationMs={m.durationMs} sourceId={m.sourceId} />
  // A SUB-AGENT COMPLETION — the same class of event as the background-shell wake above, so it takes
  // the same divider (see AgentCompletionLine). Routed here, before the tool-band walk, so the marker
  // copy never renders as a second AgentBlock card. Ahead of `textOnly` for the same reason the event
  // line is: a queue card that hides tool bands still shows what came back underneath it.
  const completion = agentCompletionCall(m)
  if (completion) return <AgentCompletionLine call={completion} sourceId={m.sourceId} />
  // User messages: right-justified chat bubble; agent output stays left-aligned prose. A follow-up
  // that's been sent but not yet echoed by the transcript shows as a grayed-out bubble — the dimming
  // alone signals queued (a "queued" tag under the bubble caused layout shift when it cleared).
  if (m.role === "user") {
    // CR/CRLF → LF: a terminal-injected follow-up round-trips carriage-return-separated, and the pre-wrap
    // bubble honors \n but not a lone \r → the breaks collapse into a run-on. Normalize for BOTH render
    // paths (the server does this too, but this is the definitive per-surface guarantee for user text).
    const text = messagePresentationText(m).replace(/\r\n?/g, "\n")
    // OUR OWN composed multi-block answer — either wire form ("Answers:\n1. …\n2. …" for the live ask,
    // "Answers to earlier questions:\n1. “Q” → A" for a buried one, both from useLiveAnswering.sendAnswers)
    // renders as a structured answers card echoing the question component — not a flat run-on bubble.
    // Non-matching text (and a parse hiccup → null) falls back to the plain bubble; text is never lost.
    const answers = paired !== undefined ? paired : parseAnswersCard(text)
    if (answers) return <AnswersCard answers={answers} queued={m.queued} sourceId={m.sourceId} />
    return <UserBubble text={text} queued={m.queued} sticky={sticky} deliveryUnconfirmed={m.deliveryState === "unconfirmed"} sourceId={m.sourceId} />
  }

  // Build ONE ordered list of block-level children, then interleave with explicit spacers. The
  // FIDELITY invariant: visual order == turn order. We render `m.parts` in block order — a "Let me
  // draft the notes:" text lead-in sits directly above the tool band it introduces, never hoisted
  // above earlier prose. A question-block index (`qi`) threads across all text parts so the answering
  // controller (which numbers ```question blocks over the flat text, same order) lines up.
  const blocks: ReactNode[] = []
  const qi = { n: -1 }
  const renderText = (text: string, keyBase: string) => {
    // Split SIGNAL fences (```done / ```awaiting) out first — each renders as a card in place of the
    // raw block — then run the remaining prose runs through the question/image pipeline. Fences never
    // contain a ```question block, so the question-block index (qi) still lines up with the answering
    // controller (which numbers ```question blocks over the flat text in the same order).
    for (const [fi, fseg] of splitFenceBlocks(text).entries()) {
      if (fseg.kind === "fence") {
        blocks.push(
          <FenceCard
            key={`${keyBase}-f${fi}`}
            fenceKind={fseg.fenceKind}
            body={fseg.body}
            hints={fseg.hints}
            wrap={dense}
          />,
        )
        continue
      }
      for (const [si, seg] of splitQuestionBlocks(fseg.text).entries()) {
        if (seg.kind === "prose") {
          for (const [j, p] of splitProseAttachments(seg.text).entries()) {
            const partKey = `${keyBase}-${fi}-p${si}-${j}`
            blocks.push(
              p.kind === "image" ? <BlockImage key={partKey} path={p.path} />
              : p.kind === "file" ? <BlockFile key={partKey} path={p.path} />
              : p.kind === "visualization" ? <InlineVisualization key={partKey} file={p.file} />
              : p.kind === "directive" ? <CodexDirectiveCard key={partKey} directive={p.directive} />
              : p.kind === "mermaid" ? <MermaidDiagram key={partKey} source={p.source} />
              : <ProseHtml key={partKey} md={p.text} wrap={dense} />,
            )
          }
          continue
        }
        qi.n += 1
        const bi = qi.n
        const interactive = answering
          ? {
              answer: answering.answerFor(bi),
              onChip: (optIdx: number, optText: string) => answering.onChip(bi, optIdx, optText),
              onText: (text: string) => answering.onText(bi, text),
              onSubmit: answering.onSubmit,
            }
          : undefined
        blocks.push(<QuestionBlockCard key={`${keyBase}-${fi}-q${si}`} raw={seg.text} questionKind={seg.questionKind} danger={seg.danger} interactive={interactive} wrap={dense} />)
      }
    }
  }

  if (m.parts && m.parts.length > 0) {
    // Ordered walk (the fix): each part renders where it belongs. A tools part → a card band over its
    // CONTIGUOUS run (collapseTools folds ×N + merges same-file edits within the run); a text part →
    // its prose + question cards.
    m.parts.forEach((part, pi) => {
      if (part.kind === "tools") {
        // textOnly (the queue card's first/last agent message): the batched tool band is dropped so only
        // the agent's prose remains — its calls live inside the collapsed intermediate bar instead.
        if (textOnly) return
        const collapsed = collapseTools(part.tools)
        if (collapsed.length) blocks.push(<ToolCalls key={`t${pi}`} tools={collapsed} dense={dense} />)
      } else {
        renderText(part.text, `x${pi}`)
      }
    })
  } else {
    // LEGACY fallback (a pre-restart server ships no `parts`): the old flat layout — tool band first,
    // then all prose. Degrades to today's (order-lossy) rendering until the server bounce.
    if (!textOnly) {
      const collapsed = collapseTools(m.tools)
      if (collapsed.length > 0) blocks.push(<ToolCalls key="tools" tools={collapsed} dense={dense} />)
    }
    renderText(m.text, "leg")
  }

  // An assistant turn that produced no renderable block (empty/whitespace-only) contributes NOTHING —
  // a bare <div> would still take a slot in the parent's gap stack and double the surrounding gap.
  if (blocks.length === 0) return null
  // The per-message Send button sits at the bottom of THIS message, scoped to just its own question
  // block(s) (answering.onSubmit → sendAnswers(thisMessageIdentity)). `answering` is present only for a
  // message that still carries an open ask, so the button only appears where there's something to send;
  // the queue card leaves showSendButton unset (it owns a single card-level Send instead).
  if (showSendButton && answering) {
    blocks.push(
      <div key="send-answers" className="flex justify-end">
        <button
          type="button"
          data-send-answers
          disabled={!answering.anyAnswered || answering.sending}
          onClick={answering.onSubmit}
          onMouseDown={(e) => e.preventDefault()}
          className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
        >
          Send answers
        </button>
      </div>,
    )
  }
  // No gap on the container — between-block spacing is entirely the explicit VSpace elements.
  // `group/msg relative` hosts the hover-revealed debug-id chip (absolutely positioned, so it adds no
  // height and never perturbs the virtualizer's row measurement). The group is NAMED so a nested
  // `group` elsewhere in the tree can never toggle it.
  return (
    <div data-fray-msg={m.sourceId} className="group/msg relative flex flex-col text-[13px] min-w-0">
      <MessageDebugId sourceId={m.sourceId} />
      {withSpacers(blocks)}
    </div>
  )
})

// A user's composed multi-block answer, rendered as a structured card that MIRRORS the question
// component's answered state: the quiet uppercase label + the neutral elevated card of QuestionBlockCard,
// with each chosen answer in the same accent chip the option chips use when selected (border-accent
// bg-accent/10). Right-aligned + the user-bubble corner (rounded-br-sm) mark it as a human artifact.
// Each row leads with ITS QUESTION (compact, muted, clamped to two lines — the full text rides the
// title tooltip) so the answers read in context, not as bare numbered rows; a row whose pairing failed
// (count mismatch / no question message found — `question` undefined) degrades to the numbered layout,
// where the number still points a scrolled-up reader at the right block. Answers keep
// whitespace-pre-wrap so a multi-line answer's breaks survive.
// The row number shows ONLY in that fallback. With the question ON the row the question IS the label,
// and a second number can only COMPETE with whatever numbering the worker used inside the question text:
// a batch answering a BURIED ask renumbers its rows from 1 (they may span several messages), so
// answering questions 9–11 of an earlier ask rendered "1" against a question that reads "9. …".
function AnswersCard({ answers, queued, sourceId }: { answers: PairedAnswer[]; queued?: boolean; sourceId?: string }) {
  return (
    <div data-fray-msg={sourceId} className={`group/msg relative self-end flex w-full max-w-[85%] flex-col items-end ${queued ? "opacity-50" : ""}`}>
      <MessageDebugId sourceId={sourceId} side="left" />
      <div className="w-full rounded-2xl rounded-br-sm border border-border-strong bg-elevated px-3.5 py-3">
        <div className="mb-2 flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-wide text-muted/70">
          <ListChecks size={11} className="shrink-0" />
          answers
        </div>
        <div className="flex flex-col gap-2.5">
          {answers.map((a, i) => (
            <div key={i} className="flex flex-col gap-1">
              {a.question && (
                <div title={a.question} className="line-clamp-2 min-w-0 text-[11px] leading-snug text-muted">
                  {a.question}
                </div>
              )}
              <div className="flex items-start gap-2">
                {!a.question && (
                  <span className="mt-1.5 shrink-0 text-[10px] uppercase tabular-nums tracking-wide text-muted/70">{a.n}</span>
                )}
                {/* Neutral recessed chip — a SETTLED answer, not "awaiting you". The bright yellow accent
                    is reserved solely for the awaiting-you motif (see styles.css); a past choice reads
                    quiet: a darker inset panel with a soft left rule to still mark it as the reply. */}
                <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border-strong border-l-2 border-l-accent/40 bg-bg/50 px-2.5 py-1.5 text-[12px] leading-snug text-fg">
                  {a.answer}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// Queue cards live in the narrow needs-you rail, so a worker message carrying a long UNBREAKABLE token
// — a Windows path, a box-drawing error dump — must wrap at the character level rather than bleed past
// the card edge (maintainer 2026-07-10: it "looks so bad"). Applied ONLY in the dense (queue) surface:
// `overflow-wrap:anywhere` breaks unbreakable PROSE runs to fit, and code fences additionally get
// `whitespace-pre-wrap` + `break-all` so their long lines wrap INSIDE the <pre> instead of forcing the
// horizontal scroll/overflow. The roomier thread view keeps its scroll-on-overflow default (wrap=false).
const QUEUE_WRAP = "[overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:break-all"

function ProseHtml({ md, wrap }: { md: string; wrap?: boolean }) {
  const html = useMemo(() => mdToHtml(md), [md])
  const ref = useRef<HTMLDivElement>(null)
  // Make inline-code file references clickable (opens in the user's editor/default app) once the server
  // confirms each resolves to a real file. Runs after render; a no-op when the prose has no such paths.
  useLocalFileCodeLinks(ref, html)
  if (!html) return null
  return <div ref={ref} className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
}

// A local absolute image path rendered inline via the gated /local-image route: rounded, bordered,
// contained, with a muted mono basename caption. A load failure (route 4xx, missing file) falls back
// to showing the plain path text so nothing is silently swallowed. `hideCaption` drops the basename
// line (SendUserFile images are hash-named cache copies whose basename is meaningless, and the
// SentFilesCard carries its own caption); `altText` overrides the a11y alt (else the basename).
export function BlockImage({ path, hideCaption, altText }: { path: string; hideCaption?: boolean; altText?: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <div className="font-mono-keep text-[12px] text-muted/70 break-all">{path}</div>
  const base = path.split("/").filter(Boolean).pop() || path
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={`/local-image?path=${encodeURIComponent(path)}`}
        alt={altText ?? base}
        data-local-path={path}
        data-local-image="true"
        onError={() => setBroken(true)}
        className="max-w-full max-h-[420px] w-auto cursor-pointer rounded-lg border border-border object-contain"
      />
      {!hideCaption && <figcaption className="font-mono-keep text-[11px] text-muted/60 break-all">{base}</figcaption>}
    </figure>
  )
}

// A standalone local NON-image attachment path (pdf/text/code/…): an openable file chip showing the
// basename, wired to the app-wide local-file click handler via `data-local-path` + the `local-file-
// action` class (the server realpath-gates the open against the attachments/project roots, same as a
// markdown file link). A bordered pill rather than the underlined inline treatment because it stands
// alone on its own line, mirroring BlockImage's block presentation.
export function BlockFile({ path }: { path: string }) {
  const base = path.split("/").filter(Boolean).pop() || path
  return (
    <button
      type="button"
      className="local-file-action inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 text-left align-top no-underline hover:border-accent"
      data-local-path={path}
      title={path}
    >
      <FileText size={14} strokeWidth={2} className="shrink-0 text-muted" />
      <span className="font-mono-keep truncate text-[12px] text-fg">{base}</span>
    </button>
  )
}

const VIS_THEME_VARIABLES: Record<string, string> = {
  "--background": "--color-bg",
  "--foreground": "--color-fg",
  "--card": "--color-panel-2",
  "--card-foreground": "--color-fg",
  "--popover": "--color-elevated",
  "--popover-foreground": "--color-fg",
  "--primary": "--color-fg",
  "--primary-foreground": "--color-bg",
  "--secondary": "--color-panel-2",
  "--secondary-foreground": "--color-fg",
  "--muted": "--color-panel-2",
  "--muted-foreground": "--color-muted",
  "--accent": "--color-border-strong",
  "--accent-foreground": "--color-fg",
  "--border": "--color-border-strong",
  "--input": "--color-border-strong",
  "--ring": "--color-accent",
}

function visualizationTheme() {
  const root = getComputedStyle(document.documentElement)
  const vars = Object.fromEntries(Object.entries(VIS_THEME_VARIABLES).map(([target, source]) => [target, root.getPropertyValue(source).trim()]))
  vars["--font-size-base"] = getComputedStyle(document.body).fontSize
  return { type: "fray-inline-vis-theme", colorScheme: root.colorScheme === "light" ? "light" : "dark", vars }
}

// Codex Visualize emits a thread-local HTML fragment plus this directive. The server resolves the
// basename against the owning Fray session and wraps it in a CSP; this iframe deliberately omits
// allow-same-origin, forms, popups, downloads, and navigation so fragment scripts never inherit the
// control plane's authority. A tiny postMessage bridge supplies theme tokens and natural height.
export function InlineVisualization({ file }: { file: string }) {
  const slug = useContext(ThreadSlugContext)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(360)
  const [available, setAvailable] = useState<boolean | null>(null)
  const src = slug ? `/local-visualization?slug=${encodeURIComponent(slug)}&file=${encodeURIComponent(file)}` : null

  useEffect(() => {
    if (!src) { setAvailable(false); return }
    const controller = new AbortController()
    setAvailable(null)
    // Probe before mounting so a missing fragment gets a useful fallback instead of a tiny iframe
    // containing a bare HTTP status. HEAD avoids downloading a potentially 2 MB fragment twice.
    void fetch(src, { method: "HEAD", signal: controller.signal }).then((response) => {
      if (!controller.signal.aborted) setAvailable(response.ok)
    }).catch(() => {
      if (!controller.signal.aborted) setAvailable(false)
    })
    return () => controller.abort()
  }, [src])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.type !== "fray-inline-vis-height") return
      const next = Number(event.data.height)
      if (Number.isFinite(next)) setHeight(Math.max(80, Math.min(2400, Math.ceil(next))))
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])

  if (available === false || !src) {
    return <div role="status" className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] text-muted">Visualization unavailable: <span className="font-mono-keep break-all">{file}</span></div>
  }
  if (available === null) return <div role="status" className="h-20 animate-pulse rounded-lg bg-panel-2" aria-label={`Loading ${file}`} />
  return (
    <iframe
      ref={iframeRef}
      src={src}
      title={file.replace(/\.html$/, "").replaceAll("-", " ")}
      sandbox="allow-scripts"
      onLoad={() => iframeRef.current?.contentWindow?.postMessage(visualizationTheme(), "*")}
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  )
}

interface BlockInteractive {
  answer: BlockAnswer
  onChip: (optIdx: number, optText: string) => void
  onText: (text: string) => void
  onSubmit: () => void
}

// ── The shared card chrome ────────────────────────────────────────────────────────────────────────
// Every card the transcript sets off from the prose — the ```done / ```awaiting signal fences, a
// ```question block, and the runtime banners (permission, provider fault, usage-limit pause, native
// input) — wears the SAME two parts, so they read as one family rather than a pile of one-off shapes
// (maintainer 2026-07-24: "I like the little checkmark with the Done label — we should have something
// similar for all the other kinds of cards").

// Part one: the kind header. A small glyph plus the kind in quiet uppercase, at the card's top-left.
// It is the card's IDENTITY, so it never carries prose — the sentence belongs in the body below.
function CardKind({
  icon: Icon,
  label,
  tone = "text-muted/70",
}: {
  icon: LucideIcon
  label: ReactNode
  // The kind's own color language: muted by default, red for danger/fault, amber for a pause, accent
  // for "this one is waiting on you".
  tone?: string
}) {
  return (
    <div className={`mb-1.5 flex items-center gap-1 text-[10px] uppercase tracking-wide ${tone}`}>
      <Icon size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
      {label}
    </div>
  )
}

// The card's MEANING, and the ONLY thing allowed to vary between kinds (maintainer 2026-07-24: the
// styling across kinds was "vastly different… almost no consistency"). Every card is otherwise the
// same shell — same fill, same border weight, same padding, same body scale, same action row — so a
// tone is a two-token swap on the border and the kind header, never a different card:
//   neutral   — a statement of fact (done, awaiting, a question)
//   attention — the agent is BLOCKED on you, answerable only in your external terminal
//   caution   — fray paused itself and will continue on its own (a usage limit)
//   danger    — something is broken or the action is irreversible (sign-in fault, a destructive gate)
//
// Only THREE border colors, though: `caution` keeps the neutral border and says its piece in an amber
// kind header. Its amber and the accent gold sit ~15° apart on the wheel, so as two lit borders they
// were indistinguishable — and a self-resolving pause must never compete for the eye with "your agent
// is stuck waiting on you". Border = how loud; the header = what it is.
type CardTone = "neutral" | "attention" | "caution" | "danger"
const CARD_TONES: Record<CardTone, { border: string; kind: string }> = {
  neutral: { border: "border-border-strong", kind: "text-muted/70" },
  attention: { border: "border-accent/45", kind: "text-accent/80" },
  caution: { border: "border-border-strong", kind: "text-amber-400" },
  danger: { border: "border-red-500/45", kind: "text-red-400" },
}

// Part two: the SHELL. One rounded panel-2 card at one padding for every kind. Cards used to disagree
// about all three of fill (panel-2 / elevated / an accent or red wash), border color, and whether they
// carried a shadow — which is what made nine sibling cards read as nine unrelated shapes.
export function TranscriptCard({
  tone = "neutral",
  icon,
  label,
  children,
  className = "",
  ...rest
}: {
  tone?: CardTone
  icon: LucideIcon
  label: ReactNode
  children: ReactNode
  className?: string
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "className">) {
  return (
    <div {...rest} className={`min-w-0 rounded-lg border ${CARD_TONES[tone].border} bg-panel-2 px-4 py-3 ${className}`}>
      <CardKind icon={icon} label={label} tone={CARD_TONES[tone].kind} />
      {children}
    </div>
  )
}

// Part three: the body copy. One scale for every card's sentence, so a two-line explanation in one
// card is not visibly larger than the same sentence in the card above it.
export const CARD_BODY = "block min-w-0 text-[12px] leading-5 text-fg/85"

// Part two: the action row, ALWAYS right-justified (maintainer 2026-07-24). A card's buttons are its
// trailing verb; hung on the left they read as another paragraph of the body and every card disagreed
// with every other about where to look for the action. Any explainer text passed as the first child
// takes the leftover width (`flex-1 min-w-0`) and wraps its own lines there, so the button still
// anchors the right edge on a narrow queue card instead of being pushed onto its own line.
export function CardActions({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mt-3 flex flex-wrap items-center justify-end gap-x-2.5 gap-y-2 ${className}`}>{children}</div>
}

// The primary (light-on-dark) verb EVERY card's main action wears — the done card's white
// "Mark as done" chrome. Exported because this is a rule, not a per-card choice (maintainer 2026-07-24:
// the buttons inside these cards should ALWAYS be white): a card is a request for one action, and the
// recessed outlined chrome some of them wore read as a secondary — or worse, disabled — affordance.
// The ONLY departure is a genuinely secondary sibling standing beside the primary (the provider-fault
// card's "Retry" next to "Sign in"), which stays outlined so the pair keeps a hierarchy.
export const CARD_PRIMARY_BUTTON = "bg-fg px-2.5 py-1 text-bg hover:opacity-90"
// The same verb with the icon+label layout every card action uses. Cards differ only in what they pass
// beyond this (shrink-0, a disabled treatment), never in the fill.
const CARD_PRIMARY_ACTION = `flex shrink-0 items-center gap-1 rounded-md text-[11px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60 ${CARD_PRIMARY_BUTTON}`

// A ```question block, set off from the surrounding prose: rounded neutral border + slightly elevated
// bg + a muted label (NOT yellow — that's the focus motif). The label + icon track the kind: a plain
// question shows a help glyph, a `multi` block shows a checklist. A `danger` block (the destructive
// gate — force-merge, deletion, rollback) layers the app's red risk language (the same text-red-400
// family the bypass permission mode uses) with a warning glyph.
// The context renders as markdown; the convention-parsed trailing options render as choice chips (radio
// feel for single-select, toggleable checkboxes for `multi`) and the "Recommendation:" line as a muted
// note. When `interactive` is present (the live message), chips are clickable and a freetext textarea
// appears; otherwise everything is read-only. EVERY kind stages its answer the same way — pick a chip
// and/or type, then Send answers. Nothing in a question card sends on a single click (maintainer
// 2026-07-26: the old approval gate's one-click Approve was the lone exception and it is gone).
export function QuestionBlockCard({
  raw,
  questionKind,
  danger,
  interactive,
  wrap,
}: {
  raw: string
  questionKind: QuestionKind
  danger?: boolean
  interactive?: BlockInteractive
  wrap?: boolean
}) {
  const parsed = useMemo(() => parseQuestionBlock(raw, questionKind, danger), [raw, questionKind, danger])
  const html = useMemo(() => mdToHtml(parsed.contextMd), [parsed.contextMd])
  const trailingHtml = useMemo(() => (parsed.trailingMd ? mdToHtml(parsed.trailingMd) : ""), [parsed.trailingMd])
  const recIdx = parsed.recommendedIdx
  const recHtml = useMemo(() => (parsed.recommendation ? mdInlineToHtml(parsed.recommendation) : ""), [parsed.recommendation])
  const isMulti = parsed.kind === "multi"
  const isDanger = parsed.danger
  const chosen = interactive?.answer.chosen ?? null
  const chosenSet = interactive?.answer.chosenSet ?? []
  const freetext = interactive?.answer.text ?? ""
  // The free-text answer is an AUTO-EXPANDING textarea (not a fixed one-line input): reset to `auto`
  // so it can SHRINK when text is deleted, then lock to the content height so the box grows line-by-line
  // as the answer is typed. Runs on every freetext change (incl. an external clear via a chip-click).
  const taRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    // box-sizing is border-box (Tailwind preflight), so the style height must INCLUDE the borders —
    // else clientHeight lands a couple px short of scrollHeight and the last line clips (overflow is
    // hidden). `offsetHeight - clientHeight` is the vertical border delta measured at height:auto.
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`
  }, [freetext])
  const KindIcon = isDanger ? AlertTriangle : isMulti ? ListChecks : HelpCircle
  const kindLabel = isMulti ? "select multiple" : "question"
  return (
    <TranscriptCard tone={isDanger ? "danger" : "neutral"} icon={KindIcon} label={kindLabel}>
      {html && <div className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />}
      {(parsed.options.length > 0 || interactive) && (
        // Options stack in a SINGLE full-width column (maintainer 2026-07-10: a 2-col grid read as
        // ragged, uneven columns with dead whitespace once option text got long). One chip per row;
        // the free-text row keeps col-span-full so the "something else…" answer gets the whole line.
        <div className="mt-2 grid grid-cols-1 gap-1.5">
          {parsed.options.map((opt, i) => (
            <Fragment key={i}>
              {/* A group heading the worker wrote between choices ("Melee family:" over D–F). It rides
                  WITH its option rather than being stranded below the chips as unanswerable prose, and
                  wears the SAME body treatment as the context above — the FIRST group's heading is just
                  the tail of that context, so a muted caption here would make two identical things
                  render differently in one card. */}
              {parsed.optionHeadings?.[i] && (
                <div
                  className={`md-body mt-1${wrap ? ` ${QUEUE_WRAP}` : ""}`}
                  dangerouslySetInnerHTML={{ __html: mdInlineToHtml(parsed.optionHeadings[i]!.split("\n").join(" ")) }}
                />
              )}
            <Chip
              label={opt}
              multi={isMulti}
              // The recommendation renders INSIDE its option as a badge (not as a caption below);
              // the inline `(recommended: why)` rationale (or a legacy rec line) rides the chip's title.
              recommended={recIdx === i}
              recTitle={recIdx === i ? parsed.recommendedNote : undefined}
              // MULTI: selected == toggled in the set (coexists with freetext). SINGLE: selected only
              // while it's the effective answer — a freetext override clears it.
              selected={isMulti ? chosenSet.includes(i) : chosen === i && !freetext.trim()}
              disabled={!interactive}
              onClick={() => {
                interactive?.onChip(i, opt)
                // SINGLE only: choosing a chip takes the selection WITH the focus — if the free-text
                // input still holds DOM focus (its mousedown is prevented, so clicking won't blur it),
                // its accent focus border would sit next to the chip's, so blur it. MULTI keeps both
                // live at once (chips + a color note coexist), so leave the input focused there.
                // Scoped to THIS block's own answer box by ref, not by a data- tag: the queue card now
                // also renders a free-form composer alongside an open ask, and a tag match would blur
                // the caret out of that unrelated box whenever a chip is clicked.
                if (isMulti) return
                if (taRef.current && document.activeElement === taRef.current) taRef.current.blur()
              }}
            />
            </Fragment>
          ))}
          {/* The free-text answer IS the final option — but it SPANS THE FULL WIDTH (col-span-full)
              below the multi-column options, and is an auto-growing textarea (see taRef effect above)
              rather than a one-line input, so a long "something else…" answer stays fully visible. */}
          {interactive && (
            <textarea
              ref={taRef}
              rows={1}
              // Its own surface tag — deliberately NOT the queue card's `queueComposer`, which is the
              // separate free-form prompt box at the bottom of the card. Escape BLURS (climb out, same
              // semantics as the shared Composer) and stops here rather than reaching App's window
              // handler. NOTE (verified in the real app 2026-07-26): stopping it does NOT keep an
              // enclosing thread drawer open — Radix's DismissableLayer takes Escape on the document
              // in the CAPTURE phase, so it has already dismissed the sheet before this bubble-phase
              // handler runs. The typed answer survives that (it lives in the draft store), but the
              // "Escape climbs out of the box first" intent only holds on the queue card.
              data-surface="questionAnswer"
              value={freetext}
              onChange={(e) => interactive.onText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Escape") {
                  e.preventDefault()
                  e.currentTarget.blur()
                  return
                }
                // Enter writes a NEWLINE here (the browser default — this box is a staged form field,
                // not a composer); ⌘/Ctrl-Enter is the send. See shouldSubmitStagedEnter.
                if (shouldSubmitStagedEnter({
                  key: e.key,
                  altKey: e.altKey,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  shiftKey: e.shiftKey,
                  isComposing: e.nativeEvent.isComposing,
                  keyCode: e.nativeEvent.keyCode,
                })) {
                  e.preventDefault()
                  interactive.onSubmit()
                }
              }}
              // SINGLE: clicking into the input MOVES the selection here — any chosen chip deselects (its
              // accent border must not linger once the user commits to typing). MULTI keeps its toggled
              // set (the freetext only appends color), so don't disturb it on focus. Keeps typed text.
              onFocus={() => {
                if (!isMulti && chosen !== null) interactive.onText(freetext)
              }}
              placeholder={
                isMulti ? "Add a note…" : parsed.options.length ? `${nextOptionId(parsed.options)} Something else…` : "Type your answer…"
              }
              // Styled as the FINAL option row (same shape as a chip) that SPANS both grid columns.
              // resize-none + overflow-hidden hand height control to the auto-grow effect (no manual
              // drag handle, no inner scrollbar). Focus or content = the accent border (the selection
              // lives HERE now); the tinted bg marks an actual answer.
              className={`col-span-full w-full resize-none overflow-hidden rounded-md border px-2.5 py-1.5 text-[12px] leading-snug text-fg/90 outline-none placeholder:text-muted/80 transition-colors ${
                freetext.trim() ? "border-accent bg-accent/10" : "border-border bg-transparent hover:bg-panel-2 focus:border-accent"
              }`}
            />
          )}
        </div>
      )}
      {/* A "Note: …" footnote the worker wrote AFTER the options — rendered below the chips (muted) so
          the choices stay answerable instead of swallowing them (the old parser dropped the chips). */}
      {parsed.trailingMd && (
        <div className={`mt-2 md-body text-[12px] text-muted/70${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: trailingHtml }} />
      )}
      {/* The caption fallback survives ONLY when the recommendation didn't match an option. */}
      {parsed.recommendation && recIdx === null && (
        <div className="md-inline mt-1.5 text-[11px] text-muted/70" dangerouslySetInnerHTML={{ __html: recHtml }} />
      )}
    </TranscriptCard>
  )
}

// A SIGNAL fence rendered as a card in place of the raw ```done / ```awaiting block (the fence
// language IS the state; the body is the message). `done` → a compact presentation-only success card;
// its thread's Archive lives in the stable lifecycle footer. `awaiting` → the SAME card shape: a
// heading naming the wait ("Arm watcher"), the body prose plus one plain-English action summary (with
// legacy pr/ci/session support), then the park button + its explainer.
export function FenceCard({ fenceKind, body, hints, wrap }: { fenceKind: FenceKind; body: string; hints: AwaitingHint[]; wrap?: boolean }) {
  const html = useMemo(() => (body ? mdToHtml(body) : ""), [body])
  const awaitingHint = awaitingHintSentence(hints)
  const awaitingLine = awaitingPresentationLine(body, awaitingHint)
  const awaitingHtml = useMemo(() => mdInlineToHtml(awaitingLine), [awaitingLine])
  // The owning thread's slug — set by the thread view AND the queue card — so the confirm button
  // resolves its thread and renders on both surfaces (null in a sub-agent's own transcript → no button).
  const slug = useContext(ThreadSlugContext)
  // On the queue this dismisses THIS card through the user-initiated auto-scroll exit; null in the
  // drawer. Wired into both fence actions so Mark-as-done / park scroll the next card up, exactly like
  // the footer's Mark-as-done and Snooze do (maintainer 2026-07-21: every card-dismissing control must).
  const queueDismiss = useContext(QueueDismissContext)
  const board = useBoard()
  // Resolve the owning thread + whether whole-thread lifecycle actions are applicable (session, not
  // foreign). Shared by both branches: the done card's Mark-as-done button and the awaiting card's
  // confirm-park button only render for a real, actionable session thread (null in the queue card /
  // sub-agent transcript, where there's no ThreadSlugContext → the fence renders card-only).
  const fenceThread = slug ? threadBySlug(board, slug) : undefined
  const lifecycle = fenceThread ? threadLifecycleAvailability(fenceThread) : undefined
  const canAct = !!(fenceThread && lifecycle?.footer)
  // Once the Mark-as-done button has appeared, KEEP it mounted through completion. Clicking it flips
  // the thread to archived (canAct → false); unmounting the button there shrank the card — a layout
  // shift, and in the queue that resize also fed the passive scroll-anchor churn. StateButton latches
  // disabled on click and never resets on success, so holding the last actionable thread keeps the
  // button in place (disabled) instead of vanishing mid-dissolve.
  const doneThreadRef = useRef<ThreadViewData | null>(null)
  if (canAct && fenceThread) doneThreadRef.current = fenceThread
  const doneThread = canAct && fenceThread ? fenceThread : doneThreadRef.current
  if (fenceKind === "done") {
    return (
      // NEUTRAL tone — the green splash stood out as the only saturated color in the UI (maintainer
      // 2026-07-10). The Check + "Done" label carries the meaning; no color needed.
      <TranscriptCard icon={Check} label="Done">
        {html && <div className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />}
        {/* A white "Mark as done" button, deliberately redundant with the stable lifecycle footer — the
            same completion mutation, styled as the primary (light-on-dark) verb. Only shown when the
            thread can actually take the action. */}
        {doneThread && (
          <CardActions>
            <StateButton
              thread={doneThread}
              className={`text-[11px] ${CARD_PRIMARY_BUTTON}`}
              iconClassName={ICON_LABEL_NUDGE}
              onArchived={queueDismiss?.dismiss}
              onDismissCancel={queueDismiss?.cancel}
            />
          </CardActions>
        )}
      </TranscriptCard>
    )
  }
  // Same shell as the done card above — heading, then the prose, then the action. The heading names
  // the WAIT ("Arm watcher"), which is what the old right-rail button label was doing badly: it read
  // as the button's verb when it was really the card's identity (maintainer 2026-07-24). With no
  // parkable hint there's no action to name, so it falls back to a plain "Awaiting".
  const parkTitle = awaitingParkAction(hints)?.title ?? AWAITING_FALLBACK_TITLE
  return (
    <TranscriptCard icon={Hourglass} label={parkTitle}>
      <div
        className={`md-inline ${CARD_BODY}${wrap ? ` ${QUEUE_WRAP}` : ""}`}
        dangerouslySetInnerHTML={{ __html: awaitingHtml }}
      />
      {canAct && fenceThread && <AwaitingParkButton thread={fenceThread} hints={hints} />}
    </TranscriptCard>
  )
}

// The awaiting card's HUMAN-IN-THE-LOOP park button, sitting under the prose with its effect spelled
// out in muted text beside it. The worker's ```awaiting fence already auto-arms the durable wake (a
// `timer` fires at its instant; a `pr-watch` watcher wakes on any new PR activity, bot or human) AND
// already files the thread into the dimmed Held band — this button lets the human EXPLICITLY commit a
// USER-OWNED snooze on top, so the park carries a concrete wake time and is durable across fence
// changes. It NEVER suppresses the auto-armed wake: a user snooze is a board-presentation concern
// only (board.ts), independent of the scheduler. The button says only "Snooze"; its kind → title +
// explainer + snooze target policy lives in lib/awaitingPresentation.ts (awaitingParkAction), where
// it is unit-tested.
function AwaitingParkButton({ thread, hints }: { thread: ThreadViewData; hints: readonly AwaitingHint[] }) {
  const [busy, setBusy] = useState(false)
  // On the queue, confirming the park dismisses THIS card through the user-initiated auto-scroll exit
  // (like Snooze); null in the drawer, where the card just leaves the board.
  const queueDismiss = useContext(QueueDismissContext)
  const action = awaitingParkAction(hints)
  if (!action) return null
  const apply = () => {
    // A future timer snoozes to its exact instant; kinds without a declared time use the default preset.
    const until = action.timerUntil ?? snoozePresetInstant(prefs.snoozePreset)
    setBusy(true)
    rpc
      .setThreadSnooze({ slug: thread.id, sessionId: thread.sessionId ?? "", until })
      .then(() => {
        showToast(`${action.toastVerb} · ${formatSnoozeWake(until)}`)
        queueDismiss?.dismiss()
      })
      .catch((error) => showToast(`Couldn’t snooze: ${(error as Error).message.slice(0, 80)}`))
      .finally(() => setBusy(false))
  }
  return (
    // Explainer first, button ANCHORED RIGHT — the same trailing-verb position the done card's
    // Mark-as-done holds (maintainer 2026-07-24). The explainer takes the remaining width and wraps its
    // OWN lines there (flex-1 + min-w-0) instead of pushing the button onto a line of its own: on a
    // narrow queue card a two-line sentence beside the button still reads as one control.
    <CardActions>
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted/70">{action.explainer}</span>
      <button
        type="button"
        onClick={apply}
        disabled={busy}
        aria-label={AWAITING_PARK_BUTTON}
        title={action.explainer}
        onMouseDown={(e) => e.preventDefault()}
        // Same white primary chrome as the done card's Mark-as-done: parking is this card's verb, and
        // the recessed grey it used to wear read as a secondary/disabled affordance beside it.
        className={`whitespace-nowrap disabled:opacity-45 ${CARD_PRIMARY_ACTION}`}
      >
        {busy && <Loader2 size={11} className="animate-spin" />}
        {AWAITING_PARK_BUTTON}
      </button>
    </CardActions>
  )
}

// A permission-blocked agent is INVISIBLE in the transcript (the turn is parked mid-tool_use, so no
// message exists yet) — without this banner the card looks like a quietly-working agent. Rendered by
// the queue card and the thread view whenever runtime is perm-prompt; the action lands the user in
// an external terminal, the only place the prompt can be answered.
// Trusted provider-auth recovery card (claude-auth plan). Rendered ONLY from the server's TYPED
// providerFault field — never parsed from assistant-authored content — so a model cannot manufacture
// a sign-in affordance in Chat. "Sign in" opens the same modal as the dispatch gate (copyable
// `claude auth login` + re-check). "Retry" re-sends the thread's LAST user message through the
// ordinary follow-up path (resume already handles a dead worker); it exists only as an explicit user
// action — a prompt is never replayed automatically after login.
export function ProviderFaultCard({
  slug,
  sessionId,
  fault,
  retryText,
}: {
  slug: string
  sessionId: string | undefined
  fault: NonNullable<ThreadViewData["providerFault"]>
  retryText?: string
}) {
  const [signIn, setSignIn] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const queryClient = useQueryClient()
  const label = PROVIDER_LABEL[fault.backend]
  // Retry-after-sign-in is an ordinary follow-up like every other turn-starting action: eager so the
  // thread paints as working and its message appears as a queued bubble the instant it's clicked, on
  // the FIFO chain, and tracked by the delivery ledger. A retry sent while still signed out fails the
  // send, whose rollback clears the optimistic state at once — no false lingering spinner. The local
  // `retrying` flag only disables THIS button; the thread's feedback no longer waits on the round-trip.
  const retry = (message: string) => {
    setRetrying(true)
    // sendEagerFollowUp does nothing (fires no callback) for an empty message. retryText is guarded
    // truthy at the button, so today `started` is always true — but resetting on false keeps this card
    // self-contained instead of trusting that external invariant to hold through a later refactor.
    const started = sendEagerFollowUp(queryClient, slug, message, {
      onSuccess: () => { setRetrying(false); showToast("Retrying with the previous message…") },
      onRollback: () => setRetrying(false),
      failureToast: (m) => `Retry failed: ${m.slice(0, 80)}`,
    })
    if (!started) setRetrying(false)
  }
  return (
    <TranscriptCard data-provider-fault tone="danger" icon={KeyRound} label={`${label} sign-in required`}>
      <span className={CARD_BODY}>
        The provider rejected this session's credential. Sign in, then retry.
      </span>
      <CardActions>
        {retryText?.trim() && (
          <button
            onClick={() => retry(retryText)}
            disabled={retrying}
            onMouseDown={(e) => e.preventDefault()}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel hover:border-border-strong disabled:opacity-60"
          >
            Retry
          </button>
        )}
        {/* The card's verb, so it wears the same white fill as every other card action. The accent
            fill it used to have made it the one saturated button in the transcript — and the red kind
            header + red border already carry the alarm, so the button did not need to repeat it. */}
        <button
          onClick={() => setSignIn(true)}
          onMouseDown={(e) => e.preventDefault()}
          className={CARD_PRIMARY_ACTION}
        >
          Sign in
        </button>
      </CardActions>
      {signIn && (
        <SignInModal
          backend={fault.backend}
          onClose={() => setSignIn(false)}
          onAuthed={() => setSignIn(false)}
        />
      )}
    </TranscriptCard>
  )
}

// Format a unix-seconds instant as a bare local wall clock ("5:50 PM"), or with the weekday when it
// is not today — a limit that resets tomorrow afternoon must not read as if it comes back this hour.
function limitResumeClock(unixSeconds: number): string {
  const when = new Date(unixSeconds * 1000)
  const sameDay = when.toDateString() === new Date().toDateString()
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return sameDay ? time : `${when.toLocaleDateString([], { weekday: "short" })} ${time}`
}

// The usage-limit pause card. Rendered ONLY from the server's TYPED limitPause — the same trust rule
// as ProviderFaultCard, so an agent quoting a limit message into its own transcript can never
// fabricate a "paused, resuming later" affordance.
//
// Deliberately NOT the sign-in card's shape, even though both are provider faults: here the
// credential is fine and the recovery is TIME, not an action. So the card leads with information —
// when the window comes back, and that fray will pick the thread up itself — and keeps a manual
// continue as the secondary, for the operator who has capacity elsewhere and doesn't want to wait.
export function LimitPauseCard({ slug, sessionId, pause }: { slug: string; sessionId: string | undefined; pause: NonNullable<ThreadViewData["limitPause"]> }) {
  const label = PROVIDER_LABEL[pause.backend]
  const which = pause.window === "weekly" ? "weekly limit" : pause.window === "session" ? "session limit" : "usage limit"
  const [continuing, setContinuing] = useState(false)
  const queryClient = useQueryClient()
  // "Continue now" is a manual override of the auto-resume — a turn-starting action exactly like a
  // steer, so it takes the same eager path: the row leaves the Held band for Active and its bubble
  // appears the instant it's clicked, rather than after the injection round-trip. `continuing` disables
  // only this button.
  const continueNow = () => {
    setContinuing(true)
    // The message is a non-empty constant, so `started` is always true here; the reset-on-false is a
    // belt-and-suspenders that keeps the button from sticking disabled if that ever changes.
    const started = sendEagerFollowUp(queryClient, slug, "Continue exactly where you left off.", {
      onSuccess: () => { setContinuing(false); showToast("Continuing…") },
      onRollback: () => setContinuing(false),
      failureToast: (m) => `Continue failed: ${m.slice(0, 80)}`,
    })
    if (!started) setContinuing(false)
  }
  return (
    <TranscriptCard data-limit-pause tone="caution" icon={Hourglass} label={`Paused by the ${label} ${which}`}>
      {/* The provider's own "You've hit your session limit · resets …" line sits directly above this
          card (unlike an auth error, it is informative, so transcript.ts keeps its bubble). So this
          card says only what THAT line cannot: what fray is going to do about it. */}
      <span className={CARD_BODY}>
        {pause.autoResume
          ? pause.resumesAt
            ? `Continuing automatically at ${limitResumeClock(pause.resumesAt)}.`
            : "Continuing automatically once the window resets."
          : "Continue it whenever you have capacity again."}
      </span>
      <CardActions>
        <button
          onClick={continueNow}
          disabled={continuing}
          onMouseDown={(e) => e.preventDefault()}
          className={`disabled:opacity-45 ${CARD_PRIMARY_ACTION}`}
        >
          Continue now
        </button>
      </CardActions>
    </TranscriptCard>
  )
}

// ATTENTION tone, like the two native-input cards below it: all three mean the same thing — the agent
// is blocked on you and the only place to answer is your external terminal — and they used to wear
// three different treatments (neutral / accent+shadow / accent wash) for that one meaning.
export function PermPromptBanner({ onTerminal }: { onTerminal: () => void }) {
  return (
    <TranscriptCard tone="attention" icon={KeyRound} label="Permission approval">
      <span className={CARD_BODY}>
        The agent is waiting on your approval — respond in your external terminal.
      </span>
      <CardActions>
        <button
          onClick={() => onTerminal()}
          onMouseDown={(e) => e.preventDefault()}
          className={CARD_PRIMARY_ACTION}
        >
          Copy terminal command
        </button>
      </CardActions>
    </TranscriptCard>
  )
}

// What fray's permission POLICY did on the worker's behalf (cc-worker/hooks/perm-policy.mjs).
//
// This exists because a policy decision is otherwise INVISIBLE. Nobody was prompted, nothing blocked,
// and an auto-approval is never written to the transcript — Claude Code renders "Allowed by
// PermissionRequest hook" in the terminal and stores nothing. Without this the honest description of
// the feature would be "fray silently approves things for you", which is not a trade anyone should
// make blind.
//
// Weighted by consequence, deliberately. A DENIAL is rare and changes what the worker can do, so it
// gets a real card. An approval is routine and would be pure noise as a card, so it is one quiet line
// — enough to answer "is this thread auto-approving?" without competing with the transcript.
export function PermPolicyNote({ policy, denies }: { policy: NonNullable<ThreadViewData["permPolicy"]>; denies?: number }) {
  const what = [policy.tool, policy.command].filter(Boolean).join(": ")
  if (policy.decision === "deny") {
    return (
      <TranscriptCard tone="caution" icon={AlertTriangle} label="Blocked by fray's permission policy">
        {/* The refused command leads on its own line — it is the thing you actually need to see — and
            the reason follows as prose. The reason is the same text the WORKER was given, so it
            already opens with "Refused:"; prefixing it here too read as a stutter. */}
        {what ? <code className="mb-1.5 block min-w-0 break-all rounded bg-panel px-1.5 py-1 text-[11px] text-fg/85">{what}</code> : null}
        <span className={CARD_BODY}>{policy.reason}</span>
        <span className="mt-1.5 block text-[11px] text-muted">
          Rule <code className="rounded bg-panel px-1 py-0.5">{policy.rule}</code>
          {denies && denies > 1 ? ` · ${denies} denials this session` : ""}
        </span>
      </TranscriptCard>
    )
  }
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-[11px] leading-5 text-muted">
      <ShieldCheck size={12} strokeWidth={1.8} className="mt-[5px] shrink-0" />
      <span className="min-w-0">
        {/* The COMMAND may break anywhere — it is long by nature and forcing it whole would overflow a
            narrow pane. The RULE name must not: split across lines its pill reads as two fragments. */}
        Auto-approved{what ? <> <code className="rounded bg-panel-2 px-1 py-0.5 text-[10.5px]">{what}</code></> : null}
        {" · "}rule <code className="whitespace-nowrap rounded bg-panel-2 px-1 py-0.5 text-[10.5px]">{policy.rule}</code>
      </span>
    </div>
  )
}

// A verified Codex-native modal is also invisible to the rollout, but unlike the legacy boolean
// permission sniff we know its coarse family. Keep it prominent and explicit about the trust boundary:
// Fray never copies option/payload detail into Chat and never chooses an answer on the user's behalf.
export function NativeInputRequiredCard({ input, onTerminal }: { input: NativeInputRequiredData; onTerminal: () => void }) {
  const label =
    input.kind === "tool-approval"
      ? "Tool approval required"
      : input.kind === "permission"
        ? "Permission choice required"
        : input.kind === "confirmation"
          ? "Confirmation required"
          : "Choice required"
  return (
    <TranscriptCard data-native-input-required tone="attention" icon={AlertTriangle} label={label}>
      {/* The modal's own title is the one line here that carries weight — it's the thing being asked.
          It stays at the body scale and earns its emphasis from the medium weight and full-strength
          fg, not from a larger size that made this card's copy visibly bigger than every sibling's. */}
      <div className="min-w-0 text-[12px] font-medium leading-5 text-fg">{input.title}</div>
      <div className="mt-1 text-[12px] leading-5 text-muted">Review and respond in your external terminal. Fray will not choose for you.</div>
      <CardActions>
        <button
          onClick={() => onTerminal()}
          onMouseDown={(e) => e.preventDefault()}
          className={CARD_PRIMARY_ACTION}
        >
          Copy terminal command
        </button>
      </CardActions>
    </TranscriptCard>
  )
}

// The persistent BACKGROUND-OPS strip, anchored above the composer: one quiet row per LIVE op the
// worker is running across rests — sub-agents (drill-in) and background shells (display-only) — so a
// worker that "launched a CI watcher then came to rest" never reads as idle, and a final message like
// "waiting for the watcher to complete" has a visible home. Visible whenever ops are live, INCLUDING
// mid-turn (it folds in the old at-rest SubAgentBanner — one surface beats two, and the anchored
// position under the composer reads as ambient status rather than transcript content). A 30s tick keeps
// elapsed fresh even when no board push arrives (a steadily-running op changes nothing to re-push).
export function BackgroundOpsStrip({
  slug,
  className = "px-4 pb-2 pt-1",
  includeAgents = true,
}: {
  slug: string
  className?: string
  // Queue cards render live sub-agents as compact child lines directly under their composer. They
  // still use this strip for unrelated background shells/Monitors, so suppress agent duplication.
  includeAgents?: boolean
}) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const agents = includeAgents ? thread?.subAgents ?? [] : []
  const shells = thread?.bgShells ?? []
  const total = agents.length + shells.length
  // This is intentionally independent of transcript cards: it sits immediately below the affected
  // prompt box so a resting worker that owns a live shell still reads as active at a glance. Do not
  // add a thread-wide “Running” marker here: a foreground turn and several independent children are
  // different operations, and only the row that owns a running state may advertise live work.
  const [, force] = useState(0)
  useEffect(() => {
    if (total === 0) return
    const id = setInterval(() => force((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [total])
  // Dismiss a finished-but-unsignalled op: the × retires it from tracking server-side (the board push
  // then drops its row). Optimism is unnecessary — dismissOp calls onChange, so the removal arrives on
  // the next board frame; on failure the row simply stays and the next frame reconciles.
  const dismiss = useMutation({
    mutationFn: (id: string) => rpc.dismissBackgroundOp({ slug, id }),
    onError: (e) => showToast(`Dismiss failed: ${(e as Error).message.slice(0, 80)}`),
  })
  if (total === 0) return null
  return (
    <div className={`flex flex-col gap-0.5 ${className}`} data-background-ops>
      {visibleChildOps(agents, "sheet").map((s, i) => (
        <ChildOpRow
          key={`a${i}`}
          kind="AGENT"
          label={s.label}
          state={s.state}
          density="sheet"
          lastActivityAt={s.lastActivityAt}
          onOpen={s.id ? () => pushSubAgentDrawer(slug, s.id!, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt }) : undefined}
          onDismiss={s.id ? () => dismiss.mutate(s.id!) : undefined}
        />
      ))}
      {visibleChildOps(shells, "sheet").map((s, i) => (
        <ChildOpRow
          key={`s${i}`}
          kind="SHELL"
          label={s.label}
          state={s.state}
          density="sheet"
          lastActivityAt={s.lastActivityAt}
          onOpen={s.id ? () => pushBackgroundShellDrawer(slug, s.id!, { label: s.label, startedAt: s.startedAt }) : undefined}
          onDismiss={s.id ? () => dismiss.mutate(s.id!) : undefined}
        />
      ))}
    </div>
  )
}

// The read-only render of a PENDING native AskUserQuestion (the safety net for a session that bypassed
// the thread-file ask channel). Shows the REAL question(s) + options as NON-interactive rows —
// deliberately NOT answer-chips: answering a native TUI dialog by keystroke injection is too fragile, so
// the ONE affordance copies an external-terminal command, where the dialog can actually be answered.
export function PendingAskCard({ ask, onTerminal }: { ask: PendingAsk; onTerminal: () => void }) {
  return (
    <TranscriptCard tone="attention" icon={HelpCircle} label="Waiting on your answer — in your external terminal">
      <div className="flex flex-col gap-3">
        {ask.questions.map((q, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            {q.header && <div className="text-[10px] uppercase tracking-wide text-muted/55">{q.header}</div>}
            <div className="min-w-0 text-[12px] font-medium leading-5 text-fg">{q.question}</div>
            {q.options.length > 0 && (
              <div className="flex flex-col gap-1">
                {q.options.map((o, j) => (
                  // A non-interactive OPTION ROW (clearly display-only — no hover, no cursor-pointer).
                  // `bg-elevated`, one step above the card's own panel-2 fill — the same relationship the
                  // question card's chips have to their card, so a row reads as a row on every surface.
                  <div key={j} className="rounded-md border border-border bg-elevated px-2.5 py-1.5 text-[12px] text-fg/80">
                    <span className="font-medium text-fg/90">{o.label}</span>
                    {o.description && <span className="text-muted/70"> — {o.description}</span>}
                  </div>
                ))}
                {q.multiSelect && <div className="text-[10px] text-muted/50">select one or more</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <CardActions>
        <button
          onClick={() => onTerminal()}
          onMouseDown={(e) => e.preventDefault()}
          className={CARD_PRIMARY_ACTION}
        >
          {/* No literal space before the label — the flex `gap` IS the spacing. A JSX space here
              rendered as a real space character ON TOP of the gap and made this the widest icon/label
              gap on the page by ~3px. */}
          <KeyRound size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
          Copy terminal command
        </button>
      </CardActions>
    </TranscriptCard>
  )
}

// Coarse duration for a FIXED span (a dispatch→completion elapsed, in ms): "<1m", "42m", "1h 3m".
// Distinct from elapsedSince(), which measures an ISO start against now for a still-running child.
function fmtDurationMs(ms: number): string {
  return formatFixedDuration(ms)
}

// The hairline+label+hairline chrome of a WAKE DIVIDER — the one rendering both kinds of child
// completion now share. A background shell coming to rest, a Monitor timing out, and a sub-agent
// finishing are the same class of event (a child the worker launched has reached a terminal state,
// usually re-invoking the agent), and they now read the same way: a centred section break that stands
// out from the tool cards around it, rather than one of them being a card indistinguishable from a
// hundred others (maintainer 2026-07-27). `label` is the whole line for a shell; the agent divider
// passes nodes so its title can be a drill-in link.
function WakeDivider({ children, sourceId, ariaLabel, marker }: { children: ReactNode; sourceId?: string; ariaLabel?: string; marker?: string }) {
  return (
    <div
      data-fray-msg={sourceId}
      data-wake-divider={marker}
      className="group/msg relative my-1 flex items-center gap-3"
      // A divider carrying an interactive title is not an ARIA `separator` (a separator may not own a
      // focus stop), so only the inert shell-wake form takes the role — via `ariaLabel`.
      role={ariaLabel ? "separator" : undefined}
      aria-label={ariaLabel}
    >
      <MessageDebugId sourceId={sourceId} />
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      <span className="petite-caps flex min-w-0 items-center gap-1 break-words text-center text-[12px] text-muted/70">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  )
}

// A SUB-AGENT COMPLETION — emitted by the server as a standalone `agentCompletion` copy of the dispatch
// call at the position the completion notification landed. It renders in the SAME wake-divider idiom a
// background shell's completion uses, because that is the convergence the maintainer asked for: the two
// events mean the same thing to a reader, and the divider is the form that survives a long run of tool
// cards. It deliberately does NOT reuse the launch card's chrome — a second identical AgentBlock at the
// completion point was pure duplication, and it disappeared into the band around it.
//
// The TITLE is a drill-in link into the child's run log wherever a slug resolves — the launch card up
// thread is often hundreds of lines away, so this is usually the closest handle on the finished child.
// With no resolvable slug it degrades to plain text rather than a dead button.
function AgentCompletionLine({ call, sourceId }: { call: TranscriptToolCall; sourceId?: string }) {
  const slug = useChildDrillSlug()
  const title = call.detail ?? "sub-agent"
  const { tail } = subAgentCompletionOutcome(call)
  const canDrill = !!(slug && call.agentId)
  return (
    <WakeDivider sourceId={sourceId} marker="agent" ariaLabel={canDrill ? undefined : `Sub-agent ${title} ${tail}`}>
      <span className="shrink-0">Sub-agent</span>
      {/* The guillemets sit OUTSIDE the truncating element (and inside a gap-less nested flex) so a
          title clipped at a narrow width still closes its quote — `«a long title…` reads as broken
          punctuation, not as a truncation. It also scopes the link underline to the title itself. */}
      <span className="flex min-w-0 items-center">
        <span className="shrink-0">«</span>
        {canDrill ? (
          <button
            type="button"
            data-subagent-completion-open
            title={CHILD_OPEN_TITLE.AGENT}
            aria-label={`${CHILD_OPEN_TITLE.AGENT}: ${title}`}
            onClick={() => pushSubAgentDrawer(slug!, call.agentId!, { label: title, subagentType: call.subagentType })}
            onMouseDown={(e) => e.preventDefault()}
            className="min-w-0 truncate rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
        <span className="shrink-0">»</span>
      </span>
      <span className="shrink-0">{tail}</span>
    </WakeDivider>
  )
}

// A quiet transcript annotation ("Thought for Ns"), or — with `boundary` — the wake divider a
// background task/shell completion emits. Muted ~12px, no bubble, no icon chrome, sitting at the same
// message rhythm as everything around it.
function EventLine({ text, boundary, sourceId }: { text: string; boundary?: boolean; sourceId?: string }) {
  // A turn BOUNDARY (an external wake — a background task/shell completion re-invoked the agent): a
  // centered divider rule carrying the cause label ON it, so two consecutive assistant turns don't read
  // as one bubble. This IS the section break the plain event line deliberately avoids.
  if (boundary) return <WakeDivider sourceId={sourceId} marker="event" ariaLabel={text}>{text}</WakeDivider>
  // Transcript PUNCTUATION ("Thought for Ns", a context-compaction note) — a quiet, left-justified
  // light-gray label. No flanking dividers: it reads as a subtle annotation, not a section break.
  // petite-caps for consistency with the other inline dispatch readouts (the Agent label, etc.).
  return (
    <div data-fray-msg={sourceId} className={`group/msg relative ${TRANSCRIPT_META_LABEL_CLASS}`}>
      <MessageDebugId sourceId={sourceId} />
      {text}
    </div>
  )
}

// A Codex model-reasoning SUMMARY — the coalesced `summary[]` steps of a turn's reasoning records
// (Claude's thinking is redacted at every seam, so this is Codex-only). A PEER of the "N tool calls"
// and "Thought for Ns" transcript-metadata labels: same petite-caps whisper (TRANSCRIPT_META_LABEL_CLASS),
// content-width, chevron flush-right of the label — so the three quiet-metadata rows read as one family
// (this is the "align thought metadata labels" work). Collapsed shows just the "reasoning" label; the
// whole row toggles to reveal the train of thought as muted markdown in a ruled block. The `.fray-reasoning`
// rule below quiets that body (12px/muted, and de-bolds codex's `**step header**` fragments) so an
// expanded turn reads as a soft aside, never a wall of bold headers competing with the real answer.
function ReasoningBlock({ text, durationMs, sourceId }: { text: string; durationMs?: number; sourceId?: string }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // "Thought for N seconds" — the wall-clock the model spent thinking this turn (server-derived from the
  // per-step reasoning gaps, tool time excluded). Sub-minute reads in whole seconds; a longer turn folds
  // into "Nm Ms" so a multi-minute think doesn't render as a giant second count. No timing → bare "Thought".
  const label =
    durationMs != null && durationMs > 0
      ? `Thought for ${durationMs < 60_000 ? `${Math.max(1, Math.round(durationMs / 1000))} seconds` : `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`}`
      : "Thought"
  return (
    <div data-fray-msg={sourceId} className="group/msg relative flex flex-col">
      <MessageDebugId sourceId={sourceId} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={bodyId}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} model reasoning`}
        className={`${TRANSCRIPT_META_LABEL_CLASS} flex items-center gap-1 self-start rounded outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60`}
      >
        <span>{label}</span>
        <ChevronRight aria-hidden="true" size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div id={bodyId} className="fray-reasoning mt-1.5 ml-[5px] border-l border-border/70 pl-3">
          <ProseHtml md={text} wrap />
        </div>
      )}
    </div>
  )
}

// The free-text row's identifier: one past the last option ("A. B. C." → "D.", "1. 2." → "3.").
function nextOptionId(options: string[]): string {
  const last = options[options.length - 1]?.match(/^\s*([A-Za-z]|\d+)([.)])\s/)
  if (!last) return `${String.fromCharCode(65 + options.length)}.`
  const [, id, punct] = last
  return /\d/.test(id) ? `${Number(id) + 1}${punct}` : `${String.fromCharCode(id.toUpperCase().charCodeAt(0) + 1)}${punct}`
}

// recommendedIndex (rec-line → option index) now lives in ../lib/questionBlocks.ts alongside the rest
// of the question parsing, so it's covered by the pure-logic unit tests.

// A single answer choice: a left-aligned neutral button; when selected it takes the subtle accent
// border (focus-adjacent selection). A `multi` chip additionally carries a checkbox square (empty →
// checked) so the "toggle several" affordance reads unmistakably as multi-select vs the single-select
// chips' bare border highlight. Read-only (no interactive controller) → muted and non-clickable.
function Chip({
  label,
  selected,
  disabled,
  multi,
  recommended,
  recTitle,
  onClick,
}: {
  label: string
  selected: boolean
  disabled: boolean
  multi?: boolean
  recommended?: boolean
  recTitle?: string
  onClick: () => void
}) {
  // The option text is worker-authored markdown — render its inline emphasis/`code`/links (a chip is
  // one line, so inline-only: no `<p>`/list block chrome). Raw `label` used to leak `**bold**`/backticks.
  // inertInteractive: the chip is itself a <button>, so a link/local-file path in the option text must
  // NOT become a nested interactive element (invalid HTML + a click that both opens the link and selects
  // the option). Flatten links to spans; emphasis/code still render.
  const labelHtml = useMemo(() => mdInlineToHtml(label, { inertInteractive: true }), [label])
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      title={recTitle}
      className={`text-left rounded-md border px-2.5 py-1.5 text-[12px] leading-snug outline-none transition-colors flex items-start gap-2 ${
        selected
          ? "border-accent bg-accent/10 text-fg"
          : disabled
            ? "cursor-default border-border text-muted/80"
            // hover lands on `elevated`, one step above the card's own panel-2 fill — hovering to
            // panel-2 was invisible once every card standardized on that fill.
            : "border-border text-fg/90 hover:bg-elevated hover:border-border-strong"
      }`}
    >
      {multi && (
        <span
          aria-hidden
          className={`mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
            selected ? "border-accent bg-accent text-bg" : "border-border-strong"
          }`}
        >
          {selected && <Check size={10} strokeWidth={3} />}
        </span>
      )}
      {/* The "Recommended" badge FLOATS to the top-right so the option text flows around it and reclaims
          the full width on the lines below — instead of a flex sibling that permanently narrows the text
          column. The badge must precede the label in source order for the float to take effect. */}
      <span className="min-w-0 flex-1">
        {recommended && (
          // Optically centred on the option text's CAP BLOCK, not on its line box. Measured on the
          // rendered page: the pill's ink centre sat 1.88px (sans) / 1.80px (mono) BELOW the label's,
          // because a 9.5px pill inside a 12px line resolves a shorter line box and lands its baseline
          // 1px low. Unlike the icon nudge this is font-INDEPENDENT — both sides scale with the same
          // font — so it is a constant, and 2px lands on a whole device pixel at 2× DPR. `translate`
          // (not a margin) so the float's exclusion area, and therefore the text wrap, is untouched.
          <span className="float-right ml-2 mt-px -translate-y-[2px] rounded-full border border-border-strong px-1.5 py-px text-[9.5px] uppercase tracking-wide text-muted">
            Recommended
          </span>
        )}
        <span className="md-inline" dangerouslySetInnerHTML={{ __html: labelHtml }} />
      </span>
    </button>
  )
}

function Dots() {
  return <span className="inline-block w-2.5 h-2.5 rounded-full border border-muted/70 border-t-transparent animate-spin" />
}

// The turn-in-flight banner: shimmering "Working…" (the ambient AI-at-work treatment) followed by a
// dimmed elapsed timer. The baseline is the last real user interaction (server-derived, so it reads
// as true turn duration and survives reloads); a thread with no usable timestamp falls back to
// mount time. Ticks once a second — cheap, and unmounts with the banner.
function WorkingIndicator({ since }: { since?: string }) {
  const [baseline] = useState(() => {
    const t = Date.parse(since ?? "")
    return Number.isFinite(t) && t <= Date.now() ? t : Date.now()
  })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((now - baseline) / 1000))
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="shimmer-text">Working…</span>
      <span className="tabular-nums text-[12px] text-muted/60">{label}</span>
    </div>
  )
}
