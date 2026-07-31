import type { QueryClient } from "@tanstack/react-query"
import type { ThreadView } from "@fray-ui/shared"
import { showToast } from "../store.ts"
import { sendEagerFollowUp } from "./eagerComposerSubmission.ts"

// THE "Restart worker" verb — retire the thread's live `claude` process and continue the SAME
// conversation in a freshly started one.
//
// Why it has to exist at all: a worker inherits its plugin (and therefore its HOOKS) and its system
// prompt at process start, and can never pick either up afterwards. Measured, not assumed — patching a
// Stop hook into a live worker's plugin dir mid-session does nothing, while a brand-new process on that
// same patched dir runs it. So a worker dispatched before a fray build shipped a hook keeps running
// without it for as long as its process lives, however many turns it takes. Nothing the operator can
// type reaches that; only replacing the process does.
//
// It is NOT "start a fresh agent": the transcript is on disk, so the cold resume replays the whole
// conversation into the new process, and the server rebuilds the worker system prompt on the way in.
// The thread keeps its history, its scratchpad and its identity — it just comes back on current tooling.
//
// Delivering a message is the point rather than an afterthought. Retiring the daemon alone would leave
// the operator staring at a card where nothing visibly happened until the thread's next natural wake;
// carrying a continuation makes the restart the observable act it reads as.
export const RESTART_WORKER_MESSAGE =
  "Your worker process was restarted so it picks up fray's current tooling (hooks and worker contract). Re-read your scratchpad, then continue exactly where you left off."

// A restart kills the parent's in-memory sub-agents, and fray's completion invariant says an agent runs
// to its terminal return — so a worker with live background work is off limits until it finishes. This
// mirrors the carve-out needsFreshProcessForLimit already makes server-side, and the server re-checks
// it: this is the reason the verb is disabled, not the enforcement.
export function restartWorkerBlockedReason(thread: ThreadView): string | null {
  if (thread.kind !== "session") return null
  const running = thread.subAgents.filter((agent) => agent.state === "running").length
  if (running === 0) return null
  return running === 1
    ? "One sub-agent is still running — restarting would kill it"
    : `${running} sub-agents are still running — restarting would kill them`
}

export function restartWorker(queryClient: QueryClient, slug: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const started = sendEagerFollowUp(queryClient, slug, RESTART_WORKER_MESSAGE, {
      freshProcess: true,
      onSuccess: () => { showToast("Restarting worker…"); resolve() },
      onRollback: () => resolve(),
      failureToast: (message) => `Restart failed: ${message.slice(0, 80)}`,
    })
    // Unreachable while the message is a non-empty constant, but a caller's `finally` must never be
    // stranded on a send that was refused before it ever started.
    if (!started) resolve()
  })
}
