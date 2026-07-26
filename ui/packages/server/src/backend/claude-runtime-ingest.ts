// The consumer for the structured event stream the Claude broker has always received and thrown away.
//
// The broker daemon runs the Agent SDK with `persistSession: true`, so the SDK writes the session
// JSONL to disk AND hands fray the same messages as typed events over the socket. Until now the
// bridge forwarded them to a `deps.onEvent` that context.ts never supplied, so every one was dropped
// and the tailer re-derived the identical state by polling that file from disk on a 1–10 s adaptive
// tick. This module is the handler that was missing (plans/t3code-adoption-spike.md item 1).
//
// It does NOT replace the tailer's fold. That fold is the corpus-verified authority for the things
// the board actually renders — signal fences, sub-agents, background shells, auto-titles, delivery
// correlation — and the broker's event projection is strictly lossier than the raw records. Swapping
// one for the other would be a rewrite of the board's derivation with no way to prove it neutral.
// Instead the event stream does the two things a disk poll structurally cannot:
//
//  1. NUDGE. An event means "this session just changed", so the tailer re-reads it now instead of on
//     the next tick. Same fold, same derivation, ~0 ms instead of up to 10 s. This is the change the
//     operator sees: a thread that finishes its turn lands in the queue immediately.
//
//  2. TURN LIVENESS. The SDK states outright when a turn began and when it ended. The tailer's
//     `computeTurn` has to infer both from `stop_reason`, and for an unknown/missing stop_reason it
//     falls back to a 5 s silence backstop — a guess. A `result` event is not a guess. See
//     `resolveRuntimeTurn` for the deliberately narrow way that signal is allowed to matter.
//
// The strict rule for (2), because it is where a DX regression would live: the runtime signal may
// only ever RESOLVE AN AMBIGUITY the fold has not settled. It must never override folded evidence.
// The SDK emits `result` over the socket at some point relative to the final assistant record
// reaching disk, and if a "turn is over" signal were allowed to beat that record to the board, the
// thread would queue with a stale last message and no parsed fence. So a folded `tool_use` (the model
// is definitively mid-tool) always wins over a runtime "settled", and only the backstop case — where
// the fold has no opinion and was going to time out into `idle` anyway — is short-circuited.
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import { createDrainableWorker, type DrainableWorker, type ReceiptBus } from "@fray-ui/shared"

/** What the SDK says about the session's turn right now, independent of what is on disk. */
export type ClaudeRuntimeTurn = "running" | "settled"

export interface ClaudeRuntimeLiveness {
  turn: ClaudeRuntimeTurn
  /** ms epoch of the event that produced this reading. */
  at: number
  /** Events ingested for this session since it was bound — a cheap "is anything arriving at all". */
  events: number
}

/** Runtime milestones published for tests and harnesses. NOT part of the production event model. */
export type ClaudeRuntimeReceipt =
  | { type: "claude.runtime.event"; slug: string; sessionId: string; kind: ClaudeQueryEvent["kind"] }
  | { type: "claude.runtime.turn.started"; slug: string; sessionId: string }
  | { type: "claude.runtime.turn.settled"; slug: string; sessionId: string; isError: boolean }
  | { type: "claude.runtime.session.released"; sessionId: string }

export interface ClaudeRuntimeIngestDeps {
  /** Ask the tailer to re-read now. Coalesced on its side; safe to call on every event. */
  nudge(slug: string): void
  /** Optional milestone sink for integration tests. Absent in production wiring. */
  receipts?: ReceiptBus<ClaudeRuntimeReceipt>
}

export interface ClaudeRuntimeIngest {
  /** The `ClaudeBrokerBridgeDeps["onEvent"]` handler. */
  onEvent(slug: string, sessionId: string, event: ClaudeQueryEvent): void
  /** The SDK's own reading of this session's turn, or undefined if nothing has been ingested. */
  liveness(sessionId: string): ClaudeRuntimeLiveness | undefined
  /** Forget a session (replaced or deleted) so a later same-slug dispatch starts clean. */
  release(sessionId: string): void
  /** Resolves once every event handed to `onEvent` so far has been folded. Tests only. */
  drain(): Promise<void>
  close(): void
}

// Which events mean "a turn is underway". `init` is session setup, not a turn; `prompt-suggestion`
// and `other` are sidecar chatter. A sub-agent's assistant/user event (parentToolUseId set) still
// means the PARENT turn is running — the parent is blocked inside its Task tool call.
function turnSignal(event: ClaudeQueryEvent): ClaudeRuntimeTurn | undefined {
  if (event.kind === "assistant") return "running"
  if (event.kind === "user") return "running"
  if (event.kind === "result") return "settled"
  return undefined
}

export function createClaudeRuntimeIngest(deps: ClaudeRuntimeIngestDeps): ClaudeRuntimeIngest {
  const live = new Map<string, ClaudeRuntimeLiveness>() // keyed by session id
  // Serialized so `drain()` means something: after it resolves, every event handed in has been
  // folded and its nudge issued. Without that a harness is back to sleeping and hoping.
  const worker: DrainableWorker<{ slug: string; sessionId: string; event: ClaudeQueryEvent }> =
    createDrainableWorker((item) => {
      const now = Date.now()
      const prior = live.get(item.sessionId)
      const signal = turnSignal(item.event)
      live.set(item.sessionId, {
        turn: signal ?? prior?.turn ?? "running",
        at: now,
        events: (prior?.events ?? 0) + 1,
      })
      deps.receipts?.publish({ type: "claude.runtime.event", slug: item.slug, sessionId: item.sessionId, kind: item.event.kind })
      if (signal === "running" && prior?.turn !== "running") {
        deps.receipts?.publish({ type: "claude.runtime.turn.started", slug: item.slug, sessionId: item.sessionId })
      }
      if (signal === "settled" && prior?.turn !== "settled") {
        const isError = item.event.kind === "result" ? item.event.isError : false
        deps.receipts?.publish({ type: "claude.runtime.turn.settled", slug: item.slug, sessionId: item.sessionId, isError })
      }
      // Every event is a "this session changed" signal, including the ones that carry no turn
      // meaning: an `other` event still corresponds to a record the SDK just wrote to disk.
      deps.nudge(item.slug)
    })

  return {
    onEvent(slug, sessionId, event) { worker.enqueue({ slug, sessionId, event }) },
    liveness: (sessionId) => live.get(sessionId),
    release(sessionId) {
      live.delete(sessionId)
      deps.receipts?.publish({ type: "claude.runtime.session.released", sessionId })
    },
    drain: () => worker.drain(),
    close() { worker.close(); live.clear() },
  }
}

/**
 * How a runtime turn reading is allowed to affect the folded one. Pure, so the rule is testable on
 * its own — this is the single place the "never override folded evidence" invariant lives.
 *
 * @param folded    what `computeTurn` derived from the transcript
 * @param backstopped  true when `folded === "in-flight"` ONLY because the unknown-stop_reason 5 s
 *                     backstop has not elapsed — i.e. the fold has no real evidence either way
 * @param runtime   the SDK's reading, or undefined when there is none
 */
export function resolveRuntimeTurn(
  folded: "in-flight" | "idle",
  backstopped: boolean,
  runtime: ClaudeRuntimeTurn | undefined,
): "in-flight" | "idle" {
  if (!runtime) return folded
  // The SDK says a turn is underway and the transcript has not caught up (the user record for a
  // just-delivered follow-up is not on disk yet). Safe in the only direction that matters: it can
  // never fire a premature turn-done, it just stops the board showing `idle` for a beat.
  if (runtime === "running" && folded === "idle") return "in-flight"
  // The SDK says the turn is over and the fold is only holding `in-flight` on the 5 s silence guess.
  // Short-circuit the guess. A fold reading `tool_use` — real evidence the model is mid-tool — is
  // deliberately NOT overridden: there the runtime is simply ahead of the disk, and trusting it
  // would queue the thread before its final message (and its signal fence) has been folded.
  if (runtime === "settled" && backstopped) return "idle"
  return folded
}
