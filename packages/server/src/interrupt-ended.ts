// SUB-AGENTS ENDED BY AN INTERRUPT — the note the worker gets when "interrupt and send" kills its children.
//
// The SDK's `query.interrupt()` aborts the turn WITHOUT discarding queued input (that is what makes
// interrupt-and-send work at all — see the bridge's `interruptTurn` contract), but it also aborts every
// BACKGROUND task the turn owned: each child's sidecar flips to `stoppedByUser` at the interrupt
// instant and its transcript ends on `[Request interrupted by user]`. The runtime tells the worker
// nothing, so it goes on believing the child is live. On the nub thread
// `looks-like-my-github-account-was` (2026-09-24) two successive interrupts killed the same daemon
// sub-agent twice (01:06:21Z, 03:11:32Z); the worker parked on `agents: [abc9b9b5f0da4c677]` and was
// bumped NOT RUNNING, and the bump never reached it because each next follow-up superseded it.
//
// The fix the maintainer chose: tell the worker WHAT DIED. The router snapshots the running children
// just before it interrupts, then this module waits for the tailer to stop listing them — the note names
// only what frizz has SEEN end, never what it presumed — and enqueues one wake through the ordinary
// outbox (scheduler SOURCE 10, `interrupt-ended:<instant>`), which is quiet-window exempt and
// deliverable into the busy turn the interrupt just opened.
import type { SessionTelemetry, SubAgentView } from "./tailer.ts"
import type { Storage } from "./storage.ts"
import { enqueueInterruptEndedWake } from "./scheduler.ts"

/** A running child as it stood the instant before the interrupt: the dispatch id the tailer keys on,
 *  and what the worker knows it by. */
export interface RunningSubAgentSnapshot {
  id: string
  taskId?: string
  label: string
}

export function runningSubAgentsOf(tele: SessionTelemetry | undefined): RunningSubAgentSnapshot[] {
  return (tele?.subAgents ?? [])
    .filter((a: SubAgentView) => a.state === "running")
    .map((a) => ({ id: a.id, ...(a.taskId ? { taskId: a.taskId } : {}), label: a.label }))
}

export interface InterruptEndedDeps {
  tailer: { get(slug: string): SessionTelemetry | undefined }
  storage: Storage
  now?: () => number
  /** How often the tailer is re-read while the children are still listed. */
  pollMs?: number
  /** How long to keep looking before giving up on a child the tailer still shows running — it survived,
   *  or the tailer is slower than this; either way it is not reported, which is the pre-2026-09-24
   *  behaviour and never a false claim. */
  maxWaitMs?: number
  log?: (line: string) => void
}

/**
 * Wait for the tailer to confirm which of `before` ended, then enqueue the note naming exactly those.
 * Resolves when the note is queued or the wait runs out. Never throws: a failure here must not
 * surface on the operator's send, which succeeded before this started.
 */
export async function noteSubAgentsEndedByInterrupt(
  deps: InterruptEndedDeps,
  input: { slug: string; sessionId: string; before: readonly RunningSubAgentSnapshot[]; interruptedAtMs: number },
): Promise<void> {
  if (input.before.length === 0) return
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? 1_000
  const maxWaitMs = deps.maxWaitMs ?? 30_000
  const startedAt = now()
  try {
    for (;;) {
      const stillRunning = new Set(runningSubAgentsOf(deps.tailer.get(input.slug)).map((a) => a.id))
      const gone = input.before.filter((a) => !stillRunning.has(a.id))
      const settled = gone.length === input.before.length || now() - startedAt >= maxWaitMs
      if (settled) {
        if (gone.length > 0) {
          enqueueInterruptEndedWake(deps.storage, {
            slug: input.slug, sessionId: input.sessionId, interruptedAtMs: input.interruptedAtMs,
            agents: gone.map((a) => ({ ...(a.taskId ? { taskId: a.taskId } : {}), label: a.label })), nowMs: now(),
          })
          deps.log?.(`interrupt: queued a note to ${input.slug} — ${gone.length} of ${input.before.length} background sub-agent(s) ended`)
        }
        return
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } catch (err) {
    deps.log?.(`interrupt: could not note ended sub-agents on ${input.slug}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
