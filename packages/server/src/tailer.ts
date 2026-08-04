import { statSync, openSync, readSync, closeSync, readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { insideFence, PermissionMode, saysAllDone } from "@frizz/shared"
import type { Bus } from "./bus.ts"
import { permMarkerPath, type Project } from "./project.ts"
import { isBrokerClaudeRow, isHeadlessRow } from "./storage.ts"
import type { Storage, SessionRow } from "./storage.ts"
import { discoverTranscriptId, DISCOVERY_GRACE_MS } from "./discover.ts"
import type { AgentBackend, FoldState, NativeInputRequiredData, NormalizedEvent, NormalizedTail } from "./backend/types.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import { normalizeObservedThreadModel, validateThreadProfile } from "./backend/thread-profiles.ts"
import { resolveRuntimeTurn, type ClaudeRuntimeTask } from "./backend/claude-runtime-ingest.ts"
import { classifyLimitRecord } from "./backend/usage-limit.ts"
import { claudeBrokerDiagnosticLogPath } from "./backend/claude-broker-diagnostics.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./backend/claude-broker-host.ts"
import { parseDeliveryLedger, correlateDeliveryRecord, ageDeliveries, serializeDeliveryLedger, type DeliveryLedgerItem } from "./delivery-ledger.ts"
import { createCodexSubAgentTracker, type CodexSubAgentTracker } from "./codex-subagents.ts"
import {
  isModelFacingCarrier, reportKind, blockTaskIds, parseReportBlock, relayedTaskIds,
  MAX_TRACKED_REPORTS, type QueuedReport,
} from "./completion-relay.ts"
import {
  createTailStateCache,
  decodeTailState,
  encodeTailState,
  fenceMatches,
  measureFence,
  type TailCacheEntry,
  type TailStateCache,
} from "./tail-cache.ts"
import { log as frizzLog } from "./logging.ts"

// The JSONL tailer: incrementally reads each registered session's Claude Code transcript
// (~/.claude/projects/<cwdSlug>/<session_id>.jsonl) to derive liveness telemetry — last activity
// time, a preview of the last assistant text, and whether the current TURN is in flight or idle.
// Per the architecture invariant, this file is TELEMETRY ONLY: it never gates correctness, parses
// defensively (bad line skipped, unknown type ignored, never throws), and degrades to "unknown"
// on any schema surprise rather than crashing.
//
// ---- TURN-STATE HEURISTIC (chosen empirically) ----
// Investigated the 15 real transcripts in ~/.claude/projects/-Users-colinmcd94-Documents-projects-frizz/.
// Record `type`s observed: assistant, user, attachment, queue-operation, last-prompt, ai-title,
// permission-mode, mode, bridge-session, file-history-snapshot, system. Only `assistant`, `user`,
// and `system` carry a `timestamp`; the rest are sidecar metadata (no timestamp).
//
// The DEFINITIVE turn-end signal is `assistant.message.stop_reason`. Across every transcript, an
// assistant message is split into one JSONL record per content block, and ALL records of a given
// message share the same stop_reason:
//   - "tool_use"  → the model is calling tools; the turn CONTINUES (a tool_result user record and
//                   further assistant records will follow).
//   - "end_turn"  → the model has finished; control returns to the prompt (the agent is IDLE).
// Empirically EVERY completed transcript's last substantive record is an assistant `end_turn`
// (optionally trailed by sidecar `system`/`last-prompt`/`ai-title` records). Counts across the
// corpus: 363 tool_use+tool_use, 209 tool_use+thinking, 117 tool_use+text, 41 end_turn.
//
// Derivation over the "last substantive record" (assistant or user; sidecar types ignored):
//   - assistant, stop_reason "end_turn"  → idle (definitive)
//   - assistant, stop_reason "tool_use"  → in-flight (tool exchange ongoing; DO NOT time out —
//                                          Opus tool latency routinely exceeds 5s)
//   - assistant, stop_reason missing/other → BACKSTOP: idle iff no append for >5s, else in-flight
//   - user (a fresh prompt or a tool_result) → in-flight (the model is about to respond)
//   - no substantive records yet             → in-flight (spawning; the pane is live)
// The 5s backstop only fires for an UNKNOWN stop_reason, so it can never override a clear tool_use.

const IDLE_BACKSTOP_MS = 5000
// How many extra nudge-driven ticks a session may spend waiting for the provider's disk write to
// catch up with its event stream before handing back to the ordinary poll. See chaseRuntime.
const RUNTIME_CHASE_MAX = 20
const POLL_MS = 1000
// Ceiling on the adaptive poll (see scheduleTick). A tick this expensive means something is badly
// wrong, but the tailer is still the only source of turn/liveness telemetry — it must keep running.
const MAX_POLL_MS = 10_000
// Claude writes an untimestamped permission sidecar just before (or alongside) its footer redraw.
// Give the footer the arrival poll plus two more redraw polls, then discard a stable mismatch so a
// killed pane's late sidecar cannot cause a permanent capture-pane/SQLite hot loop.
const CLAUDE_PERMISSION_CONFIRM_POLLS = 3
// A tracked background sub-agent whose transcript file has gone this long without an append is
// treated as "stale" — a liveness fallback for a completion record we somehow missed (the child
// died, or the worker session ended before the <task-notification> landed).
//
// The window MUST exceed the longest a LIVE child can legitimately stay silent, and that has a hard
// ceiling: a child writes its tool_use record, then blocks, and Claude's foreground Bash timeout is
// capped at 600000 ms — so one tool call buys at most ~10 minutes of silence. The old 5-minute window
// sat UNDER that ceiling and therefore declared healthy children dead: a child dispatched to own a CI
// wait (the contract's prescribed way to wait) flipped to "stale" at 312s while blocked in its
// watcher, dropping hasLiveBackgroundWork and queueing its parent mid-wait — measured on the live
// board 2026-07-22. 15 minutes clears the ceiling with headroom and still clears a genuinely dead
// child promptly; across 1366 real child transcripts (176k inter-record gaps) only 0.04% exceed it,
// while the p99 gap is 95s.
//
// AGENTS ONLY: a child appends on every step, so silence there is a real (if coarse) liveness signal.
// A background SHELL has no such property and is not judged this way at all — see bgShellViews.
const SUBAGENT_STALE_MS = 15 * 60_000
// The minute bucket of an ISO instant, for the board signature: a child's "N min ago" reading only
// changes when this changes, so folding this (not the raw mtime) into the sig means a steadily-active
// child re-pushes at most once a minute. "" when absent/unparseable — an absent reading is stable.
function activityMinute(at: string | undefined): string {
  if (!at) return ""
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? String(Math.floor(ms / 60_000)) : ""
}
// How long the transcript must be silent while a turn still looks in-flight before we spend a
// tmux capture-pane to sniff for an interactive permission prompt. Keeps us from shelling out
// every tick for a healthily-streaming turn; a real prompt only appears after a tool_use record
// (which stamps lastActivityAt), so by the time one shows the transcript has already gone quiet.
const PERM_SNIFF_MS = 4000
// Whole-directory FOREIGN-session discovery: a *.jsonl in the log dir with no registry row is a
// maintainer terminal, surfaced as a read-only thread. Only files touched within this window are
// "live" foreign threads (the dir accumulates every session ever); a file that ages past it drops
// out of foreignIds() but keeps its cached tail. Exported so other verticals share the freshness rule.
export const FOREIGN_FRESH_MS = 24 * 60 * 60_000
// Cap on concurrently-surfaced foreign threads (most-recent by mtime) — defensive against a log dir
// holding thousands of historical sessions.
const FOREIGN_MAX = 20
// Foreign discovery is a readdir + per-file stat; too costly per 1s tick, so scan at most every 5th
// tick (~5s) plus the very first tick. Between scans the last fresh set is reused verbatim.
const FOREIGN_SCAN_EVERY = 5
// How often the durable prime cache (tail-cache.ts) is written back for threads whose transcript grew.
// The cache exists to make the NEXT boot cheap, so it only has to be roughly current: this bounds how
// many appended bytes a boot can have to re-fold to at most one interval's worth per thread, while
// keeping the steady-state cost to one small batched transaction per interval instead of one per tick.
const CACHE_FLUSH_MS = 30_000
// How often the FIRST pass reports its position (see Tailer.start). Frequent enough that a launcher
// watching for progress never mistakes a working boot for a wedged one, coarse enough to cost nothing.
const PRIME_PROGRESS_EVERY = 20
// While a thread's transcript is still unresolved (missing past the grace window), re-run discovery at
// most this often — the file may yet appear (a very late boot) or a drifted transcript may materialize.
const DISCOVER_RETRY_MS = 15_000
// Per-session sink for a captured boot-failure pane, so a stall's root cause (claude's own error text,
// frozen in the remain-on-exit pane) survives past the pane being killed. Best-effort; inert litter.
const STALL_LOG_DIR = join(tmpdir(), "frizz-worker-logs")

export type TurnState = "in-flight" | "idle"

// A live background sub-agent as surfaced to the board (mirrors @frizz/shared SubAgentView; kept
// as a local shape so the tailer's telemetry stays decoupled from the wire schema).
export interface SubAgentView {
  label: string
  startedAt: string // ISO8601 of the dispatch record
  // "rested" = a DIRECT child whose run ended (the harness reported completed/failed) while the fan-out
  // it dispatched is still running. See anchorRoots below for why `completed` is not "finished".
  state: "running" | "stale" | "rested"
  subagentType?: string // the dispatch's input.subagent_type verbatim (e.g. "frizz:frizz-opus-high"); absent when unset
  id: string // the dispatch tool_use id — the drill-in drawer's stable handle to this exact child
  lastActivityAt?: string // ISO8601 of the child transcript's last append (its output-file mtime)
  // ---- provider-reported progress (broker Claude rows only; see applyRuntimeTasks) ----
  // "there's not really any indication of what they're up to aside from starts and stops" — this is
  // that indication. Every field is ABSENT unless the SDK reported it for this exact child, so a tmux
  // thread (prose-only) and an older claude that emits no task_* events render exactly as before.
  activity?: string // the tool the child is running RIGHT NOW (SDK last_tool_name)
  activityDetail?: string // what that step IS, in words (e.g. "Running Print current date and time")
  summary?: string // the provider's rolling one-line summary of the child's work
  toolUses?: number // tool calls the child has made so far
  tokens?: number // total tokens the child has spent so far
  durationMs?: number // the provider's own measure of working time (excludes paused)
  // ---- NESTING (see the DESCENDANTS note below) ----
  // 1 (or absent, which every reader treats as 1) = a child THIS session dispatched. 2 = a grandchild,
  // 3 = a great-grandchild, … Emitted only from 2 down, so a direct child's view stays byte-identical
  // to what it was before nesting existed.
  depth?: number
  parentId?: string // the dispatch id of the sub-agent that dispatched this one; absent at depth 1
}

// A signal fence parsed from the FINAL assistant message (mirrors @frizz/shared ThreadFence; kept
// as a local shape so the tailer's telemetry stays decoupled from the wire schema). The fence
// language IS the state, the body is the message; `hints` are `<kind>: <value>` lines parsed from an
// awaiting body. Only meaningful while it is the final message — any newer user record clears it.
export interface FenceView {
  kind: "done" | "awaiting"
  body: string
  hints: { kind: "pr-watch" | "human" | "timer" | "pr" | "ci" | "session"; value: string }[]
}

// Per-session derived telemetry surfaced to the board overlay. Structurally a NormalizedTail (the
// backend-neutral fold-output contract) PLUS `permPrompt` — which is pane-sniffed live, not folded
// from the transcript. `extends` makes tsc enforce that this stays a superset of the shared contract.
export interface SessionTelemetry extends NormalizedTail {
  turn: TurnState
  permPrompt: boolean // paused on an interactive permission prompt (pane-sniffed; no jsonl signal)
  // The last allow/deny frizz's permission POLICY made for this thread, and how many denials it has
  // made this session. Purely informational — a policy decision never blocks anyone, which is exactly
  // why it needs surfacing: it is otherwise invisible.
  permPolicy?: PermPolicyView
  permDenies?: number
  // A verified backend-native modal that blocks transcript progress. Its fixed presentation-safe
  // title/kind are the ONLY pane-derived data exposed; option/detail content never leaves the server.
  nativeInputRequired?: NativeInputRequiredData
  // Monotonic within this tail state. The permission controller uses it to distinguish an
  // authoritative profile emitted by the freshly attached backend from the pre-reattach fold.
  permissionModeRevision?: number
  lastActivityAt?: string // ISO8601 of the last timestamped record (ANY record, incl. sub-agent/system)
  lastAssistantAt?: string // ISO8601 of the agent's OWN last output — rest time (excludes sub-agent/system bumps)
  lastAssistant?: string // trimmed preview (~200 chars) of the last assistant text block
  aiTitle?: string // Claude's own auto-generated session title (latest ai-title sidecar record)
  // Claude's native `/rename` is distinguished from ordinary ai-title churn so the control plane can
  // prove that a title record was emitted AFTER its exact command submission.
  customTitle?: string
  customTitleRevision?: number
  subAgents: SubAgentView[] // live background sub-agents this session dispatched (empty when none)
  // Completion reports the runtime accepted into its queue and never put into the model's context.
  // A non-empty list means this agent is missing findings it believes it has. See report-delivery.ts.
  // Optional (absent ⇒ none) to match its neighbours here and to keep every existing telemetry
  // fixture valid — this is an additive observation, not a new required fact about a session.
  droppedReports?: QueuedReport[]
  bgShells: BgShellView[] // live background shells this session launched (empty when none)
  pendingAsk?: PendingAskData // a pending native AskUserQuestion the session is frozen on (else absent)
  pendingQuestion: boolean // at rest with an unanswered ```question block as the last assistant message
  lastUserAt?: string // ISO8601 of the newest USER-role record (answer/steer/dispatch) — the listing sort key
  lastFence?: FenceView // done/awaiting excusal fence on the latest assistant message (else absent)
  // The pinned transcript never materialized and discovery found no drifted one either (worker likely
  // failed to boot). Drives the board's degraded/stalled runtime instead of an eternal "Spinning up…".
  noTranscript?: boolean
  contextTokens?: number // tokens the model's last request carried (see FoldState.contextTokens)
  contextWindow?: number // the model's context size, provider-reported (see FoldState.contextWindow)
}

// ---- Interactive permission-prompt sniff (pane text; no jsonl signal) ----
// Even under `--permission-mode auto`, claude still stops on an interactive permission prompt for
// some tool calls, and the transcript gives NO signal — the last record stays assistant +
// stop_reason:"tool_use" (in-flight) indefinitely. The only observable is the rendered TUI. These
// markers were captured empirically (claude 2.1.198, --permission-mode default) for both a Bash
// and an Edit approval:
//
//   Bash command
//     touch approved-me.txt
//     Create empty file approved-me.txt
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and always allow access to permtest/ from this project
//     3. No
//   Esc to cancel · Tab to amend · ctrl+e to explain
//
//   Edit file / file.txt / <diff>
//   Do you want to make this edit to file.txt?
//   ❯ 1. Yes
//     2. Yes, allow all edits during this session (shift+tab)
//     3. No
//   Esc to cancel · Tab to amend
//
// Recurring across tools: a question line ("Do you want…"), a numbered "1. Yes" option, and the modal
// footer "Esc to cancel" (an idle prompt shows neither). We require the "1. Yes" option AND (the
// question OR the footer) — two independent signals, so a model merely printing "Do you want…" or its
// own numbered list can't trip it.
//
// The wording is NOT stable across every modal, so both signals carry alternates. ExitPlanMode's
// approval asks "Would you like to proceed?" and footers with "ctrl+g to edit in VS Code · …" — it
// matches NEITHER original spelling and was invisible here (adversarial review, claude 2.1.214). That
// is a hang-forever miss, not a cosmetic one: `detectNativeInput` is registered on the Codex backend
// ONLY (backend/codex.ts), so for a Claude worker this matcher is the single blocking-modal signal.
//
// Those content signals alone are NOT enough, because the capture is the whole visible pane: any
// TRANSCRIPT text on screen counts. A worker that quotes an approval prompt, reads this very file, or
// pastes a probe's terminal output re-trips the matcher on every ≥PERM_SNIFF_MS quiet gap and the
// thread oscillates between the sidebar's running band and Needs-you (reported 2026-07-18). Two
// STRUCTURAL gates fix that, both empirically grounded in 81 real-prompt captures (claude 2.x — the
// pre-boot trust prompt, a Bash approval, an Edit/Write approval) against 87 negatives (69 captures of
// a live pane merely quoting a prompt, plus every live worker pane on this box):
//
//   1. A live composer means the pane is ACCEPTING INPUT, so anything on it is transcript. A modal
//      replaces the composer: not one real-prompt capture carries the composer's mode line
//      ("⏵⏵ auto mode on", "⏸ manual mode on", "⏵⏵ accept edits on", "bypass permissions on"), while
//      every idle AND streaming Claude pane does. `ctrl+o`'s detailed-transcript view is the one other
//      composer-less-but-live screen (its own footer replaces the composer, and it is sticky for the
//      session), so it counts as a composer here — without it, a worker toggled into that view kept
//      re-tripping on quoted text. Scoped to the last rows, never the whole pane, so an agent that
//      merely PRINTS "auto mode on" mid-transcript cannot suppress a genuine prompt.
//   2. The modal is always the BOTTOM block. Its option row and footer land within the last handful
//      of non-blank rows, so only that tail is scanned — history scrolled above it is not evidence.
const PERM_YES_OPTION = /(^|\n)\s*(❯\s*)?1\.\s+Yes\b/
const PERM_QUESTION = /\b(?:Do you want|Would you like)\b/
const PERM_FOOTER = /\bEsc to (cancel|reject)\b/
// The four mode-footer spellings, plus plan mode and the ctrl+o transcript view.
const PERM_COMPOSER_FOOTER = /\bbypass permissions on\b|\baccept edits(?: mode)? on\b|\b(?:auto|manual|plan) mode on\b|\bShowing detailed transcript\b/i
// Rows of the modal's own tail that must contain the signals. Deepest `1. Yes` row observed is
// ExitPlanMode's at 6 rows from the end (Bash 4, trust 3); this keeps real margin over that.
const PERM_MODAL_TAIL_ROWS = 16
// Rows the composer occupies at the bottom of an input-accepting pane (divider, prompt row, divider,
// project line, mode line) — the mode line is always last, so this window need not cover all five.
const PERM_COMPOSER_TAIL_ROWS = 4

export function matchesPermPrompt(pane: string): boolean {
  if (!pane) return false
  const rows = pane.split("\n").filter((row) => row.trim() !== "")
  if (rows.length === 0) return false
  if (rows.slice(-PERM_COMPOSER_TAIL_ROWS).some((row) => PERM_COMPOSER_FOOTER.test(row))) return false
  const tail = rows.slice(-PERM_MODAL_TAIL_ROWS).join("\n")
  if (!PERM_YES_OPTION.test(tail)) return false
  return PERM_QUESTION.test(tail) || PERM_FOOTER.test(tail)
}

// ---- pre-session boot modals (NAMING the wedge matchesPermPrompt can only flag) ----
// Claude Code can block on an interactive screen BEFORE it opens a session, so the worker writes no
// transcript at all: agent_session_id stays empty and the pinned jsonl never appears. matchesPermPrompt
// already fires on these panes, but "blocked" alone made every such row card as a bare "Stalled" while
// the reason sat unread in the stall log. These name the two screens whose chrome is known, captured
// verbatim from real panes (claude 2.1.218) — the API-key screen from a worker wedged in production,
// the trust screen reproduced in a disposable HOME (its fixture is PANE_PERM_TRUST):
//
//   Detected a custom API key in your environment      Quick safety check: Is this a project you
//   ANTHROPIC_API_KEY: sk-ant-...<suffix>              created or one you trust? …
//   Do you want to use this API key?                   ❯ 1. Yes, I trust this folder
//     1. Yes                                             2. No, exit
//   ❯ 2. No (recommended)                              Enter to confirm · Esc to cancel
//   Enter to confirm · Esc to cancel
//
// Two signals each (headline + question, or question + its exact option) so one stray line cannot trip
// either. Titles are FIXED strings: per the AgentBackend contract pane text never crosses the server
// boundary, and here it holds a masked credential and the workspace path.
//
// Lives here rather than in backend/claude.ts for the same reason matchesPermPrompt does: the tailer's
// defaultBackend must stay identical to the injected ClaudeBackend (tests drive the default), and
// backend/claude.ts already imports from this module, so the dependency can only run one way.
const BOOT_APIKEY_HEADLINE = /Detected a custom API key in your environment/
const BOOT_APIKEY_QUESTION = /Do you want to use this API key\?/
const BOOT_TRUST_QUESTION = /Is this a project you created or one you trust\?/
const BOOT_TRUST_OPTION = /(^|\n)\s*(❯\s*)?1\.\s+Yes, I trust this folder\b/
// Both modals put their decisive rows within a few non-blank rows of the end; the trust screen is the
// deeper of the two (its blurb precedes the options). 24 keeps real margin over that.
const BOOT_MODAL_TAIL_ROWS = 24
// Fallback for a boot wedge whose pane trips the generic matcher but matches no chrome we can name.
// Deliberately vague — the alternative is the silent "Stalled" card, and an uncatalogued startup screen
// is still worth sending the human to look at.
const GENERIC_BOOT_MODAL: NativeInputRequiredData = { kind: "confirmation", title: "Blocked on a startup prompt" }

export function detectClaudeBootModal(pane: string): NativeInputRequiredData | undefined {
  if (!pane) return undefined
  const tail = pane.split("\n").filter((row) => row.trim() !== "").slice(-BOOT_MODAL_TAIL_ROWS).join("\n")
  if (BOOT_APIKEY_HEADLINE.test(tail) && BOOT_APIKEY_QUESTION.test(tail)) {
    return { kind: "confirmation", title: "Confirm the API key in your environment" }
  }
  if (BOOT_TRUST_QUESTION.test(tail) && BOOT_TRUST_OPTION.test(tail)) {
    return { kind: "confirmation", title: "Trust this folder" }
  }
  return undefined
}

// One tracked live background sub-agent, keyed in TailState by its dispatch tool_use id (the
// correlation key present BOTH on the Agent tool_use block AND in the completion <task-notification>'s
// <tool-use-id>). Registered on the background dispatch, enriched with `outputFile` from the launch
// tool_result, and removed on a terminal completion notification.
interface SubAgentEntry {
  kind: "agent" | "shell" // an Agent sub-agent vs a background Bash/Monitor shell
  toolUseId: string
  label: string // the dispatch's input.description (shell: falls back to the command's first-line summary)
  startedAt: string // ISO8601 — the dispatch record's timestamp
  command?: string // shell only: raw launch command for the read-only output drawer
  subagentType?: string // the dispatch's input.subagent_type verbatim (agents only; may be absent)
  outputFile?: string // the child/shell's output path (from the launch tool_result); its mtime = liveness
  // Transcript SCHEMA of `outputFile` when it isn't Claude's own JSONL. A codex sub-agent's output file
  // is the CHILD's codex rollout, which the drill-in drawer must parse with the codex reader instead.
  outputFormat?: "codex"
  // The RUNTIME task id (Bash "…with ID: <id>", Monitor "(task <id>…)", Agent "agentId: <id>"), parsed
  // from the launch ack. This is the ONE identifier a `TaskStop` references (its `input.task_id`) and
  // it also rides every natural completion notification as `<task-id>` — so it is the correlation key
  // for a MANUAL stop, which carries no tool_use id at all. Absent until the launch ack is seen.
  //
  // On a BROKER row it is also backfilled from the SDK's own `task_started`, which pairs task id and
  // tool_use id directly — so a structured session gets this correlation key without depending on the
  // ack prose parsing above landing.
  taskId?: string
  // What the provider says this child is doing, folded from the SDK `task_*` stream (broker rows only).
  // Purely additive telemetry: absent for every tmux thread and every codex row.
  progress?: SubAgentProgress
}

// Provider-reported progress for one live op — the payload the protocol used to discard. Stored on the
// entry (rather than re-read per view) so it survives in the prime cache alongside the rest of the map.
interface SubAgentProgress {
  activity?: string // SDK last_tool_name — the tool the child is running right now
  activityDetail?: string // SDK task_progress.description — the current step, in words
  summary?: string // the provider's rolling summary of the child's work
  toolUses?: number
  totalTokens?: number
  durationMs?: number
}

// A live background shell as surfaced to the board (mirrors @frizz/shared BgShellView).
export interface BgShellView {
  label: string
  startedAt: string
  state: "running" | "stale"
  id?: string
  /**
   * The tailer's HALF of "can frizz end this shell": we hold a provider task handle for it. The board
   * ANDs it with the thread's transport before an × is offered — see the full contract on the shared
   * schema, which has carried this field since the stop landed. This twin did not, so the tree did
   * not typecheck (`tailer.test.ts` reads it) and no artifact could be built.
   */
  stoppable?: boolean
  lastActivityAt?: string // ISO8601 of the shell output file's last write
}

// A pending native AskUserQuestion (structured, capped). Mirrors @frizz/shared PendingAsk; `id` is
// the tool_use id used to clear it when its tool_result lands.
interface AskOptionData {
  label: string
  description?: string
}
interface AskQuestionData {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOptionData[]
}
export interface PendingAskData {
  id: string
  questions: AskQuestionData[]
}

// A COMPLETED sub-agent retained for post-hoc review (reviewing a finished child is the main reason to
// open its drawer). On its terminal notification a live SubAgentEntry moves into a bounded ring here —
// EXCLUDED from every live surface (banner / counts / spinner stay live-only), but still resolvable by
// the drill-in drawer via its retained outputFile. The ring caps memory; its file may later be cleaned
// from disk, in which case the drawer degrades to its "transcript unavailable" state.
interface RetiredSubAgent {
  toolUseId: string
  label: string
  subagentType?: string
  outputFile?: string
  outputFormat?: "codex" // see SubAgentEntry.outputFormat
  // ISO8601 of the DISPATCH, carried over from the live entry. A retired row is normally never rendered,
  // but one holding a live fan-out is (see the RESTED anchor in descendantSubtrees), and that row needs
  // the same honest "working for 12m" instant every other child row shows rather than a derived one.
  startedAt?: string
  finishedAt?: string // ISO8601 of the completion notification
  status: "completed" | "failed" | "killed"
  // The RUNTIME task id (Claude's `agentId`) this child ran under — see SubAgentEntry.taskId. Retained
  // because a terminal child is NOT necessarily a finished one: a `SendMessage` RESTARTS a stopped
  // child, and the restart ack names only this id. It is how `trackResumes` matches a revived child
  // back to the row it was retired from, so the board shows one row per child rather than a new one
  // (or, before that path existed, none at all) on every re-steer.
  taskId?: string
}
interface RetiredShell {
  toolUseId: string
  command?: string
  outputFile?: string
  status: "completed" | "failed" | "killed"
}
// How many terminal sub-agents to retain per thread for drawer review (newest-wins ring).
const RETAINED_SUBAGENTS_MAX = 20
const RETAINED_SHELLS_MAX = 20
// How many DESCENDANT terminal instants to hold (see TailState.descendantTerminals). Unlike the ring
// above these are 16 bytes apiece and are read, never rendered, so this is sized to the sidecar cap —
// one long orchestrator session in the local corpus accumulated 104 descendants across a day.
const DESCENDANT_TERMINALS_MAX = 512
// How many un-answered `SendMessage` summaries to hold (see TailState.pendingResumes). Each is
// consumed one record after it is recorded, so this only ever bounds the pathological case.
const PENDING_RESUMES_MAX = 32
// How many FOREGROUND `Bash` launches to hold pending their result (see TailState.pendingShells).
// Each is consumed by its own tool_result — usually the very next record — so this bounds nothing but
// the pathological case of a turn whose results never land.
const PENDING_SHELLS_MAX = 32
// How far behind the fold's high-water mark a restart ack may sit and still count as live. Covers
// ordinary out-of-order writes between sibling records; a REPLAYED ack (see trackResumes) carries its
// original timestamp and is stale by minutes to days, so nothing near this boundary is ambiguous.
const RESUME_REPLAY_SLACK_MS = 60_000

// Mutable accumulator for one session's tail. Extends the backend-neutral FoldState (the running
// derivation `applyRecord`/`applyEvent` fold into — turn, lastActivityAt, lastAssistant, aiTitle,
// lastUserAt, lastFence, lastAssistantHasQuestion, sawRecords); adds the tailer's own byte cursor
// (`offset`/`partial`) plus Claude-only tracking the neutral shape doesn't carry.
export interface TailState extends FoldState {
  slug: string
  sessionId: string
  nativeSessionId: string
  runtimeGeneration: number
  path: string
  // The delivery_ledger JSON this tailer last accounted for (pushed a projection for). A ROUTER write
  // (followUp opening a ledger entry) changes the row without any JSONL advance; this drift check is
  // what re-projects the transcript to already-subscribed clients within one tick.
  deliveryLedgerSeen?: string | null
  // A FOREIGN thread (a maintainer terminal discovered from the log dir, no registry row). Structural
  // guarantee that this state can NEVER shell out to tmux — no pane-sniff, no pane-death, no notify /
  // storage write — since no `frizz-<slug>` tmux session exists for it. Keyed by session id, not slug.
  foreign: boolean
  offset: number
  partial: string
  // Claude's turn model: the kind of the last substantive record + (for assistant) its stop_reason.
  // NOT in the neutral FoldState — codex brackets turns explicitly (applyEvent sets `turn` directly);
  // only Claude's computeTurn reads these two (+ the 5s unknown-stop-reason backstop).
  lastKind?: "assistant" | "user"
  lastStopReason?: string
  // ---- provider event stream vs its own disk write (broker Claude rows only) ----
  // `runtimeEventsSeen` is the provider event count this session's fold has already caught up with;
  // `runtimeChase` counts consecutive nudge-driven ticks spent waiting for it to. Both live here
  // rather than in the neutral FoldState because they describe the tailer's READ scheduling, not the
  // derivation. See chaseRuntime for why they exist at all.
  runtimeEventsSeen?: number
  runtimeChase?: number
  // live background OPS (sub-agents AND background shells), keyed by dispatch/launch tool_use id
  // (insertion order = launch order); the `kind` field distinguishes them at the view boundary.
  subAgents: Map<string, SubAgentEntry>
  // completed sub-agents retained for drawer review (bounded ring; NOT surfaced live) — see above
  retiredSubAgents: Map<string, RetiredSubAgent>
  // Completion reports the runtime QUEUED but has not (yet) put into the model's context, keyed by
  // task-id. Filled from a `queue-operation` carrier, cleared by a model-facing one. A survivor is a
  // report the agent provably never read — see report-delivery.ts for the corpus this comes from.
  queuedReports: Map<string, QueuedReport>
  // Task-ids proven to have reached the model. Separate from the map above because the two carriers
  // are NOT written in a fixed order: the queue-operation bookkeeping is FLUSHED and can land at a file
  // position AFTER the inline attachment that delivered it (the same reordering that made carrier (c)
  // load-bearing for background shells, tailer 2026-07-22). Without this set that late queue-op would
  // re-park an already-delivered report and frizz would "repair" a report the agent had read.
  deliveredReports: Set<string>
  // CODEX rows only: the sub-agent tracker that fills the two maps above from `spawn_agent` /
  // sub_agent_activity / list_agents plus each child rollout's own turn brackets (codex-subagents.ts).
  // Claude fills them from `trackDispatches` instead, so this stays undefined there.
  codexSubAgents?: CodexSubAgentTracker
  // completed shells retained so an already-open output drawer can render the terminal tail.
  retiredShells: Map<string, RetiredShell>
  // Dispatch tool_use ids the operator has RETIRED with the × — read from the registry at prime and
  // added to on every dismiss. The fold consults it before it may mint a live op, which is the ONLY
  // thing that keeps a killed shell dead: the kill leaves no record in the transcript and none on
  // disk, so a re-primed fold would otherwise re-create the row off its dispatch record and keep it
  // "running" forever (the maintainer's real 57-hour phantom, reproduced by one cold fold of their
  // transcript). Empty for a session that has never had an × clicked, which is nearly all of them.
  dismissedOps: Set<string>
  // Ops the fold has just seen RESTART under a dismissed id (trackResumes), queued for the tick to
  // clear from the registry. Absent until one happens, which is nearly always.
  unretiredOps?: Set<string>
  // DESCENDANT agent id → the instant its last TERMINAL <task-notification> was folded, in epoch ms.
  // A descendant (a sub-agent's own sub-agent) is never in `subAgents`, so the notification that
  // retires it correlates to no live entry — but it IS in this thread's transcript, and it is the only
  // prompt rest signal the branch has. See recordDescendantTerminal. Bounded; keyed by task-id, which
  // IS the agent id, so it joins straight onto a sidecar. Absent until the first one lands.
  descendantTerminals?: Map<string, number>
  // SendMessage tool_use id → the `summary` that call carried, held only until its tool_result lands
  // (the very next record). A RESTART ack names the child's runtime id and its output path but nothing
  // about the work, so this is the label of last resort when `trackResumes` has to mint a row for a
  // child whose retired record has already aged out of the ring. Bounded; consumed on use.
  pendingResumes?: Map<string, string>
  // FOREGROUND `Bash` tool_use id → the label/command that call carried, held only until its
  // tool_result lands. A foreground shell is normally none of the board's business (the spinner covers
  // it), but Claude Code AUTO-BACKGROUNDS one that outlives its `timeout` — and it announces that in the
  // RESULT, which carries no command text. Without this the promoted row would have nothing to be
  // labelled with. Bounded; consumed on use. See AUTO_BACKGROUND_ACK_RE.
  pendingShells?: Map<string, { label: string; command?: string; startedAt: string }>
  // MONOTONIC high-water mark over every timestamped record folded so far. `lastActivityAt` cannot
  // serve this purpose: it tracks the LATEST record folded and therefore moves BACKWARD whenever a
  // transcript replays history (which Claude's do — see trackResumes). This only ever advances, and it
  // is what lets a live restart be told apart from a replayed one.
  maxRecordAt?: string
  // a pending native AskUserQuestion the session is frozen on (no tool_result yet), else undefined
  pendingAsk?: PendingAskData
  subAgentsSig?: string // last-emitted signature of the derived background-ops + ask view (dirty-change detection)
  // transition tracking (dedupe)
  primed: boolean // first tick restores state WITHOUT firing transition notifies (boot/restart)
  permPrompt: boolean // last pane-sniff verdict (see matchesPermPrompt)
  nativeInputRequired?: NativeInputRequiredData // last structured native-modal verdict
  permPolicy?: PermPolicyView // last allow/deny from the worker's permission policy (display only)
  permDenies?: number // how many policy DENIALS this thread has accumulated
  paneDead: boolean
  // ---- read-side transcript discovery (registered rows only; foreign states never touch these) ----
  // The pinned `<session_id>.jsonl` never appeared and discovery found no drifted transcript: a boot
  // failure. Surfaces a degraded runtime rather than an eternal spinner. Cleared if a transcript binds.
  noTranscript: boolean
  // Throttle: next epoch-ms at which discovery may re-run for an unresolved (missing-transcript) row.
  nextDiscoverMs: number
  // One-shot guard so a stall's pane is captured/logged once, not every tick.
  stallLogged: boolean
  customTitle?: string
  customTitleRevision: number
  // Claude permission sidecars are untimestamped. Hold an incremental observation until the live
  // footer redraw proves which generation emitted it; do not lose a genuine record that arrived a
  // tick before the footer became visible.
}

// A single parsed JSONL record — only the fields the derivation needs are typed; the rest are
// ignored. `unknown`-shaped so a schema surprise degrades rather than throws.
interface Record {
  type?: string
  timestamp?: string
  isMeta?: boolean // `/rename <title>` reminder record: CLI metadata, not a user/model turn
  isCompactSummary?: boolean // the carry-over summary claude writes as a user record after compacting
  aiTitle?: string // present only on ai-title sidecar records
  customTitle?: string // present only on custom-title records (written by /rename)
  permissionMode?: unknown // present only on Claude permission-mode sidecars
  content?: unknown // top-level string on queue-operation records — carries the <task-notification> XML
  // On `attachment` records (type:"queued_command"): the injected text — a queued human follow-up OR a
  // background op's <task-notification>. This is the notification's INLINE-written carrier, positioned
  // AFTER its launch — unlike the queue-operation bookkeeping, which is flushed and can land BEFORE it.
  attachment?: { type?: string; prompt?: unknown }
  promptSource?: string // on user records: typed/queued (human) · "system" (peer msg / task-notification)
  isApiErrorMessage?: boolean // synthetic assistant record claude writes for a provider API error
  // Structured category claude stamps on that synthetic record: "rate_limit" (subscription window
  // exhausted) · "server_error" (connectivity/5xx) · "unknown" (everything else). This is what makes
  // limit detection structural rather than a text guess — see backend/usage-limit.ts.
  error?: unknown
  apiErrorStatus?: unknown // HTTP status alongside `error` (429 on a limit stop); absent on some errors
  // A SIDECHAIN record belongs to a sub-agent running inside this session, not to the main thread.
  // Modern claude writes children to their own transcripts, so this is currently always absent — it is
  // read only by the context reading, which would otherwise report a child's context as the parent's
  // the moment a build starts inlining them again.
  isSidechain?: boolean
  // `usage` is the API's own accounting for the request this record answered: input + cache-creation +
  // cache-read is exactly what the model's context held. See applyRecord's context reading.
  // NOTE: `Record` here is this module's own transcript-record interface, which SHADOWS the global
  // `Record<K,V>` utility type — so the usage bag is written as an index signature, not Record<…>.
  message?: { stop_reason?: string; content?: unknown; model?: string; usage?: { [key: string]: unknown } }
}

// Narrow text conjunction for a Claude AUTH error (vs other API errors riding the same synthetic
// record — overloaded, rate-limit, 5xx). The canonical observed line is
// "Please run /login · API Error: 401 Invalid authentication credentials".
export function isClaudeAuthErrorText(text: string): boolean {
  if (/Please run \/login/i.test(text)) return true
  return /\b401\b/.test(text) && /authenticat|credential|OAuth/i.test(text)
}

// A fresh, unread tail cursor for a session (exported for tick + tests).
export function newTailState(
  slug: string,
  sessionId: string,
  path: string,
  foreign = false,
  nativeSessionId = sessionId,
  runtimeGeneration = 0,
): TailState {
  return {
    slug,
    sessionId,
    nativeSessionId,
    runtimeGeneration,
    path,
    foreign,
    offset: 0,
    partial: "",
    sawRecords: false,
    lastAssistantHasQuestion: false,
    lastAssistantAllDone: false,
    subAgents: new Map(),
    retiredSubAgents: new Map(),
    queuedReports: new Map(),
    deliveredReports: new Set(),
    retiredShells: new Map(),
    dismissedOps: new Set(),
    primed: false,
    turn: "in-flight",
    permPrompt: false,
    nativeInputRequired: undefined,
    paneDead: false,
    noTranscript: false,
    nextDiscoverMs: 0,
    stallLogged: false,
    customTitleRevision: 0,
  }
}

// Defensive JSON parse: a malformed line yields null (skipped), never an exception.
export function parseLine(line: string): Record | null {
  const s = line.trim()
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === "object" ? (v as Record) : null
  } catch {
    return null
  }
}

// The RAW last text block of an assistant message (newlines intact). Handles the streaming split (one
// block per record) and a defensive multi-block array alike. Kept raw because the question-fence
// detection below needs the line structure the preview collapses away.
function lastTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let text: string | undefined
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text
      if (typeof t === "string") text = t
    }
  }
  return text
}

// The board preview of an assistant text block: whitespace collapsed to single spaces, trimmed, capped
// at ~200 chars. Empty/whitespace-only → undefined (leaves the prior preview in place).
function previewText(raw: string): string | undefined {
  const norm = raw.replace(/\s+/g, " ").trim()
  if (!norm) return undefined
  return norm.length > 200 ? `${norm.slice(0, 200)}…` : norm
}

// Minimal server-side MIRROR of the web's ```question fence convention (web/src/lib/questionBlocks.ts
// QUESTION_BLOCK) — a presence check only, not a full parse: an opening ```question line (optional
// kind info-string like `multi`), its body, then a closing ``` line. Kept in sync BY HAND (the
// architecture forbids importing web code into the server). Drives the derived pending-question safety
// net: a worker that asked the human IN CHAT but never flipped its thread file to blocked.
// Info-string grammar mirrors the web exactly: one or more space-separated tokens (```question
// multi danger) — the old single-token form silently missed multi-token gates the prompt teaches.
// It matches on SHAPE, never on the token set, so a retired token (`approval`) or a future one still
// registers as an ask here exactly as it still renders as a card in the web.
// A QUOTED opener never counts: a worker documenting the protocol wraps its sample in an outer ````
// fence, and flagging that as a live ask parks the thread in "awaiting you" over an example. The
// fenced-interior scan is the one piece genuinely SHARED with the web (@frizz/shared) rather than
// mirrored — the renderer and this flag must agree on what an opener is. `parseSignalFence` needs no
// such guard: its end-anchor already rejects any fence that isn't the final content of the message.
const QUESTION_BLOCK_RE = /^```question(?:[ \t]+[A-Za-z][^\r\n]*?)?[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*$/gm
export function hasQuestionBlock(text: string | undefined): boolean {
  if (typeof text !== "string") return false
  const quoted = insideFence(text)
  QUESTION_BLOCK_RE.lastIndex = 0
  for (let m = QUESTION_BLOCK_RE.exec(text); m !== null; m = QUESTION_BLOCK_RE.exec(text)) {
    if (!quoted(m.index)) return true
    QUESTION_BLOCK_RE.lastIndex = m.index + 1
  }
  return false
}

// ---- signal-fence grammar (maintainer-settled) ----
// Exactly two EXCUSAL fences: ```done and ```awaiting. The fence LANGUAGE is the state; the BODY is
// the message. The opening line is the bare language word (trailing spaces/tabs tolerated, nothing
// else after it); the body runs to a closing ``` line. If a text carries several signal fences the
// LAST wins — and the last fence must be the FINAL NON-WHITESPACE CONTENT of the text (the prompt's
// "at the very end" rule): a fence merely QUOTED mid-message (a worker explaining the protocol to the
// human) must never excuse the thread from the queue. Malformed/unclosed fences never match.
// CRLF-tolerant (normalized before matching).
// ONE implementation so the grammar lives in a single place (mirrors QUESTION_BLOCK_RE's spirit). The
// ```question fence keeps its own separate machinery (hasQuestionBlock) — it is NOT a signal fence.
const SIGNAL_FENCE_RE = /^```(done|awaiting)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm
// An awaiting-body hint line: `<kind>: <value>`. Kind is case-insensitive (lowercased on output); the
// value must start with a non-space char (a bare `pr:` with nothing after is prose, not a hint).
const AWAITING_HINT_RE = /^(pr-watch|human|timer|pr|ci|session):\s*(\S.*)$/i
const FENCE_BODY_MAX = 500 // defensive: never let a worker's fence body fatten the snapshot
const HINT_MAX = 8 // defensive cap on parsed hint lines
const HINT_VALUE_MAX = 200 // defensive cap on a single hint value

function capFenceBody(s: string): string {
  return s.length > FENCE_BODY_MAX ? `${s.slice(0, FENCE_BODY_MAX)}…` : s
}

// Parse the done/awaiting signal fence out of an assistant text, or undefined if none. Pure and
// defensive (never throws) so it is unit-testable and degrades on any surprise. For `awaiting`,
// `<kind>: <value>` lines become `hints` in file order and the remaining lines are the prose `body`;
// for `done`, the whole body is the message and hints are empty.
export function parseSignalFence(text: string | undefined): FenceView | undefined {
  if (typeof text !== "string") return undefined
  const norm = text.replace(/\r\n/g, "\n")
  SIGNAL_FENCE_RE.lastIndex = 0
  let kind: "done" | "awaiting" | undefined
  let raw = ""
  let end = 0
  let m: RegExpExecArray | null
  while ((m = SIGNAL_FENCE_RE.exec(norm)) !== null) {
    kind = m[1] as "done" | "awaiting" // last-fence-wins: keep overwriting
    raw = m[2]
    end = m.index + m[0].length
  }
  if (!kind) return undefined
  // End-anchor: the fence only signals when it closes the message (trailing whitespace tolerated).
  // Prose after the last fence means it was quoted/explanatory, not a signal — no excusal.
  if (norm.slice(end).trim() !== "") return undefined
  if (kind === "done") return { kind, body: capFenceBody(raw.trim()), hints: [] }
  // awaiting: peel `<kind>: <value>` hint lines out; the remaining lines are the prose body.
  const hints: FenceView["hints"] = []
  const rest: string[] = []
  for (const line of raw.split("\n")) {
    const hm = line.match(AWAITING_HINT_RE)
    const k = hm?.[1].toLowerCase()
    // Only real hint kinds become hints; any other `word:` line is prose (a stray colon-line
    // like "note: …" must not mint a phantom hint that then glosses as leaked internals). 2026-07-10.
    if (hm && (k === "pr-watch" || k === "human" || k === "timer" || k === "pr" || k === "ci" || k === "session")) {
      const value = hm[2].trim()
      hints.push({ kind: k, value: value.length > HINT_VALUE_MAX ? value.slice(0, HINT_VALUE_MAX) : value })
    } else {
      rest.push(line)
    }
  }
  return { kind, body: capFenceBody(rest.join("\n").trim()), hints: hints.slice(0, HINT_MAX) }
}

// A user record is a REAL user interaction (a typed prompt / answer / steer / dispatch) rather than a
// mere tool_result fed back to the model mid-turn. The distinction matters for the chronological
// listing order: only the user's OWN messages should bump a row, never the agent's tool activity.
// Shape: a real prompt's `content` is a STRING (or an array carrying at least one non-tool_result
// block — text/image); a tool exchange's `content` is an array of ONLY tool_result blocks.
export function isRealUserMessage(content: unknown): boolean {
  if (typeof content === "string") return true
  if (!Array.isArray(content)) return false
  return content.some((b) => !(b && typeof b === "object" && (b as { type?: string }).type === "tool_result"))
}

// Flatten a tool_result's `content` (an array of {type:"text", text} blocks, or a bare string) into
// one string so we can regex the launch metadata out of it. Defensive: anything unexpected → "".
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: unknown }).text
      if (typeof t === "string") out += t
    }
  }
  return out
}

// One-line summary of a shell command: first non-blank line, whitespace-collapsed, capped. The label
// for a background shell when the model gave no `description`.
function shellSummary(command: unknown): string {
  if (typeof command !== "string") return "background shell"
  const first = (command.split("\n").find((l) => l.trim()) ?? "").trim().replace(/\s+/g, " ")
  if (!first) return "background shell"
  return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

// Register each BACKGROUND OP in an assistant message as a tracked live entry, keyed by tool_use id:
//   • an `Agent` dispatch (unless run_in_background:false — a foreground/blocking child the spinner
//     already covers; Agent defaults to background) → kind "agent" (drill-in + [type] tag).
//   • a `Bash` with run_in_background:true (a persist-across-rest shell — a CI watcher, a long build)
//     → kind "shell" (display-only).
//   • a `Monitor` (always background in Claude Code; finite or session-persistent) → kind "shell" too.
//     Tracking it keeps an off-turn worker in Active while the monitor owns an automatable wait.
// Re-seeing the same id preserves any outputFile already resolved from its launch result.
// A `SendMessage` registers NOTHING here — it addresses a child that already exists — but its recap is
// parked for `trackResumes`, the one path where such a call restarts a stopped child.
function trackDispatches(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; name?: string; id?: unknown; input?: unknown }
    if (b.type !== "tool_use") continue
    const id = typeof b.id === "string" ? b.id : undefined
    if (!id) continue
    // The operator RETIRED this op. Its dispatch record is still here and always will be — a killed
    // shell never gets a terminal record — so without this line every re-prime mints the row afresh
    // and it reads "running" forever. See FoldState.dismissedOps.
    if (state.dismissedOps.has(id)) continue
    const input = (b.input ?? {}) as { description?: unknown; run_in_background?: unknown; subagent_type?: unknown; command?: unknown; summary?: unknown }
    const startedAt = typeof rec.timestamp === "string" ? rec.timestamp : (state.lastActivityAt ?? "")
    const previous = state.subAgents.get(id)
    const outputFile = previous?.outputFile
    const desc = typeof input.description === "string" && input.description.trim() ? input.description.trim() : undefined
    if (b.name === "Agent") {
      if (input.run_in_background === false) continue // foreground (blocking) — visible via the spinner
      // The worker-profile cell (model+effort), shown verbatim as a "[type]" tag — no stripping.
      const subagentType = typeof input.subagent_type === "string" && input.subagent_type.trim() ? input.subagent_type.trim() : undefined
      state.subAgents.set(id, { kind: "agent", toolUseId: id, label: desc ?? "sub-agent", startedAt, subagentType, outputFile })
    } else if ((b.name === "Bash" && input.run_in_background === true) || b.name === "Monitor") {
      const command = typeof input.command === "string" ? input.command : previous?.command
      state.subAgents.set(id, { kind: "shell", toolUseId: id, label: desc ?? shellSummary(input.command), startedAt, command, outputFile, taskId: previous?.taskId })
    } else if (b.name === "Bash") {
      // A FOREGROUND Bash — not a background op, and normally none of this map's business. But Claude
      // Code auto-backgrounds one that outlives its `timeout`, and only the RESULT says so, so park the
      // label/command here for trackLaunchResults to promote from. Dropped by the same result when the
      // command simply finished, which is the overwhelmingly common case.
      const pending = (state.pendingShells ??= new Map())
      pending.set(id, { label: desc ?? shellSummary(input.command), command: typeof input.command === "string" ? input.command : undefined, startedAt })
      while (pending.size > PENDING_SHELLS_MAX) {
        const oldest = pending.keys().next().value
        if (oldest === undefined) break
        pending.delete(oldest)
      }
    } else if (b.name === "SendMessage") {
      // NOT a dispatch — a message to an already-dispatched child, which registers nothing here. But it
      // may RESTART a child that has already stopped (see trackResumes), and only this record carries a
      // human-readable recap of the work. Park it for the tool_result one record later; if that result
      // turns out to be an ordinary "queued for delivery" it is simply dropped.
      const summary = typeof input.summary === "string" ? input.summary.trim() : ""
      if (summary) {
        const pending = (state.pendingResumes ??= new Map())
        pending.set(id, summary.length > 160 ? `${summary.slice(0, 159)}…` : summary)
        while (pending.size > PENDING_RESUMES_MAX) {
          const oldest = pending.keys().next().value
          if (oldest === undefined) break
          pending.delete(oldest)
        }
      }
    }
  }
}

// Corpus-verified LAUNCH-ACK shapes (2026-07-09; surveyed across the real transcripts in
// ~/.claude/projects — three Agent ack wordings + the Bash/Monitor shell acks coexist in the wild):
//   • "Async agent launched successfully…"  — older Agent ack; MAY carry "output_file: <path>"
//   • "Spawned successfully…"               — newer mailbox/teammate ack; carries "agentId: <id>", NO path
//   • "Command running in background…"      — Bash shell ack; carries "Output is being written to: <path>"
//   • "Monitor started…"                    — Monitor ack; task id but no output path
// A tracked id's tool_result matching one of these means the child is now RUNNING DETACHED — keep
// tracking. Anything else on a tracked AGENT id is the synchronous (foreground) call's final report —
// its completion (an error/denial result also means the dispatch is over). The earlier discriminator
// ("no output_file: token ⇒ foreground") retired live background children of the two path-less ack
// shapes — including every mailbox-style Agent and every background shell — on their own launch ack.
const LAUNCH_ACK_RE = /^\s*(Async agent launched successfully|Spawned successfully|Command running in background|Monitor started|Command did not complete within its)/

// The FIFTH launch shape, and the only one that arrives for a call nothing registered: Claude Code
// AUTO-BACKGROUNDS a foreground `Bash` that outlives its `timeout` and says so in the result —
//   "Command did not complete within its 590s timeout and was moved to the background (ID: bhlfxzwg1).
//    Output is being written to: …/tasks/bhlfxzwg1.output. You will be notified when it completes."
// From that instant it is an ordinary detached shell: it outlives the turn, it keeps the worker's own
// work live across a rest, and it terminates with the same <task-notification> (carrying the ORIGINAL
// tool_use id, so retirement correlates normally). frizz used to see none of it — `trackDispatches`
// only registers `run_in_background: true` — so such a shell was invisible on every surface, could not
// hold its thread Active, and its completion correlated to nothing. 881 of these acks sit in the local
// transcript corpus; one thread hit it three times in an hour (2026-07-30, reported as "a background
// bash script completed, but it did not resume the agent"). Promoted in trackLaunchResults.
const AUTO_BACKGROUND_ACK_RE = /^\s*Command did not complete within its .{0,40}?and was moved to the background/

// Move a tracked AGENT entry into the bounded retained ring (drawer review), evicting the oldest.
// Shared by the foreground-completion path and the <task-notification> path.
function retireToRing(state: TailState, entry: SubAgentEntry, finishedAt: string | undefined, status: "completed" | "failed" | "killed"): void {
  state.retiredSubAgents.delete(entry.toolUseId)
  state.retiredSubAgents.set(entry.toolUseId, {
    toolUseId: entry.toolUseId,
    label: entry.label,
    subagentType: entry.subagentType,
    outputFile: entry.outputFile,
    outputFormat: entry.outputFormat,
    taskId: entry.taskId,
    startedAt: entry.startedAt,
    finishedAt,
    status,
  })
  while (state.retiredSubAgents.size > RETAINED_SUBAGENTS_MAX) {
    const oldest = state.retiredSubAgents.keys().next().value
    if (oldest === undefined) break
    state.retiredSubAgents.delete(oldest)
  }
}

// Remember that a DESCENDANT reported a terminal status. This is the rest signal the descendant rows
// used to have no access to, and it was hiding in plain sight: when a sub-agent's own sub-agent stops,
// the <task-notification> is enqueued on the ROOT session — the transcript this fold already reads —
// carrying `<task-id>` (the agent id, which is the sidecar's own filename key) and `<tool-use-id>`.
// The notification correlates to no LIVE entry, because a descendant is derived from sidecars and was
// never tracked in `subAgents`, so trackCompletions used to drop it on the floor and descendant
// liveness fell back entirely to SUBAGENT_STALE_MS — 15 minutes of a rested grandchild reading
// "running", its duration counting up from spawn the whole time. Measured on the live board
// (nub session 0bb9560b, 2026-07-30): 36 of 38 depth-2 descendants had a terminal notification sitting
// in the root transcript, each landing 0-13s AFTER the descendant's own last write; the 2 without one
// were the 2 genuinely still running. Reported by the maintainer as "when I click into the
// sub-sub-agents, a lot of them have rested or stopped, even though they're still showing up as
// running actively".
function recordDescendantTerminal(state: TailState, agentId: string, at: number): void {
  const seen = state.descendantTerminals ?? new Map<string, number>()
  state.descendantTerminals = seen
  // Newest-wins, and re-inserted so eviction order stays insertion order. A task-id CAN notify more
  // than once (the notification says so itself — a resumed agent re-notifies), and the LAST one is the
  // reading that matters: see descendantState, which measures the transcript against this instant.
  seen.delete(agentId)
  seen.set(agentId, at)
  while (seen.size > DESCENDANT_TERMINALS_MAX) {
    const oldest = seen.keys().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

// Retire a live entry however it was CORRELATED (by tool_use id from a notification, or by runtime
// task id from a manual stop) — the map key is always its tool_use id. Both kinds retain the bounded
// metadata their read-only drawers need. The single exit for every terminal signal.
function retireLive(state: TailState, entry: SubAgentEntry, finishedAt: string | undefined, status: "completed" | "failed" | "killed"): void {
  state.subAgents.delete(entry.toolUseId)
  if (entry.kind === "shell") {
    state.retiredShells.delete(entry.toolUseId)
    state.retiredShells.set(entry.toolUseId, { toolUseId: entry.toolUseId, command: entry.command, outputFile: entry.outputFile, status })
    while (state.retiredShells.size > RETAINED_SHELLS_MAX) {
      const oldest = state.retiredShells.keys().next().value
      if (oldest === undefined) break
      state.retiredShells.delete(oldest)
    }
    return
  }
  retireToRing(state, entry, finishedAt, status)
}

// Find a live tracked op by its RUNTIME task id — the correlation key a manual `TaskStop` carries (it
// has no tool_use id). Maps hold a handful of live ops, so a scan beats a second index that every
// removal path would have to keep in sync (index desync is the exact bug class this change closes).
function findLiveByTaskId(state: TailState, taskId: string): SubAgentEntry | undefined {
  for (const e of state.subAgents.values()) if (e.taskId === taskId) return e
  return undefined
}

// Resolve a tracked child's transcript path from its launch ack, best shape first: an explicit
// "output_file:" (older Agent ack), the shell ack's "Output is being written to:", else DERIVED from
// the mailbox ack's agentId — subagent transcripts live at <session-dir>/subagents/agent-<id>.jsonl
// beside the parent's own jsonl (verified on disk 2026-07-09). Undefined when nothing resolves (the
// entry then simply never goes stale — its completion notification still clears it).
function launchOutputFile(state: TailState, text: string): string | undefined {
  const m = text.match(/output_file:\s*(\S+)/) ?? text.match(/Output is being written to:\s*(\S+)/)
  // The shell ack embeds the path mid-sentence ("… written to: <path>. You will be notified …") —
  // strip the sentence period or the staleness stat hits a nonexistent path and flags every shell stale.
  if (m) return m[1].replace(/\.$/, "")
  const aid = text.match(/agentId:\s*(\S+)/)?.[1]
  if (aid) return `${state.path.replace(/\.jsonl$/, "")}/subagents/agent-${aid}.jsonl`
  return undefined
}

// The RUNTIME task id from a launch ack — the key a later `TaskStop` (and every natural completion
// notification) references. One per corpus-verified ack shape: the Bash background ack, the Monitor
// ack, and the mailbox Agent ack (whose agentId doubles as its TaskStop handle). Undefined for the
// path-only older Agent ack, which has no manual-stop handle and clears on its notification anyway.
// The app-server reports a model-run command as the ARGV it actually spawned —
// `/bin/zsh -lc 'sleep 900'` — while codex's own `backgroundTerminals/list`, the rollout, and therefore
// frizz's transcript-projected row all say `sleep 900`. Two things ride on stripping the wrapper: the
// operator reads the command they asked for rather than the launcher's plumbing, and the board row and
// the transcript row become reconcilable at all (lib/childOps.ts mergeBackgroundShells keys on it —
// without this they render as two rows for one process).
//
// Deliberately narrow: only the exact `<shell> -lc '<cmd>'` / `-c "<cmd>"` shape, only when the quoting
// spans the whole remainder. Anything else is returned untouched — a half-parsed command line is worse
// than a verbose one.
export function unwrapShellCommand(command: string | undefined): string | undefined {
  if (!command) return command
  const match = command.match(/^\S*(?:sh|bash|zsh|fish|dash|ksh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/)
  return match ? match[2] : command
}

function launchTaskId(text: string): string | undefined {
  return (
    text.match(/Command running in background with ID:\s*(\S+)/)?.[1]?.replace(/\.$/, "") ??
    text.match(/was moved to the background \(ID:\s*([^)\s]+)\)/)?.[1] ??
    text.match(/Monitor started \(task\s+(\w+)/)?.[1] ??
    text.match(/agentId:\s*(\S+)/)?.[1]
  )
}

// ---- DESCENDANTS: a sub-agent's sub-agent, and so on down --------------------------------------
//
// A grandchild's DISPATCH is not in this thread's transcript — it is in the CHILD's, because the child
// is the one that ran the Agent tool. So neither `subAgents` nor `retiredSubAgents` can ever hold it,
// and the drill-in drawer's lookup used to bottom out at depth 1 (the drawer then states "unavailable",
// which is honest but is also all it could say).
//
// The provider does record it, twice over. Measured on a real three-level broker session
// (`_live_broker_depth.mts`, 2026-07-28 — read that harness's output before changing anything here):
//
//  1. ON THE STREAM. Everything is ONE session: the grandchild's dispatch arrives as an assistant event
//     whose `parentToolUseId` is the CHILD's dispatch id, and the grandchild gets its own task_started /
//     task_progress / task_notification carrying its own taskId + toolUseId. 33 of 50 assistant+user
//     events in that run carried a parentToolUseId, so the link is populated in practice, not in theory.
//  2. ON DISK, which is what this code uses. Beside every child transcript claude writes a SIDECAR,
//     `<session-dir>/subagents/agent-<agentId>.meta.json`, verbatim from that run:
//       {"agentType":"general-purpose","description":"LEVEL-ONE","toolUseId":"toolu_01Tszn…","spawnDepth":1}
//       {"agentType":"general-purpose","description":"LEVEL-TWO","toolUseId":"toolu_01E6L4…",
//        "parentAgentId":"a40cc1902e8ccba6d","spawnDepth":2}
//
// The disk route is the one to build on because the directory is FLAT: a child, a grandchild and a
// great-grandchild all write into the SAME `subagents/` dir of the ROOT session. So "resolve a
// descendant at any depth" is ONE capped directory read keyed by the very dispatch tool_use id the
// drawer is already holding — there is no tree to walk, hence no recursion to bound and no malformed
// parent link that could loop. `parentAgentId` and `spawnDepth` come along for free and are recorded
// here rather than derived, so nothing downstream has to guess at either.
interface DescendantSidecar {
  agentId: string // from the FILENAME, so it exists even for a sidecar whose body is junk
  toolUseId?: string // the dispatch id — the key the drawer resolves against
  description?: string
  agentType?: string
  parentAgentId?: string // absent at depth 1 (a direct child of the session)
  spawnDepth?: number // 1 for a direct child, 2 for a grandchild, …
  // The sidecar file's own mtime. It is written ONCE at spawn and never rewritten (the same property
  // the index's invalidation relies on), so this IS the dispatch instant — a real reading off disk, not
  // a fabricated one. It gives a surfaced descendant row the same "working for 38s" duration a direct
  // child gets from its dispatch record. Undefined when the file no longer stats.
  spawnedAtMs?: number
}

// How many sidecars one resolution pass will read. A bound, not an opinion: a long orchestrator
// session can accumulate hundreds of descendants and this runs behind a polling drawer.
const DESCENDANT_SIDECAR_MAX = 512

// How far a descendant's transcript may advance PAST its own terminal notification while still reading
// as finished. Two different clocks are being compared — a record's ISO timestamp against a file's
// mtime — and the notification is written a beat AFTER the work it reports, so a bare `mtime > notified`
// would call a settled descendant "resumed" on sub-second skew. Sized off the real distribution (nub
// session 0bb9560b): of 36 notified depth-2 descendants, 34 last wrote 2-609s BEFORE their
// notification, 2 landed inside the same second, and the ONE genuinely resumed descendant wrote again
// 172s after — so anything from ~1s to ~170s separates the two populations. 5s sits in that gap with
// room on both sides, and a resume that IS missed self-heals on the descendant's next write.
const DESCENDANT_NOTIFY_GRACE_MS = 5_000

// Read a session's descendant sidecars. DEGRADES at every level and never throws — a missing dir, an
// unreadable file, half-written JSON, a body that is not an object are each skipped, because this runs
// on the drawer's read path and a throw there is a dead drawer (and, historically in this subsystem, a
// dead thread). A sidecar frizz cannot parse simply does not resolve, which is the state it was in
// before this existed.
function readDescendantSidecars(sessionDir: string, mtimeMs: (path: string) => number | undefined): DescendantSidecar[] {
  let names: string[]
  try {
    names = readdirSync(join(sessionDir, "subagents"))
  } catch {
    return []
  }
  const out: DescendantSidecar[] = []
  for (const name of names) {
    if (out.length >= DESCENDANT_SIDECAR_MAX) break
    const agentId = /^agent-(.+)\.meta\.json$/.exec(name)?.[1]
    if (!agentId) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(sessionDir, "subagents", name), "utf8"))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const meta = parsed as { toolUseId?: unknown; description?: unknown; agentType?: unknown; parentAgentId?: unknown; spawnDepth?: unknown }
    const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined)
    out.push({
      agentId,
      toolUseId: text(meta.toolUseId),
      description: text(meta.description),
      agentType: text(meta.agentType),
      parentAgentId: text(meta.parentAgentId),
      spawnDepth: typeof meta.spawnDepth === "number" && Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : undefined,
      spawnedAtMs: mtimeMs(join(sessionDir, "subagents", name)),
    })
  }
  return out
}

// Process tool_results for tracked background ops: enrich a launch ack with the child's transcript
// path (staleness clock) and keep tracking; retire a tracked AGENT whose tool_result is NOT a launch
// ack (a synchronous call's final report / an error — no task-notification ever fires for those;
// missing this leaked 26 phantom "running" sub-agents on a busy session, found 2026-07-09). A tracked
// SHELL follows the same launch discriminator: a recognized background/Monitor ack stays live; any
// synchronous error/non-ack result means no detached operation exists and is removed immediately.
// Once launched, its terminal signal remains the <task-notification>.
//
// This is ALSO where a foreground `Bash` becomes a background one: its result — not its call — is what
// announces the auto-background handoff, so an id nothing registered can still promote here out of
// `pendingShells`. See AUTO_BACKGROUND_ACK_RE.
function trackLaunchResults(state: TailState, rec: Record): void {
  if (state.subAgents.size === 0 && !state.pendingShells?.size) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
    if (b.type !== "tool_result") continue
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
    if (!id) continue
    const text = toolResultText(b.content)
    let entry = state.subAgents.get(id)
    if (!entry) {
      // A parked FOREGROUND shell's result. Either it was auto-backgrounded — promote it to a live
      // tracked shell, from this instant indistinguishable from one launched with run_in_background —
      // or it simply finished, and the park is over either way. `is_error` guards the (unobserved but
      // cheap to exclude) case of the harness reporting the handoff as a failure.
      const parked = state.pendingShells?.get(id)
      if (!parked) continue
      state.pendingShells?.delete(id)
      if (state.dismissedOps.has(id)) continue // retired by the operator — see FoldState.dismissedOps
      if (b.is_error === true || !AUTO_BACKGROUND_ACK_RE.test(text)) continue
      entry = { kind: "shell", toolUseId: id, label: parked.label, startedAt: parked.startedAt, command: parked.command }
      state.subAgents.set(id, entry)
    }
    if (!entry.outputFile) entry.outputFile = launchOutputFile(state, text)
    if (!entry.taskId) entry.taskId = launchTaskId(text)
    if (LAUNCH_ACK_RE.test(text)) continue // background launch ack — the child/shell is alive, keep tracking
    if (entry.kind === "shell") {
      state.subAgents.delete(id) // synchronous launch failure: no notification will ever arrive
      continue
    }
    // Foreground completion (or a failed dispatch): the tool_result IS the terminal signal.
    state.subAgents.delete(id)
    retireToRing(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, "completed")
  }
}

// A `SendMessage` aimed at a child that has ALREADY STOPPED does not just deliver a message — it
// RESTARTS that child, detached, exactly as the original dispatch did ("resumed it in the background
// … You'll be notified when it finishes"). Nothing else in the transcript announces that restart: the
// child's terminal notification already fired and retired the row, and no new `Agent` tool_use is ever
// written. That is why a re-steered child vanished from the board while it was demonstrably running —
// reproduced on a real 8668-record session (2026-07-28) where four children hit a session limit, were
// re-steered minutes later, and the fold held all four in `retiredSubAgents` with status "failed".
//
// The discriminator is STRUCTURED, not prose: the tool_result is a JSON object, and `resumedAgentId`
// is present on exactly the shapes that restart something. Corpus-verified over every SendMessage
// result in ~/.claude/projects (705 transcripts, 802 results, 2026-07-28) — four shapes, all
// `success:true`:
//   • "Message queued for delivery to <id> at its next tool round."           466 · NO resumedAgentId
//   • "Agent \"<id>\" had no active task; resumed from transcript …"          230 · resumedAgentId
//   • "Agent \"<id>\" was stopped (completed); resumed it in the background …"  95 · resumedAgentId
//   • "Agent \"<id>\" was stopped (failed); resumed it in the background …"     11 · resumedAgentId
// The first is the child already being alive — reviving on it would DOUBLE a row the fold still holds,
// which is the phantom class this whole path has leaked three times. The other three each promise the
// <task-notification> that will retire the revived row, so nothing minted here can dangle without a
// terminal signal coming for it.
interface ResumeAck {
  agentId: string // the restarted child's runtime task id (`to:` / `resumedAgentId`)
  outputFile?: string // its transcript, re-stated by the ack — the same path the launch ack gave
}
function parseResumeAck(text: string): ResumeAck | undefined {
  if (!text.includes("resumedAgentId")) return undefined // cheap reject before the parse
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined // a shape that only MENTIONS the field is not a restart
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const ack = parsed as { success?: unknown; resumedAgentId?: unknown; message?: unknown }
  if (ack.success !== true) return undefined
  const agentId = typeof ack.resumedAgentId === "string" ? ack.resumedAgentId.trim() : ""
  if (!agentId) return undefined
  const message = typeof ack.message === "string" ? ack.message : ""
  return { agentId, outputFile: message.match(/Output:\s*(\S+)/)?.[1]?.replace(/\.$/, "") }
}

// Correlate a restart ack to a row frizz already holds. The runtime task id is the primary key (both
// the launch ack's `agentId:` and this ack's `resumedAgentId` are that same id); the output path is a
// second, independent key, since both acks state it verbatim. Two keys because a MISS here mints a
// duplicate row for a child that is already on the board — the failure mode that costs the most.
function matchesAgent(candidate: { taskId?: string; outputFile?: string }, ack: ResumeAck): boolean {
  if (candidate.taskId && candidate.taskId === ack.agentId) return true
  return Boolean(ack.outputFile && candidate.outputFile === ack.outputFile)
}

// Revive a child the fold has already retired (or never saw) when its parent re-steers it back to
// life. Keyed by the ORIGINAL dispatch tool_use id whenever the retired row can be found, so the
// child keeps one stable identity across any number of re-steers and an open drill-in drawer keeps
// resolving; only a child whose retired row has aged out of the ring gets a fresh row keyed by the
// SendMessage. Either way `taskId` carries the runtime id, which is what every completion
// notification correlates on (`<task-id>`) — and for the freshly-keyed case the notification's
// `<tool-use-id>` is the SendMessage's own id, so both correlation paths land.
//
// `startedAt` is the RESUME instant, not the original dispatch: this is a new run, and the elapsed
// reading on the board should measure it rather than the dead gap before it.
function trackResumes(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown; content?: unknown }
    if (b.type !== "tool_result") continue
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined
    if (!id) continue
    // Consume the parked summary whatever the result turns out to be — an ordinary delivery must not
    // leave it to be picked up by some later, unrelated resume.
    const summary = state.pendingResumes?.get(id)
    state.pendingResumes?.delete(id)
    const ack = parseResumeAck(toolResultText(b.content))
    if (!ack) continue
    // Already live: the fold never lost this child (its terminal notification has not landed, or the
    // parent re-steered one that was still working). Reviving would double it.
    let live = false
    for (const e of state.subAgents.values()) if (matchesAgent(e, ack)) { live = true; break }
    if (live) continue
    const at = typeof rec.timestamp === "string" ? rec.timestamp : (state.lastActivityAt ?? "")
    // NEWEST match wins. `retireToRing` re-inserts on every retirement, so reverse insertion order is
    // most-recently-retired first — and a child that has been re-steered before can hold more than one
    // retired row (one per run whose original row had already aged out of the ring). Reading the oldest
    // of those would defeat the history guard below, which compares against exactly this row's death.
    const retiredRows = [...state.retiredSubAgents.values()]
    let retired: RetiredSubAgent | undefined
    for (let i = retiredRows.length - 1; i >= 0; i--) if (matchesAgent(retiredRows[i], ack)) { retired = retiredRows[i]; break }
    // REPLAYED HISTORY. A Claude transcript re-emits past records verbatim — the reproduction session
    // carries 65 duplicated uuids and replays five of these very restart acks, with their ORIGINAL
    // timestamps, some 1200 records after the fold already watched those children finish. An ack is
    // only a restart the FIRST time it is folded; folding it again would resurrect a child that
    // finished a day ago and leave it pulsing (then "stale") forever. This is the same class of
    // phantom the notification fold has leaked three times; it does not get to happen a fourth.
    //
    // The test is against the fold's own high-water mark, and deliberately NOT against the retired
    // row's `finishedAt`: that field can be stamped from the RUNTIME event clock (applyRuntimeTasks)
    // rather than from record timestamps, and comparing two clocks silently misfires — it rejected
    // every revival in the integration harness, where the two domains are hours apart. Record
    // timestamps compared to a mark built only from record timestamps is one clock, always. A
    // replayed record keeps its ORIGINAL timestamp so it lands far behind the mark; a genuine ack is
    // AT it. The slack covers ordinary out-of-order writes between sibling records — replays are
    // stale by minutes to days, so nothing near the boundary is ambiguous.
    const ackAt = at ? Date.parse(at) : Number.NaN
    const highWater = state.maxRecordAt ? Date.parse(state.maxRecordAt) : Number.NaN
    if (Number.isFinite(highWater) && Number.isFinite(ackAt) && highWater - ackAt > RESUME_REPLAY_SLACK_MS) continue
    if (retired) state.retiredSubAgents.delete(retired.toolUseId)
    const toolUseId = retired?.toolUseId ?? id
    // A restart SUPERSEDES the operator's retirement of the previous run. `SendMessage` revives a
    // stopped child under the SAME tool_use id, so without this the dismissal would outlive the run it
    // was aimed at: the row comes back here (correctly — it is live work again), and the next re-prime
    // silently deletes it, hiding a child that is genuinely running. The replay guard directly above is
    // what makes this safe to do unconditionally — only a GENUINE ack reaches this line.
    // Queued rather than written here: this is a pure fold function with no storage handle. The tick
    // drains `unretiredOps` (see the drain beside the prime), which keeps every registry write on the
    // one side of the module that owns them.
    if (state.dismissedOps.delete(toolUseId)) (state.unretiredOps ??= new Set()).add(toolUseId)
    state.subAgents.set(toolUseId, {
      kind: "agent",
      toolUseId,
      label: retired?.label ?? summary ?? "sub-agent",
      startedAt: at,
      subagentType: retired?.subagentType,
      outputFile: ack.outputFile ?? retired?.outputFile,
      outputFormat: retired?.outputFormat,
      taskId: ack.agentId,
    })
  }
}

// RETIRE a tracked sub-agent when its <task-notification> reports a TERMINAL status: move it OUT of the
// live map (so banner/counts/spinner stop showing it) and INTO the bounded retained ring (so the
// drill-in drawer can still resolve its transcript for review). Notifications ride THREE record shapes
// (all must be handled — missing the second leaked 20+ phantom "running" sub-agents on a busy session,
// found 2026-07-09; missing the third leaked a stuck background shell whose completion arrived
// mid-turn, found 2026-07-22): (a) queue-operation records with a top-level `content` string,
// (b) USER records whose message.content (string, or text blocks) embeds the <task-notification> XML —
// the shape newer harness versions emit, and (c) `attachment` records (type:"queued_command") whose
// `attachment.prompt` carries it. Shape (c) is LOAD-BEARING, not redundant with (a): when a shell
// completes MID-TURN the harness enqueues the notification and flushes the queue-operation bookkeeping
// (a) at a FILE POSITION that PRECEDES the launch's own assistant record — so we fold that completion
// before the shell is even registered (no live entry → no-op) and it is lost. The `attachment` (c) is
// written INLINE when the queued item is injected, always AFTER the launch, so it is the only
// reliably-ordered completion carrier for that race. A record can carry multiple notification blocks;
// each is retired independently. A task-id can notify more than once (a resumed background agent
// re-notifies) and a non-terminal "running" ping exists too, so only completed/failed/killed retire
// the entry. Idempotent: a repeat terminal notify (the same completion arriving via both (a) and (c))
// finds nothing live to move (no-op).
function notificationText(rec: Record): string | undefined {
  if (typeof rec.content === "string") return rec.content
  if (typeof rec.attachment?.prompt === "string") return rec.attachment.prompt
  const c = rec.message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    const text = c
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n")
    return text || undefined
  }
  return undefined
}

function trackCompletions(state: TailState, rec: Record): void {
  const raw = notificationText(rec)
  if (!raw || !raw.includes("<task-notification>")) return
  // REPORT-DELIVERY BOOKKEEPING RUNS FIRST, and deliberately BEFORE the early-return below.
  //
  // That guard exists because retiring needs a live/retired row to correlate against. Delivery
  // accounting needs no such row: what it tracks is whether the notification's TEXT ever reached the
  // model, which is true or false regardless of what frizz happens to have in its maps. Running it
  // after the guard would silently skip exactly the notifications that arrive when the maps are empty
  // — which, on a busy orchestrator whose children have all been retired already, is a great many.
  trackReportDelivery(state, rec, raw)
  // A RETIRED child still anchors a live branch (see anchorRoots), and the descendants hanging off it
  // notify through here too — so an empty live map alone no longer means there is nothing to correlate.
  if (state.subAgents.size === 0 && state.retiredSubAgents.size === 0) return
  for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const status = block.match(/<status>([^<]*)<\/status>/)?.[1]
    // completed/failed/killed are the natural terminals. `stopped` is the RECOVERY notification a NEW
    // session emits for background ops the PREVIOUS process left with no completion record ("… have been
    // marked stopped") — the owning process is gone, so it is just as terminal; map it to killed.
    // Dropping it (the old guard did) is exactly why an orphaned sub-agent lingered as `stale` and an
    // orphaned background shell — which has NO staleness clock — pulsed "running" forever, re-derived
    // identically on every restart (found 2026-07-23 on real nub threads). A non-terminal "running" ping
    // still retires nothing.
    // A Monitor that hits its timeout_ms emits ONE notification carrying NO <status> (and no
    // <tool-use-id>) — only an <event> with the harness's timeout sentinel. Without this the entry
    // dangles as "running" forever (0 of 2 timeout notifications carried a status, session 54b37ebe).
    // Key STRICTLY on the sentinel: ordinary Monitor progress events also have <event> and no <status>,
    // so "missing status ⇒ terminal" would retire every live monitor on its first event. The sentinel
    // is harness-emitted prose and could drift — same fragility as the launch-ack strings we already
    // depend on ("Command running in background with ID:", "Monitor started (task").
    const monitorTimedOut = block.includes("<event>[Monitor timed out")
    const terminal: "completed" | "failed" | "killed" | undefined =
      status === "completed" || status === "failed" || status === "killed" ? status : status === "stopped" || monitorTimedOut ? "killed" : undefined
    if (!terminal) continue
    // ONE block can list MANY ops — the recovery notification names every orphan at once — and it may
    // carry tool-use-ids, only task-ids, or both (the recovery shape omits tool-use-ids entirely). Retire
    // EVERY correlated live entry, not just the first: the old single-.match() left all-but-one live, so a
    // 3-agent recovery still leaked 2. Dedupe (a tool-use-id and a task-id can name the same entry) and
    // collect before retiring, since retireLive mutates the map findLiveByTaskId scans.
    const doomed = new Set<SubAgentEntry>()
    for (const m of block.matchAll(/<tool-use-id>([^<]*)<\/tool-use-id>/g)) {
      const entry = state.subAgents.get(m[1])
      if (entry) doomed.add(entry)
    }
    const stampedAt = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN
    for (const m of block.matchAll(/<task-id>([^<]*)<\/task-id>/g)) {
      if (m[1].startsWith("__orphan_summary__")) continue // internal scan sentinel — correlates to nothing
      const entry = findLiveByTaskId(state, m[1])
      if (entry) doomed.add(entry)
      // Nothing live under this task id. For a DIRECT child that just means the notify is a repeat of
      // one already folded; for a DESCENDANT it is the branch's only rest signal, and there is no way
      // to tell the two apart from here (a descendant is not tracked, so its absence looks identical).
      // Recording both is safe: only a depth>=2 sidecar is ever measured against this map, and a
      // direct child's id simply never gets looked up in it.
      else if (Number.isFinite(stampedAt)) recordDescendantTerminal(state, m[1], stampedAt)
    }
    for (const entry of doomed) retireLive(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, terminal)
  }
}

// Account for whether each terminal completion report actually reached the MODEL, as opposed to merely
// being accepted into the runtime's queue. See report-delivery.ts for why those are different things
// and for the corpus that showed a third of them never making the second hop.
//
// Only TERMINAL reports are tracked: a non-terminal "running" ping carries no report to lose, and a
// Monitor progress event is not a sub-agent report at all.
function trackReportDelivery(state: TailState, rec: Record, raw: string): void {
  const modelFacing = isModelFacingCarrier(rec.type)
  const at = typeof rec.timestamp === "string" ? rec.timestamp : undefined
  for (const block of raw.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const status = block.match(/<status>([^<]*)<\/status>/)?.[1]
    if (status !== "completed" && status !== "failed" && status !== "killed") continue
    // A failed/killed child has no findings to lose — its notification is a status line, not a report
    // (measured: every `failed` in the corpus was 46–384 chars of "the agent errored"). Repairing those
    // would spam the agent with pointers to transcripts that say nothing.
    if (status !== "completed") {
      for (const id of blockTaskIds(block)) state.queuedReports.delete(id)
      continue
    }
    const parsed = parseReportBlock(block, at, blockTaskIds(block)[0] ?? "")
    for (const id of blockTaskIds(block)) {
      if (modelFacing) {
        state.deliveredReports.add(id)
        state.queuedReports.delete(id)
        continue
      }
      // Both kinds are tracked. An AGENT's findings exist only inside the notification, so losing it
      // is a total loss of content; a SHELL's output survives on disk, but the WAKE it carries does
      // not — and a rested agent whose build finished and was never told just sits there, which is
      // the louder failure of the two (383 of 421 shell notifications lost on one real thread).
      if (!reportKind(parsed.summary, id)) continue // neither shape — not ours to repair
      if (state.deliveredReports.has(id)) continue // already read it; a late queue-op must not re-park
      state.queuedReports.set(id, { taskId: id, ...parsed })
    }
  }
  boundReportMaps(state)
}

// A repair frizz injected is a plain user record, so the notification fold above never sees it. This is
// what makes the repair idempotent across a re-fold without persisting anything — see report-delivery.
function trackRelayEchoes(state: TailState, rec: Record): void {
  if (!isModelFacingCarrier(rec.type)) return
  const text = notificationText(rec)
  if (!text) return
  for (const id of relayedTaskIds(text)) {
    state.deliveredReports.add(id)
    state.queuedReports.delete(id)
  }
  boundReportMaps(state)
}

// Both structures are unbounded in principle (one entry per child, and a long-running orchestrator
// dispatches hundreds), so trim oldest-first. `queuedReports` is insertion-ordered by queue time.
function boundReportMaps(state: TailState): void {
  while (state.queuedReports.size > MAX_TRACKED_REPORTS) {
    const oldest = state.queuedReports.keys().next().value
    if (oldest === undefined) break
    state.queuedReports.delete(oldest)
  }
  while (state.deliveredReports.size > MAX_TRACKED_REPORTS * 4) {
    const oldest = state.deliveredReports.values().next().value
    if (oldest === undefined) break
    state.deliveredReports.delete(oldest)
  }
}

// A manual `TaskStop` is a first-class STOP event, symmetric with the launch `tool_use` that started
// the op. Its structured result confirms "Successfully stopped task: <id>" and carries the runtime
// `task_id` — the SAME id captured at launch, and the ONLY correlation key a manual stop exposes (it
// has no tool_use id). This is the signal that retires a shell/agent killed by hand — the one the
// board previously never saw, leaving a phantom pulsing row until the pane died.
function stoppedTaskId(text: string): string | undefined {
  // Guard on the success confirmation so a failed/no-op stop never retires a still-live row, then read
  // the structured task_id field (the first match is the real field — it precedes `command` in the JSON).
  if (!/Successfully stopped task/.test(text)) return undefined
  return text.match(/"task_id"\s*:\s*"([^"]+)"/)?.[1]
}

function trackStops(state: TailState, rec: Record): void {
  if (state.subAgents.size === 0) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; content?: unknown }
    if (b.type !== "tool_result") continue
    const taskId = stoppedTaskId(toolResultText(b.content))
    if (!taskId) continue
    const entry = findLiveByTaskId(state, taskId)
    if (!entry) continue // already retired by its own notification, or never tracked — safe no-op
    retireLive(state, entry, typeof rec.timestamp === "string" ? rec.timestamp : undefined, "killed")
  }
}

// Cap a foreign string defensively (AskUserQuestion is an UNTRUSTED tool payload — never let it
// fatten the snapshot). Caps chosen so the read-only render stays a compact card.
function capAsk(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
// Parse an AskUserQuestion tool_use `input.questions` into the capped structured shape. Defensive at
// every level: a missing/misshaped field is skipped, never thrown. Empty result → treat as "no ask".
function parseAskInput(input: unknown): AskQuestionData[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs)) return []
  const out: AskQuestionData[] = []
  for (const q of qs.slice(0, 8)) {
    if (!q || typeof q !== "object") continue
    const qq = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown }
    const question = typeof qq.question === "string" && qq.question.trim() ? capAsk(qq.question.trim(), 400) : ""
    if (!question) continue
    const header = typeof qq.header === "string" && qq.header.trim() ? capAsk(qq.header.trim(), 60) : undefined
    const multiSelect = qq.multiSelect === true ? true : undefined
    const options: AskOptionData[] = []
    if (Array.isArray(qq.options)) {
      for (const o of qq.options.slice(0, 12)) {
        if (!o || typeof o !== "object") continue
        const oo = o as { label?: unknown; description?: unknown }
        const label = typeof oo.label === "string" && oo.label.trim() ? capAsk(oo.label.trim(), 160) : undefined
        if (!label) continue
        const description = typeof oo.description === "string" && oo.description.trim() ? capAsk(oo.description.trim(), 300) : undefined
        options.push({ label, description })
      }
    }
    out.push({ question, header, multiSelect, options })
  }
  return out
}
// Capture a PENDING native AskUserQuestion: an AskUserQuestion tool_use whose tool_result hasn't landed
// yet freezes the session at a TUI dialog. Same correlation pattern as sub-agent tracking (keyed by
// tool_use id). Cleared by clearAskOnResult when the matching tool_result arrives.
function trackAsk(state: TailState, rec: Record): void {
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; name?: string; id?: unknown; input?: unknown }
    if (b.type !== "tool_use" || b.name !== "AskUserQuestion") continue
    const id = typeof b.id === "string" ? b.id : undefined
    if (!id) continue
    const questions = parseAskInput(b.input)
    if (questions.length) state.pendingAsk = { id, questions }
  }
}
// Clear the pending ask once its tool_result lands (the human answered in the terminal).
function clearAskOnResult(state: TailState, rec: Record): void {
  const pending = state.pendingAsk
  if (!pending) return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as { type?: string; tool_use_id?: unknown }
    if (b.type === "tool_result" && b.tool_use_id === pending.id) {
      state.pendingAsk = undefined
      return
    }
  }
}

// Fold one record into the running derivation. Only assistant/user records are "substantive" (they
// move the turn state); assistant/user/system records with a timestamp advance lastActivityAt.
export function applyRecord(state: TailState, rec: Record): void {
  const type = rec.type
  // A `type:"user"` record with promptSource:"system" is a peer (SendMessage) message or a sub-agent
  // <task-notification> — NOT a human turn. It DOES re-invoke the agent (the model wakes to process
  // it), so it moves the TURN to in-flight (shimmer during the resume) and advances lastActivityAt like
  // any record. What it must NOT do is bump `lastUserAt` — the ROW-ORDER key — because that would jump
  // the row to the top from motion the human didn't cause. (An earlier fix over-suppressed the turn
  // flip too, which made a thread look IDLE/stalled while the agent was actually resuming after a
  // sub-agent returned — no shimmer, then a message appeared out of nowhere. Found 2026-07-09.)
  const systemUserRec = type === "user" && rec.promptSource === "system"
  // Native slash commands can append a type:user,isMeta:true reminder without invoking the model.
  // Treating that as a real user record leaves an idle session falsely in-flight forever because no
  // assistant record follows. It is sidecar metadata: no activity, turn, fence, or row-order change.
  const metaUserRec = type === "user" && rec.isMeta === true
  // After compacting, claude injects the carry-over summary as an ORDINARY user record (no isMeta, no
  // promptSource) — so without this it reads as the human typing a 20 000-character message, which jumps
  // the row to the top of the board on motion the human never caused. It IS a re-invoking record (the
  // model resumes from the summary), so it keeps the in-flight flip; it just may not touch lastUserAt.
  const compactSummaryRec = type === "user" && rec.isCompactSummary === true
  if (typeof rec.timestamp === "string" && (type === "assistant" || (type === "user" && !metaUserRec) || type === "system")) {
    state.lastActivityAt = rec.timestamp
  }
  // The high-water mark takes EVERY timestamped record and only ever advances (see TailState). A plain
  // string compare, not Date.parse: these are all `toISOString()` output, so lexicographic order IS
  // chronological order, and this runs on every record of every transcript at boot.
  if (typeof rec.timestamp === "string" && (state.maxRecordAt === undefined || rec.timestamp > state.maxRecordAt)) {
    state.maxRecordAt = rec.timestamp
  }
  if (type === "permission-mode") {
    const parsed = PermissionMode.safeParse(rec.permissionMode)
    if (parsed.success) {
      state.permissionMode = parsed.data
      state.permissionModeRevision = (state.permissionModeRevision ?? 0) + 1
    }
  } else if (type === "assistant") {
    state.sawRecords = true
    state.lastKind = "assistant"
    // The agent's OWN output timestamp = the rest-time key. For an at-rest thread the last assistant
    // record IS its final resting message; unlike lastActivityAt this never moves from a sub-agent's
    // completion notification (a promptSource:system USER record), so the queue never reshuffles on
    // background-child motion. tool_result echoes are `type:user`, not assistant, so they don't bump it.
    if (typeof rec.timestamp === "string") state.lastAssistantAt = rec.timestamp
    state.lastStopReason = typeof rec.message?.stop_reason === "string" ? rec.message.stop_reason : undefined
    // Claude records the actual resolved model on every assistant message. It does NOT record the
    // launch effort, so that half continues to come from the persisted dispatch profile. Ignore the
    // synthetic placeholder some generated/error records use rather than overwriting a real model.
    const observedModel = typeof rec.message?.model === "string" ? rec.message.model.trim() : ""
    if (observedModel && observedModel !== "<synthetic>") {
      state.model = observedModel
      state.profileAt = typeof rec.timestamp === "string" ? rec.timestamp : undefined
      state.profileRevision = (state.profileRevision ?? 0) + 1
    }
    // How full the model's context is, straight off the API's own accounting for this request. The
    // three input components sum to exactly what the request carried: fresh input, the prefix newly
    // written to cache, and the prefix read back from it. Output tokens are excluded — they are not in
    // the context until the NEXT request quotes them back, at which point they arrive inside these
    // three. Guards, in order: a synthetic error record carries no real usage; a sidechain record is a
    // CHILD's context, not this thread's; and a record whose components are all absent must leave the
    // previous reading alone rather than assert zero. A compaction shows up here for free — the next
    // request is genuinely smaller, so the reading simply drops.
    const usage = rec.isApiErrorMessage === true || rec.isSidechain === true ? undefined : rec.message?.usage
    if (usage && typeof usage === "object") {
      const part = (key: string): number | undefined => {
        const value = usage[key]
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
      }
      const input = part("input_tokens")
      const created = part("cache_creation_input_tokens")
      const read = part("cache_read_input_tokens")
      if (input !== undefined || created !== undefined || read !== undefined) {
        state.contextTokens = (input ?? 0) + (created ?? 0) + (read ?? 0)
      }
    }
    const raw = lastTextBlock(rec.message?.content)
    // Runtime auth classifier (claude-auth plan): claude records a rejected credential as a SYNTHETIC
    // assistant record (isApiErrorMessage:true, model "<synthetic>") whose text is the 401/login
    // recovery line. Keying on the synthetic flag makes user-authored or quoted "401" text
    // structurally unable to trigger the fault; the text conjunction keeps other API errors
    // (overloaded, rate-limit) from reading as auth. A later REAL assistant text clears it —
    // a genuine response is proof the credential works again.
    if (rec.isApiErrorMessage === true) {
      if (raw !== undefined && isClaudeAuthErrorText(raw)) state.authFault = "authentication_rejected"
    } else if (raw !== undefined) {
      state.authFault = undefined
    }
    // Subscription usage-limit classifier (auto-resume): the SAME synthetic-record channel, keyed on
    // the structured `error:"rate_limit"` category rather than any text match. The limit is what cut
    // this turn off mid-work, so the fault standing on the tail IS "this agent was running when the
    // window ran dry" — the set the scheduler later continues. A REAL assistant text clears it (the
    // provider is serving again); a user record clears it below (the human — or our own delivered
    // "continue" — has already moved the thread on, which is what makes the wake idempotent).
    if (rec.isApiErrorMessage === true) {
      const limit = classifyLimitRecord(rec, raw)
      if (limit && typeof rec.timestamp === "string") {
        state.limitFault = { window: limit.window, at: rec.timestamp, resetClock: limit.resetClock }
      }
    } else if (raw !== undefined) {
      state.limitFault = undefined
    }
    if (raw !== undefined) {
      const preview = previewText(raw)
      if (preview !== undefined) state.lastAssistant = preview
      // Track whether THIS (now the latest) assistant text carries an unanswered question fence.
      state.lastAssistantHasQuestion = hasQuestionBlock(raw)
      // Same lifecycle for the stop-hook sentinel: it only means "nothing actionable" while it
      // is the FINAL word, so a later assistant text that omits it re-opens the loop by itself.
      state.lastAssistantAllDone = saysAllDone(raw)
      // Recompute the done/awaiting signal fence from THIS text — an assistant text with no fence
      // clears it (the fence only signals while it is the final message). Same lifecycle as the
      // question flag: set per assistant text, cleared by any user record below.
      state.lastFence = parseSignalFence(raw)
    }
    trackDispatches(state, rec) // register any background Agent dispatches + background shells
    trackAsk(state, rec) // capture a pending native AskUserQuestion (frozen at a TUI dialog)
  } else if (type === "user" && !metaUserRec) {
    state.sawRecords = true
    // A user record — human turn, tool_result, OR a re-invoking system record (peer/notification) —
    // flips the turn to IN-FLIGHT: the model is about to respond, so the thread reads as WORKING
    // (shimmer), not idle. This is what shows motion while an agent resumes after a sub-agent returns.
    state.lastKind = "user"
    state.lastStopReason = undefined
    // A newer user record supersedes any pending chat question / excusal fence (they only signal as the
    // FINAL message); the NEXT assistant record recomputes them.
    state.lastAssistantHasQuestion = false
    state.lastAssistantAllDone = false
    state.lastFence = undefined
    // Any user record supersedes a usage-limit pause: the conversation has moved past the point where
    // it was cut off, whether by the human or by the "continue" the wake scheduler delivered. This is
    // precisely what makes the auto-resume one-shot — the delivered message erases the very fault that
    // selected the thread. If the window is still dry, the provider simply writes a NEW limit record
    // (with a NEW, later reset instant), so a re-fire can never tighten into a loop.
    state.limitFault = undefined
    // `lastUserAt` is the ROW-ORDER key — bump it ONLY for a genuine HUMAN interaction. A tool_result
    // is agent activity (excluded by isRealUserMessage); a system record (peer/notification) is
    // machine motion the human didn't cause — neither may jump the row to the top (the one part of the
    // earlier over-fix that WAS a real bug).
    if (!systemUserRec && !compactSummaryRec && typeof rec.timestamp === "string" && isRealUserMessage(rec.message?.content)) state.lastUserAt = rec.timestamp
    trackLaunchResults(state, rec) // resolve a background dispatch's transcript path from its launch result
    trackResumes(state, rec) // a SendMessage that RESTARTED a stopped child is a fresh launch — revive it
    trackStops(state, rec) // a manual TaskStop is a terminal signal — retire the op it killed
    clearAskOnResult(state, rec) // the AskUserQuestion answer landed → clear the pending ask
  } else if (type === "ai-title") {
    // Sidecar record carrying Claude's own auto-generated session title. Emitted repeatedly (often
    // identical) as the session evolves — take the latest non-empty. Never touches turn state.
    if (typeof rec.aiTitle === "string" && rec.aiTitle.trim()) state.aiTitle = rec.aiTitle.trim()
  } else if (type === "custom-title") {
    // Written by /rename (bare /rename auto-generates a slug; /rename <name> sets it). Keep it in a
    // dedicated observation slot only: the rename controller must confirm the readable second record
    // and atomically persist it before any board/file surface changes. Promoting an intermediate or
    // mismatched record to aiTitle leaked rejected slugs into the UI and paired .frizz files.
    if (typeof rec.customTitle === "string" && rec.customTitle.trim()) {
      state.customTitle = rec.customTitle.trim()
      state.customTitleRevision++
    }
  }
  // all other types (attachment, queue-operation, last-prompt, mode,
  // bridge-session, file-history-snapshot, system) are sidecar metadata — ignored for turn state.
  // Sub-agent completion rides queue-operation AND attachment records (each a <task-notification>
  // carrier — see notificationText), so it's checked for EVERY record regardless of type (the helper
  // self-guards on shape + tracked ids).
  trackCompletions(state, rec)
  // A repair frizz injected earlier carries no <task-notification>, so it needs its own pass.
  trackRelayEchoes(state, rec)
}

// Derive the final-message-dependent fields (preview + question flag + done/awaiting fence) from the
// text of a FINAL assistant message. Shared by assistant-text{final:true} and turn-end.finalText so
// the same derivation lands whichever event a backend carries the final answer on. Mirrors the
// assistant-text arm of applyRecord — minus Claude's every-block fence recompute (a normalized
// backend fences only on the final message; a codex `commentary` block must never excuse the thread).
function applyFinalText(state: FoldState, text: string): void {
  const preview = previewText(text)
  if (preview !== undefined) state.lastAssistant = preview
  state.lastAssistantHasQuestion = hasQuestionBlock(text)
  state.lastAssistantAllDone = saysAllDone(text)
  state.lastFence = parseSignalFence(text)
}

// Fold one NORMALIZED event into the backend-neutral accumulator — the codex-facing counterpart to
// applyRecord (which folds raw Claude records). A backend whose turn model maps cleanly onto
// NormalizedEvent (codex's explicit task_started/task_complete brackets) drives its fold as
// `for (const ev of parseLine(line)) applyEvent(state, ev)`; it produces the SAME FoldState fields
// applyRecord does, so the tailer/board consume either identically. Claude does NOT use this path —
// its 3-way stop_reason + 5s backstop turn signal can't round-trip through the union without loss
// (see the NOTE on NormalizedEvent in backend/types.ts).
export function applyEvent(state: FoldState, ev: NormalizedEvent): void {
  // Every timestamped event advances the activity clock (events map 1:1 to substantive lines; only the
  // untimestamped `title` lacks an `at`). Folded in file order, so the latest `at` wins. `context-usage`
  // is the exception: it is telemetry that always RIDES a real event which moves the clock itself, so
  // letting it move the clock would only add a way for pure bookkeeping to mask a stall.
  if ("at" in ev && typeof ev.at === "string" && ev.kind !== "context-usage") state.lastActivityAt = ev.at
  switch (ev.kind) {
    case "turn-start":
      // A turn opened → the agent is working.
      state.sawRecords = true
      state.turn = "in-flight"
      break
    case "turn-end":
      // A turn bracketed closed → idle. finalText (when the backend carries the final message on the
      // bracket) is authoritative: (re)derive preview + question/excusal fence from it. The bracket's
      // `at` is the agent's rest time — the queue/at-rest-label key (see NormalizedTail.lastAssistantAt).
      state.sawRecords = true
      state.turn = "idle"
      if (typeof ev.at === "string") state.lastAssistantAt = ev.at
      if (ev.finalText !== undefined) applyFinalText(state, ev.finalText)
      break
    case "assistant-text":
      // Streamed assistant text. The FINAL answer sets preview + question/excusal fence; a non-final
      // (commentary) block only refreshes the row preview and must NOT carry a fence. Turn state is
      // untouched — the turn brackets on turn-start/turn-end, not on a text block. A FINAL block's `at`
      // is the agent's own output time → the rest-time key (turn-end usually carries the same instant).
      state.sawRecords = true
      if (ev.final) {
        if (typeof ev.at === "string") state.lastAssistantAt = ev.at
        applyFinalText(state, ev.text)
      } else {
        const preview = previewText(ev.text)
        if (preview !== undefined) state.lastAssistant = preview
      }
      break
    case "user-message":
      // A human/peer/notification turn re-opens the turn (the model is about to respond → in-flight)
      // and supersedes any pending question / excusal fence (they only signal as the FINAL message).
      // Only a GENUINE human turn bumps lastUserAt — a synthetic one (peer msg / notification /
      // tool-result echo) is machine motion the human didn't cause, so it never jumps the row.
      state.sawRecords = true
      state.turn = "in-flight"
      state.lastAssistantHasQuestion = false
      state.lastAssistantAllDone = false
      state.lastFence = undefined
      if (!ev.synthetic) {
        if (typeof ev.at === "string") state.lastUserAt = ev.at
        // Keep the delivery-confirmation pair atomic. A genuine non-text user event may still bump
        // row activity, but its newer timestamp must never retain text from an older human turn.
        state.lastUserText = typeof ev.text === "string" ? ev.text : undefined
      }
      break
    case "tool-call":
    case "tool-result":
      // Agent activity mid-turn: it advanced the activity clock (above) but doesn't move the turn
      // (still bracketed in-flight) or the preview. Codex's sub-agent tracking rides its own per-line
      // seam (codex-subagents.ts) rather than this union, since a CHILD's lifecycle is a different axis
      // from this session's turn — and codex has no background-shell concept at all;
      // Claude's rich tool tracking rides applyRecord, never this path. NOTE (deliberate divergence
      // from applyRecord's user arm): a tool-result does NOT clear lastFence/lastAssistantHasQuestion —
      // tool activity is mid-turn (a user-message re-open already cleared any prior-turn fence, and the
      // final message recomputes it), so a normalized backend must not let tool motion excuse a fence.
      state.sawRecords = true
      break
    case "agent-report":
      // A CHILD reported upward (codex inter-agent agent_message). It is real session motion — the
      // activity-clock bump above is the point, since a parent that spends an hour waiting on children
      // is working, not stalled — but it is the CHILD's output, so it moves nothing else: not the turn
      // (the child's arrival does not open one; codex records `trigger_turn:false` and brackets any
      // real wake with its own task_started), not the preview or fence (those belong to THIS agent's
      // final message), and neither rest-time key. The child's own lifecycle rides codex-subagents.ts.
      state.sawRecords = true
      break
    case "title":
      // The backend's own session auto-title (codex thread title / Claude ai-title). Never touches turn.
      state.aiTitle = ev.title
      break
    case "compaction":
      // The harness rewrote the context. It is real session motion (codex spends ~100s in it with no
      // other record, which is exactly the silence a stall read would misjudge — hence the activity-clock
      // bump above), but it is the HARNESS's work, not the agent's: it brackets no turn, produces no
      // text, and must never move the preview, the fence, or the row-order key. Rendering is the
      // transcript projection's job (a compaction divider); the fold only needs to not be fooled by it.
      state.sawRecords = true
      break
    case "context-usage":
      // Pure telemetry — see the activity-clock note above. Read by the transcript projection (which
      // brackets a compaction with the readings either side of it) and by the footer's fullness
      // readout. The window is latched rather than overwritten-to-absent: codex names it on every
      // token_count, but a build that stops doing so must not silently erase a real reading.
      state.contextTokens = ev.tokens
      if (ev.window !== undefined) state.contextWindow = ev.window
      break
  }
}

// Derive the turn state from the folded tail (see the header heuristic). `nowMs` drives only the
// unknown-stop-reason backstop; a clear end_turn/tool_use is time-independent.
// computeTurn's answer PLUS whether the "in-flight" it returned is real evidence or the 5s backstop
// still running out. Only the backstop case is a guess, and it is the only case a runtime turn signal
// is permitted to short-circuit (see resolveRuntimeTurn in backend/claude-runtime-ingest.ts).
export function computeTurnDetailed(state: TailState, nowMs: number): { turn: TurnState; backstopped: boolean } {
  if (state.lastKind === "assistant") {
    if (state.lastStopReason === "end_turn") return { turn: "idle", backstopped: false }
    if (state.lastStopReason === "tool_use") return { turn: "in-flight", backstopped: false }
    // unknown/missing stop_reason: only the 5s-silence backstop can call it idle
    const at = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN
    if (Number.isFinite(at) && nowMs - at > IDLE_BACKSTOP_MS) return { turn: "idle", backstopped: false }
    return { turn: "in-flight", backstopped: true }
  }
  return { turn: computeTurn(state, nowMs), backstopped: false }
}

export function computeTurn(state: TailState, nowMs: number): TurnState {
  if (state.lastKind === "assistant") {
    if (state.lastStopReason === "end_turn") return "idle"
    if (state.lastStopReason === "tool_use") return "in-flight"
    // unknown/missing stop_reason: only the 5s-silence backstop can call it idle
    const at = state.lastActivityAt ? Date.parse(state.lastActivityAt) : NaN
    if (Number.isFinite(at) && nowMs - at > IDLE_BACKSTOP_MS) return "idle"
    return "in-flight"
  }
  // A backend that brackets turns EXPLICITLY never sets lastKind (codex: applyEvent writes `state.turn`
  // directly on task_started/task_complete and touches neither lastKind nor lastStopReason) — trust its
  // folded turn verbatim instead of clobbering it back to in-flight. This is BEHAVIOR-NEUTRAL for Claude:
  // applyRecord assigns lastKind on EVERY substantive record (tailer.ts:633/653) and never clears it, so
  // for Claude `lastKind === undefined` holds ONLY before any substantive record — and there `state.turn`
  // is still the newTailState "in-flight" the old fallthrough returned. For codex it makes the explicit
  // task_started/task_complete brackets authoritative (the fix: a folded `idle` survives the tick).
  if (state.lastKind === undefined) return state.turn
  // last substantive record was a user prompt/tool_result → in-flight (the model is about to respond)
  return "in-flight"
}

// A compact change-key for a session's derived sub-agent view — lets the tick mark the board dirty
// on any add / removal / running→stale transition (a completion clears an entry WITHOUT touching
// lastActivityAt, so without this the suffix would linger until the next full reconcile).
function subAgentSignature(views: SubAgentView[]): string {
  return views.map((v) => `${v.label}\u0000${v.state}\u0000${v.startedAt}`).join("\u0001")
}

// Order-sensitive equality of two fresh-foreign sets (id order = mtime desc). A membership OR ordering
// change means the board's foreign rows changed → the tick marks itself dirty.
function sameForeign(a: { id: string }[], b: { id: string }[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false
  return true
}

export interface SubAgentLookup {
  outputFile?: string
  outputFormat?: "codex"
  state: "running" | "stale" | "done"
  direct: boolean
  taskId?: string
  // Lifecycle instants/outcome let the transcript RPC replace an Agent dispatch CALL's latency with
  // the CHILD's real runtime. Optional for descendants, whose sidecars do not carry a terminal row.
  startedAt?: string
  finishedAt?: string
  outcome?: "completed" | "failed" | "killed"
}

export interface Tailer {
  get(slug: string): SessionTelemetry | undefined
  // FOREIGN session ids (JSONL files in the project dir with no registry row — maintainer terminals)
  // whose transcript is FRESH (recent mtime): the board lists these as read-only session threads.
  // Keyed by session id (the thread id for a foreign thread IS its session id).
  foreignIds(): string[]
  // Drill-in drawer lookup: a tracked or retained sub-agent's transcript path + state, or undefined if
  // unknown (never dispatched, or aged out of the retained ring). The router maps undefined → "gone".
  // `outputFormat` tells the reader which schema the file is: absent = Claude JSONL, "codex" = the
  // child's codex rollout (a codex sub-agent is itself a codex thread).
  // `direct` marks the ONE case frizz can address a steer at: an Agent-tool child THIS thread's own
  // session dispatched and is still tracking live. A background shell, a retired child, and a
  // DESCENDANT (a grandchild, resolved through the sidecar index — its dispatch happened inside
  // another agent's process, so this session's CLI has never heard of its tool_use id) are all
  // readable but not addressable, and each reports direct:false so the router refuses rather than
  // firing a message that would silently land on the main thread instead.
  // `taskId` is the provider's session-wide background-task handle. Unlike `direct`, which controls
  // steer safety, it is available for descendants too and is what the SDK's stopTask accepts.
  subAgent(slug: string, id: string): SubAgentLookup | undefined
  // The LIVE descendants of one sub-agent, deepest-first, as the `stopTask` handles that end them.
  // A stop names one task, so ending a sub-agent's work means naming its whole subtree — see the
  // implementation for the orphan-and-report-to-root failure this exists to close. Empty when the id
  // has no live fan-out. Optional for the same reason `dismissOp` is: a narrow test stub need not
  // have it, and a server without it degrades to the old stop-one-row behaviour.
  subAgentDescendantTasks?(slug: string, id: string): string[]
  // Read-only background-shell drawer lookup. Output content stays server-side until the scoped query.
  backgroundShell?(slug: string, id: string): { command?: string; outputFile?: string; state: "running" | "done" } | undefined
  // "Is the process that owned this thread's background ops gone?" — ONE authority for a question three
  // runtimes answer differently, already computed once per tick as `paneDead` (see paneDeadForRow): a
  // dead tmux pane, a broker whose daemon record fails its pid probe, or a headless row frizz stopped.
  // Exposed because the TRANSCRIPT producers need it too. `bgShellViews` drops a dead owner's shells
  // from the board, but the ops strip is a UNION of that list and the transcript's own pending
  // background cards, so the board dropping a row merely moves it — the transcript side has to hear the
  // same fact (see projectRetiredBackgroundOps' ownerGone arm). Optional like its neighbours; a narrow
  // test stub omits it and every caller degrades to "not gone", which is the pre-existing behaviour.
  ownerGone?(slug: string): boolean
  // Manual dismiss of a live background op (the × on an op row): retire it from tracking as if a
  // terminal signal arrived. Returns false if it is not live (unknown id / already gone). Optional so
  // an older server without it degrades gracefully.
  dismissOp?(slug: string, id: string): boolean
  // Drop a session's in-memory tail state (registered + foreign) — called when its row is hard-deleted
  // (forgetSession) so a stale TailState bound to the gone transcript can't mis-tail a later same-slug
  // re-dispatch. A no-op for an unknown slug.
  forget(slug: string): void
  // Record the launch value after the controller has synchronously folded every sidecar written
  // during the handoff. Any later backend record remains authoritative (for example a model/version
  // that rejects or coerces a requested mode).
  notePermissionMode?(slug: string, permissionMode: PermissionMode): void
  /**
   * Derive current state immediately, then poll every POLL_MS. `onPrimeProgress` observes the FIRST
   * pass only, once per PRIME_PROGRESS_EVERY rows — a cold board of thousands of threads spends real
   * time in here, and the launcher waiting on /health needs to see that it is working, not wedged.
   */
  start(onPrimeProgress?: (done: number, total: number) => void): void
  stop(): void
  tick(): void // exposed for tests + boot; the adaptive poll (scheduleTick) calls it otherwise
  /**
   * "Something changed — re-read now." Coalesced and throttled to the same duty-cycle floor the
   * adaptive poll uses, so it is safe to call on every runtime event. Called by the Claude broker's
   * event ingest (backend/claude-runtime-ingest.ts); a tailer nobody nudges behaves exactly as before.
   * Optional for the same reason `dismissOp` is — a narrow test stub of this interface need not have it.
   */
  nudge?(): void
}

export interface TailerDeps {
  project: Project
  storage: Storage
  bus: Bus
  onChange: () => void // triggers a board rebuild when derived state changes (batched: ≤1/tick)
  // Reports the sessions whose JSONL advanced this tick (bytes consumed) — the exact signal that a
  // thread's rendered transcript may have changed. The /ws transcript producer uses it to push updates
  // to subscribed clients (replacing the client's 1.5s poll). Optional: unset = no transcript push.
  onTranscriptChange?: (slugs: string[]) => void
  now?: () => number // injectable clock (tests)
  paneDead?: (slug: string) => boolean // injectable liveness (tests)
  // Injectable broker-daemon liveness (tests); defaults to defaultBrokerDaemonAlive, which reads the
  // session's discovery record and probes its pid. A fixture that omits it gets `() => true` when the
  // project has no stateDir, i.e. the pre-existing `exited`-only behavior.
  brokerDaemonAlive?: (sessionId: string) => boolean
  // Retained as inert test seams: nothing captures a pane any more (there are none), but fixtures
  // still pass them and a narrower type here would be churn for no behaviour.
  capturePane?: (slug: string) => string
  capturePanesAsync?: (slugs: readonly string[]) => Promise<Map<string, string>>
  sessionLogDir?: string // injectable transcript dir (tests); defaults to the Claude Code path
  codexHome?: string // injectable $CODEX_HOME (tests); where a codex sub-agent's child rollout is located
  mtimeMs?: (path: string) => number | undefined // injectable file mtime (tests); a sub-agent transcript's staleness clock
  // The agent backend that locates + folds a session's transcript (Codex-support epic). Injected by
  // the composition layer as a ClaudeBackend; when absent (tests) the tailer folds with its own
  // corpus-verified applyRecord + deterministic Claude path — a byte-identical default.
  backend?: AgentBackend
  // Per-session backend resolver (Codex-support epic, Phase 2): the tailer picks a backend per ROW by
  // its `backend` column so a codex row folds through the codex rollout parser while every claude row
  // (and all foreign maintainer terminals) stays on the corpus-verified Claude fold. Injected by the
  // composition layer; when absent (tests) the single `backend`/default Claude fold covers every row —
  // byte-identical to before. Takes precedence over `backend` when both are set.
  backendFor?: (kind?: string) => AgentBackend
  // The structured PermissionRequest signal (Claude workers with the cc-worker plugin): the worker's
  // perm-observe.mjs hook drops `<stateDir>/perm-requests/<slug>.json` the instant Claude creates a
  // tool-approval prompt. Injectable for tests; the default reads that file. Absent stateDir (narrow
  // test fixtures) → always undefined, so the pane-sniff regex fallback covers exactly as before.
  readPermMarker?: (slug: string) => PermMarker | undefined
  // Durable prime cache (see tail-cache.ts). Defaults to a table in the project's own SQLite DB;
  // pass `null` to disable it entirely, which restores the historical "fold every transcript from
  // byte 0 on every boot" behaviour exactly (that is what the cache-off tests assert against).
  tailCache?: TailStateCache | null
  // The SDK's OWN reading of a headless Claude session, from the broker event stream
  // (backend/claude-runtime-ingest.ts). Two things come off it:
  //   * `turn` — the provider stating outright whether a turn is running, where the fold has to infer
  //     it from `stop_reason` and falls back to a 5s silence guess. Consulted ONLY through
  //     resolveRuntimeTurn, which is forbidden from overriding folded evidence. OPTIONAL: a session
  //     whose events have all been turn-neutral (`init`, `task`, `other`) has no reading at all, and
  //     saying so is the point — inventing one there is what pinned rested threads at "Working…".
  //   * `at` — when the reading was taken, so a `running` that has STOPPED ADVANCING stops outranking
  //     a folded rest (see RUNNING_OVERRIDE_MAX_AGE_MS).
  //   * `events` — how many events this session has produced, which is what lets a tick tell that the
  //     provider has reported activity the transcript has not caught up with yet. See RUNTIME_CHASE_MAX.
  // Absent (tmux threads, tests, bridge-less server) ⇒ the fold decides alone, byte-identical to before.
  runtimeLiveness?: (sessionId: string) => { turn?: "running" | "settled"; at: number; events: number } | undefined
  // The provider's OWN view of a broker session's background tasks (backend/claude-runtime-ingest.ts):
  // what each child is doing right now, and which ones the SDK says are finished. Consulted ONLY
  // through applyRuntimeTasks, which may ENRICH a folded entry and RETIRE one the provider reports
  // terminal — and may never invent an entry the fold does not know about. Absent (tmux threads, codex
  // rows, tests, bridge-less server) ⇒ the prose fold decides alone, byte-identical to before.
  runtimeTasks?: (sessionId: string) => readonly ClaudeRuntimeTask[]
  // CODEX's live background execs, off the app-server item stream (backend/codex-app-server.ts
  // `backgroundExecs`). The exact counterpart of `runtimeTasks` for the other provider, and the ONLY
  // source there is: a codex background exec's `processId` — the id its × has to address — is on that
  // stream and NOT in the rollout this module folds (measured in backend/_live_codex_bgterm_match.mts,
  // where the rollout-projected row carried no handle at all). Unlike `runtimeTasks` this may CREATE
  // rows the fold knows nothing about, because for codex there is nothing to enrich: the fold has never
  // produced a shell entry for a codex thread. Absent (claude rows, tests, a bridge-less server) ⇒ no
  // codex shell rows, exactly as before.
  codexBackgroundExecs?: (threadSlug: string, sessionId: string) => readonly { processId: string; command?: string; startedAtMs: number }[]
  // The model's context SIZE for a broker Claude session, as the SDK reported it on that session's
  // `result` message (backend/claude-runtime-ingest.ts). It is the only place Claude names the number:
  // the JSONL carries per-request usage (the numerator) and nothing at all about the window. Absent
  // (codex rows — which name their own window on every token_count — tmux/foreign Claude rows, tests,
  // a bridge-less server) ⇒ the fold keeps whatever window it already has, and a Claude row that never
  // gets one renders no reading rather than a guessed one.
  runtimeContextWindow?: (sessionId: string) => number | undefined
}

// The durable permission-request marker written by the worker's PermissionRequest hook
// (cc-worker/hooks/perm-policy.mjs). `at` is the ISO time the request was created; the tailer treats
// the marker as an ACTIVE block only while `at` is newer than the last transcript activity (a resolved
// request always advances the transcript past it) AND the policy hook DEFERRED it to a human.
//
// `decision` is what the policy hook did with the request: "allow"/"deny" mean it already resolved it
// unattended and NO human is blocked; only "defer" is a real block. The field is OPTIONAL because a
// marker written by an older plugin build (the observe-only era, which never decided) has none — those
// are read as "defer", preserving the historical behavior exactly. rule/reason/command are display
// provenance for the dashboard: which rule decided, why, and (for Bash) the command it decided about.
export type PermDecision = "allow" | "deny" | "defer"
export interface PermMarker {
  slug: string
  tool: string | null
  promptId: string | null
  permissionMode: string | null
  at: string
  decision?: PermDecision
  rule?: string
  reason?: string
  command?: string
}

// A marker's effective decision. Absent/unrecognized ⇒ "defer": an old or malformed marker must fall
// back to "a human is blocked", never to "already approved" (which would hide a real stall).
export function markerDecision(marker: Pick<PermMarker, "decision">): PermDecision {
  return marker.decision === "allow" || marker.decision === "deny" ? marker.decision : "defer"
}

// The last policy decision frizz OBSERVED for a thread, for display. Only allow/deny appear here — a
// deferred request is already fully represented by permPrompt ("Needs you"), so repeating it would be
// noise. `command` is present for Bash only and is display text, not a re-executable string.
export interface PermPolicyView {
  decision: "allow" | "deny"
  rule: string
  reason: string
  tool: string | null
  at: string
  command?: string
}

function isPermMarker(v: unknown): v is PermMarker {
  if (!v || typeof v !== "object") return false
  const m = v as Partial<PermMarker>
  return typeof m.slug === "string" && typeof m.at === "string"
}

// A sub-agent transcript's mtime in epoch-ms, or undefined if it can't be stat'd (not yet created,
// unreadable). Telemetry-grade: a stat failure degrades to "can't assess staleness", never throws.
function defaultMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

// The Claude Code per-project transcript dir: ~/.claude/projects/<cwdSlug>/. Exported so the
// composition layer can construct the matching ClaudeBackend (its transcriptPath appends the id).
export function defaultLogDir(project: Project): string {
  return join(homedir(), ".claude", "projects", project.cwdSlug)
}

// Reads the worker's PermissionRequest marker from the per-project stateDir. Telemetry-grade: a missing
// stateDir (narrow test fixtures), an absent/half-written/corrupt file all degrade to undefined — the
// pane-sniff fallback then covers exactly as before. Never throws.
function defaultReadPermMarker(project: Project): (slug: string) => PermMarker | undefined {
  if (!project.stateDir) return () => undefined
  return (slug) => {
    try {
      const parsed = JSON.parse(readFileSync(permMarkerPath(project, slug), "utf8"))
      return isPermMarker(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
}

// "Is this broker session's daemon still running?" — the honest liveness a broker row has instead of a
// tmux pane, read from the same discovery record the bridge connects through (a `{daemonPid}` JSON under
// <stateDir>/claude-broker) plus a signal-0 probe of that pid.
//
// This exists because `exited` alone is NOT that answer. `exited` is stamped only when frizz DELIBERATELY
// stops a session, so a daemon that dies any other way — SIGKILL, OOM, an idle-timeout, a crash — leaves
// the row reading alive forever. Measured over this machine's whole broker corpus 2026-08-02: 276 daemon
// starts against 223 recorded exits, so ~19% of daemons vanish leaving no breadcrumb at all. That is the
// transcript-side half of a background shell that renders as "running" for seven hours after the process
// owning it is gone (thread invoices-just-went-out-for-august: daemon 71731 killed outright, its bg shell
// still shimmering on the board until the operator's next prompt spawned a successor).
//
// Two rules make this safe to consult from the 1s tick:
//   • FAIL-SAFE IS "ALIVE". No stateDir, an unreadable/absent/corrupt record, a pid we may not signal —
//     every one answers ALIVE, so the worst case is exactly today's behavior. The opposite default is the
//     documented catastrophe here (see paneDeadForRow: a latched dead reading emptied bgShellViews for
//     EVERY broker thread at once), so this never guesses toward death.
//   • Never `liveBrokerRecord`, which UNLINKS a record it judges stale. The tailer only observes; pruning
//     discovery state from a read path would race the bridge that owns it.
// Memoised per session on a short TTL: the answer changes at most once per daemon lifetime, and a board
// of broker rows must not pay a read + syscall per row per second to learn nothing.
const BROKER_LIVENESS_TTL_MS = 5_000

export function defaultBrokerDaemonAlive(project: Project, now: () => number): (sessionId: string) => boolean {
  if (!project.stateDir) return () => true
  const cache = new Map<string, { at: number; alive: boolean }>()
  return (sessionId) => {
    const cached = cache.get(sessionId)
    const at = now()
    if (cached && at - cached.at < BROKER_LIVENESS_TTL_MS) return cached.alive
    let alive = true
    try {
      const path = claudeBrokerRecordPath(project.stateDir!, sessionId)
      const record = readBrokerRecord(path)
      // `readBrokerRecord` collapses "absent" and "unparseable" into the same null, and those two must
      // NOT get the same answer: an absent record is a positive absence (no daemon to discover ⇒ dead),
      // while an unparseable one is a failure to read (⇒ alive). Only the absence may answer dead. A
      // daemon mid-write leaves exactly the unparseable shape, so conflating them would let a routine
      // torn read clear a LIVE thread's background shells — and a test writing `{ not json` caught this
      // implementation doing precisely that.
      if (!record) alive = existsSync(path)
      else if (typeof record.daemonPid !== "number") alive = true
      else {
        try {
          process.kill(record.daemonPid, 0)
        } catch (error) {
          // EPERM ⇒ the pid exists and is not ours to signal. Only ESRCH is "gone".
          alive = (error as NodeJS.ErrnoException).code === "EPERM"
        }
      }
    } catch {
      alive = true // unreadable state ⇒ never claim a death we cannot see
    }
    cache.set(sessionId, { at, alive })
    return alive
  }
}

// The slice of AgentBackend the tailer drives: locate a session's transcript, fold a raw line into
// the accumulator, and (registered sessions only) sniff the pane for a permission prompt.
type TailBackend = Pick<AgentBackend, "transcriptPath" | "foldLine" | "matchesPermPrompt" | "detectNativeInput" | "detectBootModal">

// Fields the durable prime cache must NEVER restore. Identity comes from the live registry row; the
// pane/discovery fields are re-derived by the prime branch on every boot and a stale value would
// suppress a genuine observation (a stall that must be captured, a discovery that must be retried).
//
// EXPORTED so a test can assert against the real set: the cache codec is deliberately generic (see
// tail-cache.ts — "A hand-written field list is a standing bug"), which means a NEW TailState field is
// restored BY DEFAULT and only an entry here stops it. That default is what made the chase bookkeeping
// below a live bug, so the set is now a tested contract rather than a private detail.
export const UNRESTORED_TAIL_FIELDS: ReadonlySet<string> = new Set([
  "slug", "sessionId", "nativeSessionId", "runtimeGeneration", "path", "foreign",
  "primed", "permPrompt", "nativeInputRequired", "paneDead", "subAgentsSig",
  "noTranscript", "nextDiscoverMs", "stallLogged",
  "deliveryLedgerSeen",
  // The chase bookkeeping is compared against an IN-MEMORY, per-process counter — the ingest's `live`
  // map is rebuilt empty on every boot (backend/claude-runtime-ingest.ts). A hydrated high-water mark
  // from the PREVIOUS process is therefore measured against a counter that restarted at zero, so
  // `live.events <= runtimeEventsSeen` holds forever and the chase never fires again. Measured on a
  // restart-crossing differential: 968/970/970 ms — the exact poll floor chaseRuntime exists to remove
  // — against 16/22/19 ms with these two fields dropped.
  "runtimeEventsSeen", "runtimeChase",
  // The REGISTRY owns this, not the cache. Both are durable, so the collision is silent and total: the
  // snapshot is written on a tick, an × clicked after that tick is not in it, and restoring the stale
  // copy overwrote the set just read from `retired_op` with an EMPTY one — which then let the cached
  // `subAgents` map, also from before the click, put the killed shell straight back on the board. The
  // fold-side guard never even ran, because a cache hit means nothing is folded at all. Found by the
  // restart test, after the fix looked correct and the row came back anyway.
  "dismissedOps",
])

export function createTailer(deps: TailerDeps): Tailer {
  const now = deps.now ?? Date.now
  // No panes: a row's liveness comes from its runtime (broker daemon / app-server). A PRE-CUTOVER row
  // has no transport left, so the default answers "dead" — the seam stays injectable for fixtures.
  const paneDead = deps.paneDead ?? (() => true)
  const brokerDaemonAlive = deps.brokerDaemonAlive ?? defaultBrokerDaemonAlive(deps.project, now)
  const capturePane = deps.capturePane ?? (() => "")
  const capturePanesAsync = deps.capturePanesAsync
  const logDir = deps.sessionLogDir ?? defaultLogDir(deps.project)
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs
  const readPermMarker = deps.readPermMarker ?? defaultReadPermMarker(deps.project)
  // The durable prime cache. `undefined` dep ⇒ open the default table in the project DB; `null` ⇒
  // explicitly disabled. A storage stub with no `db` degrades to disabled rather than throwing.
  const tailCache: TailStateCache | null = deps.tailCache === null
    ? null
    : deps.tailCache ?? (() => {
        try {
          return deps.storage.db ? createTailStateCache(deps.storage.db) : null
        } catch {
          return null
        }
      })()

  // Resolved at most ONCE per row per tick. Every row asks for its binding at least twice (pane
  // liveness and pane text), and each ask is two registry point-queries — 4 queries per row per second
  // that can only ever return the same answer, since a tick describes one instant. Reset at the top of
  // each tick alongside the pane caches.
  let adoptionBindings = new Map<string, ReturnType<typeof adoptionRuntimeBinding>>()

  // The turn a row is IN, folding in the provider's own reading when there is one. For every row
  // without a runtime signal — every tmux thread, every codex row, every test fixture — this is
  // exactly `computeTurn(state, nowMs)`.
  function turnFor(row: SessionRow, state: TailState, nowMs: number): TurnState {
    const detailed = computeTurnDetailed(state, nowMs)
    if (!deps.runtimeLiveness || !isBrokerClaudeRow(row)) return detailed.turn
    const live = deps.runtimeLiveness(row.session_id)
    // The reading's AGE, clamped at 0. An injected test clock can sit behind the wall clock the ingest
    // stamps with, and a negative age must read as FRESH — never as an ancient reading to discard.
    const ageMs = live ? Math.max(0, nowMs - live.at) : 0
    return resolveRuntimeTurn(detailed.turn, detailed.backstopped, live?.turn, ageMs)
  }

  // The provider's event stream RUNS AHEAD OF ITS OWN DISK WRITE. Measured against a real broker
  // session (_live_broker_ingest.mts): the SDK emitted `assistant` at t+3225ms and `result` at
  // t+3251ms with the transcript still at 9783 bytes, and the record only landed between t+3340ms and
  // t+3368ms — roughly 100-140ms later. So a nudge fired on the event reads a file that does not yet
  // contain the record it was told about, the tick folds nothing, and the change waits out the next
  // poll anyway. That is exactly what the promoted-artifact measurement showed: ~920ms, the poll
  // cadence, with the nudge doing no good at all.
  //
  // The fix is level-triggered, not a guessed delay: while the provider reports events this session's
  // transcript has not caught up with, ask for another look. The moment the fold advances, the
  // condition clears on its own. Bounded so an event that never produces a record (init, and the
  // system sidecars) costs a fixed number of cheap ticks and then hands back to the poll — at ~25ms
  // per chase this covers ~500ms of write lag, comfortably over the measured ~140ms.
  function chaseRuntime(row: SessionRow, state: TailState, foldAdvanced: boolean): boolean {
    if (!deps.runtimeLiveness || !isBrokerClaudeRow(row)) return false
    const live = deps.runtimeLiveness(row.session_id)
    if (!live || live.events <= (state.runtimeEventsSeen ?? 0)) return false
    if (foldAdvanced || (state.runtimeChase ?? 0) >= RUNTIME_CHASE_MAX) {
      state.runtimeEventsSeen = live.events
      state.runtimeChase = 0
      return false
    }
    state.runtimeChase = (state.runtimeChase ?? 0) + 1
    return true
  }

  // Fold the provider's OWN report of this session's background tasks over the entries the transcript
  // fold already tracks. This is the structured replacement for the prose archaeology above — the SDK
  // states outright which child is running which tool, what it has spent, and when it is done, where
  // `launchOutputFile` / `launchTaskId` / `trackCompletions` have to recognize English sentences
  // ("Command running in background with ID:", "Monitor started (task", "<task-notification>"). Those
  // stay exactly where they are: they are the ONLY signal a tmux thread has, and a broker session that
  // predates these events (or drops one) still folds identically.
  //
  // The authority split mirrors resolveRuntimeTurn's, and the SECOND rule is the load-bearing one:
  //
  //  * ENRICH — freely. Progress is information the fold structurally does not have; there is nothing
  //    to conflict with.
  //  * RETIRE — yes, on a provider-reported terminal status. This is not overriding folded evidence: it
  //    is the SAME terminal signal the `<task-notification>` fold is waiting for, on a channel that
  //    actually carries it. (Those notifications are stream-only — they are NOT in the JSONL — which is
  //    why the prose path has leaked phantoms three separate times.) retireLive is idempotent, so the
  //    prose path re-seeing it later is a no-op.
  //  * CREATE — never. `trackDispatches` deliberately skips a foreground `Agent` (run_in_background:
  //    false) because the spinner already covers it, and the provider reports those tasks too. Minting
  //    entries here would put foreground children on the board's LIVE count and into the completion
  //    hold — inventing exactly the phantoms this change exists to remove.
  // Claude's context WINDOW, latched onto the fold from the broker event stream. One-way and
  // latching by design: the SDK only names the window when a turn ends, so it must survive the
  // in-between ticks, and it lands in TailState (not a side map) so the durable tail cache carries it
  // across a frizz restart — otherwise every resting Claude thread would lose its readout on reload and
  // not get it back until its next turn finished. The tokens half needs none of this: it is on disk.
  function applyRuntimeContextWindow(row: SessionRow, state: TailState): void {
    if (!deps.runtimeContextWindow || !isBrokerClaudeRow(row)) return
    const window = deps.runtimeContextWindow(row.session_id)
    if (window !== undefined && window > 0) state.contextWindow = window
  }

  function applyRuntimeTasks(row: SessionRow, state: TailState, nowMs: number): void {
    if (!deps.runtimeTasks || !isBrokerClaudeRow(row) || state.subAgents.size === 0) return
    const runtime = deps.runtimeTasks(row.session_id)
    if (runtime.length === 0) return
    // Index both ways up front: a handful of live entries against up to a few hundred remembered tasks.
    const byToolUse = new Map<string, ClaudeRuntimeTask>()
    const byTaskId = new Map<string, ClaudeRuntimeTask>()
    for (const task of runtime) {
      if (task.toolUseId) byToolUse.set(task.toolUseId, task)
      byTaskId.set(task.taskId, task)
    }
    const doomed: Array<{ entry: SubAgentEntry; task: ClaudeRuntimeTask }> = []
    for (const entry of state.subAgents.values()) {
      // tool_use id first — it is the key BOTH sides mint at dispatch, so it cannot be confused. The
      // task id is the fallback for a launch ack frizz parsed but an SDK build that omits tool_use_id.
      const task = byToolUse.get(entry.toolUseId) ?? (entry.taskId ? byTaskId.get(entry.taskId) : undefined)
      if (!task) continue
      // Backfill the manual-stop correlation key from the structured pairing, so a `TaskStop` on this
      // child correlates even when the launch ack's prose never yielded one.
      if (!entry.taskId) entry.taskId = task.taskId
      const progress: SubAgentProgress = {
        activity: task.lastToolName,
        activityDetail: task.activityDetail,
        summary: task.summary,
        toolUses: task.toolUses,
        totalTokens: task.totalTokens,
        durationMs: task.durationMs,
      }
      entry.progress = progress
      // A terminal reading from BEFORE this run began cannot end it. A task id outlives the run that
      // created it — `SendMessage` restarts a stopped child under the SAME id — so a row revived by
      // `trackResumes` would otherwise be retired on its first tick by the DEAD run's terminal flag,
      // whichever of the two signals happens to arrive first. The ingest clears that latch on
      // `task_started`, but the stream and the transcript race by design (see chaseRuntime), so the
      // ordering must not be load-bearing: compare instants instead. An unparseable `startedAt` falls
      // through to the old unconditional behaviour rather than pinning a row alive.
      const startedMs = entry.startedAt ? Date.parse(entry.startedAt) : Number.NaN
      const staleTerminal = Number.isFinite(startedMs) && task.updatedAt < startedMs
      if (task.terminal && !staleTerminal) doomed.push({ entry, task })
    }
    // Collected first: retireLive mutates the map being iterated above.
    for (const { entry, task } of doomed) {
      retireLive(state, entry, new Date(task.updatedAt || nowMs).toISOString(), task.outcome ?? "completed")
    }
  }

  function adoptionBinding(row: SessionRow) {
    const cached = adoptionBindings.get(row.slug)
    if (cached) return cached
    const binding = adoptionRuntimeBinding(deps.storage, row)
    adoptionBindings.set(row.slug, binding)
    return binding
  }

  // "Is the process that owns this session's children gone?" — pane death for a tmux row, and the
  // registry's own exit stamp for a HEADLESS one (broker claude / app-server codex), which has no tmux
  // pane by construction. Sniffing tmux for a headless row can only ever answer "dead", the exact trap
  // deriveRuntime (board.ts) and reconcileSessions (context.ts) each refuse by name — and the tailer
  // fell into it at PRIME, where this was called unguarded while the steady tick below guards it with
  // !isHeadlessRow. That latched paneDead=true on every broker thread at first sighting and never
  // revisited it, so bgShellViews returned [] for all of them: a live CI watcher, correctly tracked by
  // the fold, rendered nowhere (measured 2026-07-29 — 13 threads holding live shell entries, the only
  // one with paneDead=false a legacy tmux row). `exited` is the headless stand-in: for those rows nothing
  // sniffs tmux to set it, so it is stamped only when frizz genuinely stops the session.
  //
  // Which makes `exited` a FLOOR, not the whole answer — it knows the deliberate stop and no other death.
  // A BROKER claude row can do better, because its daemon publishes a discovery record naming its pid; an
  // app-server codex row still has only the stamp. See the first branch below.
  function paneDeadForRow(row: SessionRow): boolean {
    // A BROKER claude row has a second, honest reading available: its daemon's own discovery record.
    // `exited` covers only the deliberate stop, which is why a daemon killed outright used to leave this
    // false forever — and with it every background shell the dead process owned, rendering as live. See
    // defaultBrokerDaemonAlive; it fails safe to ALIVE, so this can only ever ADD deaths frizz can prove.
    if (isBrokerClaudeRow(row)) return row.exited === 1 || !brokerDaemonAlive(row.session_id)
    if (isHeadlessRow(row)) return row.exited === 1
    const binding = adoptionBinding(row)
    if (binding.kind === "conflict") return true
    return paneDead(row.slug)
  }

  // ---- Off-loop pane-capture prefetch --------------------------------------------------------------
  // The pane sniff is the tick's dominant cost: `capture-pane` is one tmux subprocess, ~105ms measured
  // on the maintainer's machine. Batching every quiet in-flight thread into ONE tmux invocation cut the
  // spawn COUNT, but that one invocation was still SYNCHRONOUS — a fork/exec + tmux round-trip whose
  // duration grows with the board's pane count, run on the event loop every tick. And any thread whose
  // pane was absent from the batch fell back to a per-slug `capture-pane`, so a board with N exited/
  // reaped panes paid N synchronous spawns per tick — 13-15 spawns / 2-4s measured 2026-07-23.
  //
  // So the prefetch now runs OFF the loop: at the END of each tick we kick a single async batched
  // `capture-pane` (tmux.capturePanesAsync) for every unbound row with a live-or-frozen pane, and the
  // NEXT tick's sniff reads its result from `paneTextCache`. Nothing in the tick body ever blocks on a
  // capture. The verdict it feeds (a permission prompt) is already gated on PERM_SNIFF_MS of quiet and
  // confirmed over CLAUDE_PERMISSION_CONFIRM_POLLS, so a ≤1-tick-older capture changes no outcome — and
  // an absent pane simply isn't in the cache (empty text), never a synchronous per-slug spawn.
  //
  // `capturePanesAsync` is undefined only for narrow test fixtures that inject a synchronous `capturePane`
  // fake; those keep the old in-tick synchronous fallback below (byte-identical to the pre-batch path).
  let paneTextCache: Map<string, string> | null = null
  let paneTextRefreshing = false

  function paneTextPrefetchSlugs(): string[] {
    const slugs: string[] = []
    for (const row of deps.storage.allSessions()) {
      if (isHeadlessRow(row)) continue // headless (codex app-server / claude broker): no pane to capture
      if (adoptionBinding(row).kind !== "unbound") continue // adopted rows capture by exact pane tuple
      // A command list ABORTS at its first bad target, so only ask for panes tmux actually knows. The
      // liveness map is already cached, so this filter is free. A dead-but-present pane is kept —
      // remain-on-exit panes still hold the boot-failure/frozen-modal text the sniff and captureStall read.
      slugs.push(row.slug)
    }
    return slugs
  }

  // Kick the async batched capture (single-flight). Fire-and-forget from the tick end; its result is
  // swapped into paneTextCache for subsequent ticks to serve. Never awaited on the tick path.
  function refreshPaneTextAsync(): void {
    if (!capturePanesAsync || paneTextRefreshing) return
    const slugs = paneTextPrefetchSlugs()
    if (slugs.length === 0) {
      paneTextCache = new Map()
      return
    }
    paneTextRefreshing = true
    Promise.resolve(capturePanesAsync(slugs))
      .then((map) => { paneTextCache = map })
      .catch(() => { /* transient tmux failure — keep the prior snapshot, retry next tick */ })
      .finally(() => { paneTextRefreshing = false })
  }

  function capturePaneForRow(row: SessionRow): string {
    const binding = adoptionBinding(row)
    if (binding.kind === "unbound") {
      const cached = paneTextCache?.get(row.slug)
      if (cached !== undefined) return cached
      // Async-prefetch mode (production): the cache is authoritative. A miss means the pane is absent
      // or not yet prefetched → empty, NEVER a synchronous per-slug spawn (that was the O(N) block).
      if (capturePanesAsync) return ""
      // Sync-fallback mode (test fixtures inject only capturePane): capture synchronously, as before.
      return capturePane(row.slug)
    }
    if (binding.kind === "conflict") return ""
    return ""
  }

  // Synchronous one-shot capture for the boot-failure stall log (captureStall fires once per stalled
  // row, guarded by stallLogged — not a per-tick cost — so a blocking capture here is fine, and it must
  // read the FROZEN remain-on-exit pane directly rather than the possibly-empty prefetch cache).
  function capturePaneForRowSync(row: SessionRow): string {
    const binding = adoptionBinding(row)
    if (binding.kind === "unbound") return capturePane(row.slug)
    return ""
  }
  // Default backend = this file's own corpus-verified Claude fold (identical to the injected
  // ClaudeBackend, which reuses the same applyRecord/parseLine/matchesPermPrompt). Tests never inject
  // a backend, so this default is the regression-proof path.
  const defaultBackend: TailBackend = {
    transcriptPath: (sessionId) => join(logDir, `${sessionId}.jsonl`),
    foldLine: (state, line) => {
      const rec = parseLine(line)
      // The tailer only ever hands foldLine the concrete TailState it constructs; applyRecord needs
      // Claude's full accumulator (sub-agent/ask tracking, lastKind/lastStopReason) the neutral
      // FoldState doesn't carry, so narrow back to it. Byte-identical to the pre-refactor fold.
      if (rec) applyRecord(state as TailState, rec)
    },
    matchesPermPrompt,
    detectBootModal: detectClaudeBootModal,
  }
  // Resolve the backend for a row by its `backend` column. Prod injects `backendFor` (claude|codex);
  // a single injected `backend` or the local default covers every row otherwise. For claude (and every
  // foreign maintainer terminal) this is the corpus-verified Claude fold — byte-identical to before.
  function resolveBackend(kind?: string): TailBackend {
    return deps.backendFor?.(kind) ?? deps.backend ?? defaultBackend
  }

  function persistCodexAutoTitle(row: SessionRow, state: TailState, runtimeGeneration: number): boolean {
    if (row.backend !== "codex" || !state.aiTitle?.trim()) return false
    try {
      return deps.storage.setAutoTitleIfCurrent(row.slug, state.aiTitle.trim(), {
        sessionId: row.session_id,
        nativeSessionId: row.agent_session_id ?? null,
        runtimeGeneration,
      })
    } catch {
      // Telemetry still carries the transcript-backed title for this process. A transient registry
      // write failure must not break tailing; the full replay on restart safely retries the same CAS.
      return false
    }
  }

  // Derive the surfaced view of a session's live sub-agents (insertion = dispatch order). A tracked
  // entry whose transcript file hasn't been touched in SUBAGENT_STALE_MS is reported "stale" — a
  // liveness fallback for a completion record we missed; one still being appended to is "running".
  // A tracked child is "stale" once we've resolved its transcript path and that file has gone
  // SUBAGENT_STALE_MS without an append (or no longer stats) — a liveness fallback for a completion we
  // missed. Before the path resolves (fresh dispatch) it stays "running" — it's just starting up.
  //
  // KNOWN HOLE, deliberately left as-is (audited 2026-08-02). `outputFile` is parsed out of the launch
  // ack's PROSE (launchOutputFile), so a harness wording change silently un-resolves it — and with no
  // path this returns false on EVERY clock, so such an entry can never go stale at all. That is
  // unbounded, and a child reading "running" forever also excuses its thread from the queue forever
  // (board.ts hasLiveOwnWork). Measured across this machine's whole corpus: 61 of 4068 kept-alive
  // dispatches (1.50%) resolved no output file, every one a `Spawned successfully … agent_id:
  // <name>@<session>` mailbox ack whose key is snake_case where this parser reads `agentId:` — and all
  // 61 sit in six session files last written 2026-07-08..13, so the shape is not in current use.
  // Timing out on the DISPATCH instant instead was tried and reverted: it regresses
  // tailer.descendants.test.ts, whose fixtures encode the case this would break — a direct child with no
  // ack-named path whose own `subagents/agent-<id>.jsonl` IS being appended to, and which is therefore
  // genuinely running. The right fix resolves the path from the SIDECAR INDEX (which already maps
  // toolUseId → transcript for exactly these rows) rather than putting a clock on the dispatch; that is
  // a liveness-resolution change worth doing on its own, with a live case to validate against.
  function entryStale(e: SubAgentEntry, nowMs: number): boolean {
    if (!e.outputFile) return false
    const m = mtimeMs(e.outputFile)
    return m === undefined || nowMs - m > SUBAGENT_STALE_MS
  }

  // The child's last-append instant (its output file's mtime, the same stat entryStale reads), as ISO
  // for the surfaced view. Undefined before the path resolves or when the file no longer stats — the
  // caller then simply omits lastActivityAt (an absent reading is correct; a fabricated one is not).
  function entryLastActivity(e: SubAgentEntry): string | undefined {
    if (!e.outputFile) return undefined
    const m = mtimeMs(e.outputFile)
    return m === undefined ? undefined : new Date(m).toISOString()
  }

  // Derive the surfaced view of a session's live SUB-AGENTS (kind "agent"; insertion = dispatch order),
  // each followed by its own live DESCENDANTS in depth-first order — so a worker that fanned out through
  // a sub-agent reads as the tree it is, on every surface, instead of as one opaque row.
  //
  // A direct child's view object is deliberately left BYTE-IDENTICAL to what it was before nesting
  // existed: `depth` is emitted only from 2 down, and absent means 1 everywhere it is read.
  function subAgentViews(state: TailState, nowMs: number): SubAgentView[] {
    if (state.subAgents.size === 0 && state.retiredSubAgents.size === 0) return []
    const subtrees = descendantSubtrees(state, nowMs)
    const out: SubAgentView[] = []
    for (const e of state.subAgents.values()) {
      if (e.kind !== "agent") continue
      const lastActivityAt = entryLastActivity(e)
      // Each progress field is spread in only when the provider reported it, so a prose-only child's
      // view object is byte-identical to what it was before this existed.
      const p = e.progress
      out.push({
        label: e.label,
        startedAt: e.startedAt,
        state: entryStale(e, nowMs) ? "stale" : "running",
        subagentType: e.subagentType,
        id: e.toolUseId,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        ...(p?.activity ? { activity: p.activity } : {}),
        ...(p?.activityDetail ? { activityDetail: p.activityDetail } : {}),
        ...(p?.summary ? { summary: p.summary } : {}),
        ...(p?.toolUses !== undefined ? { toolUses: p.toolUses } : {}),
        ...(p?.totalTokens !== undefined ? { tokens: p.totalTokens } : {}),
        ...(p?.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      })
      const subtree = subtrees.get(e.toolUseId)
      if (subtree) out.push(...subtree)
    }
    // The RESTED roots (see anchorRoots): a child whose run ended while its own fan-out kept running.
    // Only the ones that actually produced a subtree — a retired child with nothing live under it is
    // finished work and belongs in the ring, off every live surface, exactly as before.
    //
    // Appended AFTER the live rows rather than interleaved by instant: the live map's insertion order IS
    // dispatch order and a good deal of the board's copy leans on it, while the ring is ordered by
    // retirement. Two honest orders beat one invented one, and the rested rows are the smaller set.
    for (const dead of state.retiredSubAgents.values()) {
      const subtree = subtrees.get(dead.toolUseId)
      if (!subtree || subtree.length === 0) continue
      const lastActivityAt = dead.outputFile ? mtimeMs(dead.outputFile) : undefined
      out.push({
        label: dead.label,
        // Its real dispatch instant, so the row's duration keeps reading "how long this branch has been
        // going". `finishedAt` is the fallback for a row retired before this field existed (the durable
        // tail cache can hold those across an upgrade); the oldest live grandchild's spawn is the last
        // resort. Every one of the three is a measured instant — never a fabricated one.
        startedAt: dead.startedAt ?? dead.finishedAt ?? subtree[0].startedAt,
        state: "rested",
        subagentType: dead.subagentType,
        id: dead.toolUseId,
        ...(lastActivityAt === undefined ? {} : { lastActivityAt: new Date(lastActivityAt).toISOString() }),
      })
      out.push(...subtree)
    }
    return out
  }

  // Derive the surfaced view of a session's live background SHELLS (kind "shell"; DISPLAY-ONLY — the
  // "background running" chip on the launch record, nothing more). A background Bash/Monitor is a CHILD
  // of the agent process running this session — it cannot outlive it. So the death of that process (it
  // exited/crashed WITHOUT emitting each shell's terminal <task-notification>) means every tracked shell
  // died with it: report none rather than leaving them to read as live (the UI would otherwise show them
  // "alive", quietly breathing, forever). The normal path — a shell exiting while the agent lives —
  // still clears via its terminal notification.
  //
  // `paneDead` is that death, and it is NOT a tmux fact: a headless row (broker claude / app-server
  // codex) has no pane at all and answers from its exit stamp — plus, for a broker row, a probe of its
  // daemon's own pid — instead. See paneDeadForRow, where asking tmux about a paneless row silently
  // emptied this list for every broker thread, and where the stamp ALONE later kept a dead process's
  // shells breathing here for seven hours (2026-08-02).
  //
  // A tracked, pane-alive shell is simply "running" — there is no age-based staleness. `run_in_background`
  // cannot tell a CI watcher (ends soon) from a vite dev server (runs forever), so NO clock is a correct
  // clock: an mtime rule falsely killed quiet watchers, and an absolute-age cap would falsely kill
  // long-lived servers. None of that can bury a thread: a shell does not excuse a rest from the queue
  // (board.deriveNeedsYou reads hasLiveBackgroundWork, which is sub-agent-only), so the worst a
  // never-clearing entry can do is leave a card saying a shell is running — the thread is queued and in
  // front of the operator either way. It clears on the shell's real terminal signal or on owner death.
  function bgShellViews(state: TailState): BgShellView[] {
    if (state.subAgents.size === 0 || state.paneDead) return []
    const out: BgShellView[] = []
    for (const e of state.subAgents.values()) {
      if (e.kind !== "shell") continue
      const lastActivityAt = entryLastActivity(e)
      // `stoppable` is only HALF the answer here — "frizz holds a provider task handle for this shell".
      // board.ts ANDs it with the thread's transport before the × is offered (see BgShellView.stoppable).
      // Emitted only when a handle exists, so the row cannot advertise a control during the window
      // between its tool_use (which creates the entry) and its launch ack (which names the task).
      out.push({ label: e.label, startedAt: e.startedAt, state: "running", id: e.toolUseId, ...(e.taskId ? { stoppable: true } : {}), ...(lastActivityAt ? { lastActivityAt } : {}) })
    }
    return out
  }

  // CODEX's background shells, which come from the app-server's item stream rather than from the fold.
  // They are a separate function and not a branch inside `bgShellViews` because they share nothing with
  // it: no `subAgents` entry, no output file to stat, no launch ack to parse. What they DO share is the
  // row: same shape, same ×, same `stoppable` contract — so the client cannot tell the two apart, which
  // is the point.
  //
  // The row's `id` is the `processId` itself. Unlike a Claude shell (whose id is the launch tool_use id
  // and whose task id is looked up separately), codex has exactly one handle and it is the one the kill
  // needs, so there is nothing to correlate and no window where the row exists without it.
  function codexBgShellViews(state: TailState): BgShellView[] {
    if (!deps.codexBackgroundExecs || state.foreign || state.paneDead) return []
    const execs = deps.codexBackgroundExecs(state.slug, state.sessionId)
    return execs.map((exec) => ({
      label: unwrapShellCommand(exec.command) ?? "Background command",
      // Carried SEPARATELY from the label even though they are the same string here: it is the client's
      // reconciliation key against the transcript's own copy of this shell, and the label is free to
      // become something friendlier later without silently breaking that.
      ...(unwrapShellCommand(exec.command) ? { command: unwrapShellCommand(exec.command)! } : {}),
      startedAt: new Date(exec.startedAtMs).toISOString(),
      state: "running" as const,
      id: exec.processId,
      stoppable: true,
      // Codex hands a yielded command's output back only when the MODEL polls it — there is no file
      // for frizz to tail, so the row carries its × and no drill-in rather than opening a drawer that
      // could only say "unavailable".
      outputUnavailable: true,
    }))
  }

  // A compact change-key over ALL derived background state — sub-agents + shells + the pending ask —
  // so the tick marks the board dirty on any add/removal, a sub-agent running→stale flip (purely
  // time-based, no new record), or an ask appearing/clearing. Without it those changes would linger to
  // the next reconcile. (Shells no longer have a time-based flip, but their add/removal still counts.)
  //
  // lastActivityAt is folded in at MINUTE granularity, never raw: the reading is displayed as
  // "N min ago", so a running child whose mtime advances every append only needs to re-push when its
  // displayed minute would change — at most once a minute per active child, not once an append.
  //
  // Provider progress joins on the same terms. `activity` and `toolUses` change together, once per tool
  // the child runs — the exact granularity the operator wants to see move. `summary` is folded in too
  // (it changes rarely). Raw TOKEN counts are deliberately NOT here: they can advance on every progress
  // event without the rendered line changing meaningfully, and pushing a board delta for that is churn.
  function derivedSignature(state: TailState, nowMs: number): string {
    const agents = subAgentViews(state, nowMs).map((v) => `A:${v.label}|${v.state}|${v.startedAt}|${activityMinute(v.lastActivityAt)}|${v.activity ?? ""}|${v.activityDetail ?? ""}|${v.toolUses ?? ""}|${v.summary ?? ""}`).join("")
    // Codex's shells join the key on the same terms: they come off a live stream rather than the fold,
    // so an exec starting or ending changes NOTHING on disk and would otherwise wait for the next
    // reconcile to reach the board.
    const shells = [...bgShellViews(state), ...codexBgShellViews(state)].map((v) => `S:${v.label}|${v.state}|${v.startedAt}|${activityMinute(v.lastActivityAt)}`).join("")
    const ask = state.pendingAsk ? `Q:${state.pendingAsk.id}:${state.pendingAsk.questions.length}` : ""
    return `${agents}\n${shells}\n${ask}`
  }

  // ---- descendant resolution (see the DescendantSidecar note above) ------------------------------
  // One directory read per thread per CHANGE to its subagents dir. The drawer POLLS, so re-reading
  // every sidecar per poll would turn an open drawer into a disk loop; and a new descendant at any
  // depth is a new FILE in that flat dir, which is exactly what moves the dir's mtime. A sidecar is
  // written once at spawn and not rewritten, so mtime is a complete invalidation signal here.
  const descendantIndex = new Map<string, { at: number | undefined; all: DescendantSidecar[]; byToolUse: Map<string, DescendantSidecar> }>()
  const subtreeMemo = new Map<string, { at: number | undefined; second: number; live: number; retired: number; terminals: number; value: Map<string, SubAgentView[]> }>()

  function sessionDirOf(state: TailState): string {
    return state.path.replace(/\.jsonl$/, "")
  }

  function descendantSidecars(state: TailState): DescendantSidecar[] {
    const at = mtimeMs(join(sessionDirOf(state), "subagents"))
    const cached = descendantIndex.get(state.slug)
    if (cached && cached.at === at) return cached.all
    const all = readDescendantSidecars(sessionDirOf(state), mtimeMs)
    const byToolUse = new Map<string, DescendantSidecar>()
    for (const meta of all) if (meta.toolUseId) byToolUse.set(meta.toolUseId, meta)
    descendantIndex.set(state.slug, { at, all, byToolUse })
    return all
  }

  function descendantSidecar(state: TailState, id: string): DescendantSidecar | undefined {
    descendantSidecars(state) // refresh the index if the dir moved
    return descendantIndex.get(state.slug)?.byToolUse.get(id)
  }

  // Where the descendant's own transcript sits — the same flat dir, beside its sidecar.
  function descendantTranscript(state: TailState, meta: DescendantSidecar): string {
    return join(sessionDirOf(state), "subagents", `agent-${meta.agentId}.jsonl`)
  }

  // LIVE DESCENDANTS of one sub-agent, as the provider stop handles that end them.
  //
  // `stopTask` ends EXACTLY the task it names. The registry behind it is flat and session-wide, so a
  // sub-agent's own fan-out holds registrations of its own that its parent's id does not cover:
  // stopping the parent leaves every grandchild running, and — because that same flatness routes a
  // completion to the SESSION's main loop rather than to whoever dispatched it — those orphans keep
  // burning tokens and then deliver their reports into the ROOT thread, under an agent the operator
  // watched die. Measured on nub session a0c5fba3 (2026-07-31): the × set `stoppedByUser` on
  // `adabd4aeedf52ef6c`, whose transcript stops at 19:54:22, while its two live children — neither
  // carrying `stoppedByUser` — went on writing until 19:56:09 and 19:56:44 and landed their results in
  // the root transcript. So a stop that means "this work ends" has to name every task in the subtree.
  //
  // Keyed by the row's DISPATCH tool_use id, resolved through the same flat sidecar index the drawer
  // uses; children link upward by the AGENT id their sidecar is named for, not by that dispatch id.
  function subAgentDescendantTasks(slug: string, id: string): string[] {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return []
    const all = descendantSidecars(state)
    if (all.length === 0) return []
    const rootAgentId = descendantSidecar(state, id)?.agentId
    if (!rootAgentId) return [] // nothing on disk claims this dispatch — no subtree to reach
    const byAgentId = new Map<string, DescendantSidecar>()
    for (const meta of all) byAgentId.set(meta.agentId, meta)

    // Hops from the root, or undefined when this sidecar does not descend from it. Bounded exactly
    // like every other walk over `parentAgentId` here: the links come off an unvalidated flat
    // directory, so a malformed or cyclic one must resolve to nothing rather than spin.
    const depthBelowRoot = (meta: DescendantSidecar): number | undefined => {
      let cur = meta
      for (let hops = 1; hops <= DESCENDANT_DEPTH_MAX; hops++) {
        if (!cur.parentAgentId) return undefined
        if (cur.parentAgentId === rootAgentId) return hops
        const next = byAgentId.get(cur.parentAgentId)
        if (!next) return undefined
        cur = next
      }
      return undefined
    }

    const found: Array<{ agentId: string; depth: number }> = []
    for (const meta of all) {
      if (meta.agentId === rootAgentId) continue
      const depth = depthBelowRoot(meta)
      if (depth === undefined) continue
      // RUNNING only, for the same reason the surfaced tree is running-only: a sidecar is written once
      // and never deleted, so admitting "stale" would fire a stop at every grandchild that ever ran.
      if (descendantState(state, meta) !== "running") continue
      found.push({ agentId: meta.agentId, depth })
    }
    // DEEPEST FIRST. The stops are sequential and a still-running agent can dispatch another child
    // between two of them, so going bottom-up leaves no window where a freshly-spawned grandchild
    // outlives the parent that was already stopped.
    found.sort((a, b) => b.depth - a.depth)
    return found.map((entry) => entry.agentId)
  }

  // A descendant's liveness, in order of authority.
  //
  //  1. The provider's own task table, when it holds the row — its task id IS the agent id, and it says
  //     outright whether the child finished. Broker rows only; a tmux row has no such table.
  //  2. This thread's own transcript: the descendant's terminal <task-notification>, folded by
  //     trackCompletions into `descendantTerminals`. Available on EVERY backend, because it rides the
  //     file the tailer already reads. See recordDescendantTerminal for why it exists.
  //  3. Silence, the coarse fallback — the same mtime rule every tracked child uses.
  //
  // (2) is measured against the transcript rather than trusted outright, because the same task-id
  // notifies again each time a resumable descendant stops: a transcript still advancing WELL past its
  // last notification is a descendant that was resumed, and it must read running again. "Well past" is
  // the grace below, not zero — the notification is written a beat after the descendant's own final
  // record, and the two instants come from different clocks (a record timestamp vs a file mtime).
  // Deliberately never "done" on a guess: a child that has merely gone quiet, with nothing having
  // reported it finished, still reads "stale".
  function descendantState(state: TailState, meta: DescendantSidecar): "running" | "stale" | "done" {
    const task = deps.runtimeTasks?.(state.sessionId).find((entry) => entry.taskId === meta.agentId)
    if (task?.terminal) return "done"
    const at = mtimeMs(descendantTranscript(state, meta))
    const notified = state.descendantTerminals?.get(meta.agentId)
    if (notified !== undefined && (at === undefined || at <= notified + DESCENDANT_NOTIFY_GRACE_MS)) return "done"
    return at === undefined || now() - at > SUBAGENT_STALE_MS ? "stale" : "running"
  }

  // How deep the surfaced tree goes. A bound, not an opinion: `parentAgentId` comes off an unvalidated
  // flat directory, so a malformed (or cyclic) link must not be able to recurse without end. Real
  // fan-out is 2-3 levels; anything past this is a broken sidecar, not a real orchestration.
  const DESCENDANT_DEPTH_MAX = 16

  // ---- RESTED roots: a child whose run ENDED while its own fan-out kept running -------------------
  //
  // `status: completed` does NOT mean a sub-agent is finished. The harness says so itself, in the very
  // notification that carries it (real bytes, nub session 5258ebe4, 2026-07-29):
  //
  //   <status>completed</status>
  //   <summary>Agent "Sweep corpus for system-library grants" finished</summary>
  //   <note>A task-notification fires each time this agent stops with no live background children of its
  //   own. The user can send it another message and resume it, so the same task-id may notify more than
  //   once.</note>
  //   <result>I've launched five parallel sweep agents … plus a Monitor … I'll continue once that
  //   notification lands.</result>
  //
  // That child had RESTED holding five live grandchildren, and its own transcript kept appending two
  // minutes later. frizz retired it on the notification (correctly — that is the only terminal signal it
  // gets) and the whole branch went dark: the root's row left every surface, and `rootedInAnchor` then
  // dropped its five RUNNING grandchildren too, because a descendant may only hang off a root the thread
  // still tracks. Six rows of live fan-out, invisible under the prompt box — for 107 s in that session,
  // and only because the coordinator happened to re-steer the child (trackResumes revives on the restart
  // ack); with no re-steer the branch stays invisible for as long as it runs. That is the bug this exists
  // to close, reported by the maintainer as "it totally disappeared from the UI".
  //
  // So a retired child STILL ANCHORS its subtree, and is surfaced as `rested` for exactly as long as
  // something under it is running. It self-retires on the same terms every descendant row does — when
  // the last live grandchild goes quiet, `shown` empties, the anchor produces no subtree, and the row
  // goes away. Nothing can dangle.
  //
  // `killed` is deliberately excluded. That status means the OPERATOR dismissed the row (the × says
  // "stop tracking this finished operation"), a `TaskStop` ended it, or the owning process died and a
  // new session swept it — each an explicit "this branch is over", which frizz must honour over any
  // mtime under it. Only the ambiguous terminals (`completed`/`failed`, the ones a resumable rest also
  // emits) keep anchoring.
  //
  // Ordered: live children in dispatch order first, then rested ones in retirement order.
  function anchorRoots(state: TailState): Set<string> {
    const out = new Set<string>()
    for (const entry of state.subAgents.values()) if (entry.kind === "agent") out.add(entry.toolUseId)
    for (const dead of state.retiredSubAgents.values()) if (dead.status !== "killed") out.add(dead.toolUseId)
    return out
  }

  // ---- the surfaced view of DESCENDANTS ----------------------------------------------------------
  //
  // `subAgents` used to be direct children only, so a worker that fanned out THROUGH a sub-agent showed
  // one row and the whole branch under it was invisible on every surface (rail, card, ops strip,
  // completion hold). The sidecars already describe that tree; this turns them into rows.
  //
  // RUNNING-ONLY, deliberately. A descendant's sidecar is written once at spawn and never deleted, so
  // admitting "stale" would pin a phantom row under the thread FOREVER, one per grandchild that ever
  // ran. Running is the only reading that retires itself — and since descendantState folds the
  // descendant's own terminal <task-notification>, a rested one stops reading `running` the tick that
  // notification lands rather than 15 minutes later. The one exception is an ancestor of something
  // running: it keeps its row even when quiet, because otherwise a live great-grandchild would have
  // nothing to indent under and would read as a child of the wrong agent.
  //
  // Returns subtrees keyed by the DIRECT child they hang off, each already in depth-first order, so the
  // caller can splice each one in directly behind its parent's row and get a tree by reading top down.
  // A key may name a RETIRED direct child — see anchorRoots.
  function descendantSubtrees(state: TailState, nowMs: number): Map<string, SubAgentView[]> {
    const empty = new Map<string, SubAgentView[]>()
    // Nothing tracked ⇒ nothing a descendant could hang off. This is the common case for most threads,
    // and returning here keeps the sidecar dir off the tick's disk path entirely. A RETIRED child counts
    // as tracked here (it can still anchor a live branch), which is why the ring is consulted too.
    if (state.subAgents.size === 0 && state.retiredSubAgents.size === 0) return empty
    const all = descendantSidecars(state)
    if (all.length === 0) return empty

    // Every reading below costs a stat per descendant, and this runs from BOTH the projection and the
    // change signature on the same tick. Memo per (sidecar-dir mtime, tracked-child counts, second) so
    // those calls collapse into one pass — a one-second grain is far finer than the staleness window it
    // feeds, so no running→gone transition is held back by it.
    // A newly-folded descendant terminal moves NONE of the other keys — a notification is a record in
    // this thread's transcript, not a file in the sidecar dir — so without counting them here the row
    // it retires would sit on the board until the second ticked over, and a test that ticks twice in
    // one millisecond would never see the retirement at all.
    const second = Math.floor(nowMs / 1000)
    const dirAt = descendantIndex.get(state.slug)?.at
    const terminals = state.descendantTerminals?.size ?? 0
    const memo = subtreeMemo.get(state.slug)
    if (memo && memo.at === dirAt && memo.second === second && memo.live === state.subAgents.size && memo.retired === state.retiredSubAgents.size && memo.terminals === terminals) return memo.value

    const byAgentId = new Map<string, DescendantSidecar>()
    for (const meta of all) byAgentId.set(meta.agentId, meta)
    // One stat per sidecar per pass, not per lookup — `shown` and the emit both need the reading.
    const liveness = new Map<string, "running" | "stale" | "done">()
    const stateOf = (meta: DescendantSidecar): "running" | "stale" | "done" => {
      const cached = liveness.get(meta.agentId)
      if (cached) return cached
      const value = descendantState(state, meta)
      liveness.set(meta.agentId, value)
      return value
    }

    const anchors = anchorRoots(state)

    // Walk to the depth-1 ancestor and check this thread is still tracking it, live or RESTED.
    const rootedInAnchor = (meta: DescendantSidecar): boolean => {
      let cur = meta
      for (let hops = 0; hops <= all.length; hops++) {
        if (!cur.parentAgentId) return Boolean(cur.toolUseId && anchors.has(cur.toolUseId))
        const next = byAgentId.get(cur.parentAgentId)
        if (!next) return false
        cur = next
      }
      return false // a cyclic parent link — resolves to nothing rather than looping
    }

    const shown = new Set<string>()
    for (const meta of all) {
      if ((meta.spawnDepth ?? 1) < 2 || !meta.toolUseId) continue
      if (stateOf(meta) !== "running" || !rootedInAnchor(meta)) continue
      // Mark it and every descendant ancestor above it (the depth-1 root already has its own row).
      let cur: DescendantSidecar | undefined = meta
      for (let hops = 0; cur && (cur.spawnDepth ?? 1) >= 2 && hops <= all.length; hops++) {
        shown.add(cur.agentId)
        cur = cur.parentAgentId ? byAgentId.get(cur.parentAgentId) : undefined
      }
    }
    const remember = (value: Map<string, SubAgentView[]>): Map<string, SubAgentView[]> => {
      subtreeMemo.set(state.slug, { at: dirAt, second, live: state.subAgents.size, retired: state.retiredSubAgents.size, terminals, value })
      return value
    }
    if (shown.size === 0) return remember(empty)

    // Group the shown rows under their parent's DISPATCH id — the same id the parent's own row carries,
    // which is what lets the client join the two without knowing anything about agent ids.
    const kids = new Map<string, DescendantSidecar[]>()
    for (const meta of all) {
      if (!shown.has(meta.agentId)) continue
      const parentId = meta.parentAgentId ? byAgentId.get(meta.parentAgentId)?.toolUseId : undefined
      if (!parentId) continue
      const list = kids.get(parentId)
      if (list) list.push(meta)
      else kids.set(parentId, [meta])
    }
    // Dispatch order, so siblings read the way the parent fanned them out rather than by agent id.
    for (const list of kids.values()) list.sort((a, b) => (a.spawnedAtMs ?? 0) - (b.spawnedAtMs ?? 0))

    const subtrees = new Map<string, SubAgentView[]>()
    for (const rootId of anchors) {
      const out: SubAgentView[] = []
      const walk = (parentId: string, depth: number): void => {
        if (depth > DESCENDANT_DEPTH_MAX) return
        for (const meta of kids.get(parentId) ?? []) {
          const id = meta.toolUseId
          if (!id) continue // unreachable — `shown` requires one — but the row's drill-in handle is not optional
          const activeAt = mtimeMs(descendantTranscript(state, meta))
          out.push({
            label: meta.description ?? "sub-agent",
            // The sidecar's own mtime IS the spawn instant (written once, never rewritten), so the row
            // gets the same real "working for 38s" duration a direct child gets from its dispatch record.
            startedAt: new Date(meta.spawnedAtMs ?? nowMs).toISOString(),
            state: stateOf(meta) === "running" ? "running" : "stale",
            ...(meta.agentType ? { subagentType: meta.agentType } : {}),
            id,
            ...(activeAt === undefined ? {} : { lastActivityAt: new Date(activeAt).toISOString() }),
            depth,
            parentId,
          })
          walk(id, depth + 1)
        }
      }
      walk(rootId, 2)
      if (out.length > 0) subtrees.set(rootId, out)
    }
    return remember(subtrees)
  }

  // Resolve a tracked sub-agent (thread slug + dispatch tool_use id) to its transcript path + state —
  // the drill-in drawer's server-side lookup. Checks the LIVE map first (running/stale), then the
  // RETAINED ring (a completed child kept for review → "done"). Undefined only when the id is unknown
  // to both (never dispatched, or aged out of the ring) → the router maps that to "gone".
  function subAgentLookup(slug: string, id: string): SubAgentLookup | undefined {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return undefined
    // `outputFormat` is spread in only when set, so a Claude child's lookup shape is byte-identical.
    const live = state.subAgents.get(id)
    // A background SHELL shares this map (see backgroundShellLookup) and is emphatically not an agent:
    // there is nobody in there to read a steer. Only kind "agent" is ever `direct`.
    if (live) return {
      outputFile: live.outputFile,
      ...(live.outputFormat ? { outputFormat: live.outputFormat } : {}),
      state: entryStale(live, now()) ? "stale" : "running",
      direct: live.kind === "agent",
      ...(live.taskId ? { taskId: live.taskId } : {}),
      startedAt: live.startedAt,
    }
    const dead = state.retiredSubAgents.get(id)
    if (dead) return {
      outputFile: dead.outputFile,
      ...(dead.outputFormat ? { outputFormat: dead.outputFormat } : {}),
      state: "done",
      direct: false,
      ...(dead.startedAt ? { startedAt: dead.startedAt } : {}),
      ...(dead.finishedAt ? { finishedAt: dead.finishedAt } : {}),
      outcome: dead.status,
    }
    // A DESCENDANT — a child of a child, of a child, at any depth. Its dispatch is in an ANCESTOR's
    // transcript rather than this thread's, so neither map above can hold it; the flat sidecar index
    // resolves it by the same tool_use id. Still undefined when nothing matches, so an id frizz genuinely
    // cannot place keeps degrading to the drawer's stated "unavailable" — this ADDS a resolution, it
    // never invents one.
    const descendant = descendantSidecar(state, id)
    if (!descendant) return undefined
    return {
      outputFile: descendantTranscript(state, descendant),
      state: descendantState(state, descendant),
      direct: false,
      // Claude's sidecar filename is `agent-<agentId>.meta.json`; that agent id is also the
      // provider task id accepted by Query.stopTask. Unlike steering, stopTask's registry is
      // session-wide, so descendants are addressable without pretending their dispatch belonged
      // to the root thread.
      taskId: descendant.agentId,
    }
  }

  function backgroundShellLookup(slug: string, id: string): { command?: string; outputFile?: string; state: "running" | "done" } | undefined {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return undefined
    const live = state.subAgents.get(id)
    if (live?.kind === "shell") {
      return { command: live.command, outputFile: live.outputFile, state: state.paneDead ? "done" : "running" }
    }
    const dead = state.retiredShells.get(id)
    if (dead) return { command: dead.command, outputFile: dead.outputFile, state: "done" }
    return undefined
  }

  // Manual DISMISS (the × on a live op row): retire a live sub-agent/shell by its dispatch tool_use id
  // exactly as a real terminal signal would — into the retained ring (so its drawer still resolves),
  // status "killed" — so it leaves every live surface (banner, counts, completion-hold, sidebar) at
  // once, and onChange() reflects that immediately instead of waiting for the next tick. This is the
  // escape hatch for the ONE residual the `stopped` recovery can't reach: a finished op whose completion
  // was never recorded while its parent stays alive. It is NOT a process kill — frizz tracks these by
  // folding the worker's transcript and does not own the child processes, so a genuinely-still-running
  // child ends only when its owning pane dies; the × just stops frizz showing a phantom. Returns whether
  // an entry was actually live to dismiss (a no-op for an unknown/already-gone id).
  function dismissOp(slug: string, id: string): boolean {
    const state = states.get(slug)
    if (!state || !registeredStateIsCurrent(state)) return false
    // DURABLE FIRST, and unconditionally — before the in-memory retirement and regardless of whether
    // anything was live to retire. The in-memory maps do not survive a frizz restart, and the op's
    // dispatch record does; a dismissal that lived only in memory is exactly how a killed shell came
    // back reading "57hr 18m" on the maintainer's board. Recording it for an id that is already gone
    // is harmless (the fold simply never mints it again) and is the honest reading of the click.
    state.dismissedOps.add(id)
    deps.storage.retireOp(slug, state.sessionId, id)
    const entry = state.subAgents.get(id)
    if (entry) {
      retireLive(state, entry, new Date(now()).toISOString(), "killed")
      deps.onChange()
      return true
    }
    // A RESTED root (see anchorRoots): already retired, but still surfaced because live descendants hang
    // off it. The × on that row means the same thing it means anywhere else — stop showing me this — so
    // re-stamp it `killed`, the one status that stops anchoring. The row keeps its place in the ring, so
    // its drawer still resolves; the branch leaves every live surface on the next frame.
    const dead = state.retiredSubAgents.get(id)
    if (!dead || dead.status === "killed") return false
    dead.status = "killed"
    // The subtree memo keys on the sidecar dir's mtime and the two map SIZES, none of which this touches,
    // so drop it explicitly — otherwise the click's own board frame would still carry the branch.
    subtreeMemo.delete(slug)
    deps.onChange()
    return true
  }

  interface PaneSniff {
    permPrompt: boolean
    nativeInputRequired?: NativeInputRequiredData
  }

  function sameNativeInput(a: NativeInputRequiredData | undefined, b: NativeInputRequiredData | undefined): boolean {
    return a?.kind === b?.kind && a?.title === b?.title
  }

  // A live PermissionRequest marker (Claude workers with the frizz plugin) is an ACTIVE block iff the
  // policy hook DEFERRED it to a human AND its timestamp is newer than the last transcript activity —
  // a resolved request always advances the transcript past it. The caller gates this on
  // turn === "in-flight" (a real block is always mid tool_use) and on the row being non-codex, which
  // both bounds the per-tick file read to actively-working Claude sessions and means a stale marker on
  // a crashed/exited pane is inert (deriveRuntime returns "exited" before it ever consults permPrompt).
  function permMarkerBlocks(state: TailState, row: SessionRow): boolean {
    const marker = readPermMarker(row.slug)
    if (!marker) return false
    // RETAIN the policy's own decision for display, separately from the block verdict below. This is
    // the only durable record an auto-approval leaves anywhere: Claude Code renders "Allowed by
    // PermissionRequest hook" in the pane but writes NOTHING about an allow to the transcript
    // (verified 2026-07-25), so without this the dashboard could never say what frizz approved or why.
    // Retained on the state rather than recomputed per tick, so it survives the turn ending — a
    // decision stays readable after the worker moves on.
    // KNOWN BOUND (documented, not hidden): the hook keeps ONE marker per thread, overwritten by the
    // next request, so this is the LAST decision observed, not a full history. Denials additionally
    // land in the transcript permanently (the model reads the refusal), which is the consequential half.
    if (marker.decision === "allow" || marker.decision === "deny") {
      const at = Date.parse(marker.at)
      if (Number.isFinite(at) && at !== Date.parse(state.permPolicy?.at ?? "")) {
        state.permPolicy = {
          decision: marker.decision,
          rule: marker.rule ?? "unknown",
          reason: marker.reason ?? "",
          tool: marker.tool ?? null,
          at: marker.at,
          ...(marker.command ? { command: marker.command } : {}),
        }
        if (marker.decision === "deny") state.permDenies = (state.permDenies ?? 0) + 1
      }
    }
    // Policy-resolved requests are NOT human blocks. perm-policy.mjs records what it did, so an
    // auto-approved (or auto-denied) request leaves a marker exactly like a deferred one does — without
    // this gate every auto-approval would flash the thread onto "Needs you" for the tick before the
    // transcript advances past it, which is the very stall this hook exists to remove.
    if (markerDecision(marker) !== "defer") return false
    const at = Date.parse(marker.at)
    if (!Number.isFinite(at)) return false
    // Stale-generation guard: a marker written BEFORE this process generation's spawn belongs to an
    // already-ended block — e.g. a worker killed while parked on a prompt, then resumed. spawned_at is
    // bumped to the current generation on every (re)spawn (storage.beginRuntimeGeneration), so on prime
    // the replayed old transcript (lastActivityAt < at) would otherwise flash "Needs you" until the
    // resume record lands. An unparseable spawned_at skips this guard (never suppress a live block).
    const spawnedMs = Date.parse(row.spawned_at)
    if (Number.isFinite(spawnedMs) && at < spawnedMs) return false
    const last = state.lastActivityAt ? Date.parse(state.lastActivityAt) : Number.NEGATIVE_INFINITY
    return at > last
  }

  // Perm-blocked verdict for a session. PRIMARY: the structured PermissionRequest marker — precise (it
  // fires exactly when Claude created the prompt), so it surfaces immediately with no quiet-gate delay
  // and cannot false-trip on transcript text that merely LOOKS like a prompt. FALLBACK (unchanged): a
  // pane-sniff of a quiet in-flight turn, for the screens that emit no PermissionRequest (pre-boot
  // workspace-trust, /login and other selectors) and for plugin-less foreign sessions. The native
  // structured detector (Codex) still rides the same single capture.
  //
  // KNOWN EDGE (accepted): a background sub-agent completing WHILE the parent is blocked appends a
  // system user-record that advances lastActivityAt past the marker, so permMarkerBlocks briefly reads
  // false. This is not a regression — it degrades to the regex fallback, which re-detects the real
  // modal after PERM_SNIFF_MS of quiet (the same latency the pre-marker path always had).
  function sniffPane(
    state: TailState,
    row: SessionRow,
    turn: TurnState,
    nowMs: number,
    backend: TailBackend,
  ): PaneSniff {
    void nowMs; void backend
    if (state.foreign) return { permPrompt: false }
    // The MARKER path is all that is left, and it is the one that always worked headlessly: the
    // cc-worker hook writes a marker into FRIZZ_PERM_DIR when a tool call is waiting on the operator.
    // Below this there used to be a fallback that captured the tmux pane and matched the TUI's modal
    // chrome by regex — the only way to see a prompt in a pane. There are no panes, and a broker
    // thread's approvals arrive as typed permission requests over the control channel anyway.
    if (turn === "in-flight" && row.backend !== "codex" && permMarkerBlocks(state, row)) {
      return { permPrompt: true }
    }
    return { permPrompt: false }
  }
  const states = new Map<string, TailState>()
  // FOREIGN thread tails, keyed by session id (separate map so a session-id key can never collide
  // with or shadow a registered slug's TailState in `states`). Entries persist once discovered — a
  // file that ages out of the fresh set keeps its cached tail here but stops being reported.
  const foreignStates = new Map<string, TailState>()
  // The current fresh foreign set (mtime-desc, capped), refreshed on scan ticks and reused between.
  let foreignFresh: { id: string; path: string }[] = []
  let foreignScanTick = 0
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  // Set for the duration of the FIRST tick only (see start): the launcher's progress signal.
  let primeProgress: ((done: number, total: number) => void) | undefined

  // Discover FOREIGN sessions: *.jsonl in the log dir whose stem is not any registered row's
  // session_id, touched within FOREIGN_FRESH_MS, most-recent-first, capped at FOREIGN_MAX. Registered
  // rows always win. Defensive: any fs error (dir/file) is skipped silently — discovery degrades to
  // "no foreign threads", never throws.
  function scanForeign(nowMs: number): { id: string; path: string }[] {
    let names: string[]
    try {
      names = readdirSync(logDir)
    } catch {
      return []
    }
    const registered = new Set<string>()
    for (const r of deps.storage.allSessions()) {
      registered.add(r.session_id)
      // A DISCOVERED (drifted) transcript is owned by its row — exclude its id too, or the re-linked
      // file would resurface as a duplicate read-only "foreign" thread (split-brain).
      if (r.transcript_id) registered.add(r.transcript_id)
    }
    // Graveyard: a transcript whose row was hard-deleted via forgetSession must STAY gone — never let a
    // dismissed phantom's *.jsonl re-surface as a read-only foreign thread on a later rescan.
    for (const id of deps.storage.forgottenIds()) registered.add(id)
    const found: { id: string; path: string; mtime: number }[] = []
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".jsonl")) continue
      const id = name.slice(0, -".jsonl".length)
      if (!id || registered.has(id)) continue // registered rows win — never also foreign
      const path = join(logDir, name)
      let mtime: number
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (nowMs - mtime > FOREIGN_FRESH_MS) continue // aged out of the freshness window
      found.push({ id, path, mtime })
    }
    found.sort((a, b) => b.mtime - a.mtime)
    return found.slice(0, FOREIGN_MAX).map(({ id, path }) => ({ id, path }))
  }

  // Tail one FOREIGN state: same fold/derivation as a registered session (consume → computeTurn →
  // derivedSignature, priming the first sighting silently) but with NO pane sniff, NO pane-death
  // check, and NO notify / storage write — a foreign thread has no tmux session and no registry row.
  // Returns whether its derived telemetry changed (→ board dirty). Pushes to transcriptDirty on bytes.
  function tailForeign(state: TailState, nowMs: number, transcriptDirty: string[], backend: TailBackend): boolean {
    const key = `foreign:${state.slug}`
    if (!state.primed) {
      const primeOffset = state.offset
      consume(state, backend)
      if (state.offset !== primeOffset) transcriptDirty.push(state.slug)
      state.turn = computeTurn(state, nowMs)
      state.subAgentsSig = derivedSignature(state, nowMs)
      state.primed = true
      // Foreign maintainer terminals are the LARGEST transcripts on the board (a day of a human's own
      // Claude session) and there are up to FOREIGN_MAX of them, so they are worth caching for exactly
      // the same reason registered rows are.
      if (state.offset !== primeOffset || !cacheHydrated.has(key)) cacheDirty.add(key)
      cacheHydrated.delete(key)
      return true // surface the newly-discovered thread
    }
    const prevActivity = state.lastActivityAt
    const prevAssistant = state.lastAssistant
    const prevModel = state.model
    const prevEffort = state.effort
    const prevPermissionMode = state.permissionMode
    const prevOffset = state.offset
    consume(state, backend)
    if (state.offset !== prevOffset) {
      transcriptDirty.push(state.slug)
      cacheDirty.add(key)
    }
    let dirty = false
    const nextTurn = computeTurn(state, nowMs)
    if (state.turn !== nextTurn) {
      state.turn = nextTurn // foreign: a turn transition NEVER notifies or writes storage
      dirty = true
    }
    const sig = derivedSignature(state, nowMs)
    if (sig !== state.subAgentsSig) {
      state.subAgentsSig = sig
      dirty = true
    }
    if (
      state.lastActivityAt !== prevActivity ||
      state.lastAssistant !== prevAssistant ||
      state.model !== prevModel ||
      state.effort !== prevEffort ||
      state.permissionMode !== prevPermissionMode
    ) dirty = true
    return dirty
  }

  // Delivery-ledger fold for one registered CLAUDE row's tick: `onLine` correlates each appended JSONL
  // record against the row's pending follow-ups (delivery-ledger.ts); `finish()` ages the items
  // (pending→unconfirmed timeout, unconfirmed drop) and persists any transition, returning true so the
  // caller re-projects the transcript + dirties the board. Rows with an empty ledger cost one null
  // check. CODEX rows fold too now: their ledger entry is a rendering guarantee for the queued bubble
  // (the app-server bridge still owns delivery and dedups on deliveryId), and correlateDeliveryRecord
  // recognises the rollout's own user-message shape so the entry drops the moment codex materialises
  // the message.
  // The delivery-ledger fold and the codex sub-agent tracker were mutually exclusive while the ledger
  // was claude-only; a codex row now runs BOTH, so the single per-line hook `consume` accepts has to
  // carry them together. Returns undefined when neither applies, so the common path is unchanged.
  function chainOnLine(
    a: ((line: string) => void) | undefined,
    b: ((line: string) => void) | undefined,
  ): ((line: string) => void) | undefined {
    if (!a) return b
    if (!b) return a
    return (line: string) => { a(line); b(line) }
  }

  function ledgerFold(
    row: SessionRow,
    nowMs: number,
  ): { onLine?: (line: string) => void; finish: () => { changed: boolean; value: string | null } } {
    if (!row.delivery_ledger) {
      return { finish: () => ({ changed: false, value: null }) }
    }
    let items: DeliveryLedgerItem[] = parseDeliveryLedger(row.delivery_ledger)
    const before = items
    const nowIso = new Date(nowMs).toISOString()
    return {
      onLine: (line: string) => {
        if (!line.trim() || !items.length) return
        let rec: unknown
        try {
          rec = JSON.parse(line)
        } catch {
          return
        }
        items = correlateDeliveryRecord(items, rec, nowIso)
      },
      finish: () => {
        items = ageDeliveries(items, nowMs)
        if (items === before) return { changed: false, value: null }
        const value = serializeDeliveryLedger(items)
        deps.storage.setDeliveryLedger(row.slug, value)
        return { changed: true, value }
      },
    }
  }

  // The CODEX counterpart of trackDispatches: codex's sub-agent signals (`spawn_agent`,
  // sub_agent_activity, list_agents) live on their own axis rather than in NormalizedEvent, so they
  // ride the same per-line `consume(..., onLine)` seam the delivery ledger uses — and the two never
  // collide, because ledgerFold is claude-only and this is codex-only. The tracker writes straight
  // into this state's live/retired maps, so the board strip, hasLiveOps, the completion-hold dialog
  // and the drill-in drawer all light up for codex with no further plumbing. Returns undefined for a
  // claude row (one string compare) so the claude path is byte-identical.
  function codexSubAgentOnLine(row: SessionRow, state: TailState): ((line: string) => void) | undefined {
    if (row.backend !== "codex") return undefined
    const tracker = (state.codexSubAgents ??= createCodexSubAgentTracker({
      codexHome: deps.codexHome,
      sink: {
        setLive: (id, e) => {
          const previous = state.subAgents.get(id)
          state.subAgents.set(id, {
            kind: "agent",
            toolUseId: id,
            label: e.label,
            startedAt: e.startedAt,
            subagentType: e.subagentType,
            // Only ever set once the child's rollout is located; until then the entry is live with no
            // file, which entryStale correctly reads as "just starting up", not stale.
            outputFile: e.outputFile ?? previous?.outputFile,
            outputFormat: "codex",
          })
        },
        retire: (id, finishedAt, status) => {
          const entry = state.subAgents.get(id)
          if (entry) retireLive(state, entry, finishedAt, status)
        },
      },
    }))
    return (line: string) => tracker.onLine(line)
  }

  // ---- durable prime cache (tail-cache.ts) ------------------------------------------------------
  // Loaded lazily on the first tick, consumed once per slug. Entries that miss their fence are simply
  // never applied: the row then folds from byte 0, exactly as it always did.
  let cacheEntries: Map<string, TailCacheEntry> | null = null
  // Slugs whose cached entry is stale (or absent) and must be (re)written at the next flush.
  const cacheDirty = new Set<string>()
  // Slugs that were restored from the cache on this boot — used to skip rewriting an entry that is
  // already byte-accurate, so a warm boot of thousands of threads writes nothing at all.
  const cacheHydrated = new Set<string>()
  let cachePruned = false
  let lastCacheFlushMs = 0

  // Registered slugs and FOREIGN thread ids live in separate namespaces (the tailer keeps two maps for
  // exactly that reason), so they get separate key spaces in the one cache table too.
  const cacheKey = (state: TailState): string => (state.foreign ? `foreign:${state.slug}` : state.slug)

  // Restore a freshly-created state from the durable cache so the prime below resumes the fold at the
  // cached byte offset instead of at 0. `row` is null for a foreign thread (it has no registry row).
  // Returns true only when EVERY fence held. Any doubt — a different session/generation, a different
  // transcript path, an open delivery ledger, a file whose inode/size/content moved under the cached
  // prefix, an undecodable blob — returns false and leaves the state untouched, which is the full
  // re-read.
  function hydrateFromCache(state: TailState, row: SessionRow | null, nativeId: string): boolean {
    if (!tailCache) return false
    if (cacheEntries === null) cacheEntries = tailCache.load()
    const key = cacheKey(state)
    const entry = cacheEntries.get(key)
    if (!entry) return false
    cacheEntries.delete(key) // one shot: a rebind within this process must re-derive, not re-restore
    if (
      entry.sessionId !== (row ? row.session_id : state.sessionId) ||
      entry.nativeSessionId !== nativeId ||
      entry.runtimeGeneration !== (row ? row.runtime_generation ?? 0 : 0) ||
      entry.path !== state.path
    ) return false
    // A row with an OPEN delivery ledger has follow-ups whose evidence may still be sitting in the
    // prefix we would skip. Correlating those records is the ledger's whole job, so such a row keeps
    // the full replay — there are only ever a handful, and they are the actively-steered threads.
    if (row?.delivery_ledger) return false
    // A CODEX row keeps the full replay too. This prime cache predates the codex sub-agent tracker
    // (`state.codexSubAgents`, a live object with methods) and cannot round-trip it — a restored plain
    // blob has no `.poll`. And resuming the parent fold mid-file would skip the `spawn_agent` records
    // in [0, offset) the tracker rebuilds itself from. Codex threads full-replay exactly as before.
    if (row?.backend === "codex") return false
    const current = measureFence(entry.path, entry.offset)
    if (!current || !fenceMatches(entry, current)) return false
    const decoded = decodeTailState(entry.state)
    if (!decoded) return false
    if (decoded.offset !== entry.offset || typeof decoded.partial !== "string") return false
    // Lifecycle collections must survive the round trip with their native collection types; a plain
    // object here crashes the incremental fold on the first completion after restart.
    for (const field of ["subAgents", "retiredSubAgents", "queuedReports", "retiredShells"]) {
      if (!(decoded[field] instanceof Map)) return false
    }
    if (!(decoded.deliveredReports instanceof Set)) return false
    // `Record` is shadowed in this module by the JSONL record interface — spell the index type out.
    const target = state as unknown as { [key: string]: unknown }
    for (const [key, value] of Object.entries(decoded)) {
      if (UNRESTORED_TAIL_FIELDS.has(key)) continue
      target[key] = value
    }
    cacheHydrated.add(key)
    return true
  }

  // The durable record of `state` at its current byte cursor, or null when it must not be cached: a
  // state bound to nothing yet, a row with an open delivery ledger, or a file that will not stat/read.
  function cacheSnapshot(state: TailState, row: SessionRow | null): TailCacheEntry | null {
    // Codex rows are never cached — the prime cache predates their live sub-agent tracker and cannot
    // round-trip it (see hydrateFromCache). Never persisting them keeps hydrate a guaranteed miss.
    if (state.offset <= 0 || row?.delivery_ledger || row?.backend === "codex") return null
    const fence = measureFence(state.path, state.offset)
    if (!fence) return null
    return {
      slug: cacheKey(state),
      sessionId: state.sessionId,
      nativeSessionId: state.nativeSessionId,
      runtimeGeneration: state.runtimeGeneration,
      path: state.path,
      state: encodeTailState(state),
      ...fence,
    }
  }

  // Persist every dirty state in one transaction. Best-effort by construction — a failure costs the
  // next boot its speedup and nothing else.
  function flushCache(nowMs: number): void {
    if (!tailCache) return
    lastCacheFlushMs = nowMs
    if (!cachePruned) {
      cachePruned = true
      try {
        const live = new Set<string>()
        for (const row of deps.storage.allSessions()) live.add(row.slug)
        for (const id of foreignStates.keys()) live.add(`foreign:${id}`)
        tailCache.prune(live)
      } catch {
        // a stale row can only ever fail its fence
      }
    }
    if (cacheDirty.size === 0) return
    const entries: TailCacheEntry[] = []
    try {
      for (const key of cacheDirty) {
        const foreign = key.startsWith("foreign:")
        const state = foreign ? foreignStates.get(key.slice("foreign:".length)) : states.get(key)
        if (!state) continue
        const row = foreign ? null : deps.storage.getSession(key) ?? null
        if (!foreign && !row) continue
        const entry = cacheSnapshot(state, row)
        if (entry) entries.push(entry)
      }
    } catch {
      // stop() flushes on the shutdown path; a registry that has already gone away must not turn a
      // clean shutdown into a failed one. Whatever was collected before the fault is still written.
    }
    cacheDirty.clear()
    tailCache.put(entries)
  }

  // Read whatever has been appended since our last offset, folding each complete line into the
  // derivation. Handles: file-not-yet-created (ENOENT → skip), truncation/rotation (size < offset
  // → re-read from 0), and a trailing partial line (buffered until its newline arrives).
  // `onLine` (optional) sees each complete appended line AFTER the fold — the delivery-ledger
  // correlation seam for registered Claude rows; unset everywhere else (zero cost).
  function consume(state: TailState, backend: TailBackend, onLine?: (line: string) => void): void {
    let size: number
    try {
      size = statSync(state.path).size
    } catch {
      return // file not written yet (agent still booting) or transiently unreadable
    }
    if (size < state.offset) {
      // truncated/rotated — restart the derivation from the top of the new file
      state.offset = 0
      state.partial = ""
    }
    if (size <= state.offset) return
    let chunk = ""
    try {
      const fd = openSync(state.path, "r")
      try {
        const buf = Buffer.allocUnsafe(size - state.offset)
        const read = readSync(fd, buf, 0, buf.length, state.offset)
        chunk = buf.toString("utf8", 0, read)
        state.offset += read
      } finally {
        closeSync(fd)
      }
    } catch {
      return // read raced with a write/unlink — try again next tick
    }
    const lines = (state.partial + chunk).split("\n")
    state.partial = lines.pop() ?? "" // last element is the (possibly empty) trailing partial
    for (const line of lines) {
      backend.foldLine(state, line)
      onLine?.(line)
    }
  }

  // Every OTHER row's pinned + discovered id — the exclude set so discovery never steals a transcript
  // already claimed by a different thread. (Only called on a real discovery attempt, which is rare.)
  function claimedIds(exceptSlug: string): Set<string> {
    const ids = new Set<string>()
    for (const r of deps.storage.allSessions()) {
      if (r.slug === exceptSlug) continue
      ids.add(r.session_id)
      if (r.transcript_id) ids.add(r.transcript_id)
    }
    return ids
  }

  // Capture a stalled worker's (remain-on-exit) pane ONCE, so claude's own boot-failure output survives
  // to the server console + a per-session sink before the pane is ever killed. Best-effort — the whole
  // point is root-causing the missing transcript, but a capture failure must never break the tick.
  function captureStall(state: TailState, row: SessionRow): void {
    if (state.stallLogged) return
    state.stallLogged = true
    let pane = ""
    try {
      pane = capturePaneForRowSync(row)
    } catch {
      pane = ""
    }
    // Boot-failure auth classifier (claude-auth plan): a worker that dies before writing a transcript
    // with the 401/login text on its pane is a rejected credential, not a generic stall. Only the
    // typed category persists — the raw pane (which may carry OAuth URLs/codes from a login attempt)
    // is REDACTED from the console line and the stall sink in this case.
    const authFailure = row.backend !== "codex" && isClaudeAuthErrorText(pane)
    if (authFailure) state.authFault = "authentication_rejected"
    // A headless row has no tmux pane at ALL (capturePaneForRowSync is skipped for it upstream), so the
    // generic "Pane: (pane empty / unavailable)" line sent whoever read it to tmux for a runtime that
    // never had a pane — measured cost on 2026-07-31, a real boot failure investigated at the wrong
    // layer first. Name the evidence that DOES exist for this runtime instead: for the broker that is the
    // daemon's own diagnostics log, which records the session's lifecycle and any dropped input.
    const evidence = isBrokerClaudeRow(row) && deps.project.stateDir
      ? `no tmux pane (broker runtime). Daemon diagnostics: ${claudeBrokerDiagnosticLogPath(deps.project.stateDir, row.session_id)}`
      : isHeadlessRow(row)
      ? `no tmux pane (headless ${row.backend === "codex" ? "codex app-server" : "claude broker"} runtime)`
      : ""
    const detail = authFailure
      ? "(claude authentication failure — pane content redacted; sign in and retry)"
      : pane.trim() || evidence || "(pane empty / unavailable)"
    frizzLog.error(
      "tailer",
      `thread ${row.slug} (session ${row.session_id}): no transcript ${DISCOVERY_GRACE_MS / 1000}s after dispatch — likely a boot failure. ${isHeadlessRow(row) && !pane.trim() && !authFailure ? "" : "Pane:\n"}${detail.slice(0, 4000)}`,
    )
    try {
      mkdirSync(STALL_LOG_DIR, { recursive: true })
      writeFileSync(join(STALL_LOG_DIR, `${row.slug}.stall.log`), `session_id: ${row.session_id}\ncaptured_at: ${new Date(now()).toISOString()}\n\n${detail}\n`)
    } catch {
      // best-effort — a missing sink is inert
    }
  }

  // READ-SIDE TRANSCRIPT DISCOVERY for a registered row whose bound file hasn't produced bytes yet.
  // Byte-identical for the healthy path: once a file binds (offset > 0) this is a no-op, and a
  // within-grace missing file is left to the ordinary spinning-up spinner. ONLY a past-grace missing
  // file engages discovery (throttled); on a hit it re-links + caches the drifted transcript and replays
  // it silently (primed=false → the next prime adopts it with no notify), on a miss it flags the row
  // no-transcript (a boot failure) so the board shows a degraded state, not an eternal spinner.
  function resolveTranscript(state: TailState, row: SessionRow, nowMs: number): boolean {
    if (state.offset > 0) return true // already bound to a real transcript — the normal path, untouched
    // Presence alone isn't enough: a worker that creates `<id>.jsonl` then crashes before writing a
    // single record leaves a permanent 0-byte file. Treat empty-or-missing alike so a touched-but-never-
    // written transcript can't silently defeat the crash-net (found in review). A stat failure → size 0.
    let size = 0
    try {
      size = statSync(state.path).size
    } catch {
      size = 0
    }
    if (size > 0) {
      // Real content present (or just appeared) — clear any prior degraded state and let consume bind it.
      state.noTranscript = false
      state.stallLogged = false
      return true
    }
    // Empty/missing but still within the grace window → an ordinary just-spawned session (spinner). Wait.
    const spawnedMs = Date.parse(row.spawned_at)
    if (Number.isFinite(spawnedMs) && nowMs - spawnedMs < DISCOVERY_GRACE_MS) return true
    // Past grace, still missing: attempt discovery (throttled), else declare the transcript missing.
    if (nowMs < state.nextDiscoverMs) return true
    state.nextDiscoverMs = nowMs + DISCOVER_RETRY_MS
    const found = discoverTranscriptId(logDir, row.session_id, { nowMs, exclude: claimedIds(row.slug) })
    if (found && found !== row.session_id) {
      // Commit ownership before touching the in-memory path. A stale A snapshot must never bind A's
      // discovered transcript under a same-slug replacement B, even transiently between tail ticks.
      let committed = false
      try {
        committed = deps.storage.setTranscriptIdIfCurrent(
          row.slug,
          row.session_id,
          row.runtime_generation ?? 0,
          found,
        )
      } catch {
        committed = false
      }
      if (!committed) return false
      // Re-link to the drifted transcript: rebind the read path, cache it (survives restart + dedupes
      // foreign discovery), and replay it as a fresh prime so no historical turn-done fires spuriously.
      state.path = join(logDir, `${found}.jsonl`)
      state.offset = 0
      state.partial = ""
      state.primed = false
      state.noTranscript = false
      state.stallLogged = false
      return true
    }
    // Nothing to bind: the worker never wrote a transcript → degraded/stalled, captured once for triage.
    state.noTranscript = true
    captureStall(state, row)
    return true
  }

  function tick(): void {
    // Discover sessions from the registry so dispatch/resume/restart all "just work" — a new row
    // starts being tailed on the next tick; a finished row keeps its final derived state.
    let dirty = false
    // Any session whose provider events have outrun its transcript this tick → ask for another look
    // once the tick finishes (see chaseRuntime). One flag for the whole board: the nudge is coalesced
    // anyway, so per-session bookkeeping would buy nothing.
    let chaseWanted = false
    // Slugs whose JSONL advanced this tick (offset moved) → their transcript may have changed. Fed to the
    // /ws transcript producer at the end so it pushes only for genuinely-changed threads.
    const transcriptDirty: string[] = []
    const nowMs = now()
    // paneTextCache holds the LAST async prefetch's result and is read (never written) during the tick;
    // a fresh batched capture is kicked off the loop at the tick's end (see refreshPaneTextAsync).
    adoptionBindings = new Map()
    const rows = deps.storage.allSessions()
    let primed = 0
    for (const row of rows) {
      if (primeProgress && primed % PRIME_PROGRESS_EVERY === 0) primeProgress(primed, rows.length)
      primed++
      // Per-row backend + the DISCOVERED transcript stem. Both backends decouple the transcript id from
      // the pinned session_id, via DIFFERENT columns (only one is ever set): codex pins its rollout id on
      // `agent_session_id` (post-dispatch discovery); claude caches a drifted stem on `transcript_id`
      // (read-side discovery). So `agent_session_id ?? transcript_id ?? session_id` is the effective stem
      // for either — a claude row (agent_session_id NULL) falls to transcript_id ?? session_id (its old
      // deterministic path); a codex row (transcript_id NULL) falls to agent_session_id ?? session_id.
      const backend = resolveBackend(row.backend)
      const nativeId = row.agent_session_id ?? row.transcript_id ?? row.session_id
      let state = states.get(row.slug)
      const runtimeGeneration = row.runtime_generation ?? 0
      if (
        !state ||
        state.sessionId !== row.session_id ||
        state.nativeSessionId !== nativeId ||
        state.runtimeGeneration !== runtimeGeneration
      ) {
        // claude.transcriptPath always returns the logDir join; codex.transcriptPath resolves the
        // date-sharded rollout by id (or undefined before its id is pinned → the join is a harmless
        // placeholder until discovery pins it).
        const path = backend.transcriptPath(nativeId) ?? join(logDir, `${nativeId}.jsonl`)
        state = newTailState(row.slug, row.session_id, path, false, nativeId, runtimeGeneration)
        // BEFORE any fold. This is the durable memory of the operator's × (storage `retired_op`), and
        // the fold consults it as it reads dispatch records — so it has to be populated while the state
        // is still empty, not after. Without it a killed shell is re-minted from a dispatch record that
        // will never get a terminal partner, and the row reads "running" for as long as the thread
        // lives (the maintainer's 57-hour phantom).
        state.dismissedOps = deps.storage.retiredOps(row.slug, row.session_id)
        // Resume the fold at the byte offset the last process reached, when the transcript can be
        // PROVEN to still carry the prefix that produced it. On a miss the state stays fresh and the
        // prime below folds from 0 — the historical path, unchanged.
        hydrateFromCache(state, row, nativeId)
        // AND AGAIN, after the cache. There are TWO ways a retired op comes back and the durable set
        // has to beat both: the fold re-reading its dispatch record (handled inside trackDispatches)
        // and the tail CACHE, which serialises `subAgents` wholesale and restores it without folding
        // anything. The cache is written on a tick, so an × clicked after the last one is simply not in
        // it — the row returned on the next boot looking exactly as live as before the click. Caught by
        // the restart test in tailer.test.ts, not by reasoning.
        for (const id of state.dismissedOps) {
          state.subAgents.delete(id)
          state.pendingShells?.delete(id)
        }
        states.set(row.slug, state)
      }

      // Read-side discovery: rebind a drifted transcript / flag a boot-failure stall. A no-op for a
      // healthy bound session (offset > 0). May rebind + reset primed → the prime branch below replays
      // the discovered file silently. Track noTranscript flips so the degraded runtime surfaces promptly.
      // CLAUDE-ONLY: the discovery scan targets the claude log dir + scratchpad sentinel; a codex row
      // locates its rollout by the agent_session_id pinned at dispatch, so running claude discovery on it
      // would wrongly flag noTranscript (a codex discovery-miss is a separate follow-up).
      const prevNoTranscript = state.noTranscript
      if (row.backend !== "codex" && !resolveTranscript(state, row, nowMs)) continue

      // First sighting of a session (fresh dispatch OR restored after a server restart): read the
      // whole transcript to date and adopt its state as the baseline WITHOUT firing turn-done /
      // exited notifies — those pre-restart events are history, not new activity.
      if (!state.primed) {
        const primeOffset = state.offset
        const primeLedger = ledgerFold(row, nowMs)
        consume(state, backend, chainOnLine(primeLedger.onLine, codexSubAgentOnLine(row, state)))
        state.codexSubAgents?.poll(nowMs)
        const primedLedger = primeLedger.finish()
        state.deliveryLedgerSeen = primedLedger.changed ? primedLedger.value : row.delivery_ledger ?? null
        if (primedLedger.changed) transcriptDirty.push(row.slug)
        persistCodexAutoTitle(row, state, runtimeGeneration)
        // Drain the fold's un-retirements: an op the agent RESTARTED under an id the operator had
        // dismissed is live work again, and its registry row has to go or the next prime would hide it.
        if (state.unretiredOps?.size) {
          for (const id of state.unretiredOps) deps.storage.unretireOp(row.slug, row.session_id, id)
          state.unretiredOps.clear()
        }
        if (state.offset !== primeOffset) transcriptDirty.push(row.slug)
        state.turn = turnFor(row, state, nowMs)
        const pane = sniffPane(
          state,
          row,
          state.turn,
          nowMs,
          backend,
        )
        state.permPrompt = pane.permPrompt
        state.nativeInputRequired = pane.nativeInputRequired
        state.paneDead = paneDeadForRow(row)
        applyRuntimeTasks(row, state, nowMs)
        applyRuntimeContextWindow(row, state)
        state.subAgentsSig = derivedSignature(state, nowMs)
        state.primed = true
        // Cache what this prime derived, unless it came from the cache and consumed nothing — in which
        // case the stored entry is already byte-accurate and rewriting it is pure work.
        if (state.offset !== primeOffset || !cacheHydrated.has(row.slug)) cacheDirty.add(row.slug)
        cacheHydrated.delete(row.slug)
        if (state.permissionMode) {
          const saved = PermissionMode.safeParse(row.permission_mode)
          const observedAt = state.permissionModeAt ? Date.parse(state.permissionModeAt) : NaN
          const spawnedAt = Date.parse(row.spawned_at)
          // An idle reattach is not guaranteed to append a new profile sidecar before the next turn
          // (verified on both standalone TUIs). Preserve a valid exact launch mode across restart;
          // backfill only unknown legacy rows, or accept a timestamped Codex event from this process
          // generation. Incremental sidecars below still persist genuine live transitions.
          // An app-server thread is the ONE case where the rollout is not evidence about frizz's thread:
          // the same file is written by any terminal `codex resume` (config default `workspace-write`)
          // and by the app-server's own config-defaulted cold resume. Folding that back over the stored
          // mode does not just mis-DISPLAY the thread — `sandboxFor` reads this column, so the next cold
          // resume then REQUESTS the downgraded sandbox, making a transient observation permanent. The
          // bridge is the authority for those rows; only backfill a row whose mode is unknown.
          const observedMayOverwrite = row.backend === "codex" && row.codex_runtime !== "app-server"
          const observedIsCurrent = !saved.success || (observedMayOverwrite && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt)
          if (observedIsCurrent && (!saved.success || saved.data !== state.permissionMode)) {
            deps.storage.setObservedPermissionIfCurrent(
              row.slug,
              row.session_id,
              runtimeGeneration,
              state.permissionMode,
            )
          }
        }
        dirty = true // surface the restored overlay
        continue
      }

      const prevActivity = state.lastActivityAt
      const prevAssistant = state.lastAssistant
      const prevAiTitle = state.aiTitle
      const prevModel = state.model
      const prevEffort = state.effort
      const prevProfileRevision = state.profileRevision ?? 0
      const prevPermissionMode = state.permissionMode
      const prevPermissionRevision = state.permissionModeRevision ?? 0
      const prevOffset = state.offset
      // Snapshot the turn BEFORE the fold. A codex fold (applyEvent) writes state.turn INLINE on
      // task_started/task_complete, so by the time we diff below state.turn already holds the new value
      // — comparing against it would miss the transition (no turn-done notify). Claude's applyRecord
      // never touches state.turn (computeTurn derives it), so prevTurn === state.turn for claude here:
      // byte-identical. This makes the transition edge backend-agnostic.
      const prevTurn = state.turn
      const rowLedger = row.delivery_ledger ?? null
      const ledgerDrifted = rowLedger !== (state.deliveryLedgerSeen ?? null) // a router write with no JSONL advance
      const ledger = ledgerFold(row, nowMs)
      consume(state, backend, chainOnLine(ledger.onLine, codexSubAgentOnLine(row, state)))
      // Child rollouts advance on their OWN clock, so poll every tick — not only when the parent
      // appended. This is what flips a finished codex child out of the live set (and, once every
      // child is done, releases the thread from Active into the queue).
      state.codexSubAgents?.poll(nowMs)
      const ledgerResult = ledger.finish()
      state.deliveryLedgerSeen = ledgerResult.changed ? ledgerResult.value : rowLedger
      if (ledgerDrifted || ledgerResult.changed) {
        transcriptDirty.push(row.slug) // the ledger projection changed even if no renderable record did
        dirty = true
      }
      const profileRecordLanded = (state.profileRevision ?? 0) !== prevProfileRevision
      if (profileRecordLanded && state.model && state.profileAt) {
        const observedAt = Date.parse(state.profileAt)
        const spawnedAt = Date.parse(row.spawned_at)
        const model = normalizeObservedThreadModel(row.backend ?? "claude", state.model)
        const effort = state.effort?.trim() || row.effort?.trim()
        if (model && effort && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt) {
          try {
            validateThreadProfile(row.backend ?? "claude", model, effort)
            deps.storage.setObservedProfileIfCurrent(
              row.slug,
              { sessionId: row.session_id, generation: runtimeGeneration },
              { model, effort },
            )
          } catch {
            // Unknown/incomplete provider telemetry is visible but never becomes a future launch target.
          }
        }
      }
      if (state.aiTitle !== prevAiTitle) persistCodexAutoTitle(row, state, runtimeGeneration)
      if (state.offset !== prevOffset) {
        transcriptDirty.push(row.slug)
        cacheDirty.add(row.slug) // the cached prefix is short by the bytes we just folded
      }
      if (chaseRuntime(row, state, state.offset !== prevOffset)) chaseWanted = true

      // turn transition (in-flight → idle): a completed turn. Mark unread + notify, gated on
      // last_read_at so a turn the user has already scrolled past doesn't re-badge.
      const nextTurn = turnFor(row, state, nowMs)
      if (prevTurn !== nextTurn) {
        if (prevTurn === "in-flight" && nextTurn === "idle") {
          onTurnDone(row, state)
          dirty = true
        } else {
          dirty = true // idle → in-flight (a new turn started): refresh the overlay badge
        }
        state.turn = nextTurn
      }

      // interactive permission prompt: no jsonl signal, so pane-sniff a quiet in-flight turn.
      // Cleared automatically once jsonl activity resumes (turn no longer quiet) or the pane stops
      // matching. Rides the board snapshot only — no notify, no unread (it's not a completed turn).
      // App-server codex sessions are headless (no tmux pane): pane capture is meaningless and a
      // "missing pane" must NOT read as process death. Native approvals arrive via the bridge's
      // InteractionStore (surfaced through interactionPresence), not a scraped modal; rest is stamped
      // by onTurnDone off the rollout, not onPaneDeath.
      if (!isHeadlessRow(row)) {
        const pane = sniffPane(
          state,
          row,
          nextTurn,
          nowMs,
          backend,
        )
        if (pane.permPrompt !== state.permPrompt) dirty = true
        if (!sameNativeInput(pane.nativeInputRequired, state.nativeInputRequired)) dirty = true
        state.permPrompt = pane.permPrompt
        state.nativeInputRequired = pane.nativeInputRequired

        // pane death (tmux remain-on-exit pane went dead) — the agent process exited.
        // Asked only while the answer can still change anything. Once a row is stamped exited AND its
        // pane has been observed dead, the death edge has already fired and nothing un-exits a row —
        // so re-observing it every second buys nothing and costs the batched tmux inventory. On a board
        // of finished threads this is what makes an idle tick cost NO subprocess at all.
        if (row.exited !== 1 || !state.paneDead) {
          const dead = paneDeadForRow(row)
          if (dead && !state.paneDead) {
            onPaneDeath(row)
            dirty = true
          }
          state.paneDead = dead
        }
      } else {
        // No pane to sniff, but the "owning process is gone" flag still has to stay CURRENT: it is what
        // clears a headless thread's background shells when frizz stops the session, exactly as a dead
        // pane clears a tmux thread's. Assigned without the death EDGE — onPaneDeath stamps `exited`
        // and fires the one-shot notify, and for a headless row `exited` is the input here, not the
        // output. Left out, the prime-time reading would latch for the life of the process.
        state.paneDead = paneDeadForRow(row)
      }

      // The provider's own report of those ops, folded over the entries the transcript fold tracks:
      // progress the JSONL does not carry at all, plus terminal statuses that reach frizz SECONDS before
      // (or, when a notification never lands on disk, INSTEAD of) the prose the fold waits for.
      applyRuntimeTasks(row, state, nowMs)
      applyRuntimeContextWindow(row, state)

      // live background ops + pending ask: a dispatch/completion/launch changes the set, a running→stale
      // flip is purely time-based (no new record), and an ask appears/clears — recompute every tick.
      const sig = derivedSignature(state, nowMs)
      if (sig !== state.subAgentsSig) {
        state.subAgentsSig = sig
        dirty = true
      }

      if (state.lastActivityAt !== prevActivity || state.lastAssistant !== prevAssistant || state.aiTitle !== prevAiTitle) dirty = true
      const permissionRecordLanded = (state.permissionModeRevision ?? 0) !== prevPermissionRevision
      if (permissionRecordLanded && state.permissionMode) {
        if (row.backend === "codex") {
          // Same authority split as the prime path above: for an app-server row the bridge owns the
          // sandbox, and a rollout record written by some other reader of the shared file must not
          // rewrite it. A row with no valid stored mode is still worth backfilling.
          if (row.codex_runtime !== "app-server" || !PermissionMode.safeParse(row.permission_mode).success) {
            deps.storage.setObservedPermissionIfCurrent(row.slug, row.session_id, runtimeGeneration, state.permissionMode)
          }
        }
      }
      if (state.model !== prevModel || state.effort !== prevEffort || state.permissionMode !== prevPermissionMode) dirty = true
      // A no-transcript flip (grace expired with no file / a re-link cleared it) changes the derived
      // runtime but touches no activity/turn — mark dirty so the board rebuilds without waiting for the
      // periodic reconcile.
      if (state.noTranscript !== prevNoTranscript) dirty = true
    }

    // FOREIGN threads: refresh the fresh set on a scan tick (a change in membership/order is itself
    // dirty), then tail every fresh one (reusing the cached set between scans).
    if (foreignScanTick % FOREIGN_SCAN_EVERY === 0) {
      const next = scanForeign(nowMs)
      if (!sameForeign(next, foreignFresh)) dirty = true
      foreignFresh = next
    }
    foreignScanTick++
    // Foreign threads are Claude maintainer terminals discovered in the Claude log dir — always the
    // Claude fold (resolveBackend("claude") returns the injected ClaudeBackend, or the default).
    const foreignBackend = resolveBackend("claude")
    for (const f of foreignFresh) {
      let state = foreignStates.get(f.id)
      if (!state) {
        state = newTailState(f.id, f.id, f.path, true) // slug = session id = thread id for a foreign thread
        hydrateFromCache(state, null, f.id)
        foreignStates.set(f.id, state)
      }
      if (tailForeign(state, nowMs, transcriptDirty, foreignBackend)) dirty = true
    }

    // Persist the prime cache. The FIRST tick always flushes (that is the boot the next one inherits);
    // afterwards a growing transcript is written at most every CACHE_FLUSH_MS, so an active board costs
    // one small batched transaction per interval rather than one per tick.
    if (tailCache && (lastCacheFlushMs === 0 || nowMs - lastCacheFlushMs >= CACHE_FLUSH_MS)) {
      flushCache(nowMs)
    }

    if (dirty) deps.onChange()
    if (transcriptDirty.length) deps.onTranscriptChange?.(transcriptDirty)

    // Refresh the pane-text cache OFF the loop for the next tick's sniff (production only; test fixtures
    // with a synchronous capturePane fake take the in-tick fallback instead). Kicked last so it never
    // sits in front of this tick's board push.
    refreshPaneTextAsync()

    // A session's provider events have outrun its transcript — look again shortly. Last, so it can
    // never delay this tick's board push, and after refreshPaneTextAsync for the same reason.
    if (chaseWanted) nudge()
  }

  // in-flight → idle: the turn finished. Badge unread if this completion post-dates the last read,
  // and fire a one-shot turn-done notify (the transition itself is the dedupe).
  function onTurnDone(row: SessionRow, state: TailState): void {
    const generation = row.runtime_generation ?? 0
    const eventAt = state.lastActivityAt ?? new Date(now()).toISOString()
    // The rest moment drives the nav's most-recently-rested-first order. A DISCRETE event (once
    // per turn end), so rows move rarely and meaningfully — unlike continuous activity sorting.
    if (!deps.storage.setRestedAtIfCurrent(row.slug, row.session_id, generation, eventAt)) return
    if (landsAfterRead(eventAt, row.last_read_at)) {
      deps.storage.setUnreadIfCurrent(row.slug, row.session_id, generation, true)
    }
    deps.bus.publish({
      type: "notify",
      slug: row.slug,
      kind: "turn-done",
      title: row.slug,
      body: state.lastAssistant,
    })
  }

  // pane death: stamp exited (keeps the stored column honest for the overlay) + badge unread +
  // one-shot exited notify.
  function onPaneDeath(row: SessionRow): void {
    const generation = row.runtime_generation ?? 0
    const eventAt = new Date(now()).toISOString()
    if (!deps.storage.setRestedAtIfCurrent(row.slug, row.session_id, generation, eventAt)) return
    if (row.exited !== 1) {
      deps.storage.setExitedIfCurrent(row.slug, row.session_id, generation, true)
    }
    if (landsAfterRead(eventAt, row.last_read_at)) {
      deps.storage.setUnreadIfCurrent(row.slug, row.session_id, generation, true)
    }
    deps.bus.publish({ type: "notify", slug: row.slug, kind: "exited", title: row.slug, body: "Agent session ended" })
  }

  // The tick runs SYNCHRONOUSLY on the event loop, so its duration is a hard floor on every RPC reply,
  // board delta and transcript push the server owes a client while it runs. When it exceeds its own poll
  // period the server is, by definition, permanently behind — and the whole UI reads as laggy (the
  // 2026-07-23 report: "I mark something as done and the sidebar won't update for a number of seconds").
  // That regression is invisible without a signal, so say it once per occurrence and name the board size.
  // Silent on a healthy board — this must never become log noise.
  let overBudgetTicks = 0
  // Duration of the most recent tick — read by the self-scheduling poll below so a tick that costs more
  // than its own period yields the event loop for at least as long as it just held it.
  let lastTickMs = 0
  function tickWithBudget(): void {
    const started = performance.now()
    try {
      tick()
    } finally {
      const elapsed = performance.now() - started
      lastTickMs = elapsed
      lastTickEndedAtMs = now()
      if (elapsed > POLL_MS) {
        overBudgetTicks++
        // Log the first, then decimate: a saturated server must not spend its remaining budget logging.
        if (overBudgetTicks === 1 || overBudgetTicks % 30 === 0) {
          frizzLog.warn(
            "tailer",
            `tick took ${Math.round(elapsed)}ms (poll ${POLL_MS}ms, ${states.size} sessions) — ` +
            `the event loop is blocked for that long, so RPCs and board pushes are delayed (occurrence ${overBudgetTicks})`,
          )
        }
      }
    }
  }

  // SELF-SCHEDULING, not a fixed interval. A tick runs synchronously on the event loop, so a tick that
  // costs more than POLL_MS on a fixed interval leaves ZERO idle time between ticks: the loop is held
  // ~100% of the time and every RPC reply, board delta and transcript push queues behind it. That is
  // the "sidebar won't update for a number of seconds" report — the server is not busy, it is starved.
  // Scheduling the NEXT tick after the last one finishes, at a delay of at least what the last tick
  // cost, bounds the tailer's duty cycle at ~50% no matter how slow a tick gets. It degrades to a
  // slower poll under load instead of self-inflicting a stall, and returns to POLL_MS the moment ticks
  // are cheap again — this is level-triggered off measured cost, with no state to get stuck in.
  // A tick that throws is a bug worth seeing, but never worth the loop or the process. Decimated so a
  // persistently failing tick cannot itself become the outage.
  let tickFailures = 0
  function reportTickFailure(error: unknown): void {
    tickFailures++
    if (tickFailures === 1 || tickFailures % 50 === 0) {
      frizzLog.error("tailer", `tick threw (occurrence ${tickFailures}; the loop keeps running): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }

  function scheduleTick(): void {
    const delay = Math.min(MAX_POLL_MS, Math.max(POLL_MS, Math.round(lastTickMs)))
    timer = setTimeout(() => {
      timer = null
      // RE-ARM EVEN IF THE TICK THREW. tickWithBudget is try/finally, not try/catch, so an exception
      // out of tick() used to escape a timer callback — which in node means an uncaughtException and,
      // with no process-level handler anywhere in this server, the whole frizz process. The tailer is
      // the only source of turn/liveness telemetry: it must degrade to a logged bad tick, never take
      // the server (or its own loop) down with it.
      try { tickWithBudget() } catch (error) { reportTickFailure(error) }
      if (!stopped) scheduleTick()
    }, delay)
    timer.unref?.()
  }

  // ---- Event-driven nudge (the poll's latency floor, removed) ---------------------------------------
  // The adaptive poll above is level-triggered: it re-reads every session on a 1–10s cadence whether or
  // not anything happened, and a thread that just finished its turn waits out the remainder of that
  // cadence before the board moves. The Claude broker already knows the instant a session changed —
  // it receives the SDK's typed event stream — so a runtime event calls nudge() and the tick runs now.
  //
  // Two properties keep this from becoming its own stability problem:
  //  * COALESCED. A turn emits many events in a burst; one pending nudge covers all of them, because
  //    the tick is whole-board anyway. Cost is bounded by the throttle below, not by event rate.
  //  * DUTY-CYCLE PRESERVING. scheduleTick deliberately bounds the tailer at ~50% of the event loop by
  //    never starting a tick sooner than the last one cost. The nudge inherits that exact floor, so a
  //    chatty session can never starve RPCs and board pushes the way a fixed interval could.
  const NUDGE_MS = 25
  let nudgeTimer: NodeJS.Timeout | null = null
  let lastTickEndedAtMs = 0

  function nudge(): void {
    if (stopped || nudgeTimer) return
    // Same floor scheduleTick uses: at least NUDGE_MS, and never sooner after the previous tick than
    // that tick cost to run.
    const earliest = lastTickEndedAtMs + Math.max(NUDGE_MS, Math.round(lastTickMs))
    const delay = Math.max(NUDGE_MS, earliest - now())
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null
      if (stopped) return
      // Take over the poll's slot rather than running alongside it: clear the pending scheduled tick,
      // run now, then restart the regular cadence from this moment.
      if (timer) { clearTimeout(timer); timer = null }
      // Strictly more dangerous than the poll callback above: this one destroys the poll timer FIRST,
      // so a throwing tick would leave BOTH timers null and the tailer permanently dead — a frozen
      // board with a healthy-looking server. Proven against a real createTailer with an injected
      // storage error: 4 ticks/1.2s before, 0 ticks in the 3s after, revived only by a later nudge.
      try { tickWithBudget() } catch (error) { reportTickFailure(error) }
      if (!stopped) scheduleTick()
    }, delay)
    nudgeTimer.unref?.()
  }

  function registeredStateIsCurrent(state: TailState): boolean {
    const current = deps.storage.getSession(state.slug)
    return Boolean(
      current &&
      current.session_id === state.sessionId &&
      (current.runtime_generation ?? 0) === state.runtimeGeneration,
    )
  }

  return {
    get(slug) {
      // Registered states win the key; a foreign thread resolves by its session id (its thread id).
      const registered = states.get(slug)
      const s = registered && registeredStateIsCurrent(registered)
        ? registered
        : registered ? undefined : foreignStates.get(slug)
      if (!s) return undefined
      // pendingQuestion is DERIVED: the turn is at rest AND the latest assistant message still carries
      // an unanswered ```question fence (a user reply clears the flag and flips the turn in-flight).
      const pendingQuestion = s.turn === "idle" && s.lastAssistantHasQuestion
      const nowMs = now()
      return { turn: s.turn, permPrompt: s.permPrompt, permPolicy: s.permPolicy, permDenies: s.permDenies, nativeInputRequired: s.nativeInputRequired, model: s.model, effort: s.effort, profileAt: s.profileAt, profileRevision: s.profileRevision, permissionMode: s.permissionMode, permissionModeAt: s.permissionModeAt, permissionModeRevision: s.permissionModeRevision, lastActivityAt: s.lastActivityAt, lastAssistantAt: s.lastAssistantAt, lastAssistant: s.lastAssistant, aiTitle: s.aiTitle, customTitle: s.customTitle, customTitleRevision: s.customTitleRevision, subAgents: subAgentViews(s, nowMs), droppedReports: [...s.queuedReports.values()], bgShells: [...bgShellViews(s), ...codexBgShellViews(s)], pendingAsk: s.pendingAsk, pendingQuestion, lastAssistantAllDone: s.lastAssistantAllDone, lastUserAt: s.lastUserAt, lastUserText: s.lastUserText, lastFence: s.lastFence, noTranscript: s.noTranscript, authFault: s.authFault, limitFault: s.limitFault, contextTokens: s.contextTokens, contextWindow: s.contextWindow }
    },
    // The CURRENT fresh foreign session ids (mtime within FOREIGN_FRESH_MS, capped), mtime-desc. Kept
    // as the last scan's result — recomputed at most every FOREIGN_SCAN_EVERY ticks.
    foreignIds: () => foreignFresh.map((f) => f.id),
    subAgent: subAgentLookup,
    subAgentDescendantTasks,
    backgroundShell: backgroundShellLookup,
    // Registered rows only. A FOREIGN thread (a maintainer's own terminal) is not frizz's to declare
    // dead — nothing here owns its process — so it answers false and its cards are left alone.
    ownerGone: (slug) => states.get(slug)?.paneDead ?? false,
    dismissOp,
    forget(slug) {
      states.delete(slug)
      foreignStates.delete(slug)
    },
    notePermissionMode(slug, permissionMode) {
      const state = states.get(slug)
      if (state) {
        state.permissionMode = permissionMode
      }
    },
    start(onPrimeProgress) {
      if (timer) return
      stopped = false
      primeProgress = onPrimeProgress
      try {
        tick() // derive current state immediately (also restores state after a server restart)
      } finally {
        primeProgress = undefined
      }
      scheduleTick()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      if (nudgeTimer) clearTimeout(nudgeTimer)
      nudgeTimer = null
      // A clean shutdown is the cheapest moment to make the next boot free: write back everything the
      // periodic flush has not reached yet. A hard kill just costs that thread its delta re-read.
      flushCache(now())
    },
    tick,
    nudge,
  }
}

// An event "lands after last_read_at" when there is no prior read, or the event's timestamp is
// strictly newer than it. Bad/absent timestamps fail safe to marking unread.
function landsAfterRead(eventAt: string, lastReadAt: string | null): boolean {
  if (!lastReadAt) return true
  const e = Date.parse(eventAt)
  const r = Date.parse(lastReadAt)
  if (!Number.isFinite(e) || !Number.isFinite(r)) return true
  return e > r
}
