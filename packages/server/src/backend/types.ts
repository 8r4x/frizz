import type { LimitWindow, PermissionMode } from "@frizz/shared"
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
  // A CHILD sub-agent reporting UPWARD into this session — codex's inter-agent `agent_message` record,
  // whose `author` is the child's agent path and whose `recipient` is ours. `final` splits the child's
  // TERMINAL return (codex "FINAL_ANSWER" — the completion notification) from a mid-flight progress
  // report ("MESSAGE"); the two render as the two wake dividers the Claude path already draws. This is
  // the child's output, NOT this session's, so the fold treats it as activity and nothing more.
  // Codex-only: Claude delivers both upward shapes as ordinary (synthetic) user records instead.
  | { kind: "agent-report"; at?: string; author: string; text: string; final: boolean }
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
  // The final message carries the AWAITING sentinel — the worker's answer to a stop hook when
  // nothing in it is actionable. Optional (absent ⇒ false) because it is an additive observation, not
  // a new required fact about a session; see scheduler.ts SOURCE 5.
  lastAssistantAllDone?: boolean
  // Live sub-agents. Claude fills these from its Agent dispatches (the tailer's trackDispatches); codex
  // from its `spawn_agent` children (codex-subagents.ts). Both land in the same TailState maps.
  subAgents: SubAgentView[]
  bgShells: BgShellView[] // codex: always [] (codex has no background-shell tool)
  pendingAsk?: PendingAskData // codex: undefined
  authFault?: "authentication_rejected" // runtime provider-auth rejection (see FoldState.authFault)
  limitFault?: LimitFault // subscription window exhausted mid-turn (see FoldState.limitFault)
  contextTokens?: number // tokens the last request carried (see FoldState.contextTokens)
  contextWindow?: number // the model's context size, provider-reported (see FoldState.contextWindow)
  // ISO8601 of the newest CONTEXT COMPACTION, or absent if this session has never been compacted. It is
  // the trigger clock for scheduler SOURCE 7 (the recurring prompt's post-compaction delivery): a new
  // compaction necessarily carries a new instant, so "at most one delivery per compaction" falls out of
  // delivery-id uniqueness, exactly as the rest trigger gets it from lastActivityAt.
  lastCompactionAt?: string
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
  // signal never leaves the board on an internal slug; a later valid Frizz signal may replace it.
  // A generated signal or provider-native title is final for automatic naming (manual titles are
  // guarded separately by storage's title_auto CAS).
  autoTitleSource?: "fallback" | "frizz" | "native"
  lastUserAt?: string // ISO8601 of the newest GENUINE (non-synthetic) human turn — the listing sort key
  lastUserText?: string // exact text of that genuine human turn when the backend records it
  lastFence?: FenceView // done/awaiting excusal fence on the final message (cleared by any user turn)
  lastAssistantHasQuestion: boolean // the final message carries an unanswered ```question fence
  // The final message answers a stop hook with AWAITING (scheduler.ts SOURCE 5). Folded and
  // cleared on exactly the same lifecycle as the question flag above: set per assistant text, wiped by
  // any user record — so the next bump the operator sends re-opens the loop by itself.
  lastAssistantAllDone: boolean
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
  // Newest context compaction — the post-compaction trigger's clock (see NormalizedTail.lastCompactionAt).
  // The two backends observe it differently and neither has a second signal: Claude injects its
  // carry-over summary as an ordinary user record flagged `isCompactSummary`, while codex emits an
  // explicit `compaction` normalized event. Both are the harness's work, not the agent's, so this is the
  // ONLY field either of them moves — turn state, preview, fence and row order all stay put.
  lastCompactionAt?: string
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

// The ONE unified frizz MCP server every worker gets: mounted under the name `frizz`, so its tools are
// addressed as `mcp__frizz__<tool>` (`spawn_thread`, `recurring_prompt` and `timer` today — new
// worker-facing frizz capabilities join the same server's registry in cc-worker/bin/frizz-mcp.mjs rather
// than mounting a second server). The dispatch layer pre-approves it at SERVER level (`mcp__frizz`), so a
// tool added there needs no allow-list change here.
export const FRIZZ_MCP = {
  name: "frizz",
  script: "frizz-mcp.mjs", // resolved under <worker plugin dir>/bin/
} as const

// Present ⇒ mount FRIZZ_MCP for this worker. Carries the abs path to the stdio MCP server script and
// the project state dir it reads `server.lock` from. Computed by the dispatch layer
// (resolveWorkerPluginDir + project.stateDir) and threaded through both backends; absent in tests /
// when the plugin dir or script can't be resolved (→ no injection, worker simply lacks the tools).
export interface FrizzMcp {
  scriptPath: string
  stateDir: string
  // WHERE THE PORT ACTUALLY IS. `server.lock` is written for the project the singleton was LAUNCHED
  // from and for no other (index.ts, "status publication"), so a worker in any OTHER open project
  // read its own project's state dir and found nothing — every frizz tool died on
  // "could not read the frizz server lock … ENOENT", or worse, on a stale lock from the last time
  // that repo ran its own server (a dead port ⇒ "dispatch request failed: fetch failed"). Absent ⇒
  // the script falls back to `<stateDir>/server.lock`, which is what a pre-singleton server passed.
  serverLock?: string
  // WHICH PROJECT the tools act on, as the immutable registry id — the script addresses
  // `/_frizz/<projectId>/rpc/…`. An UNPREFIXED `/_frizz/rpc/…` is the LAUNCHING project by design
  // (splitTenantRequest), so without this a worker in project B spawned its thread onto project A's
  // board. The id rather than the slug because a project can be renamed under a live detached worker.
  projectId?: string
  // The thread this MCP server belongs to, passed through as FRIZZ_THREAD_SLUG so a tool CAN act on its
  // OWN thread. Nothing in the MCP protocol identifies the caller, and the server is spawned per worker,
  // so its env is the only channel for this. Optional, and currently read by no shipped tool:
  // `spawn_thread` does not need to know who called it, and the one that did — a worker-armed heartbeat
  // — was removed 2026-08-02 in favour of the operator's stop hook. See dispatch.ts for why it stays.
  slug?: string
}

/**
 * The env the frizz MCP server process is spawned with — ONE builder, because both backends mount the
 * same script and a field added on only one side is a capability that silently works under claude and
 * not under codex (or the reverse), discoverable only by running a worker.
 */
export function frizzMcpEnv(mcp: FrizzMcp): Record<string, string> {
  return {
    FRIZZ_STATE_DIR: mcp.stateDir,
    ...(mcp.serverLock ? { FRIZZ_SERVER_LOCK: mcp.serverLock } : {}),
    ...(mcp.projectId ? { FRIZZ_PROJECT_ID: mcp.projectId } : {}),
    ...(mcp.slug ? { FRIZZ_THREAD_SLUG: mcp.slug } : {}),
  }
}

// The ONE canonical Chrome DevTools MCP server spec both backends inject into every worker they
// spawn — the runtime release gate requires driving a real browser, and neither backend can assume
// the operator configured a browser MCP themselves. Claude mounts it via inline `--mcp-config` JSON
// (+ a server-level `--allowedTools mcp__chrome-devtools` pre-approval) in dispatch.ts; codex mounts
// it via `-c` TOML overrides (+ `default_tools_approval_mode="approve"`) on the APP-SERVER's argv in
// codex-mcp.ts — process-level, because a per-thread override mounts nothing at all. Deriving both
// from this constant is what keeps the two backends' browser tooling in lockstep — edit HERE, never in
// one backend alone. (The codex half was DESCRIBED here long before it was written: for a while this
// paragraph was the only place it existed, and codex threads had no browser — read codex-mcp.ts.)
// `--isolated` gives each worker a disposable browser profile (never the operator's own Chrome), and
// `--headless` keeps the window off the operator's screen. BOTH are required and both default to
// false upstream: this is the same pair `.mcp.json` pins for agents working in THIS repo, and the
// same policy `.agents/skills/adhoc-cdp` states in as many words — "NEVER put a browser window on the
// maintainer's screen … a verification run must be invisible". That rule was written for agents
// editing frizz and never reached the workers frizz DISPATCHES, which is how the 2026-07-28 complaint
// ("it keeps opening tabs in my actual real Chrome") came back on 2026-08-06 from a worker doing
// ordinary browser QA in someone else's repo. A worker shares the desktop exactly as a fray agent
// does, so it gets the same two flags.
export const CHROME_DEVTOOLS_MCP = {
  name: "chrome-devtools",
  command: "npx",
  args: [
    "-y",
    "chrome-devtools-mcp@latest",
    "--experimentalPageIdRouting",
    "--headless",
    "--isolated",
    "--no-usage-statistics",
  ],
  startupTimeoutSec: 120,
} as const

// The environment EVERY frizz Claude worker gets, on BOTH spawn paths. Kept as one record with one
// spread per call site (claudeWorkerEnvironment() for tmux, the bridge's `workerEnv` for the broker,
// plus the SDK's key allowlist) so a new entry cannot reach one path and silently miss the other.
// Spread it, never re-spell a key — a typo here is silent, and each failure mode below is quiet.
//
// Distinct from claudeWorkerEnvironment()'s CAPS, which are tmux-only today: these are settings a
// worker needs on whichever path it was dispatched through.
//
// ── CLAUDE_CODE_TOTAL_TOKENS_REMINDER ──────────────────────────────────────────────────────────
// The token budget a Claude worker is TOLD it has. Claude Code's `totalTokensReminder` writes a
// `<total_tokens>N tokens left</total_tokens>` block into the system prompt and after every
// tool-result batch; `infinite` renders the literal `Infinite`. Default is `off` — no block at all.
//
// WHY A FRIZZ WORKER OVERRIDES THAT DEFAULT: with no block, the model has no signal about its budget
// and it GUESSES — badly, and always downward. Claude Code injects nothing else about context: no
// system-reminder in cli 2.1.220 mentions tokens, and the "Context is N% full" warning is `/context`
// TUI text the model never sees. Measured on a real worker (nub session 5258ebe4, transcript line
// 31014) it wrote "I'm near my context limit, so I'm not starting the linker change here" at a live
// fill of 667,277 tokens, against auto-compact boundaries that fired at ~1,000,000 — a third of the
// window still free. Earlier in that same session, 13 consecutive turns declared "I'm out of context"
// at fills of 176k–244k (under a quarter of the window), and at line 20628 it named the pattern
// itself: "I've been treating 'low context' as a stopping condition for the last several turns and
// winding down instead of working." Eight other long worker sessions END at 616k–940k with 25–38% of
// the window unused. Compaction is not cutting these sessions off — they are quitting early.
//
// `infinite` and not `countdown`: a live remaining-token count is still a shrinking number, which is
// the exact input to the bad inference. Claude Code's own autocompact system prompt already tells the
// model "your conversation with the user is not limited by the context window" — `Infinite` restates
// that in the one place the model looks for a budget, and it is TRUE for a frizz worker, whose session
// compacts and continues rather than ending.
//
// The env var is the highest-precedence source, ahead of `totalTokensReminder` in settings and the
// server-side `tengu_lapis_anchor` flag (verified against cli 2.1.220). Its failure mode if dropped
// is a worker that quits at 60% of its window.
//
// ── BASH_DEFAULT_TIMEOUT_MS ────────────────────────────────────────────────────────────────────
// How long a FOREGROUND Bash call runs before Claude Code moves it to the background. Claude Code's
// default is 120_000 (2 min) with a ceiling of 600_000 (10 min); we sit BELOW both at 60_000, which
// the maintainer chose on 2026-08-01 — reversing the same-day call to take the ceiling.
//
// WHY: the earlier reasoning optimized for the long gate (`nub run test` is ~5 min) and paid for it
// with a turn that can sit blocked for ten minutes on one call. A blocked turn is the worse failure:
// the worker is doing nothing recoverable, the board shows a card that cannot be steered, and the
// operator cannot tell a slow gate from a wedged one. Bouncing at a minute costs a poll cycle to
// recover the result and keeps the turn moving in the meantime.
//
// The ceiling is untouched — BASH_MAX_TIMEOUT_MS defaults to max(600_000, this), so it stays
// 600_000 and a worker that genuinely wants to block through a long gate still can by passing an
// explicit `timeout`. The Bash tool's own description interpolates both (`` `timeout` is in
// milliseconds: default ${...}, max ${...}``), so the worker is told this number, not a stale one.
//
// This does NOT relax the escaping-background-job rule that hooks/bash-background.mjs enforces. That
// hook is about lifecycle identity (`cmd &` leaves a child frizz and Claude cannot wake on); this is
// only about how long a tracked foreground call is allowed to take before the harness backgrounds it
// ITSELF, which keeps the task id and the wake. The two are independent.
//
// Do not "verify" this value from a stand-in harness: neither `claude -p` nor a raw SDK session
// reproduces the auto-background bounce that real dispatched workers get, so a behavioral check
// there passes identically with and without the variable. See the NOT ASSERTED note in
// _live_sdk_worker_env.mts.
export const CLAUDE_WORKER_ENV = {
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "infinite",
  BASH_DEFAULT_TIMEOUT_MS: "60000",
} as const

// Tools a TMUX worker never gets — the argv turns this into `--disallowedTools=…`.
//
// TMUX ONLY, and the asymmetry is deliberate. There AskUserQuestion opens a native TUI dialog in a pane
// nobody is watching, so the question has literally nowhere to go and the session freezes invisibly. The
// BROKER path does NOT pass this: it intercepts the same call at canUseTool and renders a real dashboard
// question card whose answer reaches the model (claude-agent-broker.ts says so at the query site).
//
// The other hazard — a parked turn swallowing a follow-up the operator typed instead of answering —
// argued for blocking it on both paths for a few hours on 2026-08-02. It is handled where it actually
// lives instead: the bridge retires an open card when a follow-up arrives, which unwinds the tool call
// and lets the turn read the message. See `retirePendingFor`.
export const WORKER_DISALLOWED_TOOLS = ["AskUserQuestion"] as const

export interface SpawnOpts {
  sessionId: string // claude: pinned via --session-id. codex: advisory (id is discovered post-spawn)
  cwd: string
  prompt: string // the composed first user message (task + orientation)
  workerContract: string // workerPrompt.ts norms — injected at system level per backend
  extraSystemPrompt?: string // scratchpad/plan orientation
  permissionMode: PermissionMode
  model?: string
  effort?: string
  frizzMcp?: FrizzMcp
}
export interface ResumeOpts extends Omit<SpawnOpts, "prompt"> {
  // Omitted when frizz is only re-attaching an idle saved conversation to apply a per-thread
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
