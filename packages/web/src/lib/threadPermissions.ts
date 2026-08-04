// Foreign sessions have no Frizz-owned terminal. Running registered sessions remain editable because
// the server persists first and uses the backend's in-band control rather than restarting the worker.
export interface ThreadPermissionState {
  // Which runtime this row is. The two apply a permission change by completely different means, so
  // they need different gates — see threadPermissionBlockedReason. Absent/unknown reads as Claude,
  // i.e. the strict side, so an unlabelled row can never be loosened by accident.
  backend?: string
  foreign?: boolean
  runtime?: string
  pendingAsk?: unknown
  nativeInputRequired?: unknown
  subAgents?: readonly { state: string }[]
  bgShells?: readonly { state: string }[]
  permissionPending?: unknown
  permissionChangePending?: boolean
  profileChangePending?: boolean
  runtimeControlPending?: boolean
  controlError?: string
}

export type ThreadComposerStatus = {
  kind: "profile-error"
  message: string
}

export function threadComposerStatus(profileError?: string): ThreadComposerStatus | null {
  if (profileError?.trim()) return { kind: "profile-error", message: `Profile controls unavailable: ${profileError.trim().slice(0, 160)}` }
  return null
}

export function threadPermissionBlockedReason(thread: ThreadPermissionState): string | null {
  if (thread.foreign) return "Read-only external thread"
  if (thread.permissionChangePending || thread.permissionPending) return "A permission change is already in progress"
  if (thread.profileChangePending) return "A model and effort change is already in progress"
  if (thread.runtimeControlPending) return "Another runtime control is already in progress"
  if (thread.pendingAsk || thread.nativeInputRequired || thread.runtime === "perm-prompt") {
    return "Resolve the current terminal approval or question first"
  }
  // ---- everything below this line fences the CLAUDE reattach specifically ----
  // Claude applies a permission change by RESTARTING the tmux pane (permission-controller.ts does a
  // controlled idle reattach and inspects the composer first so it does not destroy an unsent draft).
  // That genuinely cannot happen while a turn — or a sub-agent, or a background shell — is running:
  // the restart would kill the work.
  //
  // A Codex app-server row has no pane and no restart. Its change rides `thread/settings/update`,
  // which the app-server accepts MID-TURN and applies from the next turn on (verified live), exactly
  // the "it just queues up like anything else" behaviour the terminal UI gives you. Fencing it on a
  // running turn was the Claude gate leaking onto a runtime that never needed it, and the operator was
  // right that it made no sense. The server still fails closed on its own: an unreachable bridge falls
  // back to persist-only and answers "saved for the next resume".
  if (thread.backend === "codex") return null
  const unresolvedOps = [...(thread.subAgents ?? []), ...(thread.bgShells ?? [])].filter((op) => op.state === "running" || op.state === "stale").length
  if (unresolvedOps > 0) return `Wait for ${unresolvedOps} unresolved background operation${unresolvedOps === 1 ? "" : "s"}`
  if (thread.runtime === "running" || thread.runtime === "spawning") return "Wait for the current turn to finish"
  return null
}

// Composer submission is intentionally less restrictive than runtime profile/permission changes: any
// durable runtime-control owner fences it, but an ordinary in-flight turn does not.
export function threadFollowUpBlocked(thread: ThreadPermissionState): boolean {
  return thread.permissionChangePending === true || thread.permissionPending !== undefined ||
    thread.profileChangePending === true ||
    thread.runtimeControlPending === true
}

// Three outcomes, three honest sentences. "next-turn" exists because a Codex change made against a
// RUNNING turn is accepted and durable but does not reach the turn already executing — verified live:
// a turn that attempted a write after the flip to danger-full-access was still refused and said so.
// Claiming "applied to the live session" there would be a lie the operator could catch in one turn.
export function threadPermissionEffectMessage(
  effect: "applied" | "next-turn" | "next-resume",
  backend: "claude" | "codex",
): string {
  const noun = backend === "codex" ? "Sandbox" : "Permissions"
  if (effect === "applied") return `${noun} applied to the live session`
  if (effect === "next-turn") return `${noun} applied — takes effect on the next turn`
  return `${noun} saved for the next resume`
}
