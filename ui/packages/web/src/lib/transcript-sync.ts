import type { TranscriptMessage } from "@fray-ui/shared"

// A transcript message that may carry the client-only/queued flag (server pending OR local optimistic).
export type QueuedMessage = TranscriptMessage & { queued?: boolean }

function freshServerUserTexts(prev: QueuedMessage[], incoming: QueuedMessage[]): string[] {
  const previousSourceIds = new Set(
    prev.filter((m) => m.role === "user" && m.sourceId).map((m) => m.sourceId),
  )
  return incoming
    .filter((message) => message.role === "user" && message.sourceId && !previousSourceIds.has(message.sourceId))
    .map((message) => message.text.trim())
}

function consumedOptimisticIndexes(optimistic: QueuedMessage[], serverUserTexts: string[]): Set<number> {
  const consumed = new Set<number>()
  const separator = "\n\n"

  for (const serverText of serverUserTexts) {
    for (let start = 0; start < optimistic.length; start++) {
      if (consumed.has(start)) continue
      const first = optimistic[start].text.trim()
      if (serverText === first) {
        consumed.add(start)
        break
      }
      if (!serverText.startsWith(first)) continue
      let offset = first.length
      for (let end = start + 1; end < optimistic.length; end++) {
        if (consumed.has(end)) break
        const next = optimistic[end].text.trim()
        if (!serverText.startsWith(separator, offset) || !serverText.startsWith(next, offset + separator.length)) break
        offset += separator.length + next.length
        if (offset !== serverText.length) continue
        for (let i = start; i <= end; i++) consumed.add(i)
        break
      }
      if (consumed.has(start)) break
    }
  }
  return consumed
}

// ── Layer 3: optimistic-merge hardening (the sync audit's S1 finding) ──────────────────────────────────
// A transcript cache OVERWRITE (a poll refetch OR a socket push) must not blunt-replace an optimistic
// "queued" bubble the client appended on send but the incoming server truth doesn't yet carry — that
// blunt replace is exactly what makes a just-sent message VANISH for the window before the server's own
// copy (a pending/delivered queued message — see the server parser) shows up. So: re-append any optimistic
// queued user entry until a newly observed server user record accounts for it; drop the ones the server
// has now materialized so there's never a duplicate. With the server now carrying the message within
// ~a tick this is a short bridge, but it closes the visible swallow.
export function mergeOptimistic(prev: QueuedMessage[] | undefined, incoming: QueuedMessage[]): QueuedMessage[] {
  if (!prev?.length) return incoming
  // Server-projected pending turns also carry `queued`, but unlike client-only optimistic sends they
  // already have a stable sourceId and must never be re-appended beside the same incoming record.
  const optimistic = prev.filter((m) => m.queued && !m.sourceId && m.role === "user" && m.text.trim())
  if (!optimistic.length) return incoming
  // A newly observed server USER record (delivered OR the server's own queued copy) consumes a matching
  // optimistic entry. Every current transcript parser assigns a stable sourceId; id-less input is ignored
  // rather than using text-count heuristics that can mistake historical repeated prose for fresh delivery.
  // Codex can also materialize several consecutive sends as one user turn joined by blank lines. Consume
  // that whole run only when at least two optimistic texts reconstruct the complete server turn; a lone
  // matching paragraph inside unrelated prose is not delivery proof.
  const serverUserTexts = freshServerUserTexts(prev, incoming)
  const consumed = consumedOptimisticIndexes(optimistic, serverUserTexts)
  const unconsumed = optimistic.filter((_, i) => !consumed.has(i))
  return unconsumed.length ? [...incoming, ...unconsumed] : incoming
}

// ── Per-push message identity preservation ─────────────────────────────────────────────────────────────
// Every transcript push/refetch re-parses the full window, so each message arrives as a NEW object even
// when nothing about it changed. The memoized <Message> rows key their bail-out on `m`'s identity, so an
// identity churn re-renders EVERY mounted row on EVERY push — measured ~60-75ms of main-thread block per
// push on an ~130-row drawer, i.e. a solid jank beat all through a streaming turn. Reuse the PREVIOUS
// render's object wherever the incoming copy is content-identical (sourceId match + deep-equal via a
// serialized signature, cached per object so the prev side is stringified once across its lifetime).
// Messages that really changed (a tool status backfill, a queued→delivered flip, tail growth) keep the
// fresh object and re-render exactly as before.
const contentSig = new WeakMap<TranscriptMessage, string>()
function sigOf(message: TranscriptMessage): string {
  let sig = contentSig.get(message)
  if (sig === undefined) {
    sig = JSON.stringify(message)
    contentSig.set(message, sig)
  }
  return sig
}

export function preserveMessageIdentity(
  prev: readonly QueuedMessage[] | undefined,
  incoming: QueuedMessage[],
): QueuedMessage[] {
  if (!prev?.length || !incoming.length) return incoming
  const prevById = new Map<string, QueuedMessage>()
  for (const message of prev) {
    if (message.sourceId) prevById.set(message.sourceId, message)
  }
  if (!prevById.size) return incoming
  let reused = false
  const out = incoming.map((message) => {
    if (message === prevById.get(message.sourceId ?? "")) return message // already the same object (optimistic re-append)
    const previous = message.sourceId ? prevById.get(message.sourceId) : undefined
    if (previous && sigOf(previous) === sigOf(message)) {
      reused = true
      return previous
    }
    return message
  })
  return reused ? out : incoming
}

// ── Level-triggered freshness watchdog (pure decision) ─────────────────────────────────────────────────
// The transport (socket push AND poll) is edge-triggered: a single missed edge — a dropped subscription
// across a reconnect/HMR, a suppressed broadcast, a mount-order flip — wedges a live view forever with no
// self-healing. The watchdog is the level-triggered complement: it compares the board's lastActivityAt for
// a slug (delivered independently over the board-delta channel) against the newest RENDERED message; a lead
// beyond the threshold means the rendered transcript is provably behind. Pure so the decision is unit-tested
// apart from the React timer/heal machinery in useTranscript.
export function isTranscriptStale(lastActivityAt: string | undefined, newestRenderedAt: string | undefined, staleMs: number): boolean {
  if (!lastActivityAt) return false // no activity marker → nothing to be behind
  const activity = Date.parse(lastActivityAt)
  if (!Number.isFinite(activity)) return false
  // No rendered message yet but the board reports activity → treat as maximally behind (rendered = epoch).
  const rendered = newestRenderedAt ? Date.parse(newestRenderedAt) : 0
  if (newestRenderedAt && !Number.isFinite(rendered)) return false // unparseable tail → don't thrash
  return activity - rendered > staleMs
}

// The newest RENDERED message timestamp: the last message that carries an `at` (scanning from the tail, so
// a trailing event/at-less line doesn't mask the real newest). undefined when nothing has a timestamp.
export function newestRenderedAt(messages: QueuedMessage[] | undefined): string | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const at = messages[i].at
    if (at) return at
  }
  return undefined
}
