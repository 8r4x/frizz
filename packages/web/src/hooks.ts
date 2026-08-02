import { useEffect, useMemo } from "react"
import { useSnapshot } from "valtio"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { BoardSnapshot, InteractionRecord, ThreadView, TranscriptMessage } from "@fray-ui/shared"
import { store, threadBySlug } from "./store.ts"
import { rpc } from "./api/rpc.ts"
import { retryTranscriptSocket, subscribeTranscript, unsubscribeTranscript } from "./api/socket.ts"
import { mergeOptimistic, preserveMessageIdentity, isTranscriptStale, newestRenderedAt } from "./lib/transcript-sync.ts"
import { pendingInteractionsKey } from "./api/interaction-cache.ts"
import { reconcileLatestPage, type PaginatedTranscriptData } from "./lib/transcriptPagination.ts"

// A transcript message carrying a transient client-only flag: a follow-up we optimistically appended
// on send that hasn't yet appeared in a server refetch. The flag drives the "queued" affordance and
// is naturally dropped when server truth overwrites the cache — EXCEPT that a blunt overwrite would drop
// it too early (before the server's own copy lands), so overwrites now route through mergeOptimistic.
export type ChatMessage = TranscriptMessage & { queued?: boolean; deliveryId?: string }
export type TranscriptData = Partial<Omit<PaginatedTranscriptData, "messages">> & { messages: ChatMessage[] }

// `mergeToolRuns` stays deleted: mutating transcript truth before the ordered-parts walk hoisted tools
// across prose and lost block fidelity. The minimal renderer now performs a narrower PRESENTATION-ONLY
// coalescing in lib/toolActivity.ts: a visible tool tail and its following provider-only turns share
// one disclosure; prose and dedicated block tools such as sub-agent operations are hard boundaries.
// VISUAL ORDER == TURN ORDER remains the invariant; no persisted/query-cached message is rewritten.

// React-only helpers live here, not in store.ts, because store.ts is also imported by
// non-React code (api/sse.ts) that has no business pulling in React/valtio hooks.

// Valtio's useSnapshot() produces a DeepReadonly view that doesn't structurally match
// BoardSnapshot/ThreadView (readonly arrays vs. the mutable shapes zod infers), so every read
// needs a cast. Centralized here so it happens once instead of scattered `as BoardSnapshot`
// casts across components.
export function useBoard(): BoardSnapshot | null {
  const snap = useSnapshot(store)
  return snap.board as BoardSnapshot | null
}

// The project root every display path is shortened against (see relativeToolPaths). Narrower than
// useBoard() on purpose: valtio tracks the single property, so a transcript row that only needs the
// root does not re-render on unrelated board churn.
export function useProjectDir(): string | undefined {
  return useSnapshot(store).board?.projectDir
}

export function asThreads(threads: readonly unknown[]): ThreadView[] {
  return threads as ThreadView[]
}

// True once the /ws multiplex is the transcript source (server pushes into the cache). Components read
// this to skip pull-based refetch paths that the push now covers.
export function useSocketTranscripts(): boolean {
  return useSnapshot(store).socketTranscripts
}

export function ownedInteractionScope(thread: ThreadView | undefined): { slug: string; sessionId: string } | undefined {
  if (!thread || thread.kind !== "session" || thread.foreign || !thread.sessionId) return undefined
  return { slug: thread.id, sessionId: thread.sessionId }
}

// A current server emits an exact board-level presence bit, so unrelated needs-you rows (questions,
// done handoffs, native prompts) do not each fan out another list RPC. During a rolling update an older
// board omits the optional field; preserve the prior query behavior until the server catches up so a
// real typed request is never hidden merely because client and server bundles changed out of order.
export function pendingInteractionScope(thread: ThreadView | undefined): { slug: string; sessionId: string } | undefined {
  const scope = ownedInteractionScope(thread)
  if (!scope || thread?.pendingInteraction === false) return undefined
  return scope
}

// Keep an expiring card accurate even if the provider edge or push transport is lost. The server's
// scoped list call performs the authoritative expiry transition; otherwise SSE/WS invalidations keep
// this query pull-free.
export function nextInteractionExpiryDelay(interactions: readonly InteractionRecord[], now = Date.now()): number | false {
  let earliest = Infinity
  for (const interaction of interactions) {
    if (!interaction.expiresAt) continue
    const expires = Date.parse(interaction.expiresAt)
    if (Number.isFinite(expires)) earliest = Math.min(earliest, expires)
  }
  if (!Number.isFinite(earliest)) return false
  return Math.max(250, earliest - now + 50)
}

export function usePendingInteractions(thread: ThreadView | undefined) {
  const scope = pendingInteractionScope(thread)
  return useQuery({
    queryKey: scope ? pendingInteractionsKey(scope.slug, scope.sessionId) : ["interactions", "pending", "unowned"],
    queryFn: () => rpc.pendingInteractions(scope!),
    enabled: scope !== undefined,
    refetchInterval: (query) => nextInteractionExpiryDelay(query.state.data?.interactions ?? []),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  })
}

// Shared transcript query. `poll` controls whether the transcript stays LIVE (chat while the agent is
// running) or is left to refetch only on explicit triggers (the To-dos pager).
//
// Freshness has two transports: with the /ws multiplex live (store.socketTranscripts), a live surface
// SUBSCRIBES and the server PUSHES updates into this same cache — no interval poll. Without it (before the
// socket confirms, or on SSE fallback against a pre-restart server) it falls back to the 1.5s interval —
// exactly today's behavior. Either way the mount fetch (staleTime 0) paints immediately.
// Watchdog cadence + staleness threshold. The board's lastActivityAt can legitimately lead the rendered
// tail by a couple seconds (the two ride different reads of the same JSONL), so only a LARGER lead is a
// real delivery miss. A genuine miss self-heals on the first refetch (it pulls the whole transcript); the
// attempt cap stops us hammering when the lead is a benign tail-advance with nothing new to render.
const WATCHDOG_MS = 7000
const STALE_MS = 5000
const MAX_HEAL_ATTEMPTS = 3

export function useTranscript(slug: string, opts: { poll: boolean }) {
  const qc = useQueryClient()
  const snap = useSnapshot(store)
  const socket = snap.socketTranscripts
  const transportFallback = snap.socketTranscriptFallbacks[slug]
  // Liveness is NOT this hook's job anymore: transcript-live.ts watches the query cache and keeps every
  // OBSERVED ["transcript", slug] fresh centrally (socket subscription within budget, activity-edge
  // refetch beyond, nothing for typed-fallback slugs). Mounting this hook is what registers the observer.
  // `poll` retains exactly one meaning: the 1.5s HTTP interval for a RUNNING thread when the socket is
  // down (SSE fallback) — an at-rest thread must never interval-poll.

  const query = useQuery({
    queryKey: ["transcript", slug],
    // Preserve optimistic sends across a poll refetch too (not just the socket push) — see mergeOptimistic.
    queryFn: async () => {
      const res = await rpc.threadTranscript({ slug })
      const prev = qc.getQueryData<TranscriptData>(["transcript", slug])
      const reconciled = reconcileLatestPage(prev as PaginatedTranscriptData | undefined, res)
      return {
        ...reconciled,
        // preserveMessageIdentity: unchanged messages keep their previous object so memoized rows
        // bail out of re-render — a refetch repaints only what actually changed.
        messages: preserveMessageIdentity(
          prev?.messages,
          mergeOptimistic(prev?.messages, reconciled.messages as ChatMessage[]),
        ),
      }
    },
    // A typed per-subscription transport rejection (logical overflow or aggregate read budget) is
    // deliberately NON-retrying: keep the last complete copy visible and let the banner offer explicit
    // one-shot refresh/retry actions. Ordinary SSE fallback still polls exactly as before.
    refetchInterval: opts.poll && !socket && !transportFallback ? 1500 : false,
    refetchOnWindowFocus: !transportFallback,
  })

  // LEVEL-TRIGGERED freshness watchdog — the self-healing complement to the edge-triggered push/poll. A
  // missed edge (a dropped subscription across a reconnect/HMR, a suppressed broadcast, a mount-order flip)
  // would otherwise wedge a live view FOREVER with no recovery — the class of bug behind "it needed a hard
  // reload". Every WATCHDOG_MS (cheap: one timestamp compare, no network unless stale) we check the board's
  // lastActivityAt for this slug (delivered independently over the board-delta channel) against the newest
  // rendered message; a lead beyond STALE_MS means the transcript is provably behind, so we force a pull
  // refetch (always works — plain HTTP) AND re-establish the subscription (fixes a lost server-side sub for
  // FUTURE pushes), and warn a structured breadcrumb so the underlying delivery bug stays diagnosable. Lives
  // in the hook so every consumer (main ChatView + the drawer's) inherits the invariant.
  useEffect(() => {
    // Armed whenever the surface has a live source to guard: the SSE interval poll, or (socket mode) the
    // centrally-managed subscription/edge-refetch — a missed push edge would otherwise freeze the view
    // exactly like the pre-subscription bug this watchdog exists for.
    if ((!opts.poll && !socket) || transportFallback) return // typed pause stays manual; never turn the watchdog into a full-read loop
    let inFlight = false
    let attempts = 0
    let lastHealNewest: string | undefined
    const tick = () => {
      if (inFlight) return
      const activity = threadBySlug(store.board as BoardSnapshot | null, slug)?.lastActivityAt
      const newest = newestRenderedAt(qc.getQueryData<TranscriptData>(["transcript", slug])?.messages)
      if (!isTranscriptStale(activity, newest, STALE_MS)) {
        attempts = 0 // caught up — re-arm
        return
      }
      // Stale. If the transcript advanced since our last heal, re-arm; otherwise the lead is likely a benign
      // tail-advance (sidecar records with nothing renderable) — cap attempts so we don't hammer forever.
      if (newest !== lastHealNewest) attempts = 0
      if (attempts >= MAX_HEAL_ATTEMPTS) return
      attempts++
      lastHealNewest = newest
      const lagMs = activity ? Date.parse(activity) - (newest ? Date.parse(newest) : 0) : 0
      console.warn("[fray] transcript watchdog: stale view — self-healing", { slug, lagMs, transport: socket ? "socket" : "poll", attempt: attempts })
      if (socket) {
        // Re-establish the server-side subscription (drop→re-add on the ref count) so future pushes resume.
        unsubscribeTranscript(slug)
        subscribeTranscript(slug)
      }
      inFlight = true
      void query.refetch().finally(() => {
        inFlight = false
      })
    }
    const iv = setInterval(tick, WATCHDOG_MS)
    return () => clearInterval(iv)
    // query.refetch is stable across renders (react-query); slug/poll/socket cover the meaningful deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, opts.poll, socket, transportFallback])

  return {
    ...query,
    transportFallback: transportFallback
      ? transportFallback.kind === "payload-too-large"
        ? {
            kind: "payload-too-large" as const,
            actualBytes: transportFallback.actualBytes,
            maxBytes: transportFallback.maxBytes,
          }
        : {
            kind: "read-budget" as const,
            scope: transportFallback.scope,
            retryAfterMs: transportFallback.retryAfterMs,
          }
      : null,
    retryLiveUpdates: () => retryTranscriptSocket(slug),
  }
}

// A live/stale sub-agent's OWN transcript, for the drill-in drawer. Keyed by (slug, id) so distinct
// children never collide, and polled ONLY while the child is still running — once the RPC reports
// stale/gone the drawer is showing a settled (or unavailable) transcript, so we stop hammering the
// connection budget. The predicate reads the last result so polling self-cancels as the state flips.
export function useSubAgentTranscript(slug: string, id: string) {
  return useQuery({
    queryKey: ["subAgentTranscript", slug, id],
    queryFn: () => rpc.subAgentTranscript({ slug, id }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 2500 : false),
  })
}

export function useBackgroundShellOutput(slug: string, id: string) {
  return useQuery({
    queryKey: ["backgroundShellOutput", slug, id],
    queryFn: () => rpc.backgroundShellOutput({ slug, id }),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 1500 : false),
  })
}

// The ops strip's LIVE OUTPUT COUNTER: lines produced, per shell row on screen, refreshed while any of
// them is still running. One batched request per poll for the whole strip.
//
// The key carries the sorted ids, so a strip that gains or loses a shell re-keys rather than serving
// the old set's answer; sorting keeps a re-ordered board frame from thrashing the cache.
//
// Polling continues while any named shell is RUNNING — including one that has no readable output yet
// (`lines: null`), which is the state a shell sits in between its tool_use and its launch ack. Keying
// the stop on "did anything report a number" instead stopped the poll during that window and the
// counter never arrived. It stops when every named shell has settled, and when the server knows none
// of them at all: a settled shell's line count cannot move again.
//
// SCOPED TO WHAT IS RENDERED, on purpose: this is the reason the reading is not a board field. An
// operator looking at one thread pays for that thread's shells and nothing else, and closing the view
// unmounts the poll entirely.
export function useBackgroundShellLines(slug: string, ids: readonly string[]): Map<string, number> {
  const key = [...ids].sort()
  const query = useQuery({
    queryKey: ["backgroundShellActivity", slug, key],
    queryFn: () => rpc.backgroundShellActivity({ slug, ids: key }),
    enabled: key.length > 0,
    refetchInterval: (q) => (q.state.data && !q.state.data.shells.some((s) => s.running) ? false : 1500),
  })
  return useMemo(
    () => new Map((query.data?.shells ?? []).flatMap((s) => (s.lines === null ? [] : [[s.id, s.lines] as const]))),
    [query.data],
  )
}

// Follow-ups are injected into the agent's terminal stdin and only surface in the transcript once the
// agent's next turn picks them up — so the message would otherwise vanish on send. Optimistically
// append it to the ["transcript", slug] cache as a user bubble tagged `queued`; the next real refetch
// (which never sets `queued`) overwrites the cache and dedupes it against the server's own copy.
export function appendQueuedMessage(
  qc: QueryClient,
  slug: string,
  text: string,
  opts: { scrollToBottom?: boolean; deliveryId?: string } = {},
) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    const messages = prev?.messages ?? []
    return { ...prev, messages: [...messages, { role: "user", text, tools: [], parts: [], queued: true, deliveryId: opts.deliveryId }] }
  })
  // Chat replies commit to the conversation tail, so they normally force the page to the bottom even
  // when the reader sent from up-thread. Queue cards opt out: their post-answer destination is the
  // recorded next queue card, and a global bottom-pin would race it. rAF lets the optimistic bubble
  // lay out before the document height is read.
  if (opts.scrollToBottom !== false && typeof window !== "undefined") {
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }))
  }
}

// Roll back the optimistic bubble appendQueuedMessage added, when the send actually FAILS. Removes
// the LAST still-queued message whose text matches (only optimistic entries carry `queued`, so a
// server-confirmed copy is never touched). Keeps the optimistic UX honest: a failed follow-up no
// longer leaves a phantom "sent" bubble the reload silently erases.
export function removeQueuedMessage(qc: QueryClient, slug: string, text: string, deliveryId?: string) {
  qc.setQueryData<TranscriptData>(["transcript", slug], (prev) => {
    if (!prev?.messages?.length) return prev
    const i = prev.messages.findLastIndex((m) => m.queued && m.role === "user" && m.text === text &&
      (deliveryId === undefined || m.deliveryId === deliveryId))
    if (i === -1) return prev
    return { ...prev, messages: prev.messages.filter((_, j) => j !== i) }
  })
}
