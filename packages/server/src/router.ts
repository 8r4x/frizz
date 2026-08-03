import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { query, mutation } from "@fray-ui/rpc/server"
import {
  BoardSnapshot,
  AdoptThreadInput,
  AdoptThreadResult,
  DispatchInput,
  FollowUpInput,
  UnqueueFollowUpInput,
  UnqueueFollowUpResult,
  SetThreadRecurringPromptInput,
  SetOwnThreadRecurringPromptInput,
  ThreadPluginReloadResult,
  SetThreadSnoozeInput,
  ConfirmAwaitingInput,
  canonicalSnoozeInstant,
  GithubStatus,
  GithubListInput,
  GithubListResult,
  GithubBatchInput,
  GithubBatchResult,
  Settings,
  TranscriptMessage,
  TranscriptPage,
  TranscriptEarlierInput,
  CodexModel,
  QuotaSnapshot,
  AuthSnapshot,
  AccountLogoutInput,
  AccountLogoutResult,
  AccountLoginStartInput,
  AccountLoginStartResult,
  AccountLoginStatusInput,
  AccountLoginStatusResult,
  RenameThreadInput,
  AiRenameThreadInput,
  AiRenameThreadResult,
  SetThreadPermissionInput,
  SetThreadPermissionResult,
  ThreadProfileOptionsInput,
  ThreadProfileOptionsResult,
  SetThreadProfileInput,
  SetThreadProfileResult,
  DispatchPreferences,
  SetDispatchPreferenceInput,
  ListInteractionsInput,
  ListInteractionsResult,
  GetInteractionInput,
  GetInteractionResult,
  ResolveInteractionInput,
  ResolveInteractionResult,
  CancelInteractionInput,
  CancelInteractionResult,
  CompletionHold,
  type InteractionRecord,
  type ThreadView,
  ThreadSlug,
  isDirectSubAgent,
} from "@fray-ui/shared"
import { needsFreshProcessForLimit, type AppContext } from "./context.ts"
import { appServerTurnStalled } from "./board.ts"
import { runThreadUpdate } from "./fray.ts"
import { repairThreadFile } from "./repair.ts"
import { reopenArchivedThreadForFollowUp, resumeThread, wakeParkedThreadForFollowUp } from "./resume.ts"
import { appendDelivery, cancelDelivery, deliveryItem, hasDelivery, retireOutstandingDeliveries } from "./delivery-ledger.ts"
import {
  readEarlierThreadTranscriptPage,
  readLatestThreadTranscriptPage,
  readTranscriptFile,
  readCodexTranscriptFile,
  projectTranscriptPageAgentLifecycles,
} from "./transcript.ts"
import { openExternalUrl } from "./open-external.ts"
import { openLocalFile, resolveOpenableFile } from "./local-file.ts"
import { openableFileRoots } from "./project.ts"
import { ghInstalled, ghAuthed, ghRepo, listItems, hydrateIssue, hydratePr, renderGithubPrompt, effectiveTemplate, DEFAULT_ISSUE_PROMPT, DEFAULT_PR_PROMPT } from "./github.ts"
import { slugify, resolveSlug, resolveLegacyThreadFile, scratchpadRelPath, loadWorkerPrompt, scratchpadOrientation, frayConfigBlock } from "./dispatch.ts"
import { readCodexModels } from "./backend/codex-models.ts"
import { codexSandbox } from "./backend/codex.ts"
import type { CodexSandboxMode } from "./backend/codex-app-server.ts"
import type { ClaudePermissionMode } from "./backend/claude-agent-sdk-protocol.ts"
import { readQuota } from "./quota.ts"
import { readAuthSnapshot } from "./backend/auth-status.ts"
import { liveThreadsForBackend, runProviderLogout } from "./backend/account-actions.ts"
import { threadProfileOptions, validateThreadProfile } from "./backend/thread-profiles.ts"
import { adoptionRuntimeBinding, type AdoptionPaneLookup, type ExpectedAdoptionPane } from "./adoption-recovery.ts"
import { awaitingFenceIdentity, isActionableAwaitingHint } from "./awaiting.ts"
import { getDispatchPreferences, setDispatchPreference } from "./dispatch-preferences.ts"
import { isBrokerClaudeRow, type SessionRow, type Storage } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"
import { resolvePlanFile, deletePlanFile } from "./plan-files.ts"
import { providerResumeCommand } from "./external-terminal.ts"
import { backgroundShellLineCount, readBackgroundShellOutput } from "./background-shell-output.ts"
import { projectRetiredBackgroundOps, retiredOpsFor } from "./transcript.ts"

const SlugInput = z.object({ slug: ThreadSlug }).strict()

// GitHub is a delayed confirmation flow, so validate its captured tuple again at the final server
// boundary. This intentionally rejects stale model/effort pairs; neither is normalized, clamped, or
// replaced with Settings defaults. Permission is NOT part of the tuple: dispatch stamps it server-side
// (workerDispatchPermission — the non-interactive floor, raised to bypass only when Settings asks).
export function validateGithubDispatchProfile(input: z.infer<typeof GithubBatchInput>): void {
  validateThreadProfile(input.backend, input.model, input.effort)
}

export function githubDispatcherRequest(
  input: z.infer<typeof GithubBatchInput>,
  item: { prompt: string; title: string; slug: string },
): {
  payload: z.infer<typeof DispatchInput>
  options: { backend: z.infer<typeof GithubBatchInput>["backend"] }
} {
  return {
    payload: {
      ...item,
      backend: input.backend,
      model: input.model,
      effort: input.effort,
    },
    options: { backend: input.backend },
  }
}

export function hasUnresolvedBackgroundOps(thread: {
  subAgents: readonly { state: string; depth?: number }[]
  bgShells: readonly { state: string }[]
}): boolean {
  // Direct children only — a descendant row is surfaced for rendering and never moves thread state
  // (see isDirectSubAgent). Its ancestor's row already represents the same unresolved work.
  return thread.subAgents.some((op) => isDirectSubAgent(op) && (op.state === "running" || op.state === "stale")) ||
    thread.bgShells.some((op) => op.state === "running" || op.state === "stale")
}

export function hasPendingPermissionChange(row: { permission_pending?: unknown } | undefined): boolean {
  return row?.permission_pending !== null && row?.permission_pending !== undefined
}

interface RegisteredRuntimeTerminator {
  findExpectedAdoptionPane(expected: ExpectedAdoptionPane): AdoptionPaneLookup
  killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean
  killSession(slug: string): void
  isLive(slug: string): boolean
}

// The terminator completeThread runs on. Its standalone liveness check trusts the BATCHED cache (one
// `list-panes -a` answers every session) for a "live" verdict — the common resting-shell path — instead of
// the default uncached isLive (its own `list-panes` exec, run before AND after the kill). Those stacked
// sync tmux execs on the request path are exactly what starved the event loop and pushed Mark-as-done
// latency to seconds while an agent streamed (see tmux.ts liveness cache). A cached "dead" verdict is
// CONFIRMED with one fresh uncached check before it is trusted: paneMap() caches an all-dead map for its
// 900ms TTL after a transient `list-panes` throw, and archiving a still-live shell without stopping it
// would orphan it. So live→fast, dead→verified. killSession invalidates the cache, so the post-kill
// re-check reads fresh too — the "prove the runtime stopped before recording Done" invariant is preserved.
// The adoption path (findExpectedAdoptionPane) is unchanged; only the standalone isLive check moves here.
// A no-op terminator. Every live row is headless and answered by the codex/claude branches; a
// pre-cutover row's pane is long gone, so there is nothing left for this to stop.
const cachedLivenessTerminator: RegisteredRuntimeTerminator = {
  findExpectedAdoptionPane: () => ({ kind: "absent" }),
  killExpectedAdoptionPane: () => true,
  killSession: () => {},
  isLive: () => false,
}

// The other terminator. An app-server Codex thread has NO tmux pane: its worker is a TURN running
// inside the shared codex app-server, which now lives in a DETACHED daemon that deliberately outlives
// the fray runtime. Routed through the tmux terminator it takes stopRegisteredRuntime's `unbound`
// branch, issues `kill-session` for a session that never existed, and reports "stopped" — while the
// turn keeps running, burning tokens and touching the repo with no fray-side owner and no UI trace.
// Before the daemon worked this was masked, because the app-server died with the runtime. `turn/interrupt`
// over the bridge is the only thing that actually stops it. (Subset of CodexAppServerBridge so the
// router does not depend on the whole bridge and a test can substitute a stub.)
export interface CodexTurnTerminator {
  turnLiveness(threadSlug: string, sessionId: string): { bridgeTurn: boolean } | undefined
  interruptTurn(threadSlug: string, sessionId: string): Promise<{ interrupted: boolean }>
}

// Which rows the bridge, not tmux, owns. A LEGACY tmux Codex row — dispatched pre-cutover, `codex_runtime`
// NULL, migrated only when a follow-up first touches it (see followUp) — really does own a tmux pane, so
// it keeps the tmux terminator. This is deliberately the OPPOSITE test from setThreadPermission /
// setThreadProfile: those branch on the BACKEND alone because the controller they avoid is Claude-only and
// would parse a legacy Codex TUI as a Claude composer, so a legacy row must not reach it. Here the tmux
// path is CORRECT for a legacy row and wrong only for a migrated app-server one, so the runtime column —
// the thing that actually says where the worker lives — is the right discriminator.
export function isAppServerCodexRow(row: Pick<SessionRow, "backend" | "codex_runtime">): boolean {
  return row.backend === "codex" && row.codex_runtime === "app-server"
}

// The Claude twin of the codex turn terminator. A broker-backed Claude row also has NO tmux pane: its
// worker is a Claude session owned by a DETACHED daemon that outlives fray. Routed through the tmux
// terminator it would take stopRegisteredRuntime's `unbound` branch, `kill-session` a pane that never
// existed, and report "stopped" while the ownerless daemon keeps running — the same phantom-stop the
// codex terminator exists to prevent. releaseSession SIGTERMs the daemon by record (even when this fray
// process holds no live socket, e.g. after a restart); isDaemonAlive reports whether one was there to
// stop. (Subset of ClaudeAgentBrokerBridge so the router needn't depend on the whole bridge.)
export interface ClaudeBrokerTerminator {
  isDaemonAlive(sessionId: string): boolean
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): boolean
}


// The bridge is already the board's authority on whether a codex turn is live (context.ts wires
// turnLiveness into createBoard for exactly that reason); make it the termination authority too, so the
// two can never disagree. `bridgeTurn` false means there is nothing to interrupt — a resting codex thread
// then costs no bridge round-trip and never spawns an app-server just to be told "nothing to stop".
export function appServerCodexTurnLive(
  codex: CodexTurnTerminator | undefined,
  row: Pick<SessionRow, "slug" | "session_id">,
): boolean {
  return codex?.turnLiveness(row.slug, row.session_id)?.bridgeTurn === true
}

// THE seam every "stop this thread's worker" verb goes through, so a new verb cannot silently
// reacquire the tmux-only hole. Returns "stopped" only for a termination that actually landed; an
// interrupt that could not be delivered THROWS rather than degrading to "stopped", because the caller's
// next act is to record the worker as exited/done and that record must not outrun the truth.
export async function stopThreadRuntime(
  storage: Pick<Storage, "getAdoptionClaim"> & Partial<Pick<Storage, "getSession" | "getAdoptionRuntimeSnapshot">>,
  row: SessionRow,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
): Promise<"absent" | "stopped"> {
  if (isAppServerCodexRow(row)) {
    if (!appServerCodexTurnLive(codex, row)) return "absent"
    if (!codex) throw new Error("The Codex app-server is unavailable; nothing was stopped")
    // interruptTurn resolves only once the turn is proved retired (see its contract), so by the time
    // this returns the caller may record the stop without racing the turn's own ending.
    return (await codex.interruptTurn(row.slug, row.session_id)).interrupted ? "stopped" : "absent"
  }
  if (isBrokerClaudeRow(row)) {
    if (!claudeBroker) throw new Error("The Claude session broker is unavailable; nothing was stopped")
    // Kill the ownerless daemon. Unlike a codex turn-interrupt (session survives), a broker daemon owns
    // exactly ONE session, so this terminates the worker outright — the tmux-Claude parity: kill-pane
    // ends the claude process. isDaemonAlive is read FIRST so we report "absent" for an already-dead one.
    const wasAlive = claudeBroker.isDaemonAlive(row.session_id)
    claudeBroker.releaseSession(row.slug, row.session_id, "session-deleted")
    return wasAlive ? "stopped" : "absent"
  }
  return stopRegisteredRuntime(storage, row, runtime)
}

// A finalized cold adoption is permanently bound to one exact tmux generation. Destructive UI
// actions must never fall back to the reusable session name: another process may already occupy it
// after the owner exited. Verify token + full tuple, kill that tuple only, then prove it disappeared
// before deleting registry ownership or reporting the worker stopped.
export function stopRegisteredRuntime(
  storage: Pick<Storage, "getAdoptionClaim"> & Partial<Pick<Storage, "getSession" | "getAdoptionRuntimeSnapshot">>,
  row: Pick<SessionRow, "slug" | "session_id" | "runtime_generation">,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
): "absent" | "stopped" {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; nothing was stopped")
  }
  if (binding.kind === "unbound") {
    runtime.killSession(row.slug)
    return "stopped"
  }

  const claim = binding.claim
  const current = runtime.findExpectedAdoptionPane(claim)
  if (current.kind === "absent") return "absent"
  if (current.kind !== "found") {
    throw new Error("The adopted worker's exact runtime identity is unavailable; nothing was stopped")
  }
  if (!runtime.killExpectedAdoptionPane(claim)) {
    const afterMiss = runtime.findExpectedAdoptionPane(claim)
    if (afterMiss.kind !== "absent") {
      throw new Error("The adopted worker changed before it could be stopped; nothing was stopped")
    }
    return "absent"
  }
  if (runtime.findExpectedAdoptionPane(claim).kind !== "absent") {
    throw new Error("The adopted worker could not be confirmed stopped")
  }
  return "stopped"
}

export async function stopRuntimeBySlug(
  storage: Pick<Storage, "getAdoptionClaim" | "getSession">,
  slug: string,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
): Promise<{ outcome: "absent" | "stopped"; row?: SessionRow }> {
  const row = storage.getSession(slug)
  if (row) return { outcome: await stopThreadRuntime(storage, row, runtime, codex, claudeBroker), row }
  if (storage.getAdoptionClaim(slug)) throw new Error("An adoption attempt is in progress; nothing was stopped")
  // A rowless tmux name has no durable owner identity. Even a DB lock cannot make a forked tmux
  // client crash-safe after this process dies, so never issue a reusable-name kill without a row.
  throw new Error("No registered runtime identity is available; nothing was stopped")
}

// A live provider shell is deliberately not synonymous with a live *turn*. Providers keep their
// tmux session around at an idle prompt so a later steer can reuse it. Marking that resting shell
// done is safe to perform immediately (and must still terminate it so it is not orphaned). We ask
// only when the server can see work still being executed. Missing telemetry is intentionally
// conservative: a live, unobservable runtime may still be in the middle of a turn.
// The evidence itself, not just the verdict: the dialog has to be able to say WHICH work it refused
// to kill silently. Returns undefined when the completion may proceed immediately.
export function completionConfirmationHold(telemetry: SessionTelemetry | undefined): CompletionHold | undefined {
  const empty = { turnInFlight: false, subAgents: [], subAgentCount: 0, bgShells: [], bgShellCount: 0 }
  if (!telemetry) return { ...empty, unobservable: true }

  // These are paused waiting for a person, not churning. They are safe to stop as part of an
  // immediate Done transition; neither is evidence of an executing model/tool turn.
  if (telemetry.permPrompt || telemetry.nativeInputRequired || telemetry.pendingAsk) return undefined

  // Only ACTIVELY-running work holds Done back. A `stale` sub-agent — its completion signal lost AND its
  // transcript silent past the 15-min staleness ceiling (which already clears Claude's 600s foreground
  // cap) — is far closer to finished/dead than to working, and counting it here contradicted the queue:
  // hasLiveBackgroundWork (board.ts) holds a thread out of the queue on `running` ONLY, so a stale-only
  // parent read as at-rest in the rail yet Mark-as-done warned it was busy. The two must agree, so match
  // it — running only. (bgShells have no stale state; this narrows sub-agents, leaves shells unchanged.)
  // The real orphan case that used to strand stale rows here now retires at its `stopped` recovery
  // notification (see trackCompletions), so those never reach this filter at all.
  // DIRECT children only, for the same reason hasLiveBackgroundWork reads only those: the two must
  // agree, and a descendant (a sub-agent's own sub-agent) is surfaced for RENDERING. A running
  // descendant always sits under a running-or-rested direct child, so the work it represents is
  // already held by that child's row.
  // A type guard, so the filtered lists carry "running" into holdOps below rather than the wider view
  // union (a sub-agent can also read `rested` — its run over, its own fan-out still going — which is not
  // work this hold may claim is running).
  const busy = <T extends { state: string; depth?: number }>(op: T): op is T & { state: "running" } =>
    op.state === "running" && isDirectSubAgent(op)
  const subAgents = telemetry.subAgents.filter(busy)
  const bgShells = telemetry.bgShells.filter(busy)
  const turnInFlight = telemetry.turn === "in-flight"
  if (!turnInFlight && subAgents.length === 0 && bgShells.length === 0) return undefined
  return {
    turnInFlight,
    unobservable: false,
    subAgents: holdOps(subAgents),
    subAgentCount: subAgents.length,
    bgShells: holdOps(bgShells),
    bgShellCount: bgShells.length,
  }
}

// Worker-authored labels, so cap both the list and each string before they cross the wire — the same
// defensive discipline every other foreign-payload surface here follows. The untruncated counts ride
// alongside (see CompletionHold), so a capped list is reported as "+N more", never silently shortened.
const HOLD_OPS_MAX = 8
const HOLD_LABEL_MAX = 100
function holdOps(ops: readonly { label: string; state: "running" | "stale" }[]): CompletionHold["subAgents"] {
  return ops.slice(0, HOLD_OPS_MAX).map((op) => ({
    label: op.label.trim().slice(0, HOLD_LABEL_MAX) || "(unnamed)",
    state: op.state,
  }))
}

export function completionNeedsConfirmation(telemetry: SessionTelemetry | undefined): boolean {
  return !!completionConfirmationHold(telemetry)
}

// A completion is intentionally stronger than an archive toggle. It first establishes whether the
// *registered* runtime is still executing, and it only records Done after any necessary termination
// has been proved. A live resting shell is stopped and archived in one click; an executing or
// unobservable runtime requires explicit confirmation. Adopted workers stay bound to their exact
// pane tuple; a same-name replacement is never killed or mistaken for the original worker.
export async function completeRegisteredThread(
  storage: Pick<Storage,
    "getAdoptionClaim" | "getAdoptionRuntimeSnapshot" | "getSession" | "completeIfCurrent"
  >,
  row: SessionRow,
  terminateLive: boolean,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  telemetry?: SessionTelemetry,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
): Promise<{ needsConfirmation: boolean; hold?: CompletionHold }> {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread has a competing adoption attempt; nothing was changed")
  }
  // An app-server Codex row is never "live" to tmux — it has no pane — so asking tmux made Mark-as-done
  // on a RUNNING codex thread archive it silently: no confirmation dialog (live was false, so the hold
  // was never computed) and no termination. The bridge answers for it instead, which restores BOTH
  // halves: an executing turn now earns the same "End this session?" confirmation a Claude shell does,
  // and confirming it actually interrupts the turn.
  const appServerCodex = isAppServerCodexRow(row)
  const brokerClaude = isBrokerClaudeRow(row)
  // A broker Claude row is "live" iff its ownerless daemon is running — never a tmux pane. Without this
  // Mark-as-done on a running broker thread would archive it silently (live=false → no confirmation, no
  // termination) and orphan the daemon, the exact codex bug this branch mirrors.
  // A pre-cutover row has no transport left, so it can never be live; every current row is one of the
  // two headless kinds above.
  const live = brokerClaude
    ? (claudeBroker?.isDaemonAlive(row.session_id) ?? false)
    : appServerCodex
    ? appServerCodexTurnLive(codex, row)
    : false

  const hold = live && !terminateLive ? completionConfirmationHold(telemetry) : undefined
  if (hold) return { needsConfirmation: true, hold }
  if (live) {
    // Ordering, both paths: TERMINATE FIRST, record Done only after. A stop that throws must leave the
    // row exactly as it was — an archived row whose worker is still running is the failure this whole
    // change exists to remove, and for codex it is unrecoverable from the UI (the daemon outlives us
    // and an archived thread has no card left to act on).
    await stopThreadRuntime(storage, row, runtime, codex, claudeBroker)
    // For standalone sessions this is the postcondition that turns tmux's idempotent kill into a
    // safe completion operation. An adopted binding is already verified by stopRegisteredRuntime, an
    // app-server codex turn by interruptTurn's own proof that the turn retired, and a broker Claude
    // session by releaseSession's SIGTERM-by-record (no tmux pane to re-probe).
    if (!appServerCodex && !brokerClaude && binding.kind === "unbound" && runtime.isLive(row.slug)) {
      throw new Error("The session could not be confirmed stopped; it was not marked done")
    }
  }

  const generation = row.runtime_generation ?? 0
  if (!storage.completeIfCurrent(row.slug, row.session_id, generation)) {
    throw new Error("This thread resumed or was replaced while it was being completed; the new worker was preserved")
  }
  return { needsConfirmation: false }
}

export async function stopAndForgetRegisteredRuntime(
  storage: Pick<Storage,
    "getAdoptionClaim" | "getAdoptionRuntimeSnapshot" | "getSession" | "forgetSessionIfCurrent"
  >,
  row: SessionRow,
  runtime: RegisteredRuntimeTerminator = cachedLivenessTerminator,
  codex?: CodexTurnTerminator,
  claudeBroker?: ClaudeBrokerTerminator,
): Promise<SessionRow> {
  const binding = adoptionRuntimeBinding(storage, row)
  if (binding.kind === "conflict") {
    throw new Error("This thread changed while it was being dismissed; nothing was removed")
  }
  const expected = {
    sessionId: row.session_id,
    runtimeGeneration: row.runtime_generation ?? 0,
    adoptionAttemptToken: binding.kind === "bound" ? binding.claim.attempt_token : null,
  }
  await stopThreadRuntime(storage, row, runtime, codex, claudeBroker)
  const forgotten = storage.forgetSessionIfCurrent(row.slug, expected)
  if (!forgotten) {
    throw new Error("This thread resumed or was replaced while it was being dismissed; the new worker was preserved")
  }
  return forgotten
}

// The typed RPC surface. Every handler is thin: state mutations go through fray scripts
// (thread files) or tmux (agents), then rebuild the board so a fresh snapshot fans out on SSE.
export function createRouter(ctx: AppContext) {
  const frayDir = join(ctx.project.dir, ".fray")
  // Roots for the file-OPEN action + the inline-code path classifier (see openableFileRoots): shared so
  // a path the resolver blesses is exactly a path the open action will accept.
  const openRoots = openableFileRoots(ctx.project)

  // An auto-titled registry row is session-first authority. A same-slug `.fray/<slug>.md` may have
  // been planted independently and is never a readable or writable extension of that session.
  function isAutoTitledSession(slug: string): boolean {
    return ctx.storage.getSession(slug)?.title_auto === 1
  }

  function assertLegacyMutationAllowed(slug: string): void {
    if (isAutoTitledSession(slug)) {
      throw new Error("session-first auto-titled threads do not own a legacy thread file")
    }
  }

  // Bind a mutation to the session the CALLER was looking at. A stale tab holding a replaced session
  // id fails closed rather than acting on whatever now owns the slug (merged from origin/main).
  function currentOwnedSession(slug: string, sessionId: string) {
    const row = ctx.storage.getSession(slug)
    if (!row || row.session_id !== sessionId) {
      throw new Error("This thread was replaced; refresh before acting on its current session")
    }
    return row
  }

  // The two checks both recurring-prompt writers owe, shared so the operator's path and the worker's
  // can never disagree about what a valid arming is.
  //
  // A cadence is required when — and only when — the SCHEDULE trigger is on: a schedule nobody chose is
  // exactly the ambiguity the minutes field exists to remove, while a prompt that only fires on rest has
  // no cadence to name. Arming an ARCHIVED thread is refused, but only when a trigger is actually on;
  // clearing one, or parking the text with both triggers off, stays allowed on a shelved thread.
  interface RecurringPromptWrite {
    prompt: string | null
    onRest: boolean
    onSchedule: boolean
    intervalSeconds?: number
  }
  function assertRecurringPromptArmable(
    input: RecurringPromptWrite,
    row: Pick<SessionRow, "state" | "archived">,
  ): void {
    if (input.prompt === null) return
    if (input.onSchedule && input.intervalSeconds === undefined) {
      throw new Error("`intervalSeconds` is required when the schedule trigger is on")
    }
    if ((input.onRest || input.onSchedule) && (row.state === "archived" || row.archived === 1)) {
      throw new Error("Reopen this thread before arming a recurring prompt")
    }
  }
  // The stored cadence. Dropped when the prompt is cleared, and KEPT when only the schedule trigger is
  // off — the panel has to read back the interval that switching it on again would use.
  function recurringIntervalMs(input: RecurringPromptWrite): number | null {
    if (input.prompt === null || input.intervalSeconds === undefined) return null
    return input.intervalSeconds * 1000
  }

  // Can this exact sub-agent be steered RIGHT NOW? Returns the session to address, or null. Every
  // condition below is load-bearing and each was measured rather than assumed:
  //
  //  - the row must be a BROKER-backed claude thread. Steering rides an addressed input message on
  //    the live SDK stream, which only the broker daemon has. A tmux claude row has no such channel;
  //    a codex row's children are spawned inside codex's own process and the app-server protocol
  //    exposes no per-child address at all (`turn/steer` addresses a THREAD, and a codex child's
  //    thread is not one this app-server connection started).
  //  - the child must be DIRECT (this session's own Agent-tool dispatch, not a grandchild resolved
  //    through the descendant sidecar and not a background shell) — the CLI only knows tool_use ids
  //    its own main thread issued. MEASURED, not assumed (`_live_broker_steer_depth.mts`, 2026-07-30):
  //    an input frame addressed to a GRANDCHILD's dispatch id is not routed to it and does not fail —
  //    the unknown `parent_tool_use_id` is silently ignored and the frame lands on the top-level
  //    session's MAIN thread as an ordinary `promptSource:"sdk"` user turn. Lifting this gate would
  //    therefore not steer the grandchild; it would HIJACK THE WORKER'S TURN with text meant for
  //    someone else. (In that run the token did reach the grandchild — because the root model read the
  //    misdelivered steer and chose to relay it down with SendMessage, root → child → grandchild. A
  //    model being helpful is not a transport, and nothing may be built on it.)
  //  - the child must be RUNNING. `stale` means fray has seen no output for a long while and the
  //    completion record was probably missed; addressing a finished child MISDELIVERS to the parent's
  //    main thread rather than failing, so "probably finished" has to be treated as finished.
  //
  // A residual race remains and cannot be closed from outside the CLI: a child may settle between
  // this check and the daemon's read of the frame, and there is no receipt to tell us. It is narrow
  // (a broker row retires a child on the SDK's own task_notification, not on a mtime timeout) and it
  // is the reason the drawer's composer disappears the instant the child stops running.
  // `note` is the sentence the drawer shows in place of the prompt box, and it is composed HERE —
  // next to the code that knows the actual reason — rather than re-derived from a boolean by a client
  // that would have to guess. Null note = nothing worth saying (a settled child's transcript already
  // reads as finished; a banner there would be noise).
  function subAgentSteerable(slug: string, id: string): { sessionId: string } | { sessionId: null; note: string | null } {
    const blocked = (note: string | null) => ({ sessionId: null, note })
    const info = ctx.tailer.subAgent(slug, id)
    if (!info) return blocked(null)
    if (info.state !== "running") return blocked(null)
    if (!info.direct) return blocked("Only sub-agents this thread dispatched itself can be steered — this one belongs to another agent.")
    const row = ctx.storage.getSession(slug)
    if (!row) return blocked(null)
    if (row.backend === "codex") return blocked("Codex runs its sub-agents inside its own process and exposes no way to address one, so this child can't be steered from here.")
    if (row.claude_runtime !== "broker" || !ctx.claudeBroker) {
      return blocked("Steering a sub-agent needs the Claude session broker; this thread runs in a terminal.")
    }
    return { sessionId: row.session_id }
  }

  // Can fray END this live op, and if not, why not — for a sub-agent AND for a background shell.
  //
  // A SHELL used to be refused here categorically: "fray tracks a background shell by reading the
  // worker's transcript and holds no handle on its process". That was measured wrong. A background
  // `Bash` is a TASK in the very registry `Query.stopTask` addresses — the SDK's own
  // `backgroundTasks()` says as much ("Bash commands and subagents") — and fray has been recording its
  // task id all along, off the launch ack ("Command running in background with ID: …") and off the
  // `task_started` stream. `backend/_live_shell_stop.mts` drove the production path end to end: the
  // shell's OS process was gone within a second of the stop and the row left the board on its own.
  // The maintainer's case for this is the 24-hour wedged watcher with no way to clear it.
  //
  // Only two things differ between the two kinds, and both are handled below rather than by forking
  // the function: the LIVENESS reading, and the noun in every refusal.
  // A CODEX background exec, resolved by the id its row carries — which for codex IS the `processId`
  // the kill needs (see tailer.ts codexBgShellViews: there is exactly one handle and no correlation
  // step). Undefined for every other kind of row, so the Claude path below is reached unchanged.
  //
  // It reads the BOARD's live shell list rather than the fold, because that list IS the app-server's
  // item stream — a codex exec's processId never reaches the rollout fray folds (measured in
  // backend/_live_codex_bgterm_match.mts, where the rollout-projected row carried no handle at all).
  function codexShellTarget(slug: string, id: string): { sessionId: string; processId: string; label: string } | undefined {
    if (!ctx.codexAppServer) return undefined
    const row = ctx.storage.getSession(slug)
    if (!row || row.backend !== "codex" || row.codex_runtime !== "app-server") return undefined
    const shell = ctx.tailer.get(slug)?.bgShells?.find((entry) => entry.id === id && entry.state === "running")
    if (!shell) return undefined
    return { sessionId: row.session_id, processId: id, label: shell.label }
  }

  // What the codex worker is told when fray kills one of its background commands. Same sentence as the
  // Claude one and for the same measured reason — neither provider tells its agent. Codex's silence is
  // structural: completion there is POLLED, never pushed, so a killed exec's next `wait` reads
  // "Script completed / output:''", which is indistinguishable from a clean finish (verified in
  // backend/_live_codex_bgterm.mts). Delivered through `thread/inject_items`, the one channel that
  // appends to the model's visible history without starting a turn.
  function shellStopNotice(label: string): string {
    return `[fray] The operator stopped your background command ${JSON.stringify(label)} from the Fray dashboard. It is no longer running and will never report a result — do not wait on it or poll it again.`
  }

  // Apply the operator's retirements to a transcript page. Two surfaces render a background op and BOTH
  // have to hear about the ×: the board row (the tailer drops it on the click and remembers it durably)
  // and the transcript, which is derived from a `tool_use` whose terminal partner never arrives. Miss
  // this one and the ops strip simply redraws the row from the transcript side — with no × on it,
  // because a transcript-only row has nothing to address a stop at.
  function retireOpsInPage(slug: string, page: TranscriptPage): TranscriptPage {
    const retired = retiredOpsFor(ctx.storage, slug)
    // A dead OWNER retires every still-pending background card on the thread, for the same reason and
    // more strongly than the × retires one: those ops are children of the process that is gone. Read
    // from the tailer, which already answers this once per tick for all three runtimes — a dead tmux
    // pane as well as a dead broker daemon. Asking the broker bridge directly, as this first did, was
    // both a second implementation of the same question and blind to every tmux row.
    const gone = ctx.tailer.ownerGone?.(slug) ?? false
    if (retired.size === 0 && !gone) return page
    return { ...page, messages: projectRetiredBackgroundOps(page.messages, retired, gone) }
  }

  function subAgentStoppable(slug: string, id: string): { sessionId: string; taskId: string; shell: boolean } | { sessionId: null; note: string | null } {
    const blocked = (note: string | null) => ({ sessionId: null, note })
    const info = ctx.tailer.subAgent(slug, id)
    if (!info) return blocked(null)
    const shell = ctx.tailer.backgroundShell?.(slug, id)
    const noun = shell ? "background shell" : "sub-agent"
    // A shell has NO staleness ceiling — its entry clears on a terminal notification, so a watcher that
    // has printed nothing for a day is still `running`, not `stale`. Read the shell's own state, which
    // says exactly that; `info.state` runs it through the sub-agent staleness rule and would report
    // "stale" for precisely the wedged shell this control exists to kill.
    if (!(shell ? shell.state === "running" : info.state === "running")) return blocked(null)
    const row = ctx.storage.getSession(slug)
    if (!row) return blocked(null)
    if (row.backend === "codex") {
      return blocked(shell
        ? "Codex runs its background commands inside its own process and exposes no way to end one, so this shell can't be stopped from here."
        : "Codex does not expose per-sub-agent interruption to Fray, so this child can't be stopped from here.")
    }
    if (row.claude_runtime !== "broker" || !ctx.claudeBroker) {
      return blocked(`Stopping a ${noun} needs the Claude session broker; this thread runs in a terminal.`)
    }
    if (!info.taskId) return blocked(`This ${noun} did not publish the task identifier needed to stop it.`)
    return { sessionId: row.session_id, taskId: info.taskId, shell: Boolean(shell) }
  }

  // TELL THE WORKER ITS SHELL WAS KILLED — the half the provider does not do for us.
  //
  // Measured (backend/_live_shell_stop_notice.mts, 2026-08-01) on a real session: stopping a SUB-AGENT
  // injects a `<task-notification>` user record the model reads and acts on ("the sub-agent was stopped
  // before it finished, so it never reported back"). Stopping a background SHELL injects NOTHING — the
  // transcript gains not one record — and asked afterwards the model still believed its shell was
  // "presumably still running … I have received no completion notification". A worker left waiting on a
  // watcher fray already killed is the exact stall the × is meant to end, so fray supplies the missing
  // notice itself. Shell-only, deliberately: adding one on the sub-agent path would say it twice.
  //
  // `[fray]` is the established prefix for a machine notice to a worker — transcript.ts NOISE_PREFIXES
  // keeps it out of the human's chat, so this reaches the model without becoming a bubble the operator
  // never typed.
  //
  // NEVER cold-starts a process. `stopSubAgent` already requires a daemon this bridge holds live, but a
  // daemon can die in the gap, and `followUp` would then resume a whole `claude` from disk purely to
  // announce a kill. The liveness check keeps the worst case at "nobody was there to tell", which is
  // reported rather than hidden.
  //
  // `label` is read BEFORE the kill by the caller: the worker's own description of the shell ("Watching
  // CI") is what it will recognise, and the row it comes from is retired moments later.
  async function noticeShellStopped(slug: string, label: string): Promise<string | null> {
    const bridge = ctx.claudeBroker
    const row = ctx.storage.getSession(slug)
    if (!bridge || !row) return "The worker could not be told — the Claude session broker is unavailable."
    if (!bridge.isDaemonAlive(row.session_id)) return "The worker was not told — its session is no longer running."
    try {
      await bridge.followUp({
        threadSlug: slug,
        sessionId: row.session_id,
        cwd: ctx.project.dir,
        text: `${shellStopNotice(label)} Whatever it wrote before the kill is still readable in its output file.`,
        permissionMode: (row.permission_mode as ClaudePermissionMode | null) ?? undefined,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
      })
      return null
    } catch (error) {
      return `The worker could not be told: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // STOP A SUBTREE, NOT A ROW — the shared body behind both stop paths (the drawer's button and the ×).
  //
  // `stopTask` ends exactly the task it names, and the registry behind it is flat and session-wide, so
  // a sub-agent's own fan-out is NOT covered by its parent's id. Stopping only the named agent leaves
  // its children running, and that same flatness delivers their completions to the SESSION's main loop
  // — so the orphans keep spending tokens and then report into the ROOT thread, attributed to an agent
  // the operator watched die (maintainer, 2026-07-31, on nub session a0c5fba3: "Two orphaned
  // grandchildren of the killed agent just reported"). The subtree walk is the fix; the ORDER is the
  // rest of it.
  //
  //  · DEEPEST FIRST, then the target last. A still-running agent can dispatch another child between
  //    two sequential stops, so bottom-up leaves no window in which a fresh grandchild outlives an
  //    already-stopped parent.
  //  · A DESCENDANT stop that throws is COUNTED, never swallowed and never fatal. The common cause is
  //    benign — it settled between the sidecar read and the stop — but a genuine failure means live
  //    work fray failed to end, and the operator has to hear that rather than read "stopped" over it.
  //  · The TARGET's stop still throws through to the caller, which is what keeps `stopBackgroundOp`
  //    from retiring a row whose work is still going.
  //  · A SHELL has no subtree — its dispatch leaves no sidecar, so `subAgentDescendantTasks` answers
  //    empty and the loop is skipped. What it has instead is the NOTICE, fired here rather than at each
  //    call site so no stop path can ever kill a shell silently.
  async function stopSubAgentSubtree(
    slug: string,
    id: string,
    target: { sessionId: string; taskId: string; shell?: boolean },
  ): Promise<{ descendantsStopped: number; descendantsFailed: number; noticeFailed: string | null }> {
    const bridge = ctx.claudeBroker
    if (!bridge) throw new Error("Claude session broker is unavailable; cannot stop this sub-agent")
    // Read the shell's own name for itself while its row is still live — the notice below is delivered
    // after the kill, by which point the row it came from is on its way out of tracking.
    const shellLabel = target.shell
      ? ctx.tailer.get(slug)?.bgShells?.find((s) => s.id === id)?.label ?? ctx.tailer.backgroundShell?.(slug, id)?.command ?? "(unnamed)"
      : undefined
    let descendantsStopped = 0
    let descendantsFailed = 0
    for (const taskId of ctx.tailer.subAgentDescendantTasks?.(slug, id) ?? []) {
      try {
        await bridge.stopSubAgent({ threadSlug: slug, sessionId: target.sessionId, taskId })
        descendantsStopped++
      } catch {
        descendantsFailed++
      }
    }
    await bridge.stopSubAgent({ threadSlug: slug, sessionId: target.sessionId, taskId: target.taskId })
    // AFTER the kill, never before: the notice states the shell is already dead, and a stop that throws
    // must not leave a worker believing work ended that is still burning. A notice that fails to land
    // is reported, not thrown — the process IS dead by this line, and turning that into an error the
    // client reads as "the stop failed" would leave the row on the board over a delivery problem.
    const noticeFailed = shellLabel === undefined ? null : await noticeShellStopped(slug, shellLabel)
    return { descendantsStopped, descendantsFailed, noticeFailed }
  }

  // FAILURE ONLY. A successful fan-out is already fully described by `descendantsStopped`, and saying
  // it twice on the wire invites the two to drift; the note exists for the one thing a count cannot
  // express — a descendant fray asked to stop and could not, which is live work the operator is about
  // to lose sight of when the row leaves the board. A shell notice that did not land joins it on the
  // same terms: the operator believes the worker was told, and only this says otherwise.
  function subtreeNote(result: { descendantsFailed: number; noticeFailed?: string | null }): string | null {
    const { descendantsFailed, noticeFailed } = result
    const parts: string[] = []
    if (descendantsFailed > 0) parts.push(`${descendantsFailed} descendant${descendantsFailed === 1 ? "" : "s"} could not be stopped and may still be running.`)
    if (noticeFailed) parts.push(noticeFailed)
    return parts.length > 0 ? parts.join(" ") : null
  }

  // Every interaction RPC re-derives the project from this server and binds the requested slug to the
  // CURRENT registered session id. Foreign transcripts have no registry row; a stale page holding a
  // replaced session id fails closed instead of reading or answering the replacement's requests.
  function interactionScope(slug: string, sessionId: string) {
    const row = ctx.storage.getSession(slug)
    if (!row || row.session_id !== sessionId) throw new Error("interaction is not available for this project session")
    return { projectId: ctx.project.id, threadSlug: slug, sessionId }
  }

  // Add only the provider-neutral action effect needed by a client. Adapter delivery rows contain
  // transport ids, durable provider responses, and context that must never cross the RPC boundary.
  // A terminal journal row wins and carries no delivery effect; pending/terminal disagreement fails
  // closed as reconnect-required rather than resurrecting buttons.
  function interactionForRead(
    scope: ReturnType<typeof interactionScope>,
    interaction: InteractionRecord,
  ): InteractionRecord {
    if (interaction.lifecycle !== "pending") return interaction
    const delivery = ctx.interactions.providerDelivery(scope, interaction.id)
    if (!delivery) return interaction
    const effect = delivery.state === "queued" || delivery.state === "sent"
      ? "sending" as const
      : delivery.state === "awaiting-user" &&
          ctx.codexAppServer?.ownsInteraction(scope, interaction.id) === true
        ? "awaiting-user" as const
        : "reconnect-required" as const
    return { ...interaction, delivery: { effect } }
  }

  // Resolve the repo owner/name for a GitHub call. A POSITIVE boot cache short-circuits (stable, no
  // gh call — the common path). A null/absent cache is NOT trusted: it can be the boot race (cache not
  // resolved yet) OR an unauthed-at-boot detection (`gh repo view` needs auth), so fall back to a live
  // ghRepo and WARM the cache on success — this makes a post-boot `gh auth login` light up the feature
  // without a server restart. Never throws (ghRepo swallows failures → null).
  async function resolveRepo(): Promise<string | null> {
    const cached = ctx.github?.nameWithOwner
    if (cached) return cached
    const live = await ghRepo(ctx.project.dir)
    if (live) {
      if (ctx.github) {
        ctx.github.inRepo = true
        ctx.github.nameWithOwner = live
      } else {
        ctx.github = { installed: true, inRepo: true, nameWithOwner: live }
      }
    }
    return live
  }

  return {
    board: query({
      output: BoardSnapshot,
      handler: () => ctx.board.snapshot(),
    }),

    threadBody: query({
      input: SlugInput,
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        if (isAutoTitledSession(input.slug)) return { markdown: "" }
        const file = resolveLegacyThreadFile(ctx.project.dir, input.slug)
        if (!file) return { markdown: "" }
        // Use the bytes read under the resolver's before/after lstat checks. Reopening `file.path`
        // here would reintroduce a symlink-swap window after containment had already succeeded.
        return { markdown: file.contents.toString("utf8") }
      },
    }),

    // The full conversation, parsed mechanically from the session JSONL. Chat-first UI renders
    // this by default; the raw terminal is the power-user toggle.
    threadTranscript: query({
      input: SlugInput,
      output: TranscriptPage,
      handler: async ({ input }) => {
        // Registry row → its session's transcript; foreign slug (a session id) → resolved directly; else [].
        // backendFor routes a codex thread through the codex rollout reader (else it renders empty).
        const page = readLatestThreadTranscriptPage(ctx.project, ctx.storage, input.slug, ctx.backendFor)
        return retireOpsInPage(input.slug, projectTranscriptPageAgentLifecycles(page, (id) => ctx.tailer.subAgent(input.slug, id)))
      },
    }),

    // One bounded backward step through the canonical projected transcript. The cursor excludes the
    // already-visible anchor and is rejected on session/runtime/transcript replacement.
    threadTranscriptEarlier: query({
      input: TranscriptEarlierInput,
      output: TranscriptPage,
      handler: async ({ input }) => {
        const page = readEarlierThreadTranscriptPage(ctx.project, ctx.storage, input.slug, input.cursor, ctx.backendFor)
        return retireOpsInPage(input.slug, projectTranscriptPageAgentLifecycles(page, (id) => ctx.tailer.subAgent(input.slug, id)))
      },
    }),

    // Runtime adapters create interactions internally. React gets only scoped reads and terminal
    // transitions; there is deliberately no public/provider-spoofable create RPC.
    pendingInteractions: query({
      input: ListInteractionsInput,
      output: ListInteractionsResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        return { interactions: ctx.interactions.listPending(scope).map((interaction) => interactionForRead(scope, interaction)) }
      },
    }),

    interactionGet: query({
      input: GetInteractionInput,
      output: GetInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        const interaction = ctx.interactions.get(scope, input.interactionId)
        if (!interaction) throw new Error("interaction is not available for this project session")
        return { interaction: interactionForRead(scope, interaction) }
      },
    }),

    interactionResolve: mutation({
      input: ResolveInteractionInput,
      output: ResolveInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        const delivery = ctx.interactions.providerDelivery(scope, input.interactionId)
        let result
        if (delivery) {
          if (!ctx.codexAppServer || !ctx.codexAppServer.ownsInteraction(scope, input.interactionId)) {
            throw new Error("provider-backed interaction is unavailable until its provider bridge reconnects")
          }
          const providerResult = await ctx.codexAppServer.resolveInteraction(scope, input)
          if (!providerResult) throw new Error("provider-backed interaction lost its durable delivery owner")
          result = {
            effect: providerResult.effect === "already-sent" ? "already-queued" as const : providerResult.effect,
            interaction: providerResult.interaction,
          }
        } else {
          result = ctx.interactions.resolve(scope, input)
        }
        // The journal result contains only the persisted/redacted response. Secret input values are
        // never echoed by this RPC (and are absent from SQLite before this function returns). Re-read
        // after provider I/O: its acknowledgement may have won the race and terminalized the journal
        // while the bridge still holds the pending object returned by its earlier queue transaction.
        const latest = ctx.interactions.get(scope, result.interaction.id) ?? result.interaction
        return {
          effect: latest.lifecycle === "resolved" &&
              (result.effect === "queued" || result.effect === "already-queued")
            ? "resolved" as const
            : result.effect,
          interaction: interactionForRead(scope, latest),
        }
      },
    }),

    interactionCancel: mutation({
      input: CancelInteractionInput,
      output: CancelInteractionResult,
      handler: async ({ input }) => {
        const scope = interactionScope(input.slug, input.sessionId)
        if (ctx.interactions.providerDelivery(scope, input.interactionId)) {
          // Provider cancellation is an advertised decision that must traverse the acknowledged
          // delivery path. A local-only terminal transition would strand the app-server request.
          throw new Error("provider-backed interaction must use its advertised cancel decision")
        }
        const result = ctx.interactions.cancel(scope, input)
        return { effect: result.effect, interaction: result.interaction }
      },
    }),

    // A live/stale background sub-agent's OWN transcript, for the drill-in drawer that overlays the
    // thread. Resolves the tracked child (thread slug + dispatch tool_use id) to its output JSONL, then
    // parses it with the same mechanical extractor. Never throws: an unknown/dropped id (completed
    // children leave tracking on their terminal notification) or an unreadable file → an empty
    // transcript with state "gone", which the drawer renders as its quiet "unavailable" state.
    subAgentTranscript: query({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({
        messages: z.array(TranscriptMessage),
        state: z.enum(["running", "stale", "done", "gone"]),
        // Whether THIS child can be steered right now. Computed server-side, never re-derived by the
        // client: the drawer renders a prompt box if and only if this is true, because the codebase
        // rule is "absent ⇒ no affordance, never a fabricated one" and an input that silently drops a
        // steer is worse than no input. See subAgentSteer for every condition folded in here.
        steerable: z.boolean(),
        // Why not, when the reason is worth stating (a RUNNING child that still can't be reached).
        steerNote: z.string().nullable(),
        stoppable: z.boolean(),
        stopNote: z.string().nullable(),
      }),
      handler: async ({ input }) => {
        const info = ctx.tailer.subAgent(input.slug, input.id)
        if (!info) return { messages: [], state: "gone" as const, steerable: false, steerNote: null, stoppable: false, stopNote: null }
        // A CODEX sub-agent is itself a codex thread, so its "output file" is a rollout in codex's own
        // schema — parse it with the codex reader or the drawer renders an empty pane.
        const read = info.outputFormat === "codex" ? readCodexTranscriptFile : readTranscriptFile
        const messages = info.outputFile ? read(info.outputFile) : []
        const steer = subAgentSteerable(input.slug, input.id)
        const stop = subAgentStoppable(input.slug, input.id)
        return {
          messages,
          state: info.state,
          steerable: steer.sessionId !== null,
          steerNote: steer.sessionId === null ? steer.note : null,
          stoppable: stop.sessionId !== null,
          stopNote: stop.sessionId === null ? stop.note : null,
        }
      },
    }),

    // Steer ONE running sub-agent: deliver the operator's text into the CHILD's own conversation
    // rather than the thread's main turn. The maintainer's question — "don't we have the ability to
    // steer them with prompts?" — turned out to be yes, but only through one narrow channel: an input
    // message addressed with the child's dispatch tool_use id (`parent_tool_use_id`). There is no
    // control request for STEERING. Stopping is separate and does use the SDK's `stopTask` control.
    //
    // WHY THE GATE IS STRICT. Measured live: addressing a child that has ALREADY SETTLED does not
    // error and does not vanish — the CLI falls the message back onto the MAIN thread, where the
    // parent obeys it as if the operator had typed it into the thread composer. So an ungated steer
    // is not a no-op, it is a misdelivery. `subAgentSteerable` is the single predicate that decides,
    // and the drawer's prompt box is rendered off the same answer.
    subAgentSteer: mutation({
      input: z.object({ slug: ThreadSlug, id: z.string(), message: z.string().min(1), deliveryId: z.string().optional() }).strict(),
      output: z.object({ delivered: z.boolean() }),
      handler: async ({ input }) => {
        const target = subAgentSteerable(input.slug, input.id)
        if (target.sessionId === null) {
          throw new Error(target.note ?? "This sub-agent is no longer running, so it can't be steered")
        }
        const bridge = ctx.claudeBroker
        if (!bridge) throw new Error("Claude session broker is unavailable; cannot steer this sub-agent")
        await bridge.steerSubAgent({
          threadSlug: input.slug,
          sessionId: target.sessionId,
          subAgentId: input.id,
          text: input.message,
          deliveryId: input.deliveryId,
        })
        ctx.board.refresh()
        return { delivered: true }
      },
    }),

    subAgentStop: mutation({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({ stopped: z.boolean(), descendantsStopped: z.number(), note: z.string().nullable() }),
      handler: async ({ input }) => {
        const target = subAgentStoppable(input.slug, input.id)
        if (target.sessionId === null) {
          throw new Error(target.note ?? "This sub-agent is no longer running, so it can't be stopped")
        }
        const result = await stopSubAgentSubtree(input.slug, input.id, target)
        ctx.board.refresh()
        return { stopped: true, descendantsStopped: result.descendantsStopped, note: subtreeNote(result) }
      },
    }),

    // A live/recent background shell's command and combined process output. The tailer supplies the
    // scoped path; the reader caps the response so long-lived watchers/dev servers stay cheap.
    backgroundShellOutput: query({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({
        command: z.string().nullable(),
        output: z.string(),
        truncated: z.boolean(),
        state: z.enum(["running", "done", "gone"]),
        // The same pair `subAgentTranscript` carries, for the same reason: the drawer renders a Stop
        // button if and only if this is true, and states `stopNote` in its place when a running shell
        // still cannot be reached. Never re-derived client-side — see subAgentStoppable.
        stoppable: z.boolean(),
        stopNote: z.string().nullable(),
      }),
      handler: async ({ input }) => {
        const info = ctx.tailer.backgroundShell?.(input.slug, input.id)
        if (!info) return { command: null, output: "", truncated: false, state: "gone" as const, stoppable: false, stopNote: null }
        const content = info.outputFile ? readBackgroundShellOutput(info.outputFile) : { output: "", truncated: false }
        const stop = subAgentStoppable(input.slug, input.id)
        return {
          command: info.command ?? null,
          ...content,
          state: info.state,
          stoppable: stop.sessionId !== null,
          stopNote: stop.sessionId === null ? stop.note : null,
        }
      },
    }),

    // THE LIVE COUNTER on a background shell row: how many lines of output each named shell has
    // produced so far. Elapsed time already rides that row and it cannot answer the question the
    // operator actually has about a watcher — "is this thing still doing anything, or is it wedged?".
    // A number that climbs answers it at a glance; one that has sat still for ten minutes answers it
    // the other way.
    //
    // A CLIENT POLL, deliberately NOT a board field. Output growth happens in a file the board's
    // derived signature does not read, and folding it in would push a board delta per append for every
    // thread on the machine whether or not a human is looking at one — the same churn the signature
    // already refuses raw token counts for (tailer.ts, derivedSignature). Polled here, the cost lands
    // only while a thread with live shells is actually on screen.
    //
    // BATCHED over ids because the ops strip renders them as a group: one request per poll for the
    // whole strip, not one per row.
    //
    // Every id the tailer still tracks comes back, and `lines: null` — NOT an omission — is how "there
    // is no readable output yet" is said. The distinction is what keeps the poll alive: a shell's row
    // appears at its `tool_use` and its output path only arrives seconds later with the launch ack, so
    // for that window the shell has no file at all. Omitting it read as "nothing here is running", the
    // client stopped polling, and the counter never appeared for the rest of the view's life.
    // An id the tailer no longer knows is genuinely gone and IS omitted.
    backgroundShellActivity: query({
      input: z.object({ slug: ThreadSlug, ids: z.array(z.string()).max(64) }).strict(),
      output: z.object({
        shells: z.array(z.object({
          id: z.string(),
          lines: z.number().nullable(),
          // Whether the count can still move. The client stops polling once every named shell has
          // settled, so a finished strip does not keep a timer alive for a number that cannot change.
          running: z.boolean(),
        })),
      }),
      handler: async ({ input }) => {
        const shells: { id: string; lines: number | null; running: boolean }[] = []
        for (const id of input.ids) {
          const info = ctx.tailer.backgroundShell?.(input.slug, id)
          if (!info) continue
          const lines = info.outputFile ? backgroundShellLineCount(info.outputFile) : undefined
          shells.push({ id, lines: lines ?? null, running: info.state === "running" })
        }
        return { shells }
      },
    }),

    // THE × ON A LIVE CHILD ROW. It means STOP, and it now tries to actually stop.
    //
    // It used to mean only "retire this op from tracking", which is what the maintainer hit
    // (2026-07-30): "The fucking X button didn't actually kill the sub-agent. it removed it from my UI,
    // but then I click on the title and it's still running." A control that clears the row while the
    // work keeps burning tokens is worse than no control — it hides live work behind a gesture that
    // reads as a kill. So the order here is stop FIRST, retire second:
    //
    //  1. STOPPABLE (a broker-backed claude row's live child — sub-agent OR background shell — with a
    //     task id) → the real provider control, `Query.stopTask`, awaited to the daemon's answer. Then
    //     retire, so the row leaves every live surface on this click's own board frame instead of
    //     waiting for the fold. A SHELL additionally gets the notice the provider does not send (see
    //     noticeShellStopped), so the worker is not left waiting on a watcher fray already killed.
    //  2. The stop THREW → do NOT retire. A failed stop means the child is still working, and hiding
    //     it is exactly the bug above; the row stays and the error reaches the operator.
    //  3. NOT stoppable (a tmux claude thread, a codex thread, a stale/finished op) → retire anyway,
    //     because clearing a phantom is the escape hatch the × was built for and is still the only way
    //     to unstick a finished op whose completion was never recorded. But return the REASON, so the
    //     client can say plainly that the work may still be running rather than letting the row vanish
    //     silently. `note` is null when there is nothing worth saying — a stale/gone op is already
    //     finished as far as anything can tell.
    //
    // `dismissed:false` when the id was not live to retire (already gone / unknown) — the UI refreshes.
    stopBackgroundOp: mutation({
      input: z.object({ slug: ThreadSlug, id: z.string() }).strict(),
      output: z.object({ stopped: z.boolean(), dismissed: z.boolean(), note: z.string().nullable(), descendantsStopped: z.number() }),
      handler: async ({ input }) => {
        // CODEX takes its own route, not a branch inside the Claude one: its shells never enter the
        // fold's op map, so neither `tailer.subAgent` nor `tailer.backgroundShell` can see them, and
        // its kill is a different protocol call against a different bridge. It shares the SHAPE — stop
        // first, then let the row go — and the row leaves without `dismissOp` because the bridge drops
        // it from the live level the board reads.
        const codex = codexShellTarget(input.slug, input.id)
        if (codex) {
          const result = await ctx.codexAppServer!.terminateBackgroundExec({
            threadSlug: input.slug,
            sessionId: codex.sessionId,
            processId: codex.processId,
            notice: shellStopNotice(codex.label),
          })
          ctx.board.refresh()
          // `terminated:false` is the app-server saying the PTY was already gone. Nothing was killed and
          // nothing may claim it was — but the phantom row does clear, which is the ×'s other honest job.
          return { stopped: result.terminated, dismissed: true, note: result.noticeFailed, descendantsStopped: 0 }
        }
        const target = subAgentStoppable(input.slug, input.id)
        let stopped = false
        let note: string | null = null
        let descendantsStopped = 0
        if (target.sessionId !== null) {
          // The × ends the whole subtree, not just this row — see stopSubAgentSubtree. A descendant
          // that could not be stopped rides back in `note`, because the row is about to leave every
          // live surface and that is the operator's only chance to hear that work is still running.
          const result = await stopSubAgentSubtree(input.slug, input.id, target)
          descendantsStopped = result.descendantsStopped
          note = subtreeNote(result)
          stopped = true
        } else {
          note = target.note
        }
        const dismissed = ctx.tailer.dismissOp?.(input.slug, input.id) ?? false
        ctx.board.refresh()
        return { stopped, dismissed, note, descendantsStopped }
      },
    }),

    dispatch: mutation({
      input: DispatchInput,
      output: z.object({ slug: ThreadSlug, sessionId: z.string() }),
      // Forward the picker-selected backend into the dispatch opts seam (Codex-support epic, Phase 3).
      // Omitted ⇒ the dispatcher defaults to "claude", so an old client (no backend field) is
      // byte-identical. The resume path needs NO analog — resume reads the backend from the row's
      // `backend` column (backendFor(row.backend)), which dispatch already stamped for a codex thread.
      handler: ({ input }) => ctx.dispatcher.dispatch(input, { backend: input.backend }),
    }),

    // Cold-adopt a pre-existing thread (no session row): spawn a fresh worker on its file.
    adoptThread: mutation({
      input: AdoptThreadInput,
      output: AdoptThreadResult,
      handler: ({ input }) => ctx.dispatcher.adopt(input.slug, input.message),
    }),

    followUp: mutation({
      input: FollowUpInput,
      handler: async ({ input }) => {
        // Codex's TUI drops Enter when it follows literal text in the same instant, so this path is
        // persisted + capture-gated and submits through one atomic paste-and-key. Claude keeps its native
        // live injection, and any dead session resumes through the backend command.
        //
        // A follow-up DISABLES any snooze on this row — see wakeParkedThreadForFollowUp, which owns the
        // rule and the reasoning. Short version: re-parking after the turn you just asked for would hide
        // its own answer from the queue, so the later instruction ("now") wins over the earlier park.
        //
        // The row is bound to the CALLER's session id (origin/main's staleness guard): a stale tab must
        // not deliver a follow-up into a thread that has since been re-dispatched.
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (hasPendingPermissionChange(row)) {
          throw new Error("Wait for the current permission change to finish before sending a follow-up")
        }
        // The operator's "Restart worker" verb, enforced HERE and not only in the UI that offers it: a
        // stale tab holds a button whose preconditions may have expired since it rendered.
        //
        // Both refusals THROW rather than degrading to an ordinary follow-up, because a restart that
        // quietly becomes a plain message is the worst outcome — the operator believes their worker came
        // back on the new build when it is still the old process.
        if (input.freshProcess) {
          if (!(row?.backend === "claude" && row.claude_runtime === "broker")) {
            throw new Error("Only a broker-backed Claude worker can be restarted in place")
          }
          // Running sub-agents do NOT refuse this. They used to: the completion invariant says an agent
          // runs to its terminal return, and a restart kills the parent's in-memory children. But that
          // invariant binds fray's OWN initiative — needsFreshProcessForLimit below still declines to
          // kill a live child when FRAY is the one deciding to restart — and `freshProcess` is not fray
          // deciding, it is the operator instructing. Refusing it made the recovery verb unavailable in
          // precisely the state that motivates it: a worker wedged behind background work that will not
          // finish (maintainer 2026-08-01: "do not disable the button when there are sub-agents
          // running"). The children die; that is what the operator asked for and already knows.
        }
        // Reopen an archived thread HERE, above the runtime branches, because only the tmux path reaches
        // resumeThread (where this used to live alone). A broker-backed Claude row and an app-server
        // Codex row both return from their own branch below, so sending them a follow-up used to resume
        // the WORKER while leaving the ROW archived: the thread executed away while the board read Done,
        // and — an archived thread having no lifecycle verbs — offered no Mark-as-done button to stop it.
        // That is the state the "send a message to reopen it" readout promises against, so it has to hold
        // for every runtime. Raised 2026-07-31 against a live broker thread ("showing up as done… but it
        // is actually running actively").
        if (row) reopenArchivedThreadForFollowUp(ctx, row)
        // Un-park HERE, above the runtime branches, for the same reason the reopen is here: a broker
        // Claude row and an app-server Codex row both return from their own branch below, so anything
        // that must hold for every runtime has to run before the split.
        if (row) wakeParkedThreadForFollowUp(ctx, row)
        // Every Codex follow-up flows through the app-server bridge — no tmux composer, no queue, no
        // stale-draft class. The bridge owns the steer-vs-start decision atomically and dedups on
        // deliveryId. A LEGACY tmux Codex row (dispatched before the cutover) is migrated on its first
        // follow-up by adopting its rollout; from then on it is an ordinary app-server thread.
        if (row?.backend === "codex") {
          const bridge = ctx.codexAppServer
          if (!bridge) throw new Error("Codex app-server is unavailable; cannot deliver this follow-up")
          if (row.codex_runtime !== "app-server") {
            if (!row.agent_session_id) throw new Error("This legacy Codex thread has no resumable rollout id yet")
            await bridge.adoptExternalRollout({ threadSlug: input.slug, sessionId: row.session_id, codexThreadId: row.agent_session_id, cwd: ctx.project.dir })
            ctx.storage.setCodexRuntime(input.slug, "app-server")
          }
          const binding = bridge.binding(input.slug, row.session_id)
          // Writer-yield: if the rollout shows an in-flight turn the bridge did NOT start (it has no
          // current turn of its own), someone is driving this thread in their own terminal via
          // `codex resume`. fray keeps MIRRORING that turn (the tailer follows the same rollout), but it
          // must not start/steer a second turn and race two writers. Yield until the external turn rests.
          //
          // "In flight" must mean the rollout is ACTUALLY ADVANCING, not merely that it stopped
          // mid-turn: a rollout frozen by a dead app-server looks identical to an external writer from
          // here, and yielding to it left the operator unable to answer their own stalled thread at all.
          // appServerTurnStalled tells the two apart — see board.ts.
          const stalled = appServerTurnStalled(
            bridge.turnLiveness(input.slug, row.session_id),
            ctx.tailer.get(input.slug)?.lastActivityAt,
            Date.now(),
          )
          const turnLive = ctx.tailer.get(input.slug)?.turn === "in-flight" && !stalled
          if (turnLive && (!binding || binding.currentTurnId === null)) {
            throw new Error("This thread is running in your terminal right now — fray is mirroring it live. Wait for that turn to finish, then send your follow-up here.")
          }
          if (!binding || binding.state !== "active") {
            await bridge.resumeOwnedSession(input.slug, row.session_id)
          }
          await bridge.followUp({
            threadSlug: input.slug,
            sessionId: row.session_id,
            text: input.message,
            deliveryId: input.deliveryId,
            model: row.model ?? undefined,
            effort: row.effort ?? undefined,
          })
          // Codex gets a ledger entry too — as SERVER TRUTH for the queued bubble, not as a delivery
          // guess: the bridge already dedups on deliveryId and its return IS the receipt, so the item
          // opens `enqueued` and can never age into the amber "check the terminal" warning (there is no
          // terminal composer on an app-server thread). Without it the ONLY thing rendering a just-sent
          // codex steer is the client's optimistic bubble, and mergeOptimistic's ghost floor retires
          // that once the transcript advances 60s past it — measured against fray's own delivery
          // records, 8 of 75 codex sends took longer than that to appear in the rollout (steers at 71s,
          // 212s and 4.6h), so the message could vanish from the drawer entirely. The tailer drops the
          // item the moment the rollout materialises the message.
          if (input.deliveryId) {
            appendDelivery(ctx.storage, input.slug, { id: input.deliveryId, text: input.message, state: "enqueued" })
          }
          ctx.board.refresh()
          return
        }
        // Claude session-broker follow-up: a broker-backed claude row owns a DETACHED daemon, not a tmux
        // pane, so it can't go through the composer/sendKeys path. Route through the bridge — it reconnects
        // the live daemon's socket (context intact) or cold-resumes a dead one. Branch on the ROW's runtime
        // (not the flag): a row dispatched via the broker must always be served via the broker. The worker
        // system prompt is rebuilt so a cold resume re-applies it (ignored when the daemon is still alive).
        if (row?.backend === "claude" && row.claude_runtime === "broker") {
          const bridge = ctx.claudeBroker
          if (!bridge) throw new Error("Claude session broker is unavailable; cannot deliver this follow-up")
          // Replay guard, same as the tmux path below: the ledger entry is written only once
          // `bridge.followUp` RETURNS, so a hit proves the text already crossed into the daemon. The
          // broker branch returns before that check, so it had none — a replayed deliveryId sent the
          // message a SECOND time. It also matters now that the deliveryId IS the SDK input uuid: the
          // SDK rejects an id that is still outstanding, so a replay would surface as an error on the
          // operator's send instead of the no-op it should be.
          if (input.deliveryId && hasDelivery(ctx.storage, input.slug, input.deliveryId)) return
          const appendSystemPrompt = [
            loadWorkerPrompt("claude"),
            scratchpadOrientation(row.session_id, row.plan_path, "claude"),
            frayConfigBlock(ctx.project.dir),
          ].filter(Boolean).join("\n\n")
          await bridge.followUp({
            threadSlug: input.slug,
            sessionId: row.session_id,
            cwd: ctx.project.dir,
            text: input.message,
            // Rides through to the SDK as this input's uuid, which the SDK echoes back on the record
            // that delivers it — the ledger then correlates by identity rather than by text.
            deliveryId: input.deliveryId,
            permissionMode: (row.permission_mode as ClaudePermissionMode | null) ?? undefined,
            appendSystemPrompt,
            model: row.model ?? undefined,
            effort: row.effort ?? undefined,
            // The pause card's "Continue now" is the same act as the scheduler's auto-resume, so it
            // needs the same treatment: while the process is still latched on its own 429, delivering
            // into it does nothing at all. Restart it instead — otherwise the button is a no-op and
            // reads as fray having ignored the click.
            //
            // `input.freshProcess` is the operator asking for it OUTRIGHT (the "Restart worker" verb),
            // which the server cannot derive: only the human knows they want the worker back on a newer
            // build. It is OR'd in rather than replacing the derivation, so a restart clicked on a
            // limit-latched thread still behaves. The live-sub-agent refusal above applies to both.
            freshProcess: input.freshProcess === true || needsFreshProcessForLimit(
              ctx.tailer.get(input.slug)?.limitFault,
              Date.now(),
              (ctx.tailer.get(input.slug)?.subAgents ?? []).some((agent) => agent.state === "running"),
            ),
          })
          // The ledger's RELIABILITY half is indeed tmux-only — flush-stuck-composer and the
          // pane-inspected receipt are skipped for a headless row (isHeadlessRow gates both), and no
          // delivery marker is stamped because nothing rewrites bytes on the way to the SDK. But its
          // RENDERING half applies here exactly as it does to codex: until the JSONL carries the
          // message, the only thing showing the human their own just-sent steer is the client's
          // optimistic bubble, and mergeOptimistic's ghost floor retires that once the transcript
          // advances 60s past it. So open an entry — `enqueued`, because the SDK call returning IS the
          // receipt, which also keeps it out of the amber "check the terminal" state that would be
          // meaningless on a thread with no terminal. The tailer drops it as soon as the record lands.
          // A restart RETIRED the process every earlier outstanding send was handed to, so those sends
          // are dead and their queued bubbles are now claims about a process that no longer exists.
          // Clear them here, BEFORE this restart's own entry is opened, so the continuation is the only
          // thing left queued. Without this they linger the rest of the hour and cannot be dismissed by
          // hand — the unqueue click asks the NEW daemon about a uuid it never heard of and answers
          // "Too late — that message has already left the queue", which is exactly backwards.
          if (input.freshProcess) retireOutstandingDeliveries(ctx.storage, input.slug)
          // "Interrupt and send": preempt whatever the worker is doing so it reads this NOW. Strictly
          // AFTER the delivery above, and that order is the whole mechanism — the SDK's interrupt
          // aborts the turn without discarding queued inputs (its receipt reports `still_queued`), so
          // a message queued first is what the next turn opens on. Interrupting first would abort into
          // an empty queue and the message would merely start an ordinary new turn.
          //
          // Measured live (_live_broker_interrupt_send.mts) against a real 90s tool call in flight:
          // 94.4s without it, seconds with it, and the session takes ordinary follow-ups afterwards.
          if (input.interrupt) bridge.interruptTurn({ threadSlug: input.slug, sessionId: row.session_id })
          if (input.deliveryId) {
            appendDelivery(ctx.storage, input.slug, { id: input.deliveryId, text: input.message, state: "enqueued" })
          }
          ctx.board.refresh()
          return
        }
        // Idempotency for a REPLAYED deliveryId: if this exact send is already in the ledger, it
        // provably reached the worker — answer success and inject nothing (and don't flush/re-inject).
        //
        // What actually guarantees the retry loop cannot double-send is the CLASSIFICATION, not this
        // check: the client only replays an error typed RetryableDeliveryError, and every such throw is
        // raised strictly upstream of the first tmux write, so a replayed send never had a first copy to
        // duplicate. This dedup is defense-in-depth for replays from OTHER sources (a stale tab, an
        // at-least-once transport). It deliberately does NOT cover a throw misclassified as retryable
        // AFTER an injection: `appendDelivery` runs only once `resumeThread` returns, so such a throw
        // leaves no ledger row and this check would miss it. Keeping every retryable throw pre-injection
        // is therefore load-bearing, not optional.
        if (input.deliveryId && row?.backend !== "codex" &&
            hasDelivery(ctx.storage, input.slug, input.deliveryId)) {
          return
        }
        // The deliveryId rides along so the composer paths can stamp the send with its invisible marker
        // (delivery-marker.ts) — that is what lets the tailer confirm delivery by IDENTITY instead of by
        // comparing prose the tmux+TUI paste channel is free to rewrite. Codex never takes this path.
        resumeThread({ project: ctx.project, storage: ctx.storage, board: ctx.board, getSettings: ctx.getSettings, backendFor: ctx.backendFor }, input.slug, input.message,
          input.deliveryId && row?.backend !== "codex" ? input.deliveryId : undefined,
          // "Continue now" on a limit-paused tmux thread relaunches it, for the same reason the broker
          // branch above swaps its process: the running one is not listening.
          {
            freshProcess: needsFreshProcessForLimit(
              ctx.tailer.get(input.slug)?.limitFault,
              Date.now(),
              (ctx.tailer.get(input.slug)?.subAgents ?? []).some((agent) => agent.state === "running"),
            ),
          })
        // Injection accepted → open a delivery-ledger entry (Claude rows only; Codex has its own durable
        // queue above). From here the send is a tracked state machine: the tailer correlates the JSONL
        // evidence and the transcript projection renders the queued bubble as SERVER truth — reload-safe,
        // consumed by the client's optimistic copy via this deliveryId instead of by text match.
        if (input.deliveryId && row?.backend !== "codex") {
          appendDelivery(ctx.storage, input.slug, { id: input.deliveryId, text: input.message })
        }
        ctx.board.refresh()
      },
    }),

    // Take a queued follow-up BACK — the operator clicked their own gray bubble to unqueue it and get
    // the words back in the prompt box. The whole value of this is that it is TRUTHFUL: it reports
    // whether the provider actually removed the message, and never claims a retraction it did not get.
    //
    // Only a broker-backed Claude row can do it, because only there does fray hold a control channel
    // into a queue that still exists. A tmux row's text was typed into Claude Code's own TUI composer
    // and a codex app-server steer went straight into the running turn — in both cases the message has
    // left every surface fray can address, and the honest answer is "too late", not a silent no-op.
    unqueueFollowUp: mutation({
      input: UnqueueFollowUpInput,
      output: UnqueueFollowUpResult,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (!row) throw new Error("This thread is no longer the session this tab is looking at")
        if (row.backend !== "claude" || row.claude_runtime !== "broker") {
          return { unqueued: false, reason: "This thread's runtime can't take a message back once it's been sent" }
        }
        const bridge = ctx.claudeBroker
        if (!bridge) throw new Error("Claude session broker is unavailable; cannot unqueue this follow-up")
        // ONE refusal sentence for every way this can be too late — and it deliberately does NOT claim
        // the message was DELIVERED, which is what it used to say.
        //
        // `cancelled: false` proves exactly one thing: the message is not in the queue any more. The
        // obvious reading is "the agent picked it up", and that is what happens in every state fray has
        // been able to reach. But the SDK documents another: once a batch is dequeued and coalesced,
        // cancelling a member answers false whether its content still runs or the whole batch was
        // dropped. Probed hard for that (_live_sdk_cancel_coalesced.mts) and could not reach it — which
        // is not the same as proving it absent, so the wording must not depend on the answer. What fray
        // knows is that the message left the queue and is beyond its reach; the bubbles it could not
        // retract stay gray rather than flipping to delivered, so an undelivered message keeps LOOKING
        // undelivered whichever reading is true.
        const tooLate = { unqueued: false, reason: "Too late — that message has already left the queue, so fray can't take it back" }
        const item = deliveryItem(ctx.storage, input.slug, input.deliveryId)
        // Already retracted — a double click, or a second tab clicking the same bubble. Idempotent
        // rather than "too late": the message really is gone, and saying otherwise would be a lie in
        // the dangerous direction.
        if (item?.state === "cancelled") return { unqueued: true }
        // A retired ledger row means the tailer already correlated this send's delivery evidence — the
        // agent has it. It is also where a deliveryId fray never sent lands, which the UI cannot
        // produce (every clickable bubble is one fray itself projected from a ledger row).
        //
        // The row is also what makes a successful cancel SAFE to perform: without it there is nothing
        // to tombstone, and the orphaned JSONL enqueue bubble would stay on screen — which reads
        // exactly like the cancel failed.
        if (!item) return tooLate
        const cancelled = await bridge.cancelFollowUp({
          threadSlug: input.slug,
          sessionId: row.session_id,
          deliveryId: input.deliveryId,
        })
        // ORDER: tombstone only AFTER the provider confirms. Recording a cancellation fray did not get
        // would hide a message the agent is about to read — the one failure this feature must not have.
        if (!cancelled) return tooLate
        cancelDelivery(ctx.storage, input.slug, input.deliveryId)
        ctx.board.refresh()
        return { unqueued: true }
      },
    }),

    // Per-thread permission/sandbox control. Idle conversations reattach with backend-native launch
    // flags; active work, pending approvals, and unsent native drafts fail closed with a precise error.
    setThreadPermission: mutation({
      input: SetThreadPermissionInput,
      output: SetThreadPermissionResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((t) => t.id === input.slug)
        if (!thread || thread.foreign || thread.kind !== "session") throw new Error(`thread ${input.slug} is not editable`)
        // EVERY codex thread persists its sandbox and applies it on the next turn: there is no tmux pane
        // to reattach, and the permission controller is now a CLAUDE-only path (it inspects the pane with
        // inspectClaudeComposer). Keying this on `codex_runtime === "app-server"` instead of the backend
        // let a LEGACY codex row (dispatched pre-cutover, codex_runtime NULL, not yet migrated) fall into
        // that controller and get its Codex TUI parsed as a Claude composer. followUp already branches on
        // the backend alone and migrates such a row on contact; match it.
        const permRow = ctx.storage.getSession(input.slug)
        if (permRow?.backend === "codex") {
          // Persist FIRST and unconditionally: the registry is the operator's stated intent, it is what
          // every later cold resume now carries (resumeSandboxOverride), and it must survive even if the
          // eager apply below cannot reach the app-server.
          ctx.storage.setPermissionMode(input.slug, input.permissionMode)
          ctx.board.refresh()
          // Then apply it to the LIVE thread. Before this the handler stopped at the line above and told
          // the operator "saved for the next resume" — a promise nothing kept, because no resume path
          // sent a sandbox at all. `thread/settings/update` retunes a loaded thread in place, and the
          // bridge only reports `applied` once the app-server's own `thread/settings/updated`
          // notification confirms the new policy.
          const bridge = ctx.codexAppServer
          const sandbox = codexSandbox(input.permissionMode) as CodexSandboxMode
          if (bridge && bridge.binding(input.slug, permRow.session_id)) {
            try {
              const applied = await bridge.setSandbox({ threadSlug: input.slug, sessionId: permRow.session_id, sandbox })
              // A change made against a RUNNING turn is accepted and durable, but the running turn keeps
              // the policy it started under — so say "next turn", never "applied to the live session".
              if (applied.applied) return { effect: applied.turnInFlight ? "next-turn" as const : "applied" as const }
            } catch {
              // A bridge that cannot reach the app-server (or a thread it no longer holds) is not an
              // error the operator needs to see: the intent is already persisted and the next resume
              // carries it. Fall through to the pre-existing "next-resume" answer.
            }
          }
          return { effect: "next-resume" as const }
        }
        // Claude: persist the operator's intent and carry it on the next cold-resume fork.
        //
        // This used to branch — a broker row persisted and reported next-resume, while a PANE row went
        // through the permission controller, which inspected the live TUI's composer to protect an
        // unsent draft and then relaunched the conversation with a different launch flag. There are no
        // pane rows any more, so that whole apparatus (permission-controller.ts, 421 lines of pane
        // scraping) went with the tmux transport and this is the only path left.
        //
        // Deliberately still `next-resume` rather than `applied`: the broker's `set-mode` frame is
        // fire-and-forget with no acknowledgement, and this codebase does not call an unconfirmed write
        // "applied" — that is the same rule cancel-input and stop-task are built on. Confirming it would
        // need a response frame on set-mode, which is its own change.
        ctx.storage.setPermissionMode(input.slug, input.permissionMode)
        ctx.board.refresh()
        return { effect: "next-resume" as const }
      },
    }),

    threadProfileOptions: query({
      input: ThreadProfileOptionsInput,
      output: ThreadProfileOptionsResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not editable`)
        return threadProfileOptions(row.backend)
      },
    }),

    setThreadProfile: mutation({
      input: SetThreadProfileInput,
      output: SetThreadProfileResult,
      handler: async ({ input }) => {
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.foreign || thread.kind !== "session") throw new Error(`thread ${input.slug} is not editable`)
        // Codex takes model/effort per turn (turn/start) — no tmux process handoff. Persist them; the
        // next follow-up turn picks them up. Branch on the BACKEND, not codex_runtime: the profile
        // controller is Claude-only now, so a legacy (unmigrated) codex row must not reach its reattach.
        const profRow = ctx.storage.getSession(input.slug)
        if (profRow?.backend === "codex") {
          ctx.storage.setProfile(input.slug, input.model, input.effort)
          ctx.board.refresh()
          return { effect: "next-resume" as const }
        }
        // Claude: model/effort are fixed at fork time (the SDK takes them at query start), so a live
        // daemon cannot retune mid-session. Persist the intent and let the next cold-resume fork carry
        // it. The pane branch that used to follow — profile-controller relaunching the conversation
        // under new flags after inspecting the composer for an unsent draft — went with tmux.
        validateThreadProfile("claude", input.model, input.effort)
        ctx.storage.setProfile(input.slug, input.model, input.effort)
        ctx.board.refresh()
        return { effect: "next-resume" as const }
      },
    }),

    // Archive = hide the row (UI flag) AND settle the fray doc: a non-terminal thread gets
    // status: done written to its frontmatter. Respawn/resume un-archives the row.
    archiveThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        ctx.storage.setArchived(input.slug, true)
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (!isAutoTitledSession(input.slug) && t && t.status !== "done" && t.status !== "dismissed") {
          await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"]).catch(() => {})
        }
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    markRead: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        ctx.storage.markRead(input.slug)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Read/seen telemetry only: opening a thread records both seen_at and last_read_at. Queue
    // membership is lifecycle-driven, so viewing a resting handoff never acknowledges or removes it.
    // No-op for a foreign thread (no registry row — foreign threads never enter the queue).
    threadSeen: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) return
        const at = new Date().toISOString()
        ctx.storage.setSeenAt(input.slug, at)
        ctx.storage.markRead(input.slug, at)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // Explicit lifecycle write for session threads: Archive (the done-card button / row action) and
    // Reopen. This is the ONLY writer of state='archived' — the done fence itself mutates nothing
    // (maintainer-settled). Touches only ui.db; never the .fray legacy files.
    setThreadState: mutation({
      input: z.object({ slug: ThreadSlug, state: z.enum(["open", "archived"]) }).strict(),
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) throw new Error(`no session registered for ${input.slug}`)
        ctx.storage.setState(input.slug, input.state)
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // “Mark as done” stops a resting provider shell and archives in one action. The server—not the
    // client—asks for confirmation only when current telemetry shows an executing/ambiguous turn.
    completeThread: mutation({
      input: z.object({ slug: ThreadSlug, sessionId: z.string().min(1), terminateLive: z.boolean().default(false) }).strict(),
      // `hold` rides along only with needsConfirmation:true — it is the evidence the dialog names.
      output: z.object({ needsConfirmation: z.boolean(), hold: CompletionHold.optional() }),
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        const result = await completeRegisteredThread(
          ctx.storage, row, input.terminateLive, cachedLivenessTerminator, ctx.tailer.get(input.slug), ctx.codexAppServer, ctx.claudeBroker,
        )
        if (!result.needsConfirmation) ctx.board.refresh()
        return result
      },
    }),

    // Durable manual snooze. The client sends one exact UTC instant derived from its local picker;
    // Archive clears it, Wake now (`until: null`) is the explicit un-park, and a follow-up clears it too
    // (see followUp) — Wake now is for un-parking WITHOUT sending a turn. The operator may deliberately
    // park any queue reason—including an unresolved ask, permission prompt, or crash—until this deadline.
    //
    // An optional `prompt` upgrades the park into a SCHEDULED BUMP: at the deadline the wake scheduler
    // resumes this thread with that text over the same durable outbox a worker's `awaiting timer:` uses
    // (scheduler.ts, SOURCE 3). Without one the snooze stays what it always was — the card re-surfaces
    // and the human acts. `until: null` (wake now) clears both halves.
    setThreadSnooze: mutation({
      input: SetThreadSnoozeInput,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        const thread = (await ctx.board.snapshot()).threads.find((candidate) => candidate.id === input.slug)
        if (!thread || thread.kind !== "session" || thread.foreign) throw new Error(`thread ${input.slug} is not editable`)
        if (input.until !== null) {
          if (thread.state === "archived") throw new Error("Reopen this thread before snoozing it")
          if (Date.parse(input.until) <= Date.now()) throw new Error("Snooze time must be in the future")
        }
        ctx.storage.setSnoozedUntil(input.slug, input.until, input.prompt ?? null)
        // "Wake now" is also the cancellation path for a confirmed wait: clearing only snoozed_until
        // would leave the row still holding an operator confirmation it no longer wants.
        if (input.until === null) {
          ctx.storage.clearAwaitingWaitIfSession(input.slug, row.session_id, row.runtime_generation ?? 0)
        }
        ctx.board.refresh()
      },
    }),

    // Re-read the worker plugin closure INTO the live session: hooks, skills, agent profiles and MCP
    // servers, without restarting the process. This is `/reload-plugins` driven from the board.
    //
    // It exists because Restart is a process-level reset — it discards the running turn and the
    // session's in-memory sub-agents to apply a file change the session could simply re-read. For the
    // common case (edit a hook or a skill, want the running worker to pick it up) that is far too
    // blunt, and it is exactly what an operator iterating on the worker closure does all day.
    //
    // Claude-broker threads only. The tmux path has no control channel to ask, and fray's codex
    // app-server client speaks no reload method — both surface as a plain refusal rather than a
    // silently-ignored click.
    reloadThreadPlugins: mutation({
      input: z.object({ slug: ThreadSlug, sessionId: z.string().min(1) }).strict(),
      output: ThreadPluginReloadResult,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (row.claude_runtime !== "broker") {
          throw new Error("Only a broker-backed Claude thread can reload its plugins in place")
        }
        const bridge = ctx.claudeBroker
        if (!bridge) throw new Error("Claude session broker is unavailable; cannot reload this thread's plugins")
        const reloaded = await bridge.reloadPlugins({ threadSlug: input.slug, sessionId: row.session_id })
        return reloaded
      },
    }),

    // THE RECURRING PROMPT (scheduler.ts SOURCES 4 and 5), from the footer panel. One mutation for the
    // text, both triggers and the cadence, because they are all views of one row: split apart, a tab
    // holding a stale copy of one field would clobber the rest on save.
    //
    // Storage decides whether this is a fresh arming or an edit (it keeps the generation when the text
    // and the interval are both unchanged), so flipping a trigger off and on cannot supersede a delivery
    // already in flight for those same words, while editing the words does exactly that.
    setThreadRecurringPrompt: mutation({
      input: SetThreadRecurringPromptInput,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        assertRecurringPromptArmable(input, row)
        if (!ctx.storage.setRecurringPromptIfCurrent(
          input.slug,
          row.session_id,
          row.runtime_generation ?? 0,
          input.prompt,
          input.onRest,
          input.onSchedule,
          recurringIntervalMs(input),
          new Date().toISOString(),
        )) {
          throw new Error("This thread moved on; reopen it and try again")
        }
        ctx.board.refresh()
      },
    }),

    // The WORKER arming its own, from `mcp__fray__recurring_prompt`. Same row the footer panel writes;
    // different caller, and therefore a different guard.
    //
    // Unguarded on session/generation ON PURPOSE — see SetOwnThreadRecurringPromptInput. The MCP server
    // knows only its slug, which fray stamped into its env at spawn and which survives every resume,
    // while the session id underneath it does not. It is not attacker-supplied: a model can choose the
    // TEXT but never the thread, so there is deliberately no slug parameter it could aim elsewhere. One
    // agent making a DIFFERENT thread loop forever is not a capability fray hands out.
    setOwnThreadRecurringPrompt: mutation({
      input: SetOwnThreadRecurringPromptInput,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not registered`)
        assertRecurringPromptArmable(input, row)
        if (!ctx.storage.setRecurringPromptBySlug(
          input.slug,
          input.prompt,
          input.onRest,
          input.onSchedule,
          recurringIntervalMs(input),
          new Date().toISOString(),
        )) {
          throw new Error(`thread ${input.slug} could not be updated`)
        }
        ctx.board.refresh()
      },
    }),

    // Event-snooze the awaiting-background card: capture the CURRENT rest instant so the board hides the
    // card until rested_at advances — the exact moment the thread's own sub-agent/shell returns and the
    // worker comes to a new rest. No deadline, no scheduler, no reaper: the session stays alive (it is
    // ALREADY resting) and the snooze expires itself on the next rest. Session-guarded so a stale tab
    // cannot snooze whatever now owns the slug.
    snoozeAwaitingBackground: mutation({
      input: z.object({ slug: ThreadSlug, sessionId: z.string().min(1) }).strict(),
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        if (!row.rested_at) throw new Error("This thread is not at rest; nothing to snooze")
        if (!ctx.storage.setBgSnoozeRestedAtIfCurrent(input.slug, row.session_id, row.runtime_generation ?? 0, row.rested_at)) {
          throw new Error("This thread changed before it could be snoozed")
        }
        ctx.board.refresh()
      },
    }),

    // An awaiting fence is only a PROPOSAL. Confirming binds ONE exact final-message generation to
    // durable state; stale cards, malformed refs, elapsed timers, and in-flight workers fail closed.
    //
    // Ported from origin/main onto local main's fence shape. Two adaptations matter: local main's
    // FenceView carries `hints[]` and no instant of its own, so the identity instant is the tail's last
    // activity — exactly what scheduler.ts's fenceIdentity() keys on. And the timer is CANONICALIZED
    // before it reaches snoozed_until: the fence grammar admits instants the durable snooze grammar
    // rejects, and writing a raw hint here is the precise bug that made "Confirm snooze" fail on the
    // worker contract's own documented form.
    confirmAwaiting: mutation({
      input: ConfirmAwaitingInput,
      handler: async ({ input }) => {
        const row = currentOwnedSession(input.slug, input.sessionId)
        const tele = ctx.tailer.get(input.slug)
        const fence = tele?.lastFence
        if (row.state === "archived" || row.archived === 1) {
          throw new Error("Reopen this thread before confirming its wait")
        }
        const fenceAt = tele?.lastActivityAt
        const hint = fence?.hints.find((h) => h.kind === input.hint.kind && h.value === input.hint.value)
        if (tele?.turn !== "idle" || fence?.kind !== "awaiting" || !isActionableAwaitingHint(hint)) {
          throw new Error("This awaiting proposal is no longer current")
        }
        if (!fenceAt || !Number.isFinite(Date.parse(fenceAt)) || fenceAt !== input.fenceAt) {
          throw new Error("This awaiting proposal changed before it could be confirmed")
        }
        const snoozedUntil = hint.kind === "timer" ? canonicalSnoozeInstant(hint.value) : null
        if (hint.kind === "timer" && !snoozedUntil) {
          throw new Error("This awaiting proposal changed before it could be confirmed")
        }
        if (snoozedUntil && Date.parse(snoozedUntil) <= Date.now()) {
          throw new Error("This scheduled time has already passed")
        }
        const fenceId = awaitingFenceIdentity(input.hint, input.fenceAt)
        if (!ctx.storage.confirmAwaitingWait(
          input.slug, row.session_id, row.runtime_generation ?? 0, fenceId, new Date().toISOString(), snoozedUntil,
        )) {
          throw new Error("This awaiting proposal changed before it could be confirmed")
        }
        ctx.board.refresh()
      },
    }),

    // Dismiss/forget: the HARD-DELETE verb for a stalled/exited phantom the user wants GONE, not merely
    // shelved (Archive = state='archived', still listed in Inactive). Removes the registry row AND
    // tombstones its transcript id so a log-dir rescan / foreign-discovery can never resurrect it, then
    // drops the tailer's in-memory state. GATED on a NOT-live row: only a thread whose derived runtime is
    // "exited" (a dead pane, or a boot-failure "Stalled" session degradeIfNoTranscript flags) can be
    // forgotten — a genuinely-live session (running / turn-idle / perm-prompt) is refused so it can't be
    // yanked out from under itself. Idempotent: an already-forgotten slug no-ops.
    forgetThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) {
          if (ctx.storage.getAdoptionClaim(input.slug)) {
            throw new Error("An adoption attempt is in progress; nothing was dismissed")
          }
          return // already gone — idempotent
        }
        const t = (await ctx.board.snapshot()).threads.find((x) => x.id === input.slug)
        if (t && t.runtime !== "exited") {
          throw new Error("only a stalled or exited session can be dismissed — archive a live one instead")
        }
        await stopAndForgetRegisteredRuntime(ctx.storage, row, cachedLivenessTerminator, ctx.codexAppServer, ctx.claudeBroker)
        ctx.tailer.forget(input.slug)
        ctx.board.refresh() // storage-only change — the removed row fans out as a delete delta on SSE
      },
    }),

    // A plan artifact's markdown. The exact resolver used by board discovery requires direct,
    // non-symlink parent directories and a stable no-follow direct `.md` child, so an RPC path cannot
    // traverse, follow an indirect file, or win a check/read replacement race.
    planBody: query({
      input: z.object({ path: z.string() }),
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        const file = resolvePlanFile(ctx.project.dir, input.path)
        return { markdown: file?.contents.toString("utf8") ?? "" }
      },
    }),

    // Hard-delete a plan artifact (.fray/plans/*.md). Same secure resolver as planBody gates it, so a
    // traversal / symlink / indirect target unlinks nothing; an already-gone plan is idempotent. A real
    // filesystem failure re-throws out of deletePlanFile and surfaces as an RPC error. rebuild() (NOT the
    // overlay-only refresh()) recomputes the plans cache so the removed plan drops immediately rather than
    // only when the .fray watcher's debounced rebuild later catches up.
    planDelete: mutation({
      input: z.object({ path: z.string() }),
      handler: async ({ input }) => {
        deletePlanFile(ctx.project.dir, input.path)
        await ctx.board.rebuild()
      },
    }),

    // The thread's scratchpad (.fray/threads/<session-id>/scratch.md) — the worker's compaction-proof
    // working memory, rendered as the thread's doc tab. "" when never provisioned / foreign.
    threadScratchpad: query({
      input: SlugInput,
      output: z.object({ markdown: z.string() }),
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) return { markdown: "" }
        try {
          return { markdown: readFileSync(join(ctx.project.dir, scratchpadRelPath(row.session_id)), "utf8") }
        } catch {
          return { markdown: "" }
        }
      },
    }),

    // Copy only a provider-native resume invocation. The durable session registry is the ownership
    // boundary: board session views are derived from these exact rows, while foreign discoveries and
    // legacy docs have no row. Avoid rebuilding the full board on this latency-sensitive click path.
    // The command attaches a SECOND provider client and never touches Fray's private tmux pane, so it
    // is offered in every runtime state, live too. An absent/replaced row fails closed.
    threadTerminalCommand: query({
      input: SlugInput,
      output: z.object({ command: z.string().nullable(), mode: z.enum(["attach", "resume", "unavailable"]), reason: z.string().nullable() }),
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) {
          throw new Error("No Fray-owned terminal session is available for this thread")
        }
        // A LIVE pane gets an ATTACH, not a resume. `<cli> resume` is not a second view of a running
        // session — it starts a SEPARATE process that replays the transcript — so it structurally
        // cannot show live runtime state, and the state a human most often opens a terminal to deal
        // with is exactly that: a permission prompt the worker is parked on, which is never written to
        // the transcript at all. Handing back a resume there sends the human to a terminal that looks
        // Always a RESUME. There used to be an ATTACH branch for a live tmux pane — a genuinely
        // different thing, since `<cli> resume` replays the transcript in a separate process and can
        // show neither live runtime state nor a permission prompt the worker is parked on. Workers do
        // not run in panes any more, so there is nothing to attach to and the resume is the only
        // honest offer.
        // Gated only on a real provider-native id existing — no paternalistic "wait for it" block.
        const backend = row.backend
        if (backend === "claude" || backend === "codex") {
          // Claude pins session_id via --session-id, so its native id IS session_id. Codex mints its OWN
          // rollout id (agent_session_id), discovered shortly after spawn; the Fray UUID would not resume
          // it, so require the discovered id rather than falling back to session_id.
          const nativeId = backend === "codex" ? row.agent_session_id : (row.agent_session_id ?? row.session_id)
          if (nativeId) {
            return {
              command: providerResumeCommand(backend, ctx.project.dir, nativeId),
              mode: "resume" as const,
              reason: null,
            }
          }
          if (backend === "codex") {
            return {
              command: null,
              mode: "unavailable" as const,
              reason: "Codex hasn't reported its resumable session id yet — it appears once the first turn begins.",
            }
          }
        }
        return {
          command: null,
          mode: "unavailable" as const,
          reason: "This Fray-owned thread has no verified provider session available to resume.",
        }
      },
    }),

    // Route a link clicked inside the chromeless Chrome --app window to the OS default browser.
    // Without this, http(s) links open within our dedicated user-data-dir profile — the
    // "anonymous Chrome window" the user reported. Validation lives in open-external.ts, which
    // rejects any non-http(s) scheme and spawns `open`/`xdg-open` with an args array (no shell).
    openExternal: mutation({
      input: z.object({ url: z.string() }),
      handler: async ({ input }) => {
        openExternalUrl(input.url)
      },
    }),

    // A local file can be opened only after its canonical real path is contained by the openable roots
    // (home-and-below + temp + project). The HTTP layer already rejects non-local/mismatched origins;
    // this gate means the endpoint never becomes arbitrary remote-origin or whole-filesystem access.
    openLocalFile: mutation({
      input: z.object({ path: z.string(), image: z.boolean().optional() }).strict(),
      output: z.object({ action: z.enum(["opened", "copy"]), path: z.string() }),
      handler: async ({ input }) => openLocalFile(
        input.path,
        ctx.getSettings().localFileOpener ?? "system",
        openRoots,
        { forceSystem: input.image === true },
      ),
    }),

    // Batch-classify path REFERENCES (as they appear in inline code) → their canonical openable path, or
    // null when a candidate doesn't resolve to a real file under the openable roots. The client renders
    // resolved ones as clickable inline code (opened via openLocalFile). Pure read: it only realpath-
    // resolves + stats within the gate, never opening a file nor revealing existence outside it.
    resolveLocalPaths: query({
      input: z.object({ paths: z.array(z.string().max(1024)).max(128) }).strict(),
      output: z.object({ resolved: z.array(z.object({ input: z.string(), path: z.string().nullable() })) }),
      handler: async ({ input }) => {
        const memo = new Map<string, string | null>()
        const resolved = input.paths.map((raw) => {
          if (!memo.has(raw)) memo.set(raw, resolveOpenableFile(raw, ctx.project.dir, openRoots))
          return { input: raw, path: memo.get(raw) ?? null }
        })
        return { resolved }
      },
    }),

    markComplete: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "done"])
        ctx.storage.markRead(input.slug)
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Assign ANY status (the "Mark as <status>" split button): the exact fray status the human picks.
    // Dismissing also ends the live agent session (same side-effect the Dismiss verb carries).
    setThreadStatus: mutation({
      input: z.object({ slug: ThreadSlug, status: z.enum(["active", "planning", "planned", "needs-human", "blocked", "done", "dismissed"]) }).strict(),
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        if (input.status === "dismissed") {
          const stopped = await stopRuntimeBySlug(ctx.storage, input.slug, cachedLivenessTerminator, ctx.codexAppServer, ctx.claudeBroker)
          if (stopped.row && !ctx.storage.setExitedIfCurrent(
            stopped.row.slug,
            stopped.row.session_id,
            stopped.row.runtime_generation ?? 0,
            true,
          )) {
            throw new Error("This thread resumed or was replaced while it was being stopped; the new worker was preserved")
          }
        }
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", input.status])
        if (input.status === "done" || input.status === "dismissed") ctx.storage.markRead(input.slug)
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // One-click recovery for a malformed thread file: PREPEND minimal frontmatter to a thread .md that
    // has none (see repair.ts for the guards + why it's deliberately conservative), then rebuild the
    // board so the healed thread appears in the queue/status system. Repairs the missing-frontmatter
    // case ONLY — the write hook already blocks compliant workers; this catches the stragglers.
    repairThread: mutation({
      input: z.object({ file: z.string() }),
      output: z.object({ slug: ThreadSlug }),
      handler: async ({ input }) => {
        const candidate = input.file.match(/^([a-z0-9][a-z0-9-]*)\.md$/)?.[1]
        if (candidate) assertLegacyMutationAllowed(candidate)
        const { slug } = repairThreadFile(frayDir, input.file)
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, fresh snapshot fans out on SSE (watcher also fires)
        return { slug }
      },
    }),

    dismissThread: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        assertLegacyMutationAllowed(input.slug)
        await runThreadUpdate(ctx.project.dir, input.slug, ["--status", "dismissed"])
        void ctx.board.rebuild().catch(() => {}) // .fray changed; respond now, snapshot lands via SSE (watcher also fires)
      },
    }),

    // Persist a HUMAN display title in Fray's session registry. This deliberately does not inject a
    // backend slash command: Codex and Claude expose different rename behavior, the process need not
    // be idle/live, and transcript ai-title records must never be allowed to replace explicit intent.
    renameThread: mutation({
      input: RenameThreadInput,
      handler: async ({ input }) => {
        if (!ctx.storage.getSession(input.slug)) throw new Error(`thread ${input.slug} is not editable`)
        ctx.storage.setTitle(input.slug, input.title)
        ctx.board.refresh() // storage-only overlay; publishes an immediate board delta to every client
      },
    }),

    // Ask the provider to name this thread — the "Rename with Claude" verb in the drawer header.
    //
    // This used to type `/rename` into the session's tmux pane and scrape the result back out. It now
    // goes through the broker's typed control channel to the SDK's own `generateSessionTitle`, which is
    // the same call the daemon already makes to seed a title on the first message. The pane path was
    // not merely legacy: it threw on every broker-backed thread, i.e. on every thread dispatched since
    // the broker cutover, so this verb was dead in the UI until now.
    aiRenameThread: mutation({
      input: AiRenameThreadInput,
      output: AiRenameThreadResult,
      handler: async ({ input }) => {
        const row = ctx.storage.getSession(input.slug)
        if (!row) throw new Error(`thread ${input.slug} is not editable`)
        const bridge = ctx.claudeBroker
        if (!bridge || row.claude_runtime !== "broker") {
          throw new Error("Only a running broker-backed Claude thread can be renamed by the provider")
        }
        // What to name it FROM: the thread's own opening request, which is what the daemon seeds from.
        // The live tail's last user text would name the session after whatever was said most recently,
        // which for a long thread is a side conversation rather than the work.
        const description = ctx.tailer.get(input.slug)?.lastAssistant?.trim() || row.title?.trim() || input.slug
        const title = await bridge.renameSession({ threadSlug: input.slug, sessionId: row.session_id, description })
        if (!title?.trim()) throw new Error("Claude did not return a title for this thread")
        ctx.storage.setTitle(input.slug, title.trim())
        ctx.board.refresh()
        return { title: title.trim() }
      },
    }),

    killAgent: mutation({
      input: SlugInput,
      handler: async ({ input }) => {
        // Termination goes through stopRuntimeBySlug's seam, so an app-server Codex thread is stopped
        // with turn/interrupt rather than a tmux kill-session for a pane that never existed. A stop that
        // could not be delivered throws out of here BEFORE setExitedIfCurrent, so the row is never
        // marked exited on the strength of a termination that did not happen.
        const stopped = await stopRuntimeBySlug(ctx.storage, input.slug, cachedLivenessTerminator, ctx.codexAppServer, ctx.claudeBroker)
        if (stopped.row && !ctx.storage.setExitedIfCurrent(
          stopped.row.slug,
          stopped.row.session_id,
          stopped.row.runtime_generation ?? 0,
          true,
        )) {
          throw new Error("This thread resumed or was replaced while it was being stopped; the new worker was preserved")
        }
        ctx.board.refresh() // storage-only change — overlay is enough
      },
    }),

    // The selectable Codex models + PER-MODEL effort options, read fresh (short TTL) from the
    // authoritative ~/.codex/models_cache.json so the picker tracks codex's own catalogue instead of a
    // hand-maintained list. Degrades to a minimal fallback (never throws) when the cache is absent.
    codexModels: query({
      output: z.array(CodexModel),
      handler: async () => readCodexModels(),
    }),

    // Provider subscription quota (5h + weekly rate-limit windows) for the sidebar status bar. Codex
    // reads live from the app-server's `account/rateLimits/read`, falling back to the rollout JSONL
    // fray already tails; Claude delegates to Claude Code's own non-interactive `/usage` command.
    // Never throws — degrades to per-provider "unavailable".
    quota: query({
      input: z.object({ force: z.boolean().optional() }).strict().optional(),
      output: QuotaSnapshot,
      handler: async ({ input }) => readQuota({ claudeBin: ctx.claudeBin, force: input?.force }),
    }),

    // Per-provider LOCAL credential presence for the new-thread dispatch gate. Distinct from `quota`
    // (whose "unavailable" is overloaded with transient endpoint failures): this reports only whether a
    // credential exists, so a dispatch can be blocked on a genuine "signed-out" without false-blocking
    // on a network blip. Never throws — degrades to per-provider "unknown", on which the gate fails open.
    authStatus: query({
      output: AuthSnapshot,
      handler: async () => readAuthSnapshot({ claudeBin: ctx.claudeBin }),
    }),

    // Typed provider account action behind the `/logout` alias + confirm dialog (claude-auth plan).
    // Refuses to race a live turn for that provider (account state is process-global), then runs the
    // exact provider CLI argv without a shell and reports the post-attempt credential state.
    accountLogout: mutation({
      input: AccountLogoutInput,
      output: AccountLogoutResult,
      handler: async ({ input }) => {
        const snapshot = await ctx.board.snapshot()
        return runProviderLogout({
          backend: input.backend,
          claudeBin: ctx.claudeBin,
          codexBin: ctx.codexBin,
          liveThreads: liveThreadsForBackend(snapshot.threads, input.backend),
        })
      },
    }),

    // Slice B login utility: the sign-in modal's PRIMARY action. Starts (or re-attaches to) the one
    // live `claude auth login` tmux session, addressed by a server-issued slug-shaped attempt id the
    // browser then attaches to over the existing hardened /term transport.
    accountLoginStart: mutation({
      input: AccountLoginStartInput,
      output: AccountLoginStartResult,
      handler: async ({ input }) => ctx.loginUtility.start(input.backend),
    }),

    accountLoginStatus: query({
      input: AccountLoginStatusInput,
      output: AccountLoginStatusResult,
      handler: async ({ input }) => {
        const { state, backend } = ctx.loginUtility.status(input.attemptId)
        const auth = await readAuthSnapshot({ claudeBin: ctx.claudeBin })
        // The login CLI finished → the pane is spent; tear it down eagerly so the OAuth bytes don't
        // linger in a dead pane. Cancel is idempotent.
        if (state === "exited") ctx.loginUtility.cancel(input.attemptId)
        return { state, auth: auth[backend ?? "claude"] }
      },
    }),

    accountLoginCancel: mutation({
      input: AccountLoginStatusInput,
      output: z.object({}),
      handler: async ({ input }) => {
        ctx.loginUtility.cancel(input.attemptId)
        return {}
      },
    }),

    settingsGet: query({
      output: Settings,
      handler: async () => ctx.getSettings(),
    }),

    settingsSet: mutation({
      input: Settings,
      output: Settings,
      handler: async ({ input }) => ctx.setSettings(input),
    }),

    // Clear the stored settings blob so defaults (incl. the shipped default preamble) apply again.
    settingsReset: mutation({
      input: z.object({}),
      output: Settings,
      handler: async () => ctx.resetSettings(),
    }),

    dispatchPreferencesGet: query({
      output: DispatchPreferences,
      handler: async () => getDispatchPreferences(ctx.storage, ctx.getSettings(), readCodexModels()),
    }),

    dispatchPreferenceSet: mutation({
      input: SetDispatchPreferenceInput,
      output: DispatchPreferences,
      handler: async ({ input }) => setDispatchPreference(ctx.storage, ctx.getSettings(), input, readCodexModels()),
    }),

    // The shipped GitHub batch-dispatch prompt templates (single source of truth: server/github.ts).
    // The Settings UI reads these to prefill the editors for editing and to power "reset to default";
    // an empty/unset githubIssuePrompt/githubPrPrompt setting means the server uses exactly these.
    githubPromptDefaults: query({
      output: z.object({ issue: z.string(), pr: z.string() }),
      handler: async () => ({ issue: DEFAULT_ISSUE_PROMPT, pr: DEFAULT_PR_PROMPT }),
    }),

    // ---- GitHub-first batch dispatch ----

    // gh availability: installed (cached, else live) + inRepo/nameWithOwner (cache-warmed resolveRepo)
    // + a LIVE authed re-check (never cached — a mid-session `gh auth login` reflects on the next
    // query). The repo is resolved only when authed (gh repo view needs auth), so a cached-negative
    // inRepo from an unauthed/racy boot never sticks. Never throws (all probes degrade to false/null).
    githubStatus: query({
      output: GithubStatus,
      handler: async () => {
        const installed = ctx.github?.installed ?? (await ghInstalled())
        if (!installed) return { installed: false, inRepo: false, nameWithOwner: null, authed: false }
        const authed = await ghAuthed()
        const nameWithOwner = authed ? await resolveRepo() : (ctx.github?.nameWithOwner ?? null)
        return { installed: true, inRepo: nameWithOwner !== null, nameWithOwner, authed }
      },
    }),

    // ONE PAGE of the repo's issues or PRs, search-sorted (recency or reactions), plus the totals the
    // picker's pager renders. Empty when this isn't a GitHub repo. resolveRepo warms/uses the cache
    // with a live fallback (so a post-boot sign-in works). A gh error (rate limit / network)
    // propagates → surfaced to the client as a failed query (risk 7), rather than silently reading as
    // "no items".
    githubList: query({
      input: GithubListInput,
      output: GithubListResult,
      handler: async ({ input }) => {
        const repo = await resolveRepo()
        if (!repo) return { items: [], total: 0, page: 1, pageCount: 1 }
        return await listItems(repo, input.kind, input.sort, input.page, input.perPage)
      },
    }),

    // Spin up one fray thread per checked item: hydrate each fresh from gh, template a server-side
    // prompt (single source of truth, unit-tested), then REUSE ctx.dispatcher.dispatch (no new spawn
    // logic). SEQUENTIAL — a burst of 20 concurrent tmux spawns would hammer the box (risk 5). A
    // per-item failure is captured in `failed[]` and never aborts the rest of the batch.
    githubDispatchBatch: mutation({
      input: GithubBatchInput,
      output: GithubBatchResult,
      handler: async ({ input }) => {
        validateGithubDispatchProfile(input)
        const repo = await resolveRepo()
        if (!repo) throw new Error("not a GitHub repo")
        // Read the templates ONCE per batch: the user's Settings override (githubIssuePrompt /
        // githubPrPrompt) when non-blank, else the exported default (effectiveTemplate decides).
        const settings = ctx.getSettings()
        const dispatched: { number: number; kind: string; slug: string }[] = []
        const failed: { number: number; kind: string; error: string }[] = []
        for (const it of input.items) {
          try {
            // Explicit title skips the fallback-chop so the slug reads investigate-owner-repo-N. RESERVE
            // the slug here with the SAME predicate dispatch uses (existing .fray file / registry row)
            // and pass it EXPLICITLY, so the prompt's THREAD tag equals the real dispatched slug even on
            // a collision (re-dispatch / duplicate items) — otherwise the worker would write a ghost
            // .fray/<base>.md disjoint from the -2 registry row (resolveSlug is idempotent on a free slug).
            const title = `${it.kind === "issue" ? "Investigate" : "Review"} ${repo}#${it.number}`
            const slug = resolveSlug(frayDir, slugify(title), (s) => ctx.storage.getSession(s) !== undefined)
            const template = effectiveTemplate(it.kind, it.kind === "issue" ? settings.githubIssuePrompt : settings.githubPrPrompt)
            const hydrated = it.kind === "issue" ? await hydrateIssue(repo, it.number) : await hydratePr(repo, it.number)
            const prompt = renderGithubPrompt(template, repo, hydrated, slug, it.kind)
            const request = githubDispatcherRequest(input, { prompt, title, slug })
            const res = await ctx.dispatcher.dispatch(request.payload, request.options)
            dispatched.push({ number: it.number, kind: it.kind, slug: res.slug })
          } catch (e) {
            failed.push({ number: it.number, kind: it.kind, error: (e as Error).message.slice(0, 120) })
          }
        }
        return { dispatched, failed }
      },
    }),
  }
}

export type AppRouter = ReturnType<typeof createRouter>
