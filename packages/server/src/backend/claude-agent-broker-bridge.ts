// The fray-side bridge for the Claude session broker — the Claude twin of CodexAppServerBridge, but
// leaner because the broker DAEMON owns the session state (and the transcript lands on disk via
// persistSession, read by the tailer like any Claude thread). The bridge forks/adopts a broker per
// thread, connects a typed client, routes tool-permission requests to a decision hook (default:
// auto-allow, honoring the thread's permission mode — matching today's tmux `--permission-mode auto`;
// wiring these to the dashboard InteractionStore is the next slice), and sends follow-up turns.
import { randomUUID } from "node:crypto"
import { adoptOrForkBroker, killBroker, liveBrokerRecord, liveBrokerRecords, claudeBrokerRecordPath, resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"
import { connectClaudeBroker, type ClaudeBrokerClient } from "./claude-broker-client.ts"
import { describeClaudeBrokerExit, readClaudeBrokerExit, type ClaudeBrokerExitRecord } from "./claude-broker-diagnostics.ts"
import type { ClaudeDiagnostic, ClaudePermissionDecision, ClaudePermissionRequest, ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import { CLAUDE_AGENT_SDK_MAX_INPUT_BYTES, CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT, CLAUDE_BROKER_CAPABILITY_STOP_TASK, CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER, validateInputMessage } from "./claude-agent-sdk-protocol.ts"
import type { BrokerRecord, ClaudeBrokerConfig } from "./claude-agent-broker.ts"
import type { InteractionSessionScope, InteractionStore } from "../interaction-store.ts"
import {
  CLAUDE_ASK_USER_QUESTION_TOOL,
  buildClaudePermissionInteraction,
  buildClaudeQuestionInteraction,
  claudePermissionDecisionFor,
  claudeQuestionDecisionFor,
  parseClaudeAskUserQuestion,
  type ClaudeAskSpec,
} from "./claude-permission-interactions.ts"

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
   *  consumer, not for forensics.
   *
   *  The bridge ALSO synthesizes a `{lifecycle, crashed}` diagnostic here the moment it discovers a
   *  daemon that died while nobody was attached, carrying the dead daemon's own recorded exit reason —
   *  the one death this live relay structurally cannot observe on its own. */
  onDiagnostic?: (slug: string, sessionId: string, diagnostic: ClaudeDiagnostic) => void
  /** The broker-backed threads this fray owns and may reattach at boot — supplied by context.ts from
   *  the registry, already filtered to rows that are still OPEN and not archived (the same predicate
   *  codex's `shouldAutoResume` applies). Absent ⇒ `warmUp()` is a no-op, which is what every test and
   *  every registry-less harness wants. */
  ownedSessions?: () => Array<{ threadSlug: string; sessionId: string; cwd: string }>
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

// The uuid to hand the SDK for one input. fray's own deliveryId when it is UUID-shaped (the browser
// mints one with crypto.randomUUID), because the SDK ECHOES this id back on the record that
// materializes the input — as the delivered `user` record's `uuid`, or as the `queued_command`
// attachment's `source_uuid` — which is what lets the delivery ledger correlate by IDENTITY instead of
// by comparing prose (see the identity path in delivery-ledger.ts). The SDK rejects a non-UUID id
// outright, and eagerComposerSubmission has a non-UUID fallback for browsers without crypto.randomUUID,
// so anything else degrades to a fresh uuid and the text path — never a throw on the operator's send.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function inputIdFor(deliveryId: string | undefined): string {
  return deliveryId && UUID_SHAPE.test(deliveryId) ? deliveryId : randomUUID()
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
  /**
   * `freshProcess` retires a LIVE daemon before delivering, so the text lands in a `claude` that has
   * just started. Set it when the running process cannot act on the message no matter what it says —
   * today that is exactly one case, a usage-limit resume fired before the provider's stated reset
   * instant, because the process latched on its 429 and refuses every input until then (see
   * usage-limit.ts `limitResumeNeedsFreshProcess`). Costs the in-memory sub-agents, which is why it is
   * opt-in per call rather than the default.
   */
  followUp(input: { threadSlug: string; sessionId: string; cwd: string; text: string; deliveryId?: string; permissionMode?: ClaudeBrokerConfig["permissionMode"]; appendSystemPrompt?: string; model?: string; effort?: string; freshProcess?: boolean }): Promise<void>
  /**
   * Steer ONE running Agent-tool sub-agent: deliver `text` into the child's own conversation rather
   * than the thread's main turn. `subAgentId` is the dispatch tool_use id — the same id the board's
   * SubAgentView carries and the drill-in drawer is keyed by.
   *
   * DELIBERATELY UNLIKE `followUp`: this NEVER attaches and NEVER cold-resumes. A child exists only
   * inside the live CLI process that dispatched it — it has no transcript of its own to resume, no
   * socket, and no PID. Cold-starting a daemon and addressing a message at a `toolu_…` it has never
   * heard of does not steer anything; at best the steer evaporates, at worst it lands on the main
   * thread as an out-of-context instruction the operator never aimed there. So a steer requires a
   * daemon this bridge is holding LIVE (same generation, per holdsLiveDaemon) and throws otherwise.
   * The caller turns that into "this sub-agent can no longer be reached", which is the truth.
   */
  steerSubAgent(input: { threadSlug: string; sessionId: string; subAgentId: string; text: string; deliveryId?: string }): Promise<void>
  /** Stop one running Claude background task through the provider's task control API. */
  stopSubAgent(input: { threadSlug: string; sessionId: string; taskId: string }): Promise<void>
  /**
   * Take a follow-up BACK out of the session's command queue — the operator clicked their own queued
   * bubble to unqueue it. `deliveryId` is the id `followUp` handed the SDK, which is the uuid the CLI
   * queued the message under.
   *
   * Resolves TRUE only when the CLI positively removed it: the agent will never read that message.
   * FALSE means it had already been dequeued for execution — nothing was undone and the operator must
   * be told so, because a message they believe they retracted is the worst possible outcome here.
   *
   * NEVER attaches and never cold-resumes, for the same reason steerSubAgent doesn't: a queue lives
   * inside a running CLI process. A daemon that died took its queue with it (the message was never
   * read), and forking a fresh one to cancel a uuid it has never heard of would answer `false` — the
   * one answer that means "your message is on its way". Requires a daemon this bridge holds LIVE.
   */
  cancelFollowUp(input: { threadSlug: string; sessionId: string; deliveryId: string }): Promise<boolean>
  /**
   * Reattach at boot to every broker daemon this project left running, without waiting for someone to
   * touch the thread.
   *
   * The codex bridge has done this since its daemon started outliving fray, and its doc comment names
   * the bug: a turn still running inside a detached daemon has nobody observing it, so a perfectly
   * healthy surviving turn cards as stalled. The broker adopted LAZILY — only `spawnDispatch` and
   * `followUp` ever called `attach` — so after a fray restart:
   *
   *  - the daemon's event backlog (queued, not dropped, while detached) sits unread, so the runtime
   *    ingest has no reading of the turn and never nudges the tailer;
   *  - a tool-permission escalation raised while fray was down stays held in the daemon. It IS
   *    re-delivered on reconnect, but nothing reconnects — so no approval card appears, the turn stays
   *    blocked on a promise nobody can answer, and the thread reads as hung until a human pokes it.
   *
   * Fire-and-forget by contract: a broker that cannot be reached must never fail or delay a boot, so
   * every step here swallows its own failure and the next real dispatch/follow-up retries exactly as
   * it did before. Only ADOPTS — it never forks. A daemon that died between the record enumeration and
   * the connect must cold-start under a real dispatch that supplies the resume context, never here.
   */
  warmUp(): Promise<void>
  binding(threadSlug: string, sessionId: string): ClaudeBrokerBinding | undefined
  /** Whether an ownerless daemon for this session is running right now — the board's liveness/stall
   *  signal for a headless broker row (the parallel of codex's turnLiveness), independent of whether
   *  THIS fray process currently holds a live socket to it. */
  isDaemonAlive(sessionId: string): boolean
  /** What the daemon for this session recorded on its way out, when one is not running now. The
   *  attribution behind a headless stall: `isDaemonAlive` says the thread is dead, this says why
   *  (idle-timeout / signal-SIGTERM / self-collected-record-reassigned / …). `null` means it left no
   *  record at all — killed outright, or a daemon older than exit breadcrumbs. */
  daemonExit(sessionId: string): ClaudeBrokerExitRecord | null
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): boolean
  close(): void
}

/**
 * Validate a message BEFORE it becomes a socket frame, and say why in the operator's language.
 *
 * The `input` frame has no reply, so the daemon is the only place a rejection can be noticed and it has
 * no channel to answer on — every send that reached it and failed was simply gone. Running the same pure
 * validator on this side turns that into a thrown RPC the composer can roll back and toast, which is the
 * whole difference between "fray refused my message" and "fray ate my message".
 *
 * The protocol error's own wording is a boundary label (`input.text contains unsafe text`) aimed at a
 * developer reading a stack trace. This is the string a human reads in a toast after pressing Enter, so
 * it names the problem and what to do about it — and it has to FIT: sendEagerFollowUp renders it as
 * `Steer failed — ${message.slice(0, 90)}`, so anything longer is cut off mid-sentence (measured in the
 * browser: a 150-char version rendered as "…or h"). Keep each of these under 90 characters.
 */
export function validatedInput(message: { id: string; text: string; parentToolUseId?: string }): ReturnType<typeof validateInputMessage> {
  try {
    return validateInputMessage(message)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/exceeds/.test(detail)) {
      throw new Error(`This message is too long to send (the limit is ${CLAUDE_AGENT_SDK_MAX_INPUT_BYTES / 1024}KB). Shorten it and resend.`)
    }
    if (/unsafe text/.test(detail)) {
      throw new Error("This message holds a control or incomplete character fray can't send. Edit and resend.")
    }
    throw new Error(`fray could not send this message: ${detail}`)
  }
}

export function createClaudeAgentBrokerBridge(deps: ClaudeBrokerBridgeDeps): ClaudeAgentBrokerBridge {
  const sessions = new Map<string, ActiveSession>() // keyed by slug — one active session per thread
  // Resolve the claude executable to an ABSOLUTE path ONCE: the SDK the forked daemon runs rejects a bare
  // name (unlike the tmux execvp path), and a bare "claude" is the default on a promoted artifact.
  const executablePath = resolveClaudeExecutableAbsolute(deps.executablePath, deps.env)

  // Pending tool-permission escalations awaiting a human dashboard decision, keyed by interaction id.
  // The daemon holds the actual canUseTool promise (and re-delivers it on reconnect), so this only needs
  // the live client + the daemon's requestId to answer against once the human resolves the interaction.
  // `ask` is present for an AskUserQuestion card: the parsed question spec, needed to turn the operator's
  // field values back into the tool's `{questions, answers}` updatedInput. It is re-derived from the
  // re-delivered request on reconnect, so it survives a fray restart with the question still open.
  const pendingPerms = new Map<string, { client: ClaudeBrokerClient; requestId: string; scope: InteractionSessionScope; ask?: ClaudeAskSpec }>()

  // Route a Claude tool-permission escalation to the dashboard: reuse the still-pending journal entry on
  // a reconnect re-delivery, else journal a fresh approval interaction. Failure to represent/journal fails
  // CLOSED (deny) — a permission we can't put in front of a human must not silently run.
  //
  // AskUserQuestion forks here. It rides the same canUseTool channel but is not an authorization request:
  // it is the agent asking the operator to CHOOSE, and the SDK expects the chosen labels back inside the
  // decision. So it becomes an `agent-question` interaction — the exact payload kind codex's
  // item/tool/requestUserInput already produces, so one web card renders both providers — rather than an
  // "Approve AskUserQuestion?" card over raw JSON, whose bare allow the model reads as "not answered".
  const routePermissionToDashboard = (slug: string, sessionId: string, cwd: string, requestId: string, request: ClaudePermissionRequest, client: ClaudeBrokerClient): void => {
    const store = deps.interactions!, projectId = deps.projectId!
    const scope: InteractionSessionScope = { projectId, threadSlug: slug, sessionId }
    const owner = { projectId, threadSlug: slug, sessionId, cwd }
    const ask = request.toolName === CLAUDE_ASK_USER_QUESTION_TOOL ? parseClaudeAskUserQuestion(request.input) : null
    const existing = store.listPending(scope).find((r) => r.providerRequestId === requestId)
    if (existing) { pendingPerms.set(existing.id, { client, requestId, scope, ...(ask ? { ask } : {}) }); return }
    // A question we cannot represent EXACTLY is denied with a redirect rather than downgraded to an
    // approval card: an approximate answer (a clipped label, a dropped question) reads to the model as
    // freeform prose or as no answer at all, and it would ask again — the loop this whole path removes.
    if (request.toolName === CLAUDE_ASK_USER_QUESTION_TOOL && !ask) {
      client.answerPermission(requestId, { behavior: "deny", message: "Fray could not render this question. Ask it in your final message instead, so the operator sees it in the queue." })
      return
    }
    const req = ask
      ? buildClaudeQuestionInteraction(ask, request, owner)
      : buildClaudePermissionInteraction(request, owner)
    if (!req) { client.answerPermission(requestId, { behavior: "deny", message: "This tool call could not be represented for approval." }); return }
    let id: string
    try { id = store.create(req).interaction.id } catch { client.answerPermission(requestId, { behavior: "deny", message: "The approval request could not be recorded." }); return }
    pendingPerms.set(id, { client, requestId, scope, ...(ask ? { ask } : {}) })
  }

  // A resolved/cancelled/expired interaction → the decision the daemon applies. The daemon is the durable
  // holder of the canUseTool promise, so this simply relays the answer over the live socket.
  //
  // ABORT-AWARENESS lives here too. A cancelled or expired entry is never a silent no-op: the turn being
  // interrupted, the session being stopped or replaced, or the operator dismissing the card all land as a
  // non-"resolved" lifecycle (storage.ts cancels every pending interaction for a session on replace or
  // delete), and each one answers the still-blocked daemon with a deny so the tool call unwinds instead
  // of holding the session forever.
  const unsubInteractions = deps.interactions?.subscribe((change) => {
    const pending = pendingPerms.get(change.interactionId)
    if (!pending || change.lifecycle === "pending") return
    const record = deps.interactions!.get(pending.scope, change.interactionId)
    const decision = pending.ask
      ? (change.lifecycle === "resolved"
        ? claudeQuestionDecisionFor(pending.ask, record?.resolution?.decisionId, record?.resolution?.values)
        : { behavior: "deny" as const, message: "This question was withdrawn before anyone answered it. Decide with the information you already have, or raise it in your final message." })
      : (change.lifecycle === "resolved"
        ? claudePermissionDecisionFor(record?.resolution?.decisionId)
        : { behavior: "deny" as const, message: "This approval was withdrawn." })
    pending.client.answerPermission(pending.requestId, decision)
    pendingPerms.delete(change.interactionId)
  })

  // The daemon deaths already reported through onDiagnostic, keyed by session id + the dead daemon's
  // generation. A death is a one-time fact; re-announcing it on every later follow-up would turn an
  // attribution into noise.
  const reportedDeaths = new Set<string>()
  const reportDeath = (slug: string, sessionId: string): void => {
    if (!deps.onDiagnostic) return
    let exit: ClaudeBrokerExitRecord | null = null
    try { exit = readClaudeBrokerExit(deps.stateDir, sessionId) } catch { /* forensics degrade, never throw */ }
    const key = `${sessionId}\0${exit?.generation ?? ""}\0${exit?.at ?? ""}`
    if (reportedDeaths.has(key)) return
    reportedDeaths.add(key)
    try { deps.onDiagnostic(slug, sessionId, { kind: "lifecycle", phase: "crashed", message: describeClaudeBrokerExit(exit) }) } catch { /* informational */ }
  }

  // Wire a client onto a broker record and register the session. Shared by the fork/adopt path
  // (`attach`) and the boot reattach (`warmUp`), which must NEVER fork.
  const bind = (slug: string, sessionId: string, cwd: string, record: BrokerRecord): ActiveSession => {
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

  const attach = async (slug: string, sessionId: string, cwd: string, permissionMode: ClaudeBrokerConfig["permissionMode"], fork: ForkOpts = {}): Promise<ActiveSession> => {
    // fork opts (system prompt / model / effort / resume) AND the worker environment apply only when this
    // call FORKS a fresh daemon; when it adopts a live one (fray restart), the running session already
    // carries them. FRAY_UI_THREAD is per-thread (the slug), so it's stamped here, not in deps.workerEnv.
    const we = deps.workerEnv
    const workerEnv: Record<string, string> = {
      FRAY_UI_THREAD: slug,
      ...(we?.permDir ? { FRAY_PERM_DIR: we.permDir } : {}),
      // The cc-worker plugin's PreToolUse hook DENIES AskUserQuestion, because on the tmux path a
      // blocking question freezes a headless worker where nobody can answer it. On the broker path
      // fray CAN answer it — the call becomes a dashboard question card — so the hook is told to stand
      // down, but only when a store is actually wired to render and resolve the card.
      ...(deps.interactions && deps.projectId ? { FRAY_NATIVE_ASK: "1" } : {}),
    }
    const { record, reattached } = await adoptOrForkBroker({
      stateDir: deps.stateDir, cwd, sessionId, executablePath, permissionMode, env: deps.env,
      pluginDir: we?.pluginDir, mcpServers: we?.mcpServers, allowedTools: we?.allowedTools, workerEnv,
      ...fork,
    })
    // A RESUME that had to cold-start is the moment fray discovers a daemon died while nobody was
    // watching — the one death the live diagnostic relay structurally cannot see. Attribute it from the
    // dead daemon's own exit record now, while the record is still on disk, rather than leaving the
    // operator with "the thread went quiet". A fresh dispatch (no resume) is not a death: there was
    // never a daemon to lose.
    if (!reattached && fork.resume) reportDeath(slug, sessionId)
    return bind(slug, sessionId, cwd, record)
  }

  const current = (slug: string, sessionId: string): ActiveSession | undefined => {
    const s = sessions.get(slug)
    return s && s.sessionId === sessionId ? s : undefined
  }

  // Is the daemon behind a session we HOLD still the one we are holding?
  //
  // The client reconnects forever by design (that is what carries fray across a daemon socket blip),
  // so a held ActiveSession outlives the daemon it points at: `client.connected()` goes false, the
  // session stays in the map, and `sendInput` queues the message in `outbound` where it waits for a
  // socket that will never come back. A follow-up sent to a thread whose daemon died therefore
  // vanished silently — the thread simply never answered, which is precisely the "went quiet" this
  // work exists to eliminate. Keyed on the daemon RECORD and its generation rather than on socket
  // connectivity: a LIVE daemon whose socket is momentarily flapping must be kept (the client
  // reconnects to it), while a dead daemon — or a successor that took the record — must not be.
  const holdsLiveDaemon = (session: ActiveSession): boolean => {
    const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, session.sessionId))
    return record !== null && record.generation === session.generation
  }

  return {
    async spawnDispatch(input) {
      // A new dispatch replaces any prior session on the slug.
      const prior = sessions.get(input.threadSlug)
      if (prior) { prior.client.close(); killBroker(deps.stateDir, prior.sessionId); sessions.delete(input.threadSlug) }
      // VALIDATED BEFORE THE SOCKET, for the reason spelled out on followUp below: a frame the daemon
      // refuses is discarded there with nobody to tell, and for a DISPATCH that means a worker that
      // boots, receives no task at all, and sits idle looking frozen from birth.
      const message = validatedInput({ id: randomUUID(), text: input.prompt })
      const session = await attach(input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default", { appendSystemPrompt: input.appendSystemPrompt, model: input.model, effort: input.effort })
      session.client.sendInput(message)
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, generation: session.generation, state: "active" } }
    },

    async followUp(input) {
      // VALIDATE HERE, not only in the daemon — the same reason steerSubAgent does, and it turned out to
      // matter just as much on this path. `sendInput` writes a socket frame and returns; the frame has no
      // reply; the daemon calls `handle.send(...)` and used to swallow its rejection. So a message the
      // protocol validator refused was discarded THERE with nobody to tell, while this function returned
      // normally, the router opened an `enqueued` ledger item (which by design never times out) and the
      // operator watched their own message sit in the transcript as delivered, forever.
      //
      // Measured against a real daemon in `_live_broker_input_drop.mts`: one sentence delivered, the same
      // sentence with a single emoji appended vanished with zero diagnostics. Most of that class is now
      // deliverable (validateInputMessage no longer applies the display-grade class to a prompt body),
      // but the residue — an oversized body, a C0 control, a replayed uuid — must FAIL THE OPERATOR'S
      // SEND rather than evaporate. Running the validator before the frame is what makes that happen:
      // the throw reaches the RPC, which rolls the optimistic bubble back and toasts.
      //
      // FIRST, before any process state is touched: a message that cannot be delivered must not cost a
      // cold resume, and must certainly not cost the `freshProcess` daemon retirement below — killing the
      // operator's worker on the way to refusing their message is the worst possible order.
      const message = validatedInput({ id: inputIdFor(input.deliveryId), text: input.text })
      // Reattach if we don't already hold this session live (fray restarted, or it was detached). The
      // fork opts carry resume:true + the rebuilt system prompt so a DEAD daemon cold-resumes with the
      // worker contract re-applied; when the daemon is still alive they are ignored (socket reconnect).
      //
      // "Hold it live" means the DAEMON is still there, not merely that this bridge has an entry for the
      // slug — see holdsLiveDaemon. A held session whose daemon died is dropped (and its endlessly
      // retrying client closed) so this cold-resumes instead of queueing the operator's message into a
      // socket that never returns.
      let held = current(input.threadSlug, input.sessionId)
      if (held && !holdsLiveDaemon(held)) { held.client.close(); sessions.delete(input.threadSlug); held = undefined }
      // A caller that asked for a FRESH process is telling us the live one cannot act on this message.
      // Retire the daemon so the attach below cold-resumes instead of reconnecting: the new `claude`
      // re-reads the credential and carries no usage-limit latch. Nothing durable is lost — the
      // transcript is on disk and `resume: true` reads it back — beyond the in-memory sub-agents, and a
      // latched parent's children are already dead by the same 429 that latched it.
      if (input.freshProcess && held) {
        held.client.close()
        killBroker(deps.stateDir, held.sessionId)
        sessions.delete(input.threadSlug)
        held = undefined
      }
      const session = held ?? await attach(
        input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default",
        { resume: true, appendSystemPrompt: input.appendSystemPrompt, model: input.model, effort: input.effort },
      )
      session.client.sendInput(message)
    },

    async cancelFollowUp(input) {
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This thread's Claude session is no longer running, so nothing is queued to take back")
      }
      // Same shape as the sub-agent-steer capability gate: a detached daemon outlives fray upgrades by
      // six hours, so the process on the other end may predate the `cancel-input` frame entirely. It
      // would answer NOTHING, and this call would hang to its deadline and then read as a wedged
      // session — when the truth is simply "this session is too old to unqueue from".
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_CANCEL_INPUT)) {
        throw new Error("This thread's Claude session predates unqueueing — its next turn will restart on a session that supports it")
      }
      // `inputIdFor` is what followUp used to mint the SDK uuid, so passing the SAME deliveryId
      // reproduces the SAME uuid — as long as it is uuid-shaped. When it is NOT, followUp substituted a
      // random uuid that nothing recorded, so there is no id to cancel and a fresh one would answer a
      // misleading `false`. Refuse instead of guessing.
      if (inputIdFor(input.deliveryId) !== input.deliveryId) {
        throw new Error("This message was sent without a cancellable id, so it can no longer be taken back")
      }
      return await held.client.cancelInput(input.deliveryId)
    },

    async steerSubAgent(input) {
      // No attach, no resume — see the interface doc. `holdsLiveDaemon` is the same generation check
      // followUp uses to notice a daemon died under a held session; here a miss is terminal rather
      // than a cue to cold-start, because there is no such thing as resuming a sub-agent.
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This sub-agent's session is no longer running, so it cannot be steered")
      }
      // A DETACHED daemon outlives fray upgrades by design (six-hour idle timeout), so the process on
      // the other end of this socket may well have been forked by the previous build — whose input
      // validator drops the addressing field entirely. That would not fail; it would deliver the
      // operator's steer to the thread's MAIN turn, where the parent obeys it. Refuse instead, and say
      // what fixes it. A daemon forked by this build advertises the capability in its record.
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_SUBAGENT_STEER)) {
        throw new Error("This thread's Claude session predates sub-agent steering — its next turn will restart on a session that supports it")
      }
      // VALIDATE HERE, not only in the daemon. `sendInput` writes a socket frame and returns; the
      // daemon calls `handle.send(...).catch(() => {})`, so a message the protocol validator rejects
      // (a control byte, an over-long body) is discarded THERE with nobody to tell. For a follow-up
      // that has always been true and is out of scope to change — it is a shared hot path whose
      // error handling deliberately never kills a session. For a STEER it is unacceptable: the RPC
      // would answer `delivered: true` for a message that never reached the child, which is exactly
      // the "an input that silently drops a steer is worse than no input" failure the prompt box is
      // gated on. Measured on the promoted artifact: an ESC/BEL steer was accepted and vanished.
      // Running the same pure validator first turns that into an error the operator actually sees.
      const message = validateInputMessage({ id: inputIdFor(input.deliveryId), text: input.text, parentToolUseId: input.subAgentId })
      held.client.sendInput(message)
    },

    async stopSubAgent(input) {
      const held = current(input.threadSlug, input.sessionId)
      if (!held || !holdsLiveDaemon(held)) {
        if (held) { held.client.close(); sessions.delete(input.threadSlug) }
        throw new Error("This sub-agent's session is no longer running, so it cannot be stopped")
      }
      const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, held.sessionId))
      if (!record?.capabilities?.includes(CLAUDE_BROKER_CAPABILITY_STOP_TASK)) {
        throw new Error("This thread's Claude session predates sub-agent stopping — its next turn will restart on a session that supports it")
      }
      await held.client.stopTask(input.taskId)
    },

    async warmUp() {
      let owned: Array<{ threadSlug: string; sessionId: string; cwd: string }>
      try { owned = deps.ownedSessions?.() ?? [] } catch { return }
      if (owned.length === 0) return
      // Enumerate the LIVE daemons once and index them, rather than stat-ing a record per registry row:
      // a project accumulates hundreds of rows and runs a handful of daemons.
      let live: Map<string, BrokerRecord>
      try { live = new Map(liveBrokerRecords(deps.stateDir).map((record) => [record.sessionId, record])) } catch { return }
      if (live.size === 0) return
      for (const target of owned) {
        const record = live.get(target.sessionId)
        if (!record) continue // no daemon to adopt; a follow-up cold-resumes and attributes the death
        if (current(target.threadSlug, target.sessionId)) continue // already held (a re-entrant warmUp)
        // `bind`, not `attach`: adopting must never be able to FORK. Between the enumeration above and
        // here the daemon could have exited, and adoptOrForkBroker would then cold-start a `{kind:"new"}`
        // session on the same id — a fresh empty session writing over a real thread's transcript, at
        // boot, with nobody asking for it. Connecting to a socket that has since gone away simply fails
        // and retries, which is the harmless direction.
        try { bind(target.threadSlug, target.sessionId, target.cwd, record) } catch { /* a boot never fails on a broker */ }
      }
    },

    binding(threadSlug, sessionId) {
      const s = current(threadSlug, sessionId)
      return s ? { threadSlug, sessionId, cwd: s.cwd, generation: s.generation, state: s.client.connected() ? "active" : "detached" } : undefined
    },

    isDaemonAlive(sessionId) {
      return liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, sessionId)) !== null
    },

    daemonExit(sessionId) {
      try { return readClaudeBrokerExit(deps.stateDir, sessionId) } catch { return null }
    },

    releaseSession(threadSlug, sessionId) {
      // Kill the daemon UNCONDITIONALLY (by record), even when we don't currently hold it live — after a
      // fray restart the ownerless daemon is still running but unattached, and a stop/complete must not
      // leak it. The return value reports only whether we held a live binding to tear down first.
      const s = current(threadSlug, sessionId)
      if (s) { s.client.close(); sessions.delete(threadSlug) }
      killBroker(deps.stateDir, sessionId)
      // storage.ts cancels every pending interaction for the session before it emits the lifecycle
      // event, so the subscriber above has already denied and dropped these. Sweep anyway: an entry
      // whose interaction was ALREADY terminal never gets a change event, and there is no daemon left
      // to answer it against.
      for (const [id, pending] of pendingPerms) if (pending.scope.sessionId === sessionId) pendingPerms.delete(id)
      return s !== undefined
    },

    close() { unsubInteractions?.(); pendingPerms.clear(); for (const s of sessions.values()) s.client.close(); sessions.clear() },
  }
}
