import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { PermissionMode, wakeDeliveryToken, type Settings } from "@fray-ui/shared"
import { Bus, Emitter } from "./bus.ts"
import { resolveProject, type Project } from "./project.ts"
import { createStorage, type Storage } from "./storage.ts"
import { getSettings, setSettings, resetSettings } from "./settings.ts"
import { readQuota } from "./quota.ts"
import { refreshClaudeQuotaInBackground } from "./backend/claude-quota.ts"
import { createBoard, type BoardManager } from "./board.ts"
import { createTailer, defaultLogDir, type Tailer } from "./tailer.ts"
import { createDispatcher, type Dispatcher } from "./dispatch.ts"
import { createScheduler, type Scheduler } from "./scheduler.ts"
import {
  reattachThreadWithPermission,
  reattachThreadWithProfile,
  recoverThreadProfileHandoff,
  resumeThread,
} from "./resume.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend, codexSandbox } from "./backend/codex.ts"
import { readClaudeAuthStatusCli, readCodexAuthState } from "./backend/auth-status.ts"
import { createLoginUtility, type LoginUtility } from "./login-utility.ts"
import type { AgentBackend } from "./backend/types.ts"
import { detectGithub, type GithubDetection } from "./github.ts"
import * as tmux from "./tmux.ts"
import { createPermissionController, type PermissionController } from "./permission-controller.ts"
import { createDeliveryConfirmer, type DeliveryConfirmer } from "./delivery-confirm.ts"
import { createProfileController, type ProfileController } from "./profile-controller.ts"
import type { InteractionStore } from "./interaction-store.ts"
import {
  codexAppServerBridgeEnabled,
  createCodexAppServerBridge,
  type CodexAppServerBridge,
  type CodexSandboxMode,
} from "./backend/codex-app-server.ts"
import {
  ADOPTION_RECONCILE_INTERVAL_MS,
  adoptionRuntimeBinding,
  reconcileAdoptionClaims,
} from "./adoption-recovery.ts"
import { startOrphanReaper } from "./orphan-reaper.ts"
import {
  createRetryableCleanup,
  createShutdownBarrier,
  DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
  type ShutdownBarrier,
  type ShutdownBarrierOptions,
  type ShutdownDiagnostic,
} from "./shutdown.ts"

export const CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS = 4_000

// How often the server proactively refreshes the shared Claude quota cache (see the heartbeat wired
// below). One cheap endpoint GET per minute per account keeps the sidebar chip reading fresh.
const QUOTA_REFRESH_INTERVAL_MS = 60_000

export type ContextStartupPhase =
  | "storage"
  | "interaction expiry"
  | "adoption reconcile"
  | "orphan reaper"
  | "session reconcile"
  | "subscriptions"
  | "Codex app-server bridge"
  | "tailer"
  | "board watcher"
  | "permission producer"
  | "profile producer"
  | "wake scheduler"

export interface ContextStartupFence {
  whenSafe(): Promise<void>
  recover(): Promise<void>
}

export class ContextStartupError extends Error {
  readonly startupError: unknown
  readonly cleanupError: unknown
  readonly diagnostics: readonly ShutdownDiagnostic[]
  readonly fence: ContextStartupFence

  constructor(options: {
    startupError: unknown
    cleanupError: unknown
    diagnostics: readonly ShutdownDiagnostic[]
    fence: ContextStartupFence
  }) {
    const startupMessage = options.startupError instanceof Error ? options.startupError.message : String(options.startupError)
    const cleanupMessage = options.cleanupError instanceof Error ? options.cleanupError.message : String(options.cleanupError)
    super(`Fray context initialization failed: ${startupMessage}; partial-context cleanup failed: ${cleanupMessage}`, {
      cause: options.startupError,
    })
    this.name = "ContextStartupError"
    this.startupError = options.startupError
    this.cleanupError = options.cleanupError
    this.diagnostics = [...options.diagnostics]
    this.fence = options.fence
  }
}

// The wired singletons every request handler shares. Built once at boot in createContext.
export interface AppContext {
  // Random per-process id minted at boot. It rides every board/board-delta SSE frame and the
  // `x-fray-boot` header on /rpc responses; a client that sees it CHANGE knows the server restarted
  // under a possibly-stale page and hard-reloads once. Closes the stale-bundle / zombie-reconnect class.
  bootId: string
  project: Project
  bus: Bus
  // Internal (non-wire) per-tick signal: the batch of thread slugs whose session JSONL advanced this
  // tailer tick. The /ws transcript producer subscribes to it to PUSH updated transcripts to subscribed
  // clients (replacing the client's 1.5s poll). Kept off the wire ServerEvent bus deliberately.
  transcriptChange: Emitter<string[]>
  storage: Storage
  // Durable runtime-neutral interaction journal. Default TUI backends do not publish into it; the
  // disabled-by-default app-server foundation below is the only current provider adapter.
  interactions: InteractionStore
  // Experimental foundation for NEW bridge-owned Codex sessions only. Undefined by default; it is
  // never selected by backendFor and therefore cannot migrate or control an existing TUI session.
  codexAppServer?: CodexAppServerBridge
  board: BoardManager
  tailer: Tailer
  dispatcher: Dispatcher
  // Per-session agent-backend resolver behind the spawn/resume/transcript seam (Codex-support epic).
  // Maps a row's `backend` column (claude|codex) to its AgentBackend; DEFAULTS to claude for any unset/
  // unknown kind, so every existing session and all current behavior are unchanged until a dispatch
  // explicitly selects codex. Shared by the dispatcher, the tailer, and every resumeThread call.
  backendFor: (kind?: string) => AgentBackend
  // Durable timer scheduler (plus legacy pr/ci compatibility): resumes a rested `awaiting` session
  // on a witnessed transition. Human gates are descriptive. Started alongside the tailer; boot-safe.
  scheduler: Scheduler
  // Per-thread permission changes. Idle standalone TUIs are reopened on the same persisted
  // conversation with backend-native launch flags; busy/ambiguous states fail explicitly.
  permissionController: PermissionController
  profileController?: ProfileController
  // Proves an injected Claude follow-up was actually SUBMITTED, and re-presses Enter when the TUI
  // swallowed it and fray's own text is provably still sitting in the composer (delivery-confirm.ts).
  deliveryConfirmer: DeliveryConfirmer
  // Detach storage-owned observers before board/storage teardown. Idempotent and synchronous so a
  // deferred interaction notification cannot enqueue fresh board work during the shutdown drain.
  stopSubscriptions(): void
  getSettings: () => Settings
  setSettings: (s: Settings) => Settings
  resetSettings: () => Settings
  // GitHub detection (installed/inRepo/nameWithOwner) resolved ONCE at boot via initGithub() — stable
  // for the process lifetime. `authed` is NOT cached here; the githubStatus query re-checks it live so
  // a mid-session `gh auth login` reflects immediately. Undefined until initGithub() resolves (the
  // githubStatus handler falls back to a live detect during that ~30ms window). Kept OUT of the board
  // snapshot deliberately — no gh shell-out on every board delta.
  github?: GithubDetection
  // The dispatch Claude executable (tests use a stand-in). The account logout action runs the SAME
  // binary so sign-out targets the credential the workers actually use.
  claudeBin?: string
  // Same seam for Codex: the resolved app-server/backend executable, so codex login/logout target
  // the binary fray actually runs rather than whatever "codex" is first on PATH.
  codexBin?: string
  // Slice B account utility: the restricted short-lived `claude auth login` terminal behind the
  // sign-in modal's primary action. Attempts ride the /term transport via slug-shaped opaque ids.
  loginUtility: LoginUtility
}

export interface ContextOptions {
  claudeBin?: string // injectable dispatch executable (tests use a stand-in)
  codexBin?: string // injectable app-server executable; unused unless the bridge flag is enabled
  // startServer pins the owner-verified project before any SQLite/tailer/scheduler initialization.
  project?: Project
  /** Internal deterministic construction/rollback seam. */
  startup?: {
    afterPhase?: (phase: ContextStartupPhase) => void
    cleanupTimeoutMs?: number
    cleanupDiagnostic?: (event: ShutdownDiagnostic) => void
    cleanupDeadline?: ShutdownBarrierOptions["deadline"]
  }
}

// Boot reconcile: a session row whose tmux session is no longer live was orphaned by a prior
// server exit (or the agent finished/was killed) — stamp exited so the registry doesn't show a
// forever-running ghost. Runtime is also derived live on each board build; this keeps the stored
// column honest too.
//
// Liveness is asked through the BATCHED cache (one `list-panes -a` for the whole tmux server), not the
// per-slug `tmux.isLive`. The uncached form is one subprocess per row, run synchronously, before the
// server can listen: 165 rows measured 5.2-6.3s of pure process-spawn on the maintainer's board and
// grows linearly with thread count — it was the larger half of the "context" boot phase. The truth
// table is identical (missing session → dead, present-but-exited → dead, present-and-running → live);
// the only difference is that every row now reads the same ≤900ms-old inventory, which for a
// boot-time reconcile is the same instant.
export function reconcileSessions(storage: Storage) {
  for (const row of storage.allSessions()) {
    // A codex app-server thread has NO tmux pane by construction — it lives in the detached bridge
    // daemon. Sniffing tmux for it would stamp `exited` on every healthy headless thread at every
    // boot, which is exactly the trap deriveRuntime() in board.ts refuses to fall into. Its liveness
    // is the bridge's turn state, resolved live on each board build; leave the stored column alone.
    if (row.codex_runtime === "app-server") continue
    const binding = adoptionRuntimeBinding(storage, row)
    const live = binding.kind === "unbound"
      ? tmux.isLiveCached(row.slug)
      : binding.kind === "bound"
        ? (() => {
            const current = tmux.findExpectedAdoptionPane(binding.claim)
            return current.kind === "found" && !current.pane.dead
          })()
        : false
    if (!live && row.exited !== 1) {
      storage.setExitedIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, true)
    }
  }
}

// Resolve the stable GitHub detection triple once and cache it on ctx.github. Never throws
// (detectGithub swallows every gh failure), so it is safe to fire-and-forget at boot: a broken or
// absent gh just leaves the feature off. Called from startServer without blocking the listen — the
// githubStatus handler live-detects during the brief pre-cache window.
export async function initGithub(ctx: AppContext): Promise<void> {
  ctx.github = await detectGithub(ctx.project.dir)
}

interface PartialContextResources {
  storage?: Storage
  stopSubscriptions?: () => void
  codexAppServer?: CodexAppServerBridge
  board?: BoardManager
  tailer?: Tailer
  scheduler?: Scheduler
  permissionController?: PermissionController
  profileController?: ProfileController
  deliveryConfirmer?: DeliveryConfirmer
}

interface PartialContextCleanup {
  tailer(): Promise<void>
  permissionController(): Promise<void>
  deliveryConfirmer(): Promise<void>
  profileController(): Promise<void>
  subscriptions(): Promise<void>
  scheduler(): Promise<void>
  board(): Promise<void>
  codexAppServer(): Promise<void>
  storage(): Promise<void>
}

function partialContextCleanup(resources: PartialContextResources): PartialContextCleanup {
  return {
    tailer: createRetryableCleanup(() => resources.tailer?.stop()),
    permissionController: createRetryableCleanup(() => resources.permissionController?.stop()),
    deliveryConfirmer: createRetryableCleanup(() => resources.deliveryConfirmer?.stop()),
    profileController: createRetryableCleanup(() => resources.profileController?.stop()),
    subscriptions: createRetryableCleanup(() => resources.stopSubscriptions?.()),
    scheduler: createRetryableCleanup(async () => { await resources.scheduler?.stop() }),
    board: createRetryableCleanup(async () => { await resources.board?.stop() }),
    codexAppServer: createRetryableCleanup(async () => { await resources.codexAppServer?.shutdown() }),
    storage: createRetryableCleanup(() => resources.storage?.close()),
  }
}

function contextCleanupBarrier(
  cleanup: PartialContextCleanup,
  opts: ContextOptions,
  diagnostic: (event: ShutdownDiagnostic) => void,
): ShutdownBarrier {
  return createShutdownBarrier({
    timeoutMs: opts.startup?.cleanupTimeoutMs ?? CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS,
    // Bound + name each producer so a wedged one cannot stall startup-rollback cleanup indefinitely.
    phaseTimeoutMs: DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
    diagnostic,
    deadline: opts.startup?.cleanupDeadline,
    phases: [
      { name: "context tailer", run: cleanup.tailer },
      { name: "context permission producer", run: cleanup.permissionController },
      { name: "context delivery confirmer", run: cleanup.deliveryConfirmer },
      { name: "context profile producer", run: cleanup.profileController },
      { name: "context subscriptions", run: cleanup.subscriptions },
      { name: "context wake scheduler", run: cleanup.scheduler },
      { name: "context board watcher", run: cleanup.board },
      {
        name: "context Codex app-server bridge",
        run: cleanup.codexAppServer,
      },
    ],
    closeStorage: cleanup.storage,
  })
}

/**
 * Deliver a scheduler wake to a CODEX thread over the app-server bridge — adopting a legacy tmux
 * rollout first, then reactivating the persisted thread — exactly like the followUp RPC.
 *
 * Extracted from the scheduler `resume` closure so the promise contract below is directly testable.
 * It MUST return the promise rather than detaching it: the scheduler AWAITS `resume` and owns the
 * retry/supersede policy on rejection (scheduler.ts `deliverDue`). It previously ran this work in a
 * `void (async () => …)().catch(() => {})` IIFE and returned `undefined` synchronously, so the
 * scheduler saw an instant success and ACKED the delivery, while the real bridge failure landed
 * seconds later into a bare catch and vanished — no log, no retry, the wake lost permanently.
 * Claude's synchronous `resumeThread` throws straight into that same catch and retries correctly, so
 * the defect was CODEX-ONLY and silent: an `awaiting timer:` or limit-auto-resume codex thread could
 * simply never wake. See context.codex-wake.test.ts.
 */
export function deliverCodexWake(deps: {
  bridge: Pick<CodexAppServerBridge, "adoptExternalRollout" | "binding" | "resumeOwnedSession" | "followUp">
  storage: Pick<Storage, "setCodexRuntime">
  cwd: string
  row: { session_id: string; agent_session_id?: string | null; codex_runtime?: string | null }
  slug: string
  deliveryMessage: string
  deliveryId: string
}): Promise<void> {
  const { bridge, storage, cwd, row, slug, deliveryMessage, deliveryId } = deps
  return (async () => {
    if (row.codex_runtime !== "app-server" && row.agent_session_id) {
      await bridge.adoptExternalRollout({ threadSlug: slug, sessionId: row.session_id, codexThreadId: row.agent_session_id, cwd })
      storage.setCodexRuntime(slug, "app-server")
    }
    const binding = bridge.binding(slug, row.session_id)
    if (!binding || binding.state !== "active") await bridge.resumeOwnedSession(slug, row.session_id)
    await bridge.followUp({ threadSlug: slug, sessionId: row.session_id, text: deliveryMessage, deliveryId })
  })()
}

/**
 * Context construction is atomic to startServer: if any constructor/reconciliation step throws,
 * every already-created timer, observer, bridge, watcher and storage handle drains behind the same
 * bounded lifecycle barrier before the error crosses the ownership boundary.
 */
export async function createContext(opts: ContextOptions = {}): Promise<AppContext> {
  const resources: PartialContextResources = {}
  const cleanup = partialContextCleanup(resources)
  try {
    return createContextUnchecked(opts, resources)
  } catch (startupError) {
    const diagnostics: ShutdownDiagnostic[] = []
    const diagnostic = (event: ShutdownDiagnostic) => {
      diagnostics.push(event)
      opts.startup?.cleanupDiagnostic?.(event)
    }
    let barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
    let activeSafety = barrier.whenDrained()
    void activeSafety.catch(() => undefined)
    let cleanupError: unknown
    try {
      await barrier.close()
      await activeSafety
    } catch (error) {
      cleanupError = error
    }
    if (!cleanupError) throw startupError

    let recovery: Promise<void> | null = null
    const fence: ContextStartupFence = {
      whenSafe: () => activeSafety,
      recover: () => {
        if (recovery) return recovery
        barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
        activeSafety = barrier.whenDrained()
        void activeSafety.catch(() => undefined)
        const attempt = barrier.close().then(() => activeSafety)
        recovery = attempt
        void attempt.catch(() => {
          if (recovery === attempt) recovery = null
        })
        return attempt
      },
    }
    throw new ContextStartupError({ startupError, cleanupError, diagnostics, fence })
  }
}

function createContextUnchecked(opts: ContextOptions, resources: PartialContextResources): AppContext {
  const project = opts.project ?? resolveProject()
  // Isolate this instance's tmux server by PROJECT (C3): two fray-ui instances sharing one
  // `tmux -L fray` server would collide on fray-<slug> session names. Derive the socket from the
  // stable project id BEFORE any tmux call — reconcileSessions below calls tmux.isLive, and the
  // wrong socket would find no live sessions and wrongly mark them all exited on every boot.
  // The launcher/project resolver performs the crash-safe legacy migration exactly once and pins the
  // result through supervisor/child/reexec ownership. Never re-read FRAY_TMUX_SOCKET in a disposable
  // child: an environment drift must not move live workers to another server mid-run.
  tmux.pinSocket(project.tmuxSocket ?? tmux.deriveProjectSocket(
    project.id,
    project.identityScope === "worktree",
  ), {
    projectId: project.id,
    projectDir: project.dir,
  }, project.tmuxSocketManaged !== false)
  const dbPath = join(project.stateDir, "ui.db")
  const storage = createStorage(dbPath)
  resources.storage = storage
  const bus = new Bus()
  const transcriptChange = new Emitter<string[]>()
  const bootId = randomUUID()
  // Late-bound for the journal observer and tailer callbacks; boot expiry runs before assignment and
  // needs no board edge because the first build reads authoritative pending state directly.
  let board!: BoardManager
  const contextUnsubscribers: (() => void)[] = []
  let subscriptionsStopped = false
  const stopSubscriptions = () => {
    if (subscriptionsStopped) return
    const failures: { unsubscribe: () => void; error: unknown }[] = []
    for (const unsubscribe of contextUnsubscribers.splice(0).reverse()) {
      try {
        unsubscribe()
      } catch (error) {
        failures.push({ unsubscribe, error })
      }
    }
    if (failures.length > 0) {
      // Preserve failed observers for an explicit recover() attempt while still trying every sibling.
      contextUnsubscribers.push(...failures.map(({ unsubscribe }) => unsubscribe).reverse())
      throw new AggregateError(
        failures.map(({ error }) => error),
        `could not detach ${failures.length} context subscription${failures.length === 1 ? "" : "s"}`,
      )
    }
    subscriptionsStopped = true
  }
  resources.stopSubscriptions = stopSubscriptions
  opts.startup?.afterPhase?.("storage")

  contextUnsubscribers.push(storage.interactions.subscribe((change) => {
    // The DB is project-local, but still verify the explicit protocol owner before publishing. A
    // malformed/future adapter can never leak another project's invalidation onto this server.
    if (change.projectId !== project.id) return
    bus.publish({
      type: "interactions-invalidated",
      slug: change.threadSlug,
      sessionId: change.sessionId,
      interactionId: change.interactionId,
      lifecycle: change.lifecycle,
      recordRevision: change.recordRevision,
    })
    board?.interactionChanged?.(change)
  }))
  storage.interactions.expireDue()
  opts.startup?.afterPhase?.("interaction expiry")

  reconcileAdoptionClaims({ storage, projectDir: project.dir })
  opts.startup?.afterPhase?.("adoption reconcile")
  // Permanent retired tokens are an active fence for pre-upgrade actors only if enforcement is
  // level-triggered. Sweep the single batched tmux inventory periodically so a late token pane is
  // killed within a bounded window even when no restart or new adoption occurs.
  const adoptionReconcileTimer = setInterval(() => {
    try {
      reconcileAdoptionClaims({ storage, projectDir: project.dir, includeFinalized: false })
    } catch {
      // Retain every claim/tombstone and retry next tick; recovery is deliberately fail-closed.
    }
  }, ADOPTION_RECONCILE_INTERVAL_MS)
  adoptionReconcileTimer.unref?.()
  contextUnsubscribers.push(() => clearInterval(adoptionReconcileTimer))

  // Keep the shared Claude quota cache warm on a fixed 1-minute cadence, independent of any browser
  // poll, so the sidebar chip (and the scheduler's weekly-reset check) always reads a value ~1 minute
  // old rather than the multi-minute-stale reading a purely read-driven cache served during a fast
  // fleet burn. One cheap endpoint GET, on the same non-blocking background path a stale read kicks;
  // the cross-process lock keeps N Fray windows to ~one request per minute per account. Gated on the
  // same FRAY_WAKERS_OFF flag as the scheduler so a disposable adhoc/test stack never touches the real
  // account with the real credential.
  if (process.env.FRAY_WAKERS_OFF !== "1") {
    void refreshClaudeQuotaInBackground(opts.claudeBin) // warm immediately so the first read is fresh
    const quotaRefreshTimer = setInterval(() => {
      void refreshClaudeQuotaInBackground(opts.claudeBin)
    }, QUOTA_REFRESH_INTERVAL_MS)
    quotaRefreshTimer.unref?.()
    contextUnsubscribers.push(() => clearInterval(quotaRefreshTimer))
  }

  // Reap this machine's leaked worker aux — verification browsers (agent-browser/chrome-devtools/
  // puppeteer) and MCP/dev servers that daemonized out of a stopped worker's tmux tree, so nothing
  // else ever collects them. A sweep on startup clears accumulated leaks; the interval catches new
  // orphans (a stopped/crashed thread's browsers) within a bounded window. Reaps ONLY processes
  // whose FRAY_UI_THREAD slug has no live claude/codex root; never a session/tmux/self process.
  // FRAY_ORPHAN_REAPER_OFF disables it for disposable adhoc/test stacks (mirrors FRAY_WAKERS_OFF) so a
  // throwaway instance never reaps the real machine's processes.
  if (!process.env.FRAY_ORPHAN_REAPER_OFF) {
    contextUnsubscribers.push(startOrphanReaper({ log: (m) => console.log(`[fray-ui] ${m}`) }))
  }
  opts.startup?.afterPhase?.("orphan reaper")
  reconcileSessions(storage)
  opts.startup?.afterPhase?.("session reconcile")
  opts.startup?.afterPhase?.("subscriptions")

  // The agent backends behind the spawn/resume/transcript seam (Codex-support epic). The ClaudeBackend's
  // transcript dir matches the tailer's (defaultLogDir) so foreign-scan + per-session path stay
  // consistent; the CodexBackend uses $CODEX_HOME (default ~/.codex). `backendFor` maps a row's `backend`
  // column to the right one, DEFAULTING to claude for any unset/unknown kind — so a session is codex ONLY
  // when it was dispatched codex, and every claude path is byte-identical to before.
  const claudeBackend = createClaudeBackend({ logDir: defaultLogDir(project), claudeBin: opts.claudeBin })
  const codexBackend = createCodexBackend({})
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : claudeBackend)
  const codexAppServer = codexAppServerBridgeEnabled()
    ? createCodexAppServerBridge({
        projectId: project.id,
        projectDir: project.dir,
        // The detached app-server daemon's socket + record live under the project state dir, so a
        // later fray generation can find the app-server this one left running.
        stateDir: project.stateDir,
        dbPath,
        interactions: storage.interactions,
        codexBin: opts.codexBin,
        // Never wake a thread the human has already put away: a restart-recovery nudge is only for a
        // thread that is still open and still theirs to come back to.
        shouldAutoResume: (slug) => {
          const row = storage.getSession(slug)
          return Boolean(row) && row?.state !== "archived" && row?.archived !== 1
        },
        // The operator's sandbox intent, so a COLD `thread/resume` carries it. fray's registry is the
        // single authority here — `setThreadPermission` persists `permission_mode` on every change,
        // including the ones the eager apply could not deliver — which is what finally makes the
        // "saved for the next resume" copy true. Scoped by session id so a stale binding for a
        // replaced session can never pull a newer row's permission.
        sandboxFor: (slug, sessionId) => {
          const row = storage.getSession(slug)
          if (!row || row.backend !== "codex" || row.session_id !== sessionId) return undefined
          const mode = PermissionMode.safeParse(row.permission_mode)
          // No recorded intent (a row from before permission_mode was stamped) ⇒ send no override at
          // all, so the resume behaves exactly as it did before this existed.
          if (!mode.success) return undefined
          return codexSandbox(mode.data) as CodexSandboxMode
        },
      })
    : undefined
  resources.codexAppServer = codexAppServer
  if (codexAppServer) {
    contextUnsubscribers.push(storage.subscribeSessionLifecycle((event) => {
      codexAppServer.releaseSession(
        event.previous.slug,
        event.previous.session_id,
        event.type === "replaced" ? "session-replaced" : "session-deleted",
      )
    }))
  }
  // Rejoin the detached app-server daemon now rather than on first use. A turn that outlived our
  // restart is still running in there, and until we attach its `turn/completed` sits queued and the
  // board's stall grace would card the thread as crashed. Fire-and-forget: codex being unavailable
  // must never hold up (or fail) a boot.
  void codexAppServer?.warmUp()
  opts.startup?.afterPhase?.("Codex app-server bridge")

  // The tailer derives turn/liveness telemetry and, on a state change, asks the board for an
  // OVERLAY-ONLY refresh (tailer changes never alter .fray content — the full shell-out rebuild
  // here was the source of multi-second RPC stalls). Late-bound `board` breaks the cycle.
  // It ALSO reports, per tick, which sessions' JSONL advanced → fanned out on transcriptChange so the
  // /ws transcript producer can push (no board dependency; the two signals are independent).
  const tailer = createTailer({
    project,
    storage,
    bus,
    backendFor,
    onChange: () => board.refresh(),
    onTranscriptChange: (slugs) => transcriptChange.emit(slugs),
  })
  resources.tailer = tailer
  opts.startup?.afterPhase?.("tailer")
  // The bridge is the authority on whether a codex app-server TURN is actually running — a rollout
  // frozen by a dead app-server reads "in-flight" forever on its own. Without this the board spins
  // such a thread on `running` and never queues it (live stall 2026-07-22).
  board = createBoard(project, storage, bus, tailer, bootId, {
    codexTurnLiveness: (slug, sessionId) => codexAppServer?.turnLiveness(slug, sessionId),
  })
  resources.board = board
  opts.startup?.afterPhase?.("board watcher")
  const permissionController = createPermissionController({
    storage,
    tailer,
    board,
    reattach: (slug, current, requested, onGeneration) =>
      reattachThreadWithPermission(
        { project, storage, board, getSettings: () => getSettings(storage), backendFor },
        slug,
        current,
        requested,
        onGeneration,
      ),
  })
  resources.permissionController = permissionController
  opts.startup?.afterPhase?.("permission producer")
  const deliveryConfirmer = createDeliveryConfirmer({ storage, board })
  resources.deliveryConfirmer = deliveryConfirmer
  const profileController = createProfileController({
    storage,
    tailer,
    board,
    reattach: (slug, current, requested, onGeneration, onCheckpoint) =>
      reattachThreadWithProfile(
        { project, storage, board, getSettings: () => getSettings(storage), backendFor },
        slug,
        current,
        requested,
        onGeneration,
        onCheckpoint,
      ),
    recover: (row, journal, observation) => recoverThreadProfileHandoff(
      { project, storage, board, getSettings: () => getSettings(storage), backendFor },
      row,
      journal,
      observation,
    ),
  })
  resources.profileController = profileController
  opts.startup?.afterPhase?.("profile producer")
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => getSettings(storage),
    claudeBin: opts.claudeBin,
    backendFor,
    codexAppServer,
    // Auth preflight (claude-auth plan, Slice A): Claude asks its own CLI (`claude auth status
    // --json`, run in the project cwd with the dispatch executable); Codex reads the local
    // auth.json/env. Both block only on a positive "signed-out" — everything else fails open.
    preflightAuth: (kind) =>
      kind === "codex"
        ? Promise.resolve(readCodexAuthState())
        : readClaudeAuthStatusCli({ claudeBin: opts.claudeBin, cwd: project.dir }),
  })

  // Durable timer waker + legacy pr/ci compatibility. Reuses the SAME resume path as followUp;
  // boot-safe because it only fires on a condition it witnesses cross.
  const scheduler = createScheduler({
    storage,
    tailer,
    // Second wake source: every thread a subscription window cut off mid-turn gets its own "continue"
    // once that window rolls, over this same delivery path. The quota reader supplies the fallback
    // instant for a weekly limit, whose message text carries a clock but no date; readQuota memoizes,
    // so consulting it per tick costs a live request only every few minutes.
    autoResumeOnLimit: () => getSettings(storage).autoResumeOnLimit !== false,
    readQuota,
    resume: (slug, message, deliveryId) => {
      const deliveryMessage = `${message}\n\n${wakeDeliveryToken(deliveryId)}`
      const row = storage.getSession(slug)
      // Codex wake: deliver over the app-server bridge (adopting a legacy tmux rollout first, then
      // reactivating the persisted thread), exactly like the followUp RPC. Codex never uses tmux resume
      // — resumeThread is a CLAUDE-only path now, so a codex row must never reach it even when the
      // bridge is absent (only possible in a test context): drop the wake loudly instead of degrading.
      if (row?.backend === "codex") {
        const bridge = codexAppServer
        if (!bridge) {
          process.stderr.write(`[fray] codex wake for ${slug} dropped: the app-server bridge is unavailable\n`)
          return
        }
        return deliverCodexWake({ bridge, storage, cwd: project.dir, row, slug, deliveryMessage, deliveryId })
      }
      resumeThread({ project, storage, board, getSettings: () => getSettings(storage), backendFor }, slug, deliveryMessage)
    },
  })
  resources.scheduler = scheduler
  opts.startup?.afterPhase?.("wake scheduler")

  return {
    bootId,
    project,
    bus,
    transcriptChange,
    storage,
    interactions: storage.interactions,
    codexAppServer,
    board,
    tailer,
    dispatcher,
    scheduler,
    permissionController,
    profileController,
    deliveryConfirmer,
    stopSubscriptions,
    backendFor,
    getSettings: () => getSettings(storage),
    setSettings: (s) => setSettings(storage, s),
    resetSettings: () => resetSettings(storage),
    claudeBin: opts.claudeBin,
    codexBin: opts.codexBin,
    loginUtility: createLoginUtility({ claudeBin: opts.claudeBin, codexBin: opts.codexBin, cwd: project.dir }),
  }
}
