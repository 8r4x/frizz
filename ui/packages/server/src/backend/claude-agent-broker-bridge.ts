// The fray-side bridge for the Claude session broker — the Claude twin of CodexAppServerBridge, but
// leaner because the broker DAEMON owns the session state (and the transcript lands on disk via
// persistSession, read by the tailer like any Claude thread). The bridge forks/adopts a broker per
// thread, connects a typed client, routes tool-permission requests to a decision hook (default:
// auto-allow, honoring the thread's permission mode — matching today's tmux `--permission-mode auto`;
// wiring these to the dashboard InteractionStore is the next slice), and sends follow-up turns.
import { randomUUID } from "node:crypto"
import { adoptOrForkBroker, killBroker, liveBrokerRecord, claudeBrokerRecordPath, resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"
import { connectClaudeBroker, type ClaudeBrokerClient } from "./claude-broker-client.ts"
import type { ClaudeDiagnostic, ClaudePermissionDecision, ClaudePermissionRequest, ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import type { ClaudeBrokerConfig } from "./claude-agent-broker.ts"
import type { InteractionSessionScope, InteractionStore } from "../interaction-store.ts"
import { buildClaudePermissionInteraction, claudePermissionDecisionFor } from "./claude-permission-interactions.ts"

/** Gate for routing Claude dispatch through the session broker instead of the tmux TUI. Default ON
 *  (opt out with FRAY_CLAUDE_BROKER_BRIDGE=0). Verified end-to-end on a real PROMOTED ARTIFACT (not just
 *  the dev stack): a dispatched broker thread starts its daemon and the agent replies. The promoted-
 *  artifact regression was the SDK requiring an absolute claude executable (a bare "claude" crashed the
 *  daemon before it published its record) — fixed in resolveClaudeExecutableAbsolute. */
export function claudeBrokerBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRAY_CLAUDE_BROKER_BRIDGE !== "0"
}

export interface ClaudeBrokerBinding {
  threadSlug: string
  sessionId: string
  cwd: string
  generation: string
  state: "active" | "detached"
}

export interface ClaudeBrokerBridgeDeps {
  stateDir: string
  /** Path to the `claude` executable. */
  executablePath: string
  /** Base env; the broker forwards only the SDK-allowlisted subset to claude. */
  env: Record<string, string>
  /** The fray WORKER ENVIRONMENT — constant per project, applied on every fork so a dispatch AND a
   *  dead-daemon cold-resume both rebuild it. `pluginDir` loads the cc-worker plugin (fray sub-agent
   *  profiles + hooks); `mcpServers`/`allowedTools` mount + pre-approve the fray + chrome-devtools MCP;
   *  `permDir` is the per-project perm-marker dir the hooks write to (paired with the per-thread slug at
   *  attach time). Absent ⇒ a bare SDK worker (the pre-cutover behavior). */
  workerEnv?: {
    pluginDir?: string
    mcpServers?: Record<string, { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }>
    allowedTools?: string[]
    permDir?: string
  }
  /** The dashboard InteractionStore + this project's id. When present, a Claude tool-permission
   *  escalation (canUseTool, which under "auto" fires only for classifier-flagged risky calls) is
   *  journaled as an approval interaction and gated on the human's dashboard decision. Absent ⇒ the
   *  `decidePermission` hook (default auto-allow) decides — the pre-cutover behavior. */
  interactions?: InteractionStore
  projectId?: string
  /** Decide a tool-permission request when NOT routing to the dashboard (tests / interactions absent).
   *  Defaults to auto-allow, honoring the thread's permission mode — matching today's tmux `auto`. */
  decidePermission?: (slug: string, sessionId: string, request: ClaudePermissionRequest) => Promise<ClaudePermissionDecision>
  /** Observe the session/transcript event stream (board liveness / telemetry). Optional. */
  onEvent?: (slug: string, sessionId: string, event: ClaudeQueryEvent) => void
  /** Observe daemon lifecycle/stderr diagnostics from a LIVE socket. The durable copy is written by
   *  the daemon itself (claude-broker-diagnostics.ts) precisely because this relay only reaches a fray
   *  that is attached at the time — which a crash during a restart is not. Optional; for a live
   *  consumer, not for forensics. */
  onDiagnostic?: (slug: string, sessionId: string, diagnostic: ClaudeDiagnostic) => void
}

export interface ClaudeSpawnDispatchInput {
  threadSlug: string
  sessionId: string
  cwd: string
  prompt: string
  permissionMode?: ClaudeBrokerConfig["permissionMode"]
  /** Appended to Claude's default system prompt — the fray worker contract + scratchpad orientation. */
  appendSystemPrompt?: string
  model?: string
  effort?: string
}

// Options that shape a FORK (only consulted when attach cold-starts a daemon; ignored when it reattaches
// to a live one — the running session already carries them). `resume` picks up the on-disk transcript.
type ForkOpts = Pick<ClaudeSpawnDispatchInput, "appendSystemPrompt" | "model" | "effort"> & { resume?: boolean }


interface ActiveSession { slug: string; sessionId: string; cwd: string; generation: string; client: ClaudeBrokerClient }

export interface ClaudeAgentBrokerBridge {
  spawnDispatch(input: ClaudeSpawnDispatchInput): Promise<{ binding: ClaudeBrokerBinding }>
  /** Deliver a follow-up turn. If the daemon is live we reattach its socket (context intact); if it
   *  died, we cold-start a fresh daemon that RESUMES the on-disk transcript — so the resume context
   *  (worker system prompt + profile) must be re-supplied, exactly like the tmux `claude -r` path. */
  followUp(input: { threadSlug: string; sessionId: string; cwd: string; text: string; permissionMode?: ClaudeBrokerConfig["permissionMode"]; appendSystemPrompt?: string; model?: string; effort?: string }): Promise<void>
  binding(threadSlug: string, sessionId: string): ClaudeBrokerBinding | undefined
  /** Whether an ownerless daemon for this session is running right now — the board's liveness/stall
   *  signal for a headless broker row (the parallel of codex's turnLiveness), independent of whether
   *  THIS fray process currently holds a live socket to it. */
  isDaemonAlive(sessionId: string): boolean
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): boolean
  close(): void
}

export function createClaudeAgentBrokerBridge(deps: ClaudeBrokerBridgeDeps): ClaudeAgentBrokerBridge {
  const sessions = new Map<string, ActiveSession>() // keyed by slug — one active session per thread
  // Resolve the claude executable to an ABSOLUTE path ONCE: the SDK the forked daemon runs rejects a bare
  // name (unlike the tmux execvp path), and a bare "claude" is the default on a promoted artifact.
  const executablePath = resolveClaudeExecutableAbsolute(deps.executablePath, deps.env)

  // Pending tool-permission escalations awaiting a human dashboard decision, keyed by interaction id.
  // The daemon holds the actual canUseTool promise (and re-delivers it on reconnect), so this only needs
  // the live client + the daemon's requestId to answer against once the human resolves the interaction.
  const pendingPerms = new Map<string, { client: ClaudeBrokerClient; requestId: string; scope: InteractionSessionScope }>()

  // Route a Claude tool-permission escalation to the dashboard: reuse the still-pending journal entry on
  // a reconnect re-delivery, else journal a fresh approval interaction. Failure to represent/journal fails
  // CLOSED (deny) — a permission we can't put in front of a human must not silently run.
  const routePermissionToDashboard = (slug: string, sessionId: string, cwd: string, requestId: string, request: ClaudePermissionRequest, client: ClaudeBrokerClient): void => {
    const store = deps.interactions!, projectId = deps.projectId!
    const scope: InteractionSessionScope = { projectId, threadSlug: slug, sessionId }
    const existing = store.listPending(scope).find((r) => r.providerRequestId === requestId)
    if (existing) { pendingPerms.set(existing.id, { client, requestId, scope }); return }
    const req = buildClaudePermissionInteraction(request, { projectId, threadSlug: slug, sessionId, cwd })
    if (!req) { client.answerPermission(requestId, { behavior: "deny", message: "This tool call could not be represented for approval." }); return }
    let id: string
    try { id = store.create(req).interaction.id } catch { client.answerPermission(requestId, { behavior: "deny", message: "The approval request could not be recorded." }); return }
    pendingPerms.set(id, { client, requestId, scope })
  }

  // A resolved/cancelled/expired approval interaction → the decision the daemon applies. The daemon is
  // the durable holder of the canUseTool promise, so this simply relays the answer over the live socket.
  const unsubInteractions = deps.interactions?.subscribe((change) => {
    const pending = pendingPerms.get(change.interactionId)
    if (!pending || change.lifecycle === "pending") return
    const record = deps.interactions!.get(pending.scope, change.interactionId)
    const decision = change.lifecycle === "resolved"
      ? claudePermissionDecisionFor(record?.resolution?.decisionId)
      : { behavior: "deny" as const, message: "This approval was withdrawn." }
    pending.client.answerPermission(pending.requestId, decision)
    pendingPerms.delete(change.interactionId)
  })

  const attach = async (slug: string, sessionId: string, cwd: string, permissionMode: ClaudeBrokerConfig["permissionMode"], fork: ForkOpts = {}): Promise<ActiveSession> => {
    // fork opts (system prompt / model / effort / resume) AND the worker environment apply only when this
    // call FORKS a fresh daemon; when it adopts a live one (fray restart), the running session already
    // carries them. FRAY_UI_THREAD is per-thread (the slug), so it's stamped here, not in deps.workerEnv.
    const we = deps.workerEnv
    const workerEnv: Record<string, string> = { FRAY_UI_THREAD: slug, ...(we?.permDir ? { FRAY_PERM_DIR: we.permDir } : {}) }
    const { record } = await adoptOrForkBroker({
      stateDir: deps.stateDir, cwd, sessionId, executablePath, permissionMode, env: deps.env,
      pluginDir: we?.pluginDir, mcpServers: we?.mcpServers, allowedTools: we?.allowedTools, workerEnv,
      ...fork,
    })
    const client = connectClaudeBroker(record.socketPath, {
      onEvent: (event) => deps.onEvent?.(slug, sessionId, event),
      onDiagnostic: (diagnostic) => deps.onDiagnostic?.(slug, sessionId, diagnostic),
      onPermissionRequest: (requestId, request) => {
        // Dashboard routing when the store is wired; else the decision hook / auto-allow (tests).
        if (deps.interactions && deps.projectId) {
          try { routePermissionToDashboard(slug, sessionId, cwd, requestId, request, client) }
          catch { client.answerPermission(requestId, { behavior: "deny", message: "permission routing failed" }) }
          return
        }
        void (deps.decidePermission?.(slug, sessionId, request) ?? Promise.resolve<ClaudePermissionDecision>({ behavior: "allow" }))
          .then((decision) => client.answerPermission(requestId, decision))
          .catch(() => client.answerPermission(requestId, { behavior: "deny", message: "permission decision failed" }))
      },
    })
    const session: ActiveSession = { slug, sessionId, cwd, generation: record.generation, client }
    sessions.set(slug, session)
    return session
  }

  const current = (slug: string, sessionId: string): ActiveSession | undefined => {
    const s = sessions.get(slug)
    return s && s.sessionId === sessionId ? s : undefined
  }

  return {
    async spawnDispatch(input) {
      // A new dispatch replaces any prior session on the slug.
      const prior = sessions.get(input.threadSlug)
      if (prior) { prior.client.close(); killBroker(deps.stateDir, prior.sessionId); sessions.delete(input.threadSlug) }
      const session = await attach(input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default", { appendSystemPrompt: input.appendSystemPrompt, model: input.model, effort: input.effort })
      session.client.sendInput({ id: randomUUID(), text: input.prompt })
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, generation: session.generation, state: "active" } }
    },

    async followUp(input) {
      // Reattach if we don't already hold this session live (fray restarted, or it was detached). The
      // fork opts carry resume:true + the rebuilt system prompt so a DEAD daemon cold-resumes with the
      // worker contract re-applied; when the daemon is still alive they are ignored (socket reconnect).
      const session = current(input.threadSlug, input.sessionId) ?? await attach(
        input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default",
        { resume: true, appendSystemPrompt: input.appendSystemPrompt, model: input.model, effort: input.effort },
      )
      session.client.sendInput({ id: randomUUID(), text: input.text })
    },

    binding(threadSlug, sessionId) {
      const s = current(threadSlug, sessionId)
      return s ? { threadSlug, sessionId, cwd: s.cwd, generation: s.generation, state: s.client.connected() ? "active" : "detached" } : undefined
    },

    isDaemonAlive(sessionId) {
      return liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, sessionId)) !== null
    },

    releaseSession(threadSlug, sessionId) {
      // Kill the daemon UNCONDITIONALLY (by record), even when we don't currently hold it live — after a
      // fray restart the ownerless daemon is still running but unattached, and a stop/complete must not
      // leak it. The return value reports only whether we held a live binding to tear down first.
      const s = current(threadSlug, sessionId)
      if (s) { s.client.close(); sessions.delete(threadSlug) }
      killBroker(deps.stateDir, sessionId)
      return s !== undefined
    },

    close() { unsubInteractions?.(); pendingPerms.clear(); for (const s of sessions.values()) s.client.close(); sessions.clear() },
  }
}
