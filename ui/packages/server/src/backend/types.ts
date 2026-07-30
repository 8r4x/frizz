import type { LimitWindow, PermissionMode } from "@fray-ui/shared"
import type { FenceView, SubAgentView, BgShellView, PendingAskData, TurnState } from "../tailer.ts"

// A turn cut off by an exhausted SUBSCRIPTION window, as a backend's fold observed it. Carries only
// typed data — which window, when it happened, and the provider's stated reset clock in structured
// form. The raw error text never leaves the fold, matching the authFault discipline.
export interface LimitFault {
  window: LimitWindow
  at: string // ISO8601 of the limit record — when the agent got cut off
  resetClock?: { hour: number; minute: number; timeZone: string }
}

// ---- The agent-backend abstraction (Codex-support epic, Phase 1) ----
// One interface, one implementation per agent CLI. The server holds an AgentBackend per session and
// routes spawn / resume / transcript-location / line-folding through it, so the tailer + dispatcher
// stay backend-blind. Phase 1 ships ClaudeBackend as the sole implementation with byte-for-byte
// identical observable behavior; Phase 2 adds CodexBackend behind this same interface.

export type BackendKind = "claude" | "codex"

// A verified native TUI modal that blocks the backend before it can append another transcript
// record. This is intentionally tiny and presentation-safe: pane contents/options never cross the
// server boundary (they can contain commands, repository data, or secrets). Backends emit only a
// coarse family plus a fixed, sanitized title after matching their own version-grounded modal chrome.
export type NativeInputKind = "tool-approval" | "permission" | "confirmation" | "selection"
export interface NativeInputRequiredData {
  kind: NativeInputKind
  title: string
}

// A backend-neutral transcript record: the vocabulary a backend's parser emits, and — for a backend
// whose turn model maps cleanly onto it (codex's explicit task_started/task_complete brackets) — the
// unit the tailer's generic fold would consume. Each backend maps its raw transcript lines onto this
// union; sidecar/unknown lines map to nothing (skipped).
//
// NOTE (Phase 1): Claude's OWN fold does NOT route through this union. Claude's turn signal is the
// 3-way assistant `stop_reason` (end_turn / tool_use / unknown-with-5s-backstop) that computeTurn and
// the corpus-verified tailer tests depend on, and that distinction cannot be expressed by
// turn-start/turn-end/assistant-text{final} without information loss. So ClaudeBackend keeps its
// corpus-verified applyRecord fold (AgentBackend.foldLine) and exposes parseLine only as the
// normalized VIEW — the codex-facing seam + the unit-test surface.
export type NormalizedEvent =
  | { kind: "turn-start"; at?: string } // a turn began (→ in-flight)
  | { kind: "turn-end"; at?: string; finalText?: string } // a turn finished (→ idle); finalText carries the fence
  | { kind: "assistant-text"; at?: string; text: string; final: boolean } // streamed assistant text (final=the answer, not commentary)
  | { kind: "user-message"; at?: string; text?: string; synthetic: boolean } // human turn (synthetic=peer/notification/tool-result echo — never bumps lastUserAt)
  | { kind: "tool-call"; at?: string; id: string; name: string; input: unknown }
  // `image` is a `data:image/…;base64,…` URL when the result CARRIED a picture (an MCP
  // `take_screenshot`, codex `view_image`). It is deliberately a SEPARATE channel from `text`: the text
  // is what the board fold, summaries and the output pane consume, and splicing megabytes of base64 into
  // it would push the blob through every one of them. Carrying the already-parsed string by reference
  // costs nothing; only the transcript projection reads it, and only to decode it to disk once.
  | { kind: "tool-result"; at?: string; id: string; text: string; image?: string }
  | { kind: "reasoning"; at?: string; text: string } // model-reasoning SUMMARY (Codex plaintext summary[]; Claude thinking is redacted → never emitted)
  | { kind: "title"; title: string } // backend's own session auto-title (ai-title / codex thread title)
  // Context COMPACTION: the harness replaced the conversation with a summary, so everything above this
  // point is gone from the agent's context. Both providers record it (Claude: a system/compact_boundary
  // record carrying preTokens/postTokens; codex: a top-level `compacted` envelope carrying none), which
  // is why the token fields are optional — a backend that doesn't measure it still reports the event.
  | { kind: "compaction"; at?: string; preTokens?: number; postTokens?: number }
  // Tokens occupying the model's context after its latest request (codex token_count). Pure telemetry:
  // it moves no turn state. It exists so a consumer can bracket a compaction it can't measure directly —
  // the codex reading is the token_count immediately before/after the `compacted` envelope — and so the
  // footer can render how full the context is. `window` is the model's context size AS THE PROVIDER
  // REPORTS IT on the same event (codex: `info.model_context_window`), never a table we maintain: a
  // hardcoded window goes stale on exactly the schedule the codex version pin did. Optional because a
  // backend may measure the numerator without naming the denominator.
  | { kind: "context-usage"; at?: string; tokens: number; window?: number }

// The shape a backend's fold produces per session — the SAME shape board.ts already consumes as
// SessionTelemetry, minus `permPrompt` (which is pane-sniffed live, not folded from the transcript).
// A documented contract for what every backend's fold must surface; Phase-1 Claude realizes it as
// SessionTelemetry directly (see tailer.get()).
export interface NormalizedTail {
  turn: TurnState
  // Backend-observed session profile when its transcript records it. Claude assistant records expose
  // the actual model but not effort; codex turn_context exposes both. Optional by design.
  model?: string
  effort?: string
  profileAt?: string
  profileRevision?: number
  // Backend-observed permission/sandbox state. Codex emits this in turn_context and
  // thread_settings_applied; Claude emits permission-mode sidecars.
  permissionMode?: PermissionMode
  // Timestamp of the Codex profile event. Claude's permission-mode sidecar has no timestamp, so it
  // remains undefined there. Used to distinguish a pre-reattach Codex turn_context from a later
  // manual /permissions change.
  permissionModeAt?: string
  lastActivityAt?: string
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output (rest time; excludes sub-agent/system bumps)
  lastAssistant?: string
  aiTitle?: string
  lastUserAt?: string
  lastUserText?: string // latest genuine human message (used to confirm wake-token delivery)
  lastFence?: FenceView // parsed by the shared fence grammar from the final message
  pendingQuestion: boolean
  // Live sub-agents. Claude fills these from its Agent dispatches (the tailer's trackDispatches); codex
  // from its `spawn_agent` children (codex-subagents.ts). Both land in the same TailState maps.
  subAgents: SubAgentView[]
  bgShells: BgShellView[] // codex: always [] (codex has no background-shell tool)
  pendingAsk?: PendingAskData // codex: undefined
  authFault?: "authentication_rejected" // runtime provider-auth rejection (see FoldState.authFault)
  limitFault?: LimitFault // subscription window exhausted mid-turn (see FoldState.limitFault)
  contextTokens?: number // tokens the last request carried (see FoldState.contextTokens)
  contextWindow?: number // the model's context size, provider-reported (see FoldState.contextWindow)
}

// The backend-NEUTRAL fold accumulator: the running derivation a backend folds each transcript line
// into, and exactly the fields needed to produce a NormalizedTail. This is the state `foldLine`
// mutates — decoupled from the tailer's private TailState (which EXTENDS this, adding byte-cursor
// bookkeeping + Claude-only sub-agent/ask tracking + Claude's stop_reason turn inputs), so this
// interface no longer leaks Claude internals. A backend whose turn model maps onto NormalizedEvent
// (codex's explicit task_started/task_complete brackets) drives this via `applyEvent`; Claude reuses
// its corpus-verified `applyRecord` over the richer TailState (see the NOTE on NormalizedEvent).
export interface FoldState {
  turn: TurnState // in-flight while a turn runs; idle once it brackets closed
  sawRecords: boolean // any substantive record folded yet (a fresh/booting session guard)
  model?: string // latest concrete backend-observed model
  effort?: string // latest concrete backend-observed reasoning effort
  profileAt?: string // timestamp of latest model/effort record
  profileRevision?: number // increments even when a profile record repeats
  permissionMode?: PermissionMode // latest concrete backend-observed permission/sandbox mode
  permissionModeAt?: string // timestamp of the latest timestamped permission profile event
  permissionModeRevision?: number // increments for every profile record, even when the value repeats
  lastActivityAt?: string // ISO8601 of the latest timestamped event (ANY line, incl. sub-agent/system)
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output — the rest-time key (see NormalizedTail)
  lastAssistant?: string // ~200-char preview of the latest assistant text
  aiTitle?: string // the backend's own session auto-title (latest non-empty wins)
  // A backend may carry one in-band auto-title candidate on its first finalized response. Recording
  // that first final lets a backend distinguish a later recovery signal from an initial title; only a
  // replaceable automatic fallback may accept that later signal.
  titleCandidateFinalSeen?: boolean
  // Raw text of that first finalized response. Codex repeats the answer on task_complete; remembering
  // it lets the fold strip the same hidden marker from the echo without treating a later turn as a
  // second title candidate.
  titleCandidateFinalText?: string
  // Provenance for Codex's auto title. A bounded dispatch fallback exists only so an omitted in-band
  // signal never leaves the board on an internal slug; a later valid Fray signal may replace it.
  // A generated signal or provider-native title is final for automatic naming (manual titles are
  // guarded separately by storage's title_auto CAS).
  autoTitleSource?: "fallback" | "fray" | "native"
  lastUserAt?: string // ISO8601 of the newest GENUINE (non-synthetic) human turn — the listing sort key
  lastUserText?: string // exact text of that genuine human turn when the backend records it
  lastFence?: FenceView // done/awaiting excusal fence on the final message (cleared by any user turn)
  lastAssistantHasQuestion: boolean // the final message carries an unanswered ```question fence
  // Runtime provider-auth rejection (claude-auth plan, Slice A). Set when the backend records a
  // SYNTHETIC auth-error response (Claude: isApiErrorMessage + 401/login text) — never from user or
  // ordinary assistant content — and cleared by the next real assistant text (a genuine response
  // proves the credential works). Only this typed category ever leaves the fold; raw error/pane text
  // stays out of persisted state.
  authFault?: "authentication_rejected"
  // Subscription usage-limit pause (auto-resume). Set when the backend records a limit stop — for
  // Claude the synthetic record carrying the structured `error:"rate_limit"` category, never a text
  // match — and cleared by the next real assistant text OR any user record. That clearing rule is
  // what makes a delivered "continue" supersede the fault it was fired for.
  limitFault?: LimitFault
  // ---- context occupancy (the footer's fullness readout) ----
  // How many tokens the model's LAST request actually carried — i.e. how full its context is right
  // now. Both providers measure this themselves and both write it to their transcript, so this is
  // always a reading, never an estimate: codex reports `last_token_usage.total_tokens`; Claude's
  // per-assistant `message.usage` sums input + cache-creation + cache-read (the three components of
  // one request's input). It falls back down after a compaction, exactly as it should.
  contextTokens?: number
  // The model's context size, as the PROVIDER reports it. Deliberately not a per-model table: the
  // window depends on the concrete variant in play (a `[1m]` Claude alias reports 1_000_000 where the
  // same canonical model otherwise reports 200_000), so only the provider can answer for THIS session.
  // Codex names it on every token_count; Claude names it on the SDK `result` message, which means a
  // Claude row has a numerator from its first assistant record but no denominator until its first turn
  // ends — and a tmux/foreign Claude row never gets one at all. Absent ⇒ NO reading is rendered.
  contextWindow?: number
}

// A file a backend needs on disk BEFORE the detached spawn (e.g. codex's session-scoped AGENTS.md).
// Claude's system prompt rides a file too, but buildClaudeCommand writes it as a side effect, so
// ClaudeBackend returns an empty prewrite list.
export interface PrewriteFile {
  path: string
  contents: string
  // Sensitive prompt transports should be owner-only while the spawned CLI is consuming them.
  // Optional so existing backend prewrites retain their current platform default.
  mode?: number
}

export interface BuiltCommand {
  argv: string[]
  env: Record<string, string>
  prewrite: PrewriteFile[]
}

// The ONE unified fray MCP server every worker gets: mounted under the name `fray`, so its tools are
// addressed as `mcp__fray__<tool>` (today just `mcp__fray__spawn_thread` — new worker-facing fray
// capabilities join the same server's registry in cc-worker/bin/fray-mcp.mjs rather than mounting a
// second server). The dispatch layer pre-approves it at SERVER level (`mcp__fray`), so a tool added
// there needs no allow-list change here.
export const FRAY_MCP = {
  name: "fray",
  script: "fray-mcp.mjs", // resolved under <worker plugin dir>/bin/
} as const

// Present ⇒ mount FRAY_MCP for this worker. Carries the abs path to the stdio MCP server script and
// the project state dir it reads `server.lock` from. Computed by the dispatch layer
// (resolveWorkerPluginDir + project.stateDir) and threaded through both backends; absent in tests /
// when the plugin dir or script can't be resolved (→ no injection, worker simply lacks the tools).
export interface FrayMcp {
  scriptPath: string
  stateDir: string
}

// The ONE canonical Chrome DevTools MCP server spec both backends inject into every worker they
// spawn — the runtime release gate requires driving a real browser, and neither backend can assume
// the operator configured a browser MCP themselves. Claude mounts it via inline `--mcp-config` JSON
// (+ a server-level `--allowedTools mcp__chrome-devtools` pre-approval); codex mounts it via `-c`
// TOML overrides (+ `default_tools_approval_mode="approve"`). Deriving both from this constant is
// what keeps the two backends' browser tooling in lockstep — edit HERE, never in one backend alone.
// `--isolated` gives each worker a disposable browser profile (never the operator's own Chrome).
export const CHROME_DEVTOOLS_MCP = {
  name: "chrome-devtools",
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest", "--experimentalPageIdRouting", "--isolated", "--no-usage-statistics"],
  startupTimeoutSec: 120,
} as const

export interface SpawnOpts {
  sessionId: string // claude: pinned via --session-id. codex: advisory (id is discovered post-spawn)
  cwd: string
  prompt: string // the composed first user message (task + orientation)
  workerContract: string // workerPrompt.ts norms — injected at system level per backend
  extraSystemPrompt?: string // scratchpad/plan orientation
  permissionMode: PermissionMode
  model?: string
  effort?: string
  frayMcp?: FrayMcp
}
export interface ResumeOpts extends Omit<SpawnOpts, "prompt"> {
  // Omitted when fray is only re-attaching an idle saved conversation to apply a per-thread
  // permission change. Present for an ordinary dead-session follow-up.
  message?: string
}

export interface AgentBackend {
  readonly kind: BackendKind

  // ---- spawn / resume (argv + injection) ----
  // Build the detached-spawn argv + any files that must exist on disk first. The caller runs
  // `tmux.spawn(slug, argv, cwd, env)` after writing the prewrite files.
  buildSpawn(opts: SpawnOpts): BuiltCommand
  // Resume/reattach the pinned session; `message` starts a turn when present, otherwise the CLI opens
  // idle at its prompt (used for a controlled permission-profile restart).
  buildResume(opts: ResumeOpts): BuiltCommand

  // ---- transcript location ----
  // Deterministic path for a session's transcript (claude: <logDir>/<sessionId>.jsonl), or undefined
  // when it can't be computed yet (codex: the rollout id isn't known until the process writes
  // session_meta — discoverSession then resolves it).
  transcriptPath(sessionId: string): string | undefined
  // Phase 2 (codex) only — ClaudeBackend omits it (its path is deterministic from the pinned id).
  discoverSession?(cwd: string, spawnedAtMs: number): { sessionId: string; path: string } | undefined

  // ---- parsing ----
  // Pure, defensive NORMALIZED view of one raw transcript line (bad line → []). The codex-facing seam
  // + the unit-test surface. A backend whose turn model maps onto NormalizedEvent drives its fold off
  // this; Claude does not (see the NOTE on NormalizedEvent).
  parseLine(line: string): NormalizedEvent[]
  // The AUTHORITATIVE per-backend fold the tailer's driver invokes: fold one raw transcript line into
  // the backend-neutral session accumulator (FoldState). Claude reuses its corpus-verified applyRecord
  // (narrowing FoldState back to the concrete TailState the tailer hands it); a codex backend can
  // implement this as `for (const ev of this.parseLine(line)) applyEvent(state, ev)`.
  foldLine(state: FoldState, line: string): void

  // ---- optional pane-sniff (native interactive prompt; no jsonl signal) ----
  matchesPermPrompt?(pane: string): boolean // claude: the empirical markers; codex: its own or omitted
  // Structured, backend-specific native-modal detection. Implementations MUST match verified terminal
  // chrome rather than arbitrary model output and MUST NOT return pane-derived option/detail text.
  detectNativeInput?(pane: string): NativeInputRequiredData | undefined
  // PRE-SESSION modals only — the screens a backend can block on BEFORE it opens a session and writes
  // its first transcript record. Kept separate from detectNativeInput because the tailer runs it on a
  // different path (the no-transcript stall, where no transcript-derived signal exists) and because a
  // boot screen must never be matched against a live session's pane, where ordinary transcript text
  // could quote the same chrome. Same presentation-safe contract: fixed titles, never pane-derived.
  detectBootModal?(pane: string): NativeInputRequiredData | undefined
}
