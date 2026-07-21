import type { ThreadView } from "@fray-ui/shared"

export interface ThreadLifecycleAvailability {
  footer: boolean
  snooze: boolean
  archive: boolean
}

// One ownership/lifecycle decision shared by queue cards and full thread surfaces. The controls are
// deliberately not message actions: a done fence, transcript hydration, or selected tab can never
// move or duplicate them.
export function threadLifecycleAvailability(thread: ThreadView): ThreadLifecycleAvailability {
  const owned = thread.kind === "session" && thread.foreign !== true
  // `archived` mirrors the pre-state-column protocol; honor it during a rolling server/client reload.
  const archived = owned && (thread.state === "archived" || thread.archived === true)
  // An archived thread has NO lifecycle controls: there is no Reopen button (reopening is just sending
  // the thread another message), so with Snooze/Archive gone too the footer has nothing to show.
  const footer = owned && !archived
  return {
    footer,
    snooze: footer,
    archive: footer,
  }
}

// Predict whether Mark-as-done will archive IMMEDIATELY — with no "End this session?" dialog — so the
// click can dismiss the card optimistically instead of waiting out the completeThread round-trip.
// Deliberately mirrors the server's completionNeedsConfirmation (server/src/router.ts): a resting,
// human-blocked, or exited shell completes in one action; an executing turn or live background work is
// asked about first. A wrong "immediate" guess is harmless — the server still owns the verdict, and the
// caller reinstates the card + opens the dialog on a needsConfirmation reply — so this only ever errs
// toward NON-optimistic (waiting), never toward skipping a dialog the server would have shown.
export function completionArchivesImmediately(thread: ThreadView): boolean {
  // Paused-for-a-human states are explicitly safe to stop on the server, regardless of any background work.
  if (thread.runtime === "perm-prompt" || thread.pendingAsk || thread.nativeInputRequired) return true
  // An executing (or still-spawning) turn always prompts.
  if (thread.runtime === "running" || thread.runtime === "spawning") return false
  // A resting/exited shell prompts only if it still has live background sub-agents or shells.
  const busy = (op: { state: string }) => op.state === "running" || op.state === "stale"
  if (thread.subAgents?.some(busy) || thread.bgShells?.some(busy)) return false
  return true
}
