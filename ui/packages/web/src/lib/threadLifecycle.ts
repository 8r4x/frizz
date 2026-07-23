import type { CompletionHold, ThreadView } from "@fray-ui/shared"

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

// One named group of work the confirmation is holding on — "2 sub-agents", with the labels beneath it.
export interface CompletionHoldGroup {
  kind: "agent" | "shell"
  heading: string // "1 sub-agent" / "3 background shells"
  // The ops the server named (already capped). `stale` is carried through rather than flattened: it
  // is not proof the op stopped — which is why it holds the completion — but claiming a silent child
  // is actively running would overstate what the tailer knows.
  items: { label: string; stale: boolean }[]
  overflow: number // labels the server withheld; >0 renders a "+N more" line
}

export interface CompletionHoldSummary {
  lead: string // the sentence that names WHY Done stopped to ask
  groups: CompletionHoldGroup[]
  trailer: string // what "End session & mark done" will actually do
}

// The confirm dialog's copy. "This thread is still running" answers nothing the human can act on —
// they clicked Done precisely because they thought it was finished — so the reason gets spelled out:
// an executing turn, a specific count of live sub-agents/background shells with their labels, or an
// unreadable transcript. `hold` absent (an older server, or a mispredicted needsConfirmation with no
// evidence attached) degrades to the original generic sentence rather than asserting something false.
export function completionHoldSummary(hold: CompletionHold | undefined): CompletionHoldSummary {
  const generic = {
    lead: "This thread is still running.",
    groups: [],
    trailer: "Marking it done will stop its agent session, then move it to Done.",
  }
  if (!hold) return generic
  const groups = [
    holdGroup("agent", "sub-agent", hold.subAgents, hold.subAgentCount),
    holdGroup("shell", "background shell", hold.bgShells, hold.bgShellCount),
  ].filter((group): group is CompletionHoldGroup => group !== null)
  if (hold.unobservable) {
    return {
      lead: "This session is live, but its transcript can’t be read right now — it may still be working.",
      groups,
      trailer: "Marking it done will stop the session anyway, then move it to Done.",
    }
  }
  if (!hold.turnInFlight && groups.length === 0) return generic // defensive: a hold with no evidence
  const lead = hold.turnInFlight
    ? groups.length > 0
      ? "The agent is mid-turn, and it still owns background work:"
      : "The agent is mid-turn — it’s executing right now."
    : "The agent is resting, but the background work it launched is still running:"
  return {
    lead,
    groups,
    trailer: groups.length > 0
      ? "Marking it done will stop the session and everything running under it, then move it to Done."
      : "Marking it done will stop its agent session mid-turn, then move it to Done.",
  }
}

function holdGroup(
  kind: CompletionHoldGroup["kind"],
  noun: string,
  ops: CompletionHold["subAgents"],
  count: number,
): CompletionHoldGroup | null {
  // The count is authoritative — the label list is capped server-side and can be shorter.
  const total = Math.max(count, ops.length)
  if (total === 0) return null
  return {
    kind,
    heading: `${total} ${noun}${total === 1 ? "" : "s"}`,
    items: ops.map((op) => ({ label: op.label, stale: op.state === "stale" })),
    overflow: Math.max(0, total - ops.length),
  }
}
