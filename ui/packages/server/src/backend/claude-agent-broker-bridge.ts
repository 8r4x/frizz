// The fray-side bridge for the Claude session broker — the Claude twin of CodexAppServerBridge, but
// leaner because the broker DAEMON owns the session state (and the transcript lands on disk via
// persistSession, read by the tailer like any Claude thread). The bridge forks/adopts a broker per
// thread, connects a typed client, routes tool-permission requests to a decision hook (default:
// auto-allow, honoring the thread's permission mode — matching today's tmux `--permission-mode auto`;
// wiring these to the dashboard InteractionStore is the next slice), and sends follow-up turns.
import { randomUUID } from "node:crypto"
import { adoptOrForkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker, type ClaudeBrokerClient } from "./claude-broker-client.ts"
import type { ClaudePermissionDecision, ClaudePermissionRequest, ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"
import type { ClaudeBrokerConfig } from "./claude-agent-broker.ts"

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
  /** Decide a tool-permission request. Defaults to auto-allow. Later: journal to the InteractionStore. */
  decidePermission?: (slug: string, sessionId: string, request: ClaudePermissionRequest) => Promise<ClaudePermissionDecision>
  /** Observe the session/transcript event stream (board liveness / telemetry). Optional. */
  onEvent?: (slug: string, sessionId: string, event: ClaudeQueryEvent) => void
}

export interface ClaudeSpawnDispatchInput {
  threadSlug: string
  sessionId: string
  cwd: string
  prompt: string
  permissionMode?: ClaudeBrokerConfig["permissionMode"]
}

interface ActiveSession { slug: string; sessionId: string; cwd: string; generation: string; client: ClaudeBrokerClient }

export interface ClaudeAgentBrokerBridge {
  spawnDispatch(input: ClaudeSpawnDispatchInput): Promise<{ binding: ClaudeBrokerBinding }>
  followUp(input: { threadSlug: string; sessionId: string; cwd: string; text: string; permissionMode?: ClaudeBrokerConfig["permissionMode"] }): Promise<void>
  binding(threadSlug: string, sessionId: string): ClaudeBrokerBinding | undefined
  releaseSession(threadSlug: string, sessionId: string, reason: "session-replaced" | "session-deleted"): boolean
  close(): void
}

export function createClaudeAgentBrokerBridge(deps: ClaudeBrokerBridgeDeps): ClaudeAgentBrokerBridge {
  const sessions = new Map<string, ActiveSession>() // keyed by slug — one active session per thread

  const attach = async (slug: string, sessionId: string, cwd: string, permissionMode: ClaudeBrokerConfig["permissionMode"]): Promise<ActiveSession> => {
    const { record } = await adoptOrForkBroker({ stateDir: deps.stateDir, cwd, sessionId, executablePath: deps.executablePath, permissionMode, env: deps.env })
    const client = connectClaudeBroker(record.socketPath, {
      onEvent: (event) => deps.onEvent?.(slug, sessionId, event),
      onPermissionRequest: (requestId, request) => {
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
      const session = await attach(input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default")
      session.client.sendInput({ id: randomUUID(), text: input.prompt })
      return { binding: { threadSlug: input.threadSlug, sessionId: input.sessionId, cwd: input.cwd, generation: session.generation, state: "active" } }
    },

    async followUp(input) {
      // Reattach if we don't already hold this session live (fray restarted, or it was detached).
      const session = current(input.threadSlug, input.sessionId) ?? await attach(input.threadSlug, input.sessionId, input.cwd, input.permissionMode ?? "default")
      session.client.sendInput({ id: randomUUID(), text: input.text })
    },

    binding(threadSlug, sessionId) {
      const s = current(threadSlug, sessionId)
      return s ? { threadSlug, sessionId, cwd: s.cwd, generation: s.generation, state: s.client.connected() ? "active" : "detached" } : undefined
    },

    releaseSession(threadSlug, sessionId) {
      const s = current(threadSlug, sessionId)
      if (!s) return false
      s.client.close()
      killBroker(deps.stateDir, sessionId)
      sessions.delete(threadSlug)
      return true
    },

    close() { for (const s of sessions.values()) s.client.close(); sessions.clear() },
  }
}
