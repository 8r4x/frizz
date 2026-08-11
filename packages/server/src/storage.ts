import Database from "./sqlite.ts"
import { ThreadSlug, slugify, threadIdentityName } from "@frizz/shared"
import { createInteractionStore, type InteractionStore } from "./interaction-store.ts"
import { log } from "./logging.ts"

// The UI-state store (never .frizz/): session registry + settings. SQLite at
// stateDir/ui.db, WAL for concurrent read while the watcher writes. Frizz thread files stay
// the source of truth for STATUS; this DB holds only runtime overlay (which tmux session
// backs a thread, unread, last-read) and settings.

export interface SessionRow {
  slug: string
  session_id: string
  // Legacy column NAME, live column: the thread identity string (`frizz-<slug>`). It is not renamed
  // because every existing ui.db on disk carries it; see threadIdentityName.
  /**
   * LEGACY NAME. Nothing here has been a tmux session since the broker landed: this is the thread's
   * IDENTITY STRING, `frizz-<slug>`, re-derived and checked on every write by
   * validateSessionIdentity. It is not renamed because the column is load-bearing on disk in every
   * existing database; see the tmux invariant in ARCHITECTURE.md.
   */
  tmux_name: string
  spawned_at: string // ISO8601
  last_read_at: string | null // ISO8601
  unread: number // 0 | 1
  exited: number // 0 | 1
  archived: number // 0 | 1 — user hid the row from the nav; any respawn/resume un-archives
  rested_at: string | null // ISO8601 — when the agent last came to REST (turn end / pane death); drives nav order
  // 0 | 1 — the stored `title` is a machine GUESS (the prompt chop), not a real name. Display-only:
  // it is what makes the UI show "Spinning up…"/"Untitled thread" instead of an internal-looking slug.
  // It does NOT decide whether a later machine title may land — that is `title_locked` below.
  title_auto: number
  // 0 | 1 — a HUMAN named this thread (explicit rename, native /rename, or an adopted `.frizz/<slug>.md`
  // heading), so no backend auto-title may ever replace it. A title HARD-CODED by a dispatch CALLER is
  // NOT this: `Investigate acme/app#391` from the GitHub batch, or a parent agent's guess through
  // `mcp__frizz__spawn_thread`, is shown as a real name (title_auto = 0) yet stays replaceable, because
  // the worker's own title for the task is nearly always the more informative one. The human-facing
  // new-thread composer has no title field at all, so a dispatch title never means "a human typed this".
  // INVARIANT, relied on by the idempotent boot repair: title_locked = 1 ⇒ title_auto = 0.
  // Optional in the TS shape so the many pre-existing row literals keep their old semantics — absent
  // reads as "locked unless the title was a machine guess" (see sessionTitleLocked).
  title_locked?: number
  // 0 | 1 — the text currently in `title` is the WORKER's own name for its task (persisted from its
  // title signal by the auto-title CAS), not the dispatch chop the row was seeded with. `title_auto`
  // cannot answer this: it records how the row was SEEDED and is deliberately left alone when a
  // machine title lands, so a codex row reads `title_auto = 1` whether its title is still the prompt
  // chop or the worker's real name. The display side needs exactly that distinction — without it the
  // codex fallback had to assume the worst and showed "Untitled thread" for every rested codex thread,
  // discarding a perfectly good persisted title (maintainer 2026-08-07). Cleared by every other title
  // writer (human rename, re-dispatch) so it always describes the CURRENT text.
  // Optional in the TS shape for the same reason as `title_locked`: pre-existing row literals.
  title_agent?: number
  // ---- session-first columns (2026-07-09; all nullable — additive migration under a live server) ----
  title: string | null // dispatch title (new dispatches have no thread FILE to hold it); display prefers aiTitle
  // The filename stem of the DISCOVERED transcript when it drifted off the pinned `<session_id>.jsonl`
  // (a worker whose real transcript lives at a different id). NULL in the normal case — the read side
  // then binds `<session_id>.jsonl` directly. Cached by the tailer's discovery fallback so the drifted
  // path survives restarts AND so foreign-discovery doesn't surface the re-linked transcript as a
  // duplicate thread. See tailer.ts / discover.ts. session_id stays the pinned resume/scratchpad key.
  transcript_id: string | null
  // Lifecycle: 'open' | 'archived'. NULL = never explicitly set (pre-migration row) — the board derives
  // an effective state (archived flag ⇒ archived; paired legacy .frizz file with terminal status ⇒
  // archived; else open) so historical sessions don't flood the working rail. Written ONLY by explicit
  // Archive/Reopen (the done FENCE mutates nothing — maintainer-settled).
  state: string | null
  // Exact UTC instant chosen by the human. This is lifecycle metadata (like Archive), never inferred
  // from an agent fence. Optional keeps old fixtures/source-compatible; SQLite always returns null or
  // a concrete value after the additive migration.
  snoozed_until?: string | null
  // The follow-up this snooze owes at its deadline. NULL = a plain reminder snooze (the card just
  // re-surfaces, which is all a snooze ever did before). Non-NULL = the scheduler owns the expiry: it
  // bumps the thread with exactly this text, so the board must NOT clear such a row on elapse.
  snooze_prompt?: string | null
  // Event-snooze for the awaiting-background card: the `rested_at` value captured when the human snoozed
  // a "resting while its own sub-agents/shells run" card. The board hides that card while this equals the
  // CURRENT rested_at (the same rest), and re-surfaces it the moment rested_at advances — i.e. the parent
  // came to a new rest because a sub-agent/shell returned. NULL = no event-snooze armed. Distinct from
  // snoozed_until (a wall-clock park owned by the scheduler); this one clears itself on the next rest.
  bg_snooze_rested_at?: string | null
  // The thread's RECURRING PROMPT — one piece of text with up to three independent triggers
  // (scheduler.ts SOURCES 4, 5 and 7). `recurring_armed_at` is the GENERATION: editing the text or the
  // cadence mints a new one, so a delivery already queued under the old settings reads as superseded.
  recurring_prompt?: string | null
  // The three mechanisms. ALL 0 is the off state — the text and the cadence are kept so re-arming costs
  // no retyping, and there is deliberately no fourth `enabled` column that could disagree with these.
  //
  // NAME MAPPING, stated once: `recurring_on_rest` is the STOP HOOK, `recurring_on_schedule` is the
  // HEARTBEAT and `recurring_on_compact` is POST-COMPACTION — the names the panel, the API and the MCP
  // tool all use. The columns keep their trigger-shaped names because renaming them would mean
  // migrating rows that are armed right now, for no user-visible gain; everything above the storage
  // boundary speaks stopHook/heartbeat/postCompaction.
  recurring_on_rest?: number
  recurring_on_schedule?: number
  // POST-COMPACTION (scheduler SOURCE 7, added 2026-08-06). The trigger that exists because a worker's
  // context is emptiest exactly when nobody is there to re-orient it: the operator (or the worker)
  // links whatever doc it wrote in its scratch directory, and this hands that link back the moment the
  // window is summarized away. It replaced a hook that spliced a canonical scratchpad's head into the
  // context — the durable row is visible and editable in the thread footer, where a hook was neither.
  recurring_on_compact?: number
  // THE QUESTION HOLD (2026-08-11) — not a fourth trigger, a hold over all three. 1 = send nothing while
  // the thread is blocked on the human (an unanswered ```question fence, a native ask, a permission
  // prompt). It is stored beside the triggers rather than derived because it is an operator PREFERENCE
  // about this thread, and the scheduler must be able to read it without the panel being open.
  recurring_pause_on_questions?: number
  // The ON SCHEDULE trigger's cadence. Kept even while that trigger is off, so switching it back on
  // does not lose the interval the operator chose.
  recurring_interval_ms?: number | null
  recurring_armed_at?: string | null
  // Terminal-delivery stamps, ONE PER TRIGGER. They are separate because they answer different
  // questions: the schedule's is load-bearing (the next delivery is due an interval after THIS, so a
  // thread cannot accumulate a backlog), while the rest and post-compaction triggers' are only the
  // panel's "last sent" readout — they have no floor and fire on every rest / every compaction.
  recurring_rest_fired_at?: string | null
  recurring_schedule_fired_at?: string | null
  recurring_compact_fired_at?: string | null
  // Operator confirmation for one exact final ```awaiting fence generation. The board/scheduler ignore a
  // transcript proposal unless these match its current fence identity.
  awaiting_fence_id?: string | null
  awaiting_confirmed_at?: string | null
  meta: string | null // JSON blob for future annotations (unparsed here)
  seen_at: string | null // ISO8601 — interaction clearance: recorded when the human opens the thread
  plan_path: string | null // project-relative .frizz/plans/*.md this thread was dispatched from
  // Which agent backend serves this session (Codex-support epic). Optional in the TS shape (older rows
  // + the many test-fixture literals predate it); the SQLite column carries a "claude" DEFAULT so every
  // existing row and all current behavior are unchanged. Phase 1 only ever writes "claude".
  backend?: string
  // The backend's OWN native session id when it differs from the frizz-minted session_id (Codex-support
  // epic, Phase 2). Claude pins session_id via --session-id, so its native id IS session_id and this
  // stays NULL. Codex mints its OWN rollout id (discovered post-spawn), so session_id remains the frizz
  // UUID (the sentinel + scratchpad key) and the discovered codex id is pinned HERE — the id the tailer
  // locates the rollout with and resume re-attaches. Readers use `agent_session_id ?? session_id`, so a
  // claude row (NULL) is byte-identical to before.
  agent_session_id?: string | null
  // The resolved model + reasoning-effort values this session was STARTED with. These are deliberately
  // session metadata, not a live read of Settings: changing the global dispatch defaults later must not
  // relabel an existing thread. Nullable/optional keeps migrated, adopted-old, and foreign sessions honest
  // when frizz never observed a concrete CLI value.
  model?: string | null
  effort?: string | null
  // A live profile request is armed as one complete pair. The committed model/effort stay visible
  // and rollback-safe until the replacement generation reaches a proven idle composer.
  profile_pending_model?: string | null
  profile_pending_effort?: string | null
  // When the OPERATOR last set model/effort (ISO). Sibling of permission_set_at: only setProfile (the
  // codex-only setThreadProfile path) stamps it — never the tailer's observed write-back. The board
  // prefers the saved model/effort over an older observed turn_context when this is newer, so a codex
  // model/effort change shows on the composer selector immediately instead of snapping back to the
  // stale value until the next turn. Null on pre-migration, never-set, and Claude rows.
  profile_set_at?: string | null
  profile_revision?: number
  // Versioned crash journal for an in-flight model/effort reattach. This remains populated while
  // runtime_control='profile'; restart recovery must prove one exact runtime before clearing either.
  profile_handoff?: string | null
  // The concrete permission mode / codex-sandbox mapping selected for THIS session. NULL means a
  // migrated row whose launch argv predates persistence; once explicitly set it always wins over
  // mutable global Settings on every later resume.
  permission_mode?: string | null
  // A requested live permission change that has not yet been observed in backend telemetry. Kept
  // separately from permission_mode so the board never presents an optimistic selection as actual.
  permission_pending?: string | null
  // When the OPERATOR last set permission_mode (ISO). Only setPermissionMode stamps it — never the
  // tailer's observed write-back. The board prefers the saved value over an older observed telemetry
  // reading when this is newer, so a codex sandbox change shows in the pill immediately instead of
  // lagging until the next turn emits a fresh turn_context. Null on pre-migration and never-set rows.
  permission_set_at?: string | null
  // An actionable reason a runtime control failed closed and cannot safely advance right now.
  control_error?: string | null
  // Durable Claude follow-up delivery ledger (delivery-ledger.ts): small JSON array of not-yet-
  // delivered sends, correlated by the tailer and projected into the rendered transcript.
  delivery_ledger?: string | null
  // Monotonic process incarnation for this Frizz session. Incremented atomically before every
  // respawn/reattach so output or async completion from an older process cannot mutate the new one.
  runtime_generation?: number
  // Durable, mutually-exclusive native runtime control. The revision prevents ABA when one control
  // finishes and another starts with the same kind while an async pane operation is still returning.
  runtime_control?: string | null
  runtime_control_revision?: number
  // Codex transport: NULL/'tmux' = legacy interactive-TUI-in-tmux; 'app-server' = a bridge-owned
  // JSON-RPC session. Only meaningful for backend='codex' rows.
  codex_runtime?: string | null
  // Claude transport: NULL/'tmux' = interactive-TUI-in-tmux; 'broker' = a session-broker-owned Agent
  // SDK session. Only meaningful for backend='claude' rows.
  claude_runtime?: string | null
}

/**
 * A HEADLESS thread has no tmux pane: input goes through a bridge, liveness comes from the bridge /
 * the on-disk transcript, and nothing captures a pane. Both bridge-owned transports are headless —
 * codex over its app-server, claude over its session broker. Use this wherever the intent is "does
 * this thread live in a tmux pane?" rather than a codex- or claude-specific branch.
 */
export function isHeadlessRow(row: Pick<SessionRow, "backend" | "codex_runtime" | "claude_runtime">): boolean {
  return (row.backend === "codex" && row.codex_runtime === "app-server") ||
    (row.backend === "claude" && row.claude_runtime === "broker")
}

/** A Claude row whose session lives in the detached broker daemon (no tmux pane). Stamped
 *  claude_runtime="broker" at dispatch and never migrated, so — unlike legacy codex rows — the runtime
 *  column is authoritative from birth. The Claude twin of isAppServerCodexRow. */
export function isBrokerClaudeRow(row: Pick<SessionRow, "backend" | "claude_runtime">): boolean {
  return row.backend === "claude" && row.claude_runtime === "broker"
}

// Is this row's title off-limits to the backend's own auto-title? The column is authoritative once
// written; an ABSENT value (a pre-migration row read through a partial Pick, or one of the many test
// row literals) falls back to the pre-`title_locked` rule — every non-guessed title was locked — so
// nothing that predates the split silently loosens. The registry, the board's aiTitle overlay, and the
// auto-title CAS all decide through this one predicate.
export function sessionTitleLocked(row: Pick<SessionRow, "title_auto" | "title_locked">): boolean {
  return (row.title_locked ?? (row.title_auto === 1 ? 0 : 1)) === 1
}

// Does this slug read as one DISPATCH minted from this exact title? Only dispatch derives the two
// from each other — `slugify(title)`, plus the `-2`/`-3` suffix resolveSlug appends on a collision —
// so an affirmative means the stored title is still the one the thread was spawned with. Every human
// title writer (rename, native /rename) rewrites the title and leaves the slug alone, so a renamed
// thread answers NO. That asymmetry is the whole basis of the boot repair that unlocks titles a
// dispatch-path bug froze; it is a heuristic, never an invariant, so nothing but that one-time repair
// may decide anything on it.
export function slugMintedFromTitle(slug: string, title: string): boolean {
  const derived = slugify(title)
  return derived === slug || derived === slug.replace(/-\d+$/, "")
}

export interface RuntimeExpectation {
  sessionId: string
  generation: number
  permissionPending: string | null
  runtimeControl?: string | null
}

// ONE recurring-prompt write, for both the operator's session-guarded path and the worker's by-slug one.
// An OBJECT rather than a positional list because the triggers are same-typed booleans: with two of them
// `("keep going", true, false, null, at)` was already unreadable at the call site, and a third made a
// silently transposed pair a question of when rather than whether. `prompt: null` clears the row, which
// forces every trigger off regardless of what is passed here (see recurringArgs).
export interface RecurringWrite {
  prompt: string | null
  stopHook: boolean // scheduler SOURCE 5 — on every rest
  heartbeat: boolean // scheduler SOURCE 4 — every intervalMs on a clock
  postCompaction: boolean // scheduler SOURCE 7 — on every context compaction
  pauseOnQuestions: boolean // a HOLD over all three while the thread is blocked on the human
  intervalMs: number | null
  armedAt: string
}

export type RuntimeControlKind = "permission" | "profile" | "resume" | "follow-up" | "ai-rename"

export type ProfileHandoffPhase =
  | "armed"
  | "target-starting"
  | "target-spawned"
  | "target-ready"
  | "rollback-starting"
  | "rollback-spawned"
  | "rollback-ready"

export interface ProfileHandoffBinding {
  kind: "standalone" | "adopted"
  paneId: string
  panePid: number
  sessionCreated: number
  adoptionAttemptToken?: string
  handoffToken?: string
}

export interface ProfileHandoffLeg {
  generation: number
  handoffToken: string
  binding?: ProfileHandoffBinding
}

export interface ProfileHandoffJournal {
  version: 1
  phase: ProfileHandoffPhase
  nativeSessionId: string
  previous: { model: string; effort: string; binding: ProfileHandoffBinding }
  requested: { model: string; effort: string }
  target?: ProfileHandoffLeg
  rollback?: ProfileHandoffLeg
}

export interface ProfileChangeExpectation {
  sessionId: string
  nativeSessionId: string | null
  generation: number
  profileRevision: number
  controlRevision: number
  model: string
  effort: string
  profileHandoff: string
}

export interface AutoTitleExpectation {
  sessionId: string
  nativeSessionId: string | null
  runtimeGeneration: number
}

export type AdoptionClaimState = "reserved" | "spawned" | "recovering" | "finalized"

// A cold-adoption attempt owns its slug in SQLite before it is allowed to create a tmux session.
// The tmux tuple is filled immediately after new-session returns; the attempt token is also embedded
// in the tmux session environment, which lets restart recovery identify the otherwise tiny window
// between tmux creation and this row update without guessing from a reusable slug or PID.
export interface AdoptionClaimRow {
  slug: string
  attempt_token: string
  session_id: string
  state: AdoptionClaimState
  reserved_at_ms: number
  lease_expires_at_ms: number
  recovery_token: string | null
  pane_id: string | null
  pane_pid: number | null
  session_created: number | null
  finalized_at_ms: number | null
}

export interface AdoptionPaneIdentity {
  paneId: string
  panePid: number
  sessionCreated: number
}

export interface AdoptionReservation {
  slug: string
  attemptToken: string
  sessionId: string
  reservedAtMs: number
  leaseExpiresAtMs: number
}

// Tokens are never reusable after an attempt gives up ownership. Keeping the retirement ledger
// durable lets boot recovery find a pane created by an old process that resumed after its lease was
// recovered. New processes are additionally fenced under SQLite's writer lock before spawning.
export interface RetiredAdoptionAttemptRow {
  attempt_token: string
  slug: string
  session_id: string
  retired_at_ms: number
}

export interface ForgetSessionExpectation {
  sessionId: string
  runtimeGeneration: number
  adoptionAttemptToken: string | null
}

export type AdoptionSpawnFenceResult<T> =
  | { acquired: false }
  | { acquired: true; value: T }

/** One row of `thread_timer` — a worker's one-off alarm. Instants are epoch ms in the table (they are
 *  only ever compared against `Date.now()`); the ISO string the worker and the delivered trailer see is
 *  derived at the boundary. */
export interface ThreadTimerRow {
  id: string
  thread_slug: string
  prompt: string
  fire_at: number
  state: "armed" | "fired" | "cancelled"
  created_at: number
  settled_at: number | null
}

export interface Storage {
  db: Database
  interactions: InteractionStore
  getSession(slug: string): SessionRow | undefined
  // Every registered row, newest schema first. The array and the rows in it are SHARED and CACHED
  // between callers (see the cache note at the implementation) — read them, never mutate them.
  allSessions(): readonly SessionRow[]
  subscribeSessionLifecycle(listener: (event: SessionLifecycleEvent) => void): () => void
  upsertSession(row: SessionRow): void
  // Claim a previously-unowned slug without ever replacing its current owner. This is the registry
  // compare-and-swap used by cold adoption after spawn: a competing writer either wins atomically or
  // leaves its row byte-for-byte untouched. Unlike the legacy upsert, identity columns are part of the
  // same INSERT so backend/native-session ownership can never be partially updated across backends.
  insertSessionIfAbsent(row: SessionRow): boolean
  getAdoptionClaim(slug: string): AdoptionClaimRow | undefined
  getAdoptionRuntimeSnapshot(slug: string): {
    session: SessionRow | undefined
    claim: AdoptionClaimRow | undefined
  }
  allAdoptionClaims(): AdoptionClaimRow[]
  allRetiredAdoptionAttempts(): RetiredAdoptionAttemptRow[]
  // INSERT ... WHERE no session owner exists. The slug PK and token UNIQUE constraint serialize
  // separate Frizz processes/connections; a loser never reaches tmux.
  reserveAdoptionClaim(reservation: AdoptionReservation): boolean
  recordAdoptionPane(
    slug: string,
    attemptToken: string,
    identity: AdoptionPaneIdentity,
    leaseExpiresAtMs: number,
  ): boolean
  // Revalidate the exact token while holding SQLite's write lock across new-session and the first
  // pane bind. Recovery on another connection cannot retire the token in the validation→spawn gap.
  withAdoptionSpawnFence<T>(
    slug: string,
    attemptToken: string,
    leaseExpiresAtMs: number,
    spawn: (bindPane: (identity: AdoptionPaneIdentity, leaseExpiresAtMs: number) => boolean) => T,
  ): AdoptionSpawnFenceResult<T>
  // The session INSERT and claim finalization are one SQLite transaction. False means another row
  // won; the spawned attempt remains recoverable and must be exact-pane cleaned by its owner/restart.
  finalizeAdoptionClaim(slug: string, attemptToken: string, row: SessionRow, finalizedAtMs: number): boolean
  // Reuse the durable binding for a legitimate resume without an unbound gap. While reserved/spawned,
  // every reader sees a conflict and fails closed; recovery restores a finalized no-pane binding.
  rearmFinalizedAdoptionClaim(reservation: AdoptionReservation, previousAttemptToken: string): boolean
  finalizeAdoptionRespawnClaim(
    slug: string,
    attemptToken: string,
    sessionId: string,
    finalizedAtMs: number,
  ): boolean
  // The live owner may abandon only its own non-finalized token after proving its pane is absent.
  abandonAdoptionClaim(slug: string, attemptToken: string): boolean
  // Lease takeover is itself CAS + leased, so two booting servers cannot both clean one attempt and
  // a recovery process killed midway can be safely superseded after its recovery lease expires.
  beginAdoptionRecovery(
    slug: string,
    attemptToken: string,
    recoveryToken: string,
    nowMs: number,
    leaseExpiresAtMs: number,
  ): AdoptionClaimRow | undefined
  finishAdoptionRecovery(slug: string, attemptToken: string, recoveryToken: string): boolean
  retireFinalizedAdoptionClaim(slug: string, sessionId: string, attemptToken: string): boolean
  markRead(slug: string, at?: string): void
  setUnread(slug: string, unread: boolean): void
  setUnreadIfCurrent(slug: string, sessionId: string, generation: number, unread: boolean): boolean
  setExited(slug: string, exited: boolean): void
  setExitedIfCurrent(slug: string, sessionId: string, generation: number, exited: boolean): boolean
  // Completion is one CAS write: a verified stopped runtime becomes exited + Done together, while
  // clearing stale attention/wake state. A replaced owner/generation observes zero changes.
  completeIfCurrent(slug: string, sessionId: string, generation: number): boolean
  setRestedAt(slug: string, at: string): void
  setRestedAtIfCurrent(slug: string, sessionId: string, generation: number, at: string): boolean
  setSeenAt(slug: string, at: string): void
  // Cache/clear the discovered transcript filename stem (the read-side discovery fallback's result).
  setTranscriptId(slug: string, transcriptId: string | null): void
  setTranscriptIdIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    transcriptId: string | null,
  ): boolean
  // Explicit lifecycle write (Archive button / Reopen), and the ONLY way to archive. Keeps the legacy
  // `archived` flag in sync so pre-restart readers of that column stay honest; archiving also clears
  // unread (never badge a deliberately-shelved thread).
  //
  // There was a `setArchived` beside this that wrote ONLY that legacy column. It is gone, because the
  // column is no longer what anything reads: `effectiveSessionState` (board.ts) consults it only when
  // `state` is NULL, and every row the dispatch path creates has an explicit `state`. So the legacy
  // setter's one caller (the archiveThread RPC) reported success while the card never moved.
  setState(slug: string, state: "open" | "archived"): void
  setStateIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    state: "open" | "archived",
  ): boolean
  // `prompt` arms the deadline as a scheduled BUMP: the waker resumes the thread with exactly this
  // text when the instant crosses. Omitted/null keeps the historical reminder behavior (the card
  // simply re-surfaces). Clearing the instant always clears the prompt with it.
  setSnoozedUntil(slug: string, until: string | null, prompt?: string | null): void
  // Session-guarded park: writes only while the row is still this session+generation, so a stale card
  // cannot re-park a thread that has since been re-dispatched.
  setSnoozedUntilIfCurrent(slug: string, sessionId: string, generation: number, until: string | null): boolean
  // Arm/clear the awaiting-background event-snooze. Session-guarded like the park above. `restedAt` is
  // the rest instant the card is snoozed FOR; the board re-surfaces it once rested_at moves past this.
  setBgSnoozeRestedAtIfCurrent(slug: string, sessionId: string, generation: number, restedAt: string | null): boolean
  // Arm / edit / clear the thread's RECURRING PROMPT in ONE write, because the popover's textarea, its
  // two trigger toggles and its minutes field are all views of one row — split into separate writes, a
  // tab holding a stale copy of one of them would clobber the rest.
  //
  // GENERATION DISCIPLINE: a change to the TEXT or the INTERVAL mints a fresh `armed_at`, superseding
  // any delivery already queued under the old settings; a bare trigger flip preserves it, so switching
  // a trigger off and on cannot re-run a delivery the operator just watched land. A null prompt clears
  // the row outright.
  //
  // Session-guarded: this comes from a browser tab that may be looking at a thread which has since been
  // re-dispatched.
  setRecurringPromptIfCurrent(slug: string, sessionId: string, generation: number, write: RecurringWrite): boolean
  // The WORKER's path to the same row, from `mcp__frizz__recurring_prompt`. Deliberately keyed on the
  // slug ALONE, with no session/generation guard, because the MCP server cannot satisfy one: it is
  // spawned with its thread's slug and keeps it across a resume, while the session id and generation
  // bump underneath it — so a guard here would fail exactly on the long-lived thread this exists for.
  // The slug is stamped into that server's env by frizz itself and is not attacker-controlled.
  setRecurringPromptBySlug(slug: string, write: RecurringWrite): boolean
  // ---- ONE-OFF TIMERS (scheduler SOURCE 6) -------------------------------------------------------
  // Arm one. `id` is minted by the caller so the row and the scheduler's delivery id agree without a
  // read-back. Slug-keyed for the same reason the recurring prompt's worker path is.
  armThreadTimer(timer: { id: string; slug: string; prompt: string; fireAtMs: number; createdAtMs: number }): void
  // A thread's timers, newest deadline last. `armedOnly` is what the worker's tool reads back; the full
  // set is for tests and diagnostics.
  listThreadTimers(slug: string, opts?: { armedOnly?: boolean }): ThreadTimerRow[]
  getThreadTimer(id: string): ThreadTimerRow | undefined
  // Every armed timer that is due, across all threads — the scheduler's one read per tick.
  dueThreadTimers(nowMs: number): ThreadTimerRow[]
  // Withdraw one. Scoped to the slug so a worker can only ever cancel its OWN, and only an ARMED timer
  // moves: cancelling one that already fired is a no-op, not a rewrite of history.
  cancelThreadTimer(slug: string, id: string, settledAtMs: number): boolean
  // Terminal for the scheduler: this timer's delivery has settled, so it must never be queued again.
  // Guarded on `armed` so a cancel that raced the delivery keeps its own verdict.
  markThreadTimerFired(id: string, settledAtMs: number): boolean
  // Stamp a delivered ON REST prompt, guarded on the generation so one settling after an edit cannot
  // write onto words it no longer describes.
  stampRecurringRestFired(slug: string, armedAt: string, firedAt: string): boolean
  // Stamp a delivered ON SCHEDULE prompt. Same guard, and load-bearing rather than cosmetic: the next
  // one is due an interval after THIS stamp.
  stampRecurringScheduleFired(slug: string, armedAt: string, firedAt: string): boolean
  // Stamp a delivered POST-COMPACTION prompt. Same guard; cosmetic like the rest trigger's, since a
  // compaction is an event rather than a deadline and every one of them fires.
  stampRecurringCompactFired(slug: string, armedAt: string, firedAt: string): boolean
  // Operator confirmation of ONE exact awaiting fence; fails closed if the session/generation moved.
  confirmAwaitingWait(
    slug: string,
    sessionId: string,
    generation: number,
    fenceId: string,
    confirmedAt: string,
    snoozedUntil: string | null,
  ): boolean
  clearAwaitingWaitIfSession(slug: string, sessionId: string, generation: number): boolean
  clearAwaitingWaitIfCurrent(slug: string, sessionId: string, fenceId: string): boolean
  // Clears elapsed PROMPTLESS values atomically and returns the number changed. The board calls this at
  // each refresh and at its exact wake timer so restart/reload cannot leave a stale Held marker behind.
  // A snooze carrying a prompt survives its deadline until the scheduler has delivered its bump.
  clearExpiredSnoozes(now: string): number
  // Persist an EXPLICIT human title and LOCK it against every backend auto-title. The flag flips are
  // atomic with the text write so no board refresh, transcript ai-title, resume upsert, or server
  // restart can see the new title as machine-generated or still replaceable.
  setTitle(slug: string, title: string): void
  // AI rename is asynchronous. Commit only if this is still the same session with the same title
  // provenance captured at start, so a later manual rename/re-dispatch always wins.
  setTitleIfCurrent(
    slug: string,
    title: string,
    expected: { sessionId: string; title: string | null; titleAuto: number },
  ): boolean
  // Persist an automatically-derived title without changing its display provenance. The full runtime
  // identity and the title_locked guard make a late transcript fold harmless after manual rename,
  // resume, or same-slug replacement; a later trustworthy native auto-title may still supersede this
  // fallback. Deliberately NOT gated on title_auto: an uninformative title hard-coded by a dispatch
  // CALLER is displayable-but-replaceable, and this is the write that replaces it.
  setAutoTitleIfCurrent(slug: string, title: string, expected: AutoTitleExpectation): boolean
  // Hard-delete a session row — the "Dismiss/forget" verb for a phantom the user wants GONE, not merely
  // shelved (Archive only sets state='archived'). DELETEs the registry row AND records a TOMBSTONE on its
  // session_id + transcript_id, so foreign-discovery (which surfaces any fresh unregistered *.jsonl in the
  // log dir) can never resurrect the same transcript as a read-only "foreign" thread after the row is
  // gone. Idempotent: forgetting an absent/already-forgotten slug is a no-op. A fresh dispatch mints a NEW
  // session_id (never tombstoned), so re-dispatching the same slug still works — the tombstone keys on the
  // OLD session id only. Returns the forgotten row (for the caller to tear down its tailer state), or
  // undefined when nothing was there.
  forgetSession(slug: string): SessionRow | undefined
  // Forget only the row/runtime generation and finalized adoption owner the caller stopped. A
  // concurrent resume/replacement wins without having its new row or claim deleted by stale work.
  forgetSessionIfCurrent(slug: string, expected: ForgetSessionExpectation): SessionRow | undefined
  // Every tombstoned transcript id (session_id + any discovered transcript_id of a forgotten row). The
  // tailer's foreign-discovery consults this so a forgotten phantom's transcript stays excluded forever.
  forgottenIds(): Set<string>
  // ---- RETIRED BACKGROUND OPS — the × the operator clicked, remembered across restarts ----
  //
  // The tailer folds a background op into existence from its DISPATCH record and retires it on a
  // TERMINAL one. A killed shell never gets the terminal record — measured, twice: the provider writes
  // nothing to the transcript when it stops one (backend/_live_shell_stop_notice.mts) and leaves no
  // disk trace either (backend/_live_shell_stop_trace.mts, whose control shows a normally-finished
  // shell keeps its output file exactly as a killed one does). So the fold has no way to learn the op
  // ended, and any re-prime — a frizz restart above all — re-creates it as LIVE off a tool_use that
  // will never get a result.
  //
  // That is not hypothetical: the maintainer's own board carried a killed shell reading "57hr 18m",
  // and one cold fold of their real transcript reproduced it exactly. This table is the missing
  // memory, and it is the ONLY thing standing between a dismissed row and its own resurrection.
  retireOp(slug: string, sessionId: string, opId: string): void
  /** Every op id retired for this exact (slug, session) — consulted by the fold, so an id in here can
   *  never become a live row again. Empty for a session that has never had an × clicked. */
  retiredOps(slug: string, sessionId: string): Set<string>
  /** Lift a retirement, because the op RESTARTED under the same id. The dismissal was aimed at the run
   *  that ended; keeping it would silently hide the new one on the next prime. */
  unretireOp(slug: string, sessionId: string, opId: string): void
  // Codex-support epic (Phase 2): pin the agent backend + its native session id on a row AFTER
  // dispatch. Kept OFF the shared upsert (whose named-param statement every claude caller + test
  // fixture feeds) so the codex path is purely additive — a claude dispatch never calls these, so its
  // `backend` stays the column DEFAULT 'claude' and `agent_session_id` stays NULL.
  setBackend(slug: string, backend: string): void
  setAgentSession(slug: string, agentSessionId: string): void
  setCodexRuntime(slug: string, runtime: string): void
  setClaudeRuntime(slug: string, runtime: string): void
  setProfile(slug: string, model: string, effort: string): void
  setPermissionMode(slug: string, permissionMode: string): void
  setPermissionPending(slug: string, permissionMode: string | null): void
  beginRuntimeControl(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    kind: RuntimeControlKind,
  ): number | null
  releaseRuntimeControl(
    slug: string,
    expected: { sessionId: string; generation: number; kind: RuntimeControlKind; revision: number },
  ): boolean
  setProfileTargetIfCurrent(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    profile: { model: string; effort: string },
  ): boolean
  armProfileChange(
    slug: string,
    expected: { sessionId: string; nativeSessionId: string | null; generation: number },
    profile: { model: string; effort: string },
    handoff: ProfileHandoffJournal,
  ): { profileRevision: number; controlRevision: number; profileHandoff: string } | null
  checkpointProfileChange(
    slug: string,
    expected: ProfileChangeExpectation,
    handoff: ProfileHandoffJournal,
  ): string | null
  commitProfileChange(slug: string, expected: ProfileChangeExpectation): boolean
  restoreProfileChange(
    slug: string,
    expected: ProfileChangeExpectation,
    previous: { model: string; effort: string },
    error: string,
  ): boolean
  blockProfileChange(slug: string, expected: ProfileChangeExpectation, error: string): boolean
  failProfileChange(slug: string, expected: ProfileChangeExpectation, error: string): boolean
  setObservedProfileIfCurrent(
    slug: string,
    expected: { sessionId: string; generation: number },
    profile: { model: string; effort: string },
  ): boolean
  // Stamp a new process generation BEFORE spawn. The expected pending value is part of ownership:
  // a different/recovered permission request cannot be overtaken by a late starter.
  beginRuntimeGeneration(slug: string, expected: RuntimeExpectation, spawnedAt: string): number | null
  setPermissionStateIfCurrent(
    slug: string,
    expected: RuntimeExpectation,
    state: { exited: boolean; permissionMode: string; permissionPending: string | null; controlError: string | null },
  ): boolean
  setObservedPermissionIfCurrent(slug: string, sessionId: string, generation: number, permissionMode: string): boolean
  setControlErrorIfCurrent(slug: string, sessionId: string, generation: number, error: string | null): boolean
  setControlError(slug: string, error: string | null): void
  setDeliveryLedger(slug: string, ledger: string | null): void
  getSetting(key: string): unknown
  setSetting(key: string, value: unknown): void
  deleteSetting(key: string): void
  close(): void
}

export type SessionLifecycleEvent =
  | { type: "replaced"; previous: SessionRow; current: SessionRow }
  | { type: "deleted"; previous: SessionRow }

export function createStorage(dbPath: string): Storage {
  const db = new Database(dbPath)
  db.pragma("busy_timeout = 5000")
  db.pragma("journal_mode = WAL")

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      slug        TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      tmux_name   TEXT NOT NULL,
      spawned_at  TEXT NOT NULL,
      last_read_at TEXT,
      unread      INTEGER NOT NULL DEFAULT 0,
      exited      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Forgotten-transcript graveyard: a transcript id (a session_id or a discovered transcript_id) whose
    -- registry row was hard-deleted via forgetSession. Foreign-discovery excludes these so a dismissed
    -- phantom can never re-surface as a read-only "foreign" thread on a later log-dir rescan.
    CREATE TABLE IF NOT EXISTS tombstone (
      transcript_id TEXT PRIMARY KEY,
      slug          TEXT NOT NULL,
      forgotten_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adoption_claim (
      slug                TEXT PRIMARY KEY,
      attempt_token       TEXT NOT NULL UNIQUE,
      session_id          TEXT NOT NULL UNIQUE,
      state               TEXT NOT NULL CHECK (state IN ('reserved', 'spawned', 'recovering', 'finalized')),
      reserved_at_ms      INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      recovery_token      TEXT,
      pane_id             TEXT,
      pane_pid            INTEGER,
      session_created     INTEGER,
      finalized_at_ms     INTEGER,
      CHECK (
        (pane_id IS NULL AND pane_pid IS NULL AND session_created IS NULL) OR
        (pane_id IS NOT NULL AND pane_pid IS NOT NULL AND session_created IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS adoption_retired_attempt (
      attempt_token TEXT PRIMARY KEY,
      slug          TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      retired_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS adoption_retired_attempt_slug_idx
      ON adoption_retired_attempt(slug);
    -- A background op the operator RETIRED (the × on its row), by its dispatch tool_use id.
    --
    -- This has to be durable, and the reason is measured rather than defensive. Killing a background
    -- shell writes NOTHING anywhere frizz can re-read: not a tool_result in the session JSONL (verified
    -- in backend/_live_shell_stop_notice.mts — the transcript gains not one record), and not on disk
    -- (backend/_live_shell_stop_trace.mts — the output file survives the kill exactly as a normally
    -- finished shell's does, so file-absence proves nothing). The tailer's retirement therefore lived
    -- only in memory, and ANY re-prime re-created the row as live off a tool_use that will never get a
    -- result — forever. Reproduced from the maintainer's own 57-hour phantom: one cold fold of their
    -- real transcript brings the killed shell straight back.
    --
    -- Keyed by SESSION as well as slug: a re-dispatched slug is a different conversation whose ids
    -- come from a different transcript, and it must not inherit this one's retirements.
    CREATE TABLE IF NOT EXISTS retired_op (
      slug       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      op_id      TEXT NOT NULL,
      retired_at TEXT NOT NULL,
      PRIMARY KEY (slug, session_id, op_id)
    );
    -- A worker's ONE-OFF TIMERS (scheduler SOURCE 6): text to hand back at one instant, once.
    --
    -- A TABLE rather than more recurring_* columns on the session, because the feature's whole premise
    -- is that a thread may hold ARBITRARILY MANY at a time — a row can hold one arrangement, and "check
    -- the deploy in 10 min AND re-read the spec in an hour" is two.
    --
    -- Keyed by SLUG, not by session: a timer is armed by the worker's MCP server, which keeps its slug
    -- across every resume while the session id underneath it bumps (the same reason
    -- setRecurringPromptBySlug is slug-keyed). A resumed thread is still the thread that set the alarm.
    --
    -- state is the whole lifecycle: 'armed' until the scheduler's delivery reaches a terminal state,
    -- then 'fired' — which is what stops a second delivery once the outbox has pruned the terminal row
    -- that would otherwise dedupe it — or 'cancelled' when the worker withdraws it.
    CREATE TABLE IF NOT EXISTS thread_timer (
      id          TEXT PRIMARY KEY,
      thread_slug TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      fire_at     INTEGER NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('armed', 'fired', 'cancelled')),
      created_at  INTEGER NOT NULL,
      settled_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS thread_timer_due
      ON thread_timer(state, fire_at);
    CREATE INDEX IF NOT EXISTS thread_timer_slug
      ON thread_timer(thread_slug, state, fire_at);
  `)
  // Best-effort inline migration for older DBs. Session-first/profile columns are nullable ADDs
  // (except the existing boolean/backend defaults) — additive + idempotent, safe while another server
  // process holds the db open (the live server never sees a shape it can't read).
  for (const col of [
    "archived INTEGER NOT NULL DEFAULT 0",
    "title_auto INTEGER NOT NULL DEFAULT 0",
    // Defaults LOCKED so the ADD COLUMN backfill is conservative: every row that predates the split
    // keeps exactly its old behavior, and any write path that forgets the column fails safe (a title
    // that can't be replaced, never one that's silently overwritten). The boot repair below then
    // unlocks the machine-guessed ones.
    "title_locked INTEGER NOT NULL DEFAULT 1",
    "rested_at TEXT",
    "title TEXT",
    "state TEXT",
    "snoozed_until TEXT",
    "snooze_prompt TEXT",
    "bg_snooze_rested_at TEXT",
    "awaiting_fence_id TEXT",
    "awaiting_confirmed_at TEXT",
    "meta TEXT",
    "seen_at TEXT",
    "plan_path TEXT",
    "transcript_id TEXT",
    "backend TEXT NOT NULL DEFAULT 'claude'",
    "agent_session_id TEXT",
    "model TEXT",
    "effort TEXT",
    "profile_pending_model TEXT",
    "profile_pending_effort TEXT",
    "profile_revision INTEGER NOT NULL DEFAULT 0",
    "profile_handoff TEXT",
    "permission_mode TEXT",
    "permission_pending TEXT",
    "permission_set_at TEXT",
    "profile_set_at TEXT",
    "control_error TEXT",
    "delivery_ledger TEXT",
    "runtime_generation INTEGER NOT NULL DEFAULT 0",
    "runtime_control TEXT",
    "runtime_control_revision INTEGER NOT NULL DEFAULT 0",
    // Codex transport discriminator: NULL/'tmux' = the legacy interactive-TUI path; 'app-server' = a
    // bridge-owned JSON-RPC session (input via turn/start|steer, liveness from the bridge not a pane).
    "codex_runtime TEXT",
    // Claude transport discriminator: NULL/'tmux' = the interactive-TUI path in a tmux pane; 'broker'
    // = a session-broker-owned Agent SDK session (input via the bridge, liveness from it, not a pane).
    "claude_runtime TEXT",
    // The legacy two-feature columns. Superseded 2026-08-03 by the `recurring_*` set below, which
    // merged the stop hook and the heartbeat into ONE prompt with two triggers. They are still declared
    // here (rather than dropped) for exactly one reason: the backfill further down reads them, and it
    // must keep working on a database that has not booted since before the merge. Nothing WRITES them
    // any more — if you find yourself adding a writer, you are re-forking the feature.
    "heartbeat_prompt TEXT",
    "heartbeat_interval_ms INTEGER",
    "heartbeat_enabled INTEGER NOT NULL DEFAULT 0",
    "heartbeat_armed_at TEXT",
    "heartbeat_last_fired_at TEXT",
    "stop_hook TEXT",
    "stop_hook_enabled INTEGER NOT NULL DEFAULT 0",
    "stop_hook_armed_at TEXT",
    "stop_hook_last_fired_at TEXT",
    // THE RECURRING PROMPT (scheduler.ts SOURCES 4, 5 and 7): one text, three independent triggers —
    // every time the thread rests, every N ms on a clock, and/or every time its context is compacted.
    // All flags 0 = off; there is no separate enable column, because another flag could only ever
    // contradict the ones that decide the behaviour.
    "recurring_prompt TEXT",
    "recurring_on_rest INTEGER NOT NULL DEFAULT 0",
    "recurring_on_schedule INTEGER NOT NULL DEFAULT 0",
    "recurring_interval_ms INTEGER",
    "recurring_armed_at TEXT",
    "recurring_rest_fired_at TEXT",
    "recurring_schedule_fired_at TEXT",
    // The post-compaction trigger (2026-08-06). Added as its own ALTER rather than folded into the set
    // above so a database armed before this release picks it up on the next boot with the flag off,
    // which is the correct default: an existing prompt described the triggers its operator chose.
    "recurring_on_compact INTEGER NOT NULL DEFAULT 0",
    "recurring_compact_fired_at TEXT",
    // The question hold (2026-08-11). Its own ALTER for the same reason as the trigger above: an existing
    // armed row picks it up OFF on the next boot, which is the honest reading of a row whose operator has
    // never been shown the option.
    "recurring_pause_on_questions INTEGER NOT NULL DEFAULT 0",
    // Title provenance for the CURRENT text (2026-08-07): 1 = the worker's own title signal wrote it,
    // 0 = the dispatch seeded it. DEFAULT 0 is the conservative direction — an existing row is assumed
    // to hold its dispatch chop until the repair below (or the next title signal) says otherwise.
    "title_agent INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(`ALTER TABLE session ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }
  // THE REBRAND LEFT THESE ROWS BEHIND (2026-08-06). `tmux_name` is re-derived as
  // `frizz-<slug>` and checked on EVERY write by validateSessionIdentity, so a row still holding
  // `fray-<slug>` is a row whose next write is rejected. The one-time migration that fixed this was
  // deleted once the projects in use had been converted — but ten project databases had simply not
  // been opened since, carrying fourteen threads between them, and a project nobody opened for a week
  // is exactly what a machine-wide project grid now invites you to open.
  //
  // It lives here rather than in a migration module because it is idempotent and self-limiting: the
  // LIKE matches nothing once a database has been through it, so it costs one no-op scan per boot and
  // there is nothing left to delete later.
  try {
    db.exec("UPDATE session SET tmux_name = 'frizz-' || substr(tmux_name, 6) WHERE tmux_name LIKE 'fray-%'")
  } catch {
    // A pre-schema database, or one without the column yet. The ALTERs above own that case.
  }
  // ONE-SHOT ADOPTION of the pre-merge two-feature rows (2026-08-03). A thread that had a stop hook, a
  // heartbeat, or both keeps working across the upgrade instead of silently going quiet.
  //
  // GUARDED ON `recurring_armed_at IS NULL`, which is what makes it safe to re-run on every boot: the
  // moment a row has a recurring prompt of its own, this stops touching it. Without that guard it would
  // resurrect a prompt the operator had since cleared, every single restart — the exact failure the
  // 2026-08-02 adoption pass was deleted for.
  //
  // WHERE THE TEXT COMES FROM when both were armed with DIFFERENT words: the stop hook's wins. Merging
  // is inherently lossy in that case (it is the one capability this merge removes), and the stop hook
  // is the more likely to hold the real driving instruction — the heartbeat's tended to be a short
  // "check X" reminder. The triggers and the cadence both carry over regardless, so the thread keeps
  // firing on the same schedule it had.
  try {
    db.exec(`
      UPDATE session SET
        recurring_prompt = COALESCE(stop_hook, heartbeat_prompt),
        recurring_on_rest = CASE WHEN stop_hook IS NOT NULL AND stop_hook_enabled = 1 THEN 1 ELSE 0 END,
        recurring_on_schedule = CASE WHEN heartbeat_prompt IS NOT NULL AND heartbeat_enabled = 1 THEN 1 ELSE 0 END,
        recurring_interval_ms = heartbeat_interval_ms,
        -- The generation is the LATER of the two, so a delivery still in the outbox under either old
        -- generation reads as superseded rather than landing against the merged row.
        recurring_armed_at = CASE
          WHEN stop_hook_armed_at IS NULL THEN heartbeat_armed_at
          WHEN heartbeat_armed_at IS NULL THEN stop_hook_armed_at
          WHEN stop_hook_armed_at > heartbeat_armed_at THEN stop_hook_armed_at
          ELSE heartbeat_armed_at
        END,
        recurring_rest_fired_at = stop_hook_last_fired_at,
        recurring_schedule_fired_at = heartbeat_last_fired_at
      WHERE recurring_armed_at IS NULL
        AND (stop_hook IS NOT NULL OR heartbeat_prompt IS NOT NULL)
    `)
  } catch {
    // A database predating the legacy columns has nothing to adopt.
  }
  // One-time idempotent backfill: rows the user already archived under the boolean flag carry that
  // into the new lifecycle column. Only fills NULLs — an explicit later state write always wins.
  try {
    db.exec("UPDATE session SET state = 'archived' WHERE archived = 1 AND state IS NULL")
    // Unlock the machine-guessed titles the conservative DEFAULT 1 above just locked. Safe to re-run on
    // EVERY boot — not merely at first migration — because every writer that locks a title also clears
    // title_auto, so `title_locked = 1 AND title_auto = 1` is a state nothing can legitimately produce.
    // (A boot repair that re-LOCKED instead would be the dangerous direction: it would silently re-lock
    // each newly dispatched caller-titled row on the next restart.)
    db.exec("UPDATE session SET title_locked = 0 WHERE title_auto = 1")
    // ONE-TIME repair for titles locked by a BUG rather than by a human. From the broker's arrival
    // (2026-07-24) until the fix that ships with this line, the Claude session-broker dispatch path
    // omitted `title_locked` from its registry row, and an absent value on a caller-titled row
    // normalises to LOCKED (see sessionTitleLocked — it fails safe, which here means failing into the
    // bug). So every GitHub-batch and spawn_thread thread froze on its dispatch title
    // (`Investigate acme/app#391`) while the worker's own, far better name was withheld forever.
    // Rows that predate the title_auto/title_locked split carry the same shape, left locked by the
    // deliberately conservative ADD COLUMN backfill above.
    //
    // A human's rename and a stuck dispatch title are indistinguishable by the flags alone, so this
    // asks a sharper question: does the SLUG still read as one this exact title minted? Dispatch is
    // the only writer that derives one from the other, and a rename rewrites the title while leaving
    // the slug untouched — so a renamed thread fails the test, which is what keeps the repair off
    // human names. It runs ONCE (settings marker) because, unlike the invariant-based repairs around
    // it, that test is a heuristic: a human rename after the repair must be the last word.
    const unlockedRepairKey = "repair:unlock-dispatch-minted-titles"
    const repairDone = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
      .get(unlockedRepairKey)
    if (!repairDone) {
      const unlockOne = db.prepare("UPDATE session SET title_locked = 0 WHERE slug = ? AND title_locked = 1")
      const candidates = db.prepare<[], Pick<SessionRow, "slug" | "title">>(`
        SELECT slug, title FROM session
        WHERE title_locked = 1 AND title_auto = 0 AND title IS NOT NULL AND title <> ''
      `).all()
      for (const row of candidates) {
        if (row.title && slugMintedFromTitle(row.slug, row.title)) unlockOne.run(row.slug)
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .run(unlockedRepairKey, new Date().toISOString())
    }
    // ONE-TIME backfill of `title_agent` for rows that predate the column. The auto-title CAS has been
    // persisting the codex worker's own title into `title` since the app-server path landed, but until
    // the column shipped nothing recorded that provenance — so once a codex thread's live telemetry
    // went away (rest, archive, restart) the board had no way to tell that title from the dispatch
    // chop and the display fell back to "Untitled thread" for ALL of them. On the maintainer's own
    // board that was every codex thread on it, 29 of 29 (2026-08-07).
    //
    // Same sharper question the repair above asks, in the same direction: dispatch is the only writer
    // that derives the slug and the title from each other, so a codex row whose slug no longer reads
    // as one this title minted is a row whose title has been REPLACED since dispatch — and on an
    // unlocked `title_auto = 1` row the only writer that can have done so is the auto-title CAS.
    // ONCE (settings marker), because it is a heuristic: a row whose title genuinely is still its chop
    // must be free to stay that way, and every title written from here on records its own provenance.
    const agentTitleRepairKey = "repair:mark-agent-written-titles"
    const agentRepairDone = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
      .get(agentTitleRepairKey)
    if (!agentRepairDone) {
      const markOne = db.prepare("UPDATE session SET title_agent = 1 WHERE slug = ? AND title_agent = 0")
      const candidates = db.prepare<[], Pick<SessionRow, "slug" | "title">>(`
        SELECT slug, title FROM session
        WHERE backend = 'codex' AND title_auto = 1 AND title_locked = 0
          AND title IS NOT NULL AND title <> ''
      `).all()
      for (const row of candidates) {
        if (row.title && !slugMintedFromTitle(row.slug, row.title)) markOne.run(row.slug)
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .run(agentTitleRepairKey, new Date().toISOString())
    }
    // The tmux codex composer is gone, and with it every writer AND releaser of its durable
    // 'codex-input' runtime lock. A row that still holds one was locked by the retired subsystem and
    // nothing can ever clear it again: the board reports runtimeControlPending forever, which fences
    // that thread's composer, model, and sandbox controls permanently. Release it once, at boot.
    db.exec("UPDATE session SET runtime_control = NULL WHERE runtime_control = 'codex-input'")
    // Same class, same reasoning, the OTHER purely in-process lock. `resume.ts` takes 'follow-up' for
    // the ~300-800ms an injection needs and releases it in a `finally` — so no process can legitimately
    // still hold one after a restart, and one left by a hard kill inside that window fences the thread's
    // follow-ups permanently ("Another runtime control is in progress" on every later send, forever).
    // Note what is NOT swept: 'profile' is DURABLE by design — profile_handoff rides with it and restart
    // recovery must prove one exact runtime before clearing either (see the codex-only abandon above).
    db.exec("UPDATE session SET runtime_control = NULL WHERE runtime_control = 'follow-up'")
    // Same class, one step further: a CODEX row can also still hold the tmux-era PROFILE handoff from a
    // pre-cutover crash. That handoff can never complete now — recovery reattaches a tmux pane and reads
    // it with the Claude composer parser, which a Codex pane never satisfies, so the recovery loop
    // re-blocks the thread on every tick forever. Abandon the pending pair and say why; codex takes
    // model/effort per turn, so nothing is lost but the stuck arming.
    db.exec(`
      UPDATE session
      SET runtime_control = NULL, profile_pending_model = NULL, profile_pending_effort = NULL,
          profile_handoff = NULL,
          control_error = 'A model/effort change armed on the retired Codex tmux path was abandoned; set it again.'
      WHERE backend = 'codex' AND runtime_control = 'profile'
    `)
    // Heal every app-server codex row that was downgraded behind the operator's back. Until the fixes
    // that ship with this line, a cold resume sent no sandbox/approval override, so the app-server
    // applied the config.toml defaults (`workspace-write` + `on-request`) and the tailer then folded
    // that observation back into permission_mode as if the operator had chosen it. `sandboxFor` reads
    // this column, so the downgrade became self-perpetuating: the thread requested workspace-write on
    // every later resume and stalled on an approval nobody was watching. Frizz workers are dispatched
    // non-interactively (WORKER_DISPATCH_PERMISSION.codex) and the per-thread picker was removed from
    // the UI, so there is no operator choice left for this rewrite to overwrite.
    db.exec(`
      UPDATE session SET permission_mode = 'bypassPermissions'
      WHERE backend = 'codex' AND codex_runtime = 'app-server'
        AND (permission_mode IS NULL OR permission_mode <> 'bypassPermissions')
    `)
  } catch {
    // best-effort
  }
  db.exec("CREATE INDEX IF NOT EXISTS session_snoozed_until_idx ON session(snoozed_until)")

  // The interaction journal is an additive, independently-versioned schema in this same project DB.
  // Construct it before session write statements: replacement/delete transactions below close any
  // pending requests owned by the superseded session atomically with the registry mutation.
  const interactions = createInteractionStore(db)
  const lifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>()
  let closed = false
  const emitSessionLifecycle = (event: SessionLifecycleEvent) => {
    for (const listener of [...lifecycleListeners]) listener(event)
  }

  const selOne = db.prepare<[string], SessionRow>("SELECT * FROM session WHERE slug = ?")
  const selAll = db.prepare<[], SessionRow>("SELECT * FROM session")

  // ---- the whole-table read, memoised --------------------------------------------------------------
  // `allSessions()` is the single hottest operation in the server. It is not a background chore: the
  // tailer calls it TWICE per tick (once at the top of tick(), once inside scanForeign), and the tick
  // is nudge-driven, so on a busy board it runs tens of times a second. A live CPU profile of the
  // maintainer's own server (290 rows, 60 columns) put it at 32% of the entire process — more than half
  // of all tailer time — with node:sqlite's row→object conversion (`plainRow`) alone at 24%. Every tick
  // was re-materialising ~17,000 cells that had not changed, and because a tick runs SYNCHRONOUSLY on
  // the event loop, that cost lands directly on RPC latency and board pushes. The cost also grows with
  // HISTORY, not with live work: 267 of those 290 rows were archived threads nobody was watching.
  //
  // So keep the last read and re-run the query only when the database actually moved. Two cheap probes
  // decide that, and they are deliberately BOTH here:
  //   * `total_changes()` (~0.3µs) counts rows this connection has inserted/updated/deleted. It moves
  //     for any write we made, whatever table — over-invalidating (a `tail_state` flush re-reads the
  //     sessions) but never under-invalidating, which is the only direction that could serve stale rows.
  //     A no-op UPDATE that matches nothing does not move it, so the per-assemble snooze sweep is free.
  //   * `PRAGMA data_version` (~1.8µs) changes only when ANOTHER connection commits. Today one process
  //     owns each project DB, so this never fires; it is here so that if that ever stops being true the
  //     failure mode is a re-read rather than a board frozen forever.
  // Both are read on every call rather than trusting a hand-maintained version counter: there are ~40
  // statements that write this table, and a new one added later must not be able to silently serve
  // stale rows to the board.
  //
  // The returned array is SHARED, hence `readonly SessionRow[]` on the interface — the compiler is what
  // keeps a caller from sorting or splicing the cache out from under the next one.
  const totalChangesStmt = db.prepare<[], { changes: number }>("SELECT total_changes() AS changes")
  const dataVersionStmt = db.prepare<[], { data_version: number }>("PRAGMA data_version")
  let cachedSessions: SessionRow[] | null = null
  let cachedAtChanges = -1
  let cachedAtDataVersion = -1
  const readAllSessions = () => selAll.all().filter((row) => ThreadSlug.safeParse(row.slug).success)
  const allSessions = (): readonly SessionRow[] => {
    // NEVER cache a read taken inside an open transaction. `total_changes()` counts statements as they
    // execute and a ROLLBACK does not wind it back, so a mid-transaction read stored under the
    // post-write watermark would survive the rollback as a view of data that no longer exists. Nothing
    // on the hot path (the tick, board assembly) runs inside a transaction, so this costs nothing.
    if (db.inTransaction) return readAllSessions()
    const changes = totalChangesStmt.get()?.changes ?? -1
    const dataVersion = dataVersionStmt.get()?.data_version ?? -1
    if (cachedSessions && changes === cachedAtChanges && dataVersion === cachedAtDataVersion) return cachedSessions
    cachedSessions = readAllSessions()
    cachedAtChanges = changes
    cachedAtDataVersion = dataVersion
    return cachedSessions
  }
  const upsertStmt = db.prepare(`
    INSERT INTO session (slug, session_id, tmux_name, spawned_at, last_read_at, unread, exited, title_auto, title_locked, title, state, snoozed_until, snooze_prompt, awaiting_fence_id, awaiting_confirmed_at, meta, seen_at, plan_path, transcript_id, model, effort, profile_pending_model, profile_pending_effort, profile_revision, profile_handoff, permission_mode, permission_pending, control_error, runtime_generation, runtime_control, runtime_control_revision)
    VALUES (@slug, @session_id, @tmux_name, @spawned_at, @last_read_at, @unread, @exited, @title_auto, @title_locked, @title, @state, @snoozed_until, @snooze_prompt, @awaiting_fence_id, @awaiting_confirmed_at, @meta, @seen_at, @plan_path, @transcript_id, @model, @effort, @profile_pending_model, @profile_pending_effort, @profile_revision, @profile_handoff, @permission_mode, @permission_pending, @control_error, @runtime_generation, @runtime_control, @runtime_control_revision)
    ON CONFLICT(slug) DO UPDATE SET
      session_id = excluded.session_id,
      tmux_name  = excluded.tmux_name,
      spawned_at = excluded.spawned_at,
      last_read_at = excluded.last_read_at,
      unread = excluded.unread,
      exited = excluded.exited,
      title_auto = excluded.title_auto,
      title_locked = excluded.title_locked,
      title = excluded.title,
      -- This statement REPLACES the title text, so the provenance of the old one cannot survive it: a
      -- re-dispatch over a slug whose worker had already named itself would otherwise keep reading as
      -- agent-written while displaying the fresh dispatch chop. The next title signal sets it again.
      title_agent = 0,
      snoozed_until = excluded.snoozed_until,
      -- Always moves WITH the instant: a spread row carries both, a re-dispatch clears both. An armed
      -- prompt outliving its deadline would be a wake nothing can ever fire.
      snooze_prompt = excluded.snooze_prompt,
      -- A confirmation belongs to ONE session. If this upsert carries a different session_id the row was
      -- re-dispatched, so the operator's prior confirmation must not survive onto it.
      awaiting_fence_id = CASE
        WHEN session.session_id = excluded.session_id THEN excluded.awaiting_fence_id
        ELSE NULL
      END,
      awaiting_confirmed_at = CASE
        WHEN session.session_id = excluded.session_id THEN excluded.awaiting_confirmed_at
        ELSE NULL
      END,
      plan_path = excluded.plan_path,
      model = excluded.model,
      effort = excluded.effort,
      profile_pending_model = excluded.profile_pending_model,
      profile_pending_effort = excluded.profile_pending_effort,
      profile_revision = excluded.profile_revision,
      profile_handoff = excluded.profile_handoff,
      permission_mode = excluded.permission_mode,
      permission_pending = excluded.permission_pending,
      control_error = excluded.control_error,
      runtime_generation = CASE
        WHEN session.session_id = excluded.session_id THEN MAX(session.runtime_generation, excluded.runtime_generation)
        ELSE excluded.runtime_generation
      END,
      runtime_control = excluded.runtime_control,
      runtime_control_revision = excluded.runtime_control_revision,
      -- A re-dispatch/adopt carries a FRESH session_id, so the old discovered path is stale → adopt the
      -- incoming value (NULL for a fresh spawn); a resume spreads the existing row, preserving its cache.
      transcript_id = excluded.transcript_id,
      archived = 0,
      state = 'open'
  `)
  const insertSessionIfAbsentStmt = db.prepare(`
    INSERT INTO session (
      slug, session_id, tmux_name, spawned_at, last_read_at, unread, exited, archived, rested_at,
      title_auto, title_locked, title, transcript_id, state, snoozed_until, snooze_prompt, awaiting_fence_id, awaiting_confirmed_at,
      meta, seen_at, plan_path, backend, agent_session_id,
      model, effort, profile_pending_model, profile_pending_effort, profile_revision, profile_handoff,
      permission_mode, permission_pending, control_error,
      runtime_generation, runtime_control, runtime_control_revision
    )
    VALUES (
      @slug, @session_id, @tmux_name, @spawned_at, @last_read_at, @unread, @exited, @archived,
      @rested_at, @title_auto, @title_locked, @title, @transcript_id, @state, @snoozed_until, @snooze_prompt,
      @awaiting_fence_id, @awaiting_confirmed_at, @meta, @seen_at, @plan_path,
      @backend, @agent_session_id, @model, @effort, @profile_pending_model,
      @profile_pending_effort, @profile_revision, @profile_handoff, @permission_mode, @permission_pending,
      @control_error, @runtime_generation, @runtime_control,
      @runtime_control_revision
    )
    ON CONFLICT(slug) DO NOTHING
  `)
  const selAdoptionClaim = db.prepare<[string], AdoptionClaimRow>(
    "SELECT * FROM adoption_claim WHERE slug = ?",
  )
  const selAllAdoptionClaims = db.prepare<[], AdoptionClaimRow>("SELECT * FROM adoption_claim")
  const selAllRetiredAdoptionAttempts = db.prepare<[], RetiredAdoptionAttemptRow>(
    "SELECT * FROM adoption_retired_attempt ORDER BY retired_at_ms, attempt_token",
  )
  const selRetiredAdoptionAttempt = db.prepare<[string], RetiredAdoptionAttemptRow>(
    "SELECT * FROM adoption_retired_attempt WHERE attempt_token = ?",
  )
  const putRetiredAdoptionAttempt = db.prepare(`
    INSERT OR IGNORE INTO adoption_retired_attempt (attempt_token, slug, session_id, retired_at_ms)
    VALUES (?, ?, ?, ?)
  `)
  const reserveAdoptionClaimStmt = db.prepare(`
    INSERT INTO adoption_claim (
      slug, attempt_token, session_id, state, reserved_at_ms, lease_expires_at_ms,
      recovery_token, pane_id, pane_pid, session_created, finalized_at_ms
    )
    SELECT @slug, @attempt_token, @session_id, 'reserved', @reserved_at_ms, @lease_expires_at_ms,
           NULL, NULL, NULL, NULL, NULL
    WHERE NOT EXISTS (SELECT 1 FROM session WHERE slug = @slug)
      AND NOT EXISTS (
        SELECT 1 FROM adoption_retired_attempt WHERE attempt_token = @attempt_token
      )
    ON CONFLICT DO NOTHING
  `)
  const recordAdoptionPaneStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'spawned', pane_id = @pane_id, pane_pid = @pane_pid,
        session_created = @session_created, lease_expires_at_ms = @lease_expires_at_ms
    WHERE slug = @slug AND attempt_token = @attempt_token
      AND state IN ('reserved', 'spawned')
      AND (
        pane_id IS NULL OR
        (pane_id = @pane_id AND pane_pid = @pane_pid AND session_created = @session_created)
      )
  `)
  const renewAdoptionSpawnFenceStmt = db.prepare(`
    UPDATE adoption_claim
    SET lease_expires_at_ms = ?
    WHERE slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
      AND recovery_token IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM adoption_retired_attempt
        WHERE attempt_token = adoption_claim.attempt_token
      )
  `)
  const finalizeAdoptionClaimStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', finalized_at_ms = ?, recovery_token = NULL
    WHERE slug = ? AND attempt_token = ? AND session_id = ? AND state IN ('reserved', 'spawned')
  `)
  const rearmFinalizedAdoptionClaimStmt = db.prepare(`
    UPDATE adoption_claim
    SET attempt_token = @attempt_token, state = 'reserved', reserved_at_ms = @reserved_at_ms,
        lease_expires_at_ms = @lease_expires_at_ms, recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL, finalized_at_ms = NULL
    WHERE slug = @slug AND session_id = @session_id AND attempt_token = @previous_attempt_token
      AND state = 'finalized'
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const finalizeAdoptionRespawnClaimStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', finalized_at_ms = ?, recovery_token = NULL
    WHERE slug = ? AND attempt_token = ? AND session_id = ? AND state IN ('reserved', 'spawned')
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const restoreAdoptionNoPaneStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL,
        finalized_at_ms = COALESCE(finalized_at_ms, reserved_at_ms)
    WHERE slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const deleteAbandonedAdoptionClaimStmt = db.prepare(`
    DELETE FROM adoption_claim
    WHERE slug = ? AND attempt_token = ? AND state IN ('reserved', 'spawned')
  `)
  const beginAdoptionRecoveryStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'recovering', recovery_token = ?, lease_expires_at_ms = ?
    WHERE slug = ? AND attempt_token = ? AND state != 'finalized' AND lease_expires_at_ms <= ?
  `)
  const restoreRecoveredAdoptionNoPaneStmt = db.prepare(`
    UPDATE adoption_claim
    SET state = 'finalized', recovery_token = NULL,
        pane_id = NULL, pane_pid = NULL, session_created = NULL,
        finalized_at_ms = COALESCE(finalized_at_ms, reserved_at_ms)
    WHERE slug = ? AND attempt_token = ? AND state = 'recovering' AND recovery_token = ?
      AND EXISTS (
        SELECT 1 FROM session
        WHERE session.slug = adoption_claim.slug AND session.session_id = adoption_claim.session_id
      )
  `)
  const deleteRecoveredAdoptionClaimStmt = db.prepare(`
    DELETE FROM adoption_claim
    WHERE slug = ? AND attempt_token = ? AND state = 'recovering' AND recovery_token = ?
  `)
  const delFinalizedAdoptionClaim = db.prepare(`
    DELETE FROM adoption_claim WHERE slug = ? AND session_id = ? AND state = 'finalized'
  `)
  const retireFinalizedAdoptionClaimStmt = db.prepare(`
    DELETE FROM adoption_claim
    WHERE slug = ? AND session_id = ? AND attempt_token = ? AND state = 'finalized'
  `)
  const readStmt = db.prepare("UPDATE session SET last_read_at = ?, unread = 0 WHERE slug = ?")
  const unreadStmt = db.prepare("UPDATE session SET unread = ? WHERE slug = ?")
  const unreadIfCurrentStmt = db.prepare(`
    UPDATE session SET unread = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const exitedStmt = db.prepare("UPDATE session SET exited = ? WHERE slug = ?")
  const exitedIfCurrentStmt = db.prepare(`
    UPDATE session SET exited = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const completeIfCurrentStmt = db.prepare(`
    UPDATE session
    SET exited = 1, state = 'archived', archived = 1, unread = 0, snoozed_until = NULL, snooze_prompt = NULL,
        awaiting_fence_id = NULL, awaiting_confirmed_at = NULL
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const restedStmt = db.prepare("UPDATE session SET rested_at = ? WHERE slug = ?")
  const restedIfCurrentStmt = db.prepare(`
    UPDATE session SET rested_at = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const seenStmt = db.prepare("UPDATE session SET seen_at = ? WHERE slug = ?")
  const transcriptIdStmt = db.prepare("UPDATE session SET transcript_id = ? WHERE slug = ?")
  const transcriptIdIfCurrentStmt = db.prepare(`
    UPDATE session SET transcript_id = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const stateStmt = db.prepare(
    "UPDATE session SET state = ?, archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END, snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END, snooze_prompt = CASE WHEN ? = 1 THEN NULL ELSE snooze_prompt END, awaiting_fence_id = CASE WHEN ? = 1 THEN NULL ELSE awaiting_fence_id END, awaiting_confirmed_at = CASE WHEN ? = 1 THEN NULL ELSE awaiting_confirmed_at END WHERE slug = ?",
  )
  const stateIfCurrentStmt = db.prepare(`
    UPDATE session SET state = ?, archived = ?,
      unread = CASE WHEN ? = 1 THEN 0 ELSE unread END,
      snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END,
      snooze_prompt = CASE WHEN ? = 1 THEN NULL ELSE snooze_prompt END,
      awaiting_fence_id = CASE WHEN ? = 1 THEN NULL ELSE awaiting_fence_id END,
      awaiting_confirmed_at = CASE WHEN ? = 1 THEN NULL ELSE awaiting_confirmed_at END
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const snoozedUntilStmt = db.prepare("UPDATE session SET snoozed_until = ?, snooze_prompt = ? WHERE slug = ?")
  // The session-guarded park. Deliberately leaves snooze_prompt alone: this is the awaiting
  // confirmation/park path, which never arms a scheduled bump.
  const snoozedUntilIfCurrentStmt = db.prepare(`
    UPDATE session SET snoozed_until = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const bgSnoozeRestedAtIfCurrentStmt = db.prepare(`
    UPDATE session SET bg_snooze_rested_at = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  // Every SET expression here reads the ORIGINAL row (SQLite evaluates the whole SET list against the
  // pre-update values), which is what lets one statement decide whether this write is a new arming or
  // an edit of the existing one. The generation — and with it the last-fired stamp — is preserved
  // exactly when the TEXT is unchanged, so toggling off and on again does not supersede a bump already
  // in flight for those same words, while editing the text does.
  // THE RECURRING PROMPT'S SET LIST, shared verbatim by the session-guarded and the by-slug statements
  // so the operator's path and the worker's path can never drift in behaviour — only in their WHERE.
  //
  // Every expression on the right reads the ORIGINAL row, so ONE statement decides whether this write is
  // a fresh arming or an edit: the generation survives exactly when the text AND the interval are both
  // unchanged. That is what makes a bare trigger flip non-destructive.
  //
  // The three fired-stamps clear ASYMMETRICALLY, and deliberately. A prompt edit invalidates all three
  // (the words that fired are gone). An interval-only change invalidates only the SCHEDULE's clock — the
  // rest and post-compaction triggers have no cadence for the interval to describe, so wiping their
  // "last sent" readout would be a lie about when the operator's text last reached the worker.
  const RECURRING_SET = `
      recurring_prompt = ?,
      recurring_interval_ms = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
      recurring_on_rest = ?,
      recurring_on_schedule = ?,
      recurring_on_compact = ?,
      -- The hold is deliberately absent from every CASE below it: it changes neither the WORDS nor the
      -- cadence, so a delivery already queued still describes this row exactly. Flipping it must not
      -- mint a generation or drop a "last sent" stamp.
      recurring_pause_on_questions = ?,
      recurring_armed_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? AND recurring_interval_ms IS ? THEN recurring_armed_at
        ELSE ? END,
      recurring_rest_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? THEN recurring_rest_fired_at
        ELSE NULL END,
      recurring_schedule_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? AND recurring_interval_ms IS ? THEN recurring_schedule_fired_at
        ELSE NULL END,
      recurring_compact_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN recurring_armed_at IS NOT NULL AND recurring_prompt IS ? THEN recurring_compact_fired_at
        ELSE NULL END`
  // The 18 bound values RECURRING_SET consumes, in order. Factored out for the same reason the SET list
  // is: writing this argument list twice is how the two paths silently diverge.
  const recurringArgs = ({ prompt, stopHook, heartbeat, postCompaction, pauseOnQuestions, intervalMs, armedAt }: RecurringWrite) => {
    // A cleared row keeps nothing: no cadence, and every trigger off. No trigger can be left on over a
    // null prompt, or the scheduler would hold an armed row with nothing to say.
    const ms = prompt === null ? null : intervalMs
    const flag = (on: boolean) => (prompt === null || !on ? 0 : 1)
    return [
      prompt,
      ms, ms,
      flag(stopHook),
      flag(heartbeat),
      flag(postCompaction),
      flag(pauseOnQuestions),
      prompt, prompt, ms, armedAt,
      prompt, prompt,
      prompt, prompt, ms,
      prompt, prompt,
    ] as const
  }
  const recurringStmt = db.prepare(`UPDATE session SET ${RECURRING_SET}
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?`)
  const recurringBySlugStmt = db.prepare(`UPDATE session SET ${RECURRING_SET} WHERE slug = ?`)
  const recurringRestFiredStmt = db.prepare(`
    UPDATE session SET recurring_rest_fired_at = ?
    WHERE slug = ? AND recurring_armed_at = ?
  `)
  const recurringScheduleFiredStmt = db.prepare(`
    UPDATE session SET recurring_schedule_fired_at = ?
    WHERE slug = ? AND recurring_armed_at = ?
  `)
  const recurringCompactFiredStmt = db.prepare(`
    UPDATE session SET recurring_compact_fired_at = ?
    WHERE slug = ? AND recurring_armed_at = ?
  `)
  // ---- ONE-OFF TIMERS ----------------------------------------------------------------------------
  const armTimerStmt = db.prepare(`
    INSERT INTO thread_timer (id, thread_slug, prompt, fire_at, state, created_at, settled_at)
    VALUES (@id, @slug, @prompt, @fireAtMs, 'armed', @createdAtMs, NULL)
  `)
  const timersBySlugStmt = db.prepare<[string], ThreadTimerRow>(
    "SELECT * FROM thread_timer WHERE thread_slug = ? ORDER BY fire_at, id",
  )
  const armedTimersBySlugStmt = db.prepare<[string], ThreadTimerRow>(
    "SELECT * FROM thread_timer WHERE thread_slug = ? AND state = 'armed' ORDER BY fire_at, id",
  )
  const timerByIdStmt = db.prepare<[string], ThreadTimerRow>("SELECT * FROM thread_timer WHERE id = ?")
  const dueTimersStmt = db.prepare<[number], ThreadTimerRow>(
    "SELECT * FROM thread_timer WHERE state = 'armed' AND fire_at <= ? ORDER BY fire_at, id",
  )
  const cancelTimerStmt = db.prepare(`
    UPDATE thread_timer SET state = 'cancelled', settled_at = ?
    WHERE id = ? AND thread_slug = ? AND state = 'armed'
  `)
  const fireTimerStmt = db.prepare(`
    UPDATE thread_timer SET state = 'fired', settled_at = ?
    WHERE id = ? AND state = 'armed'
  `)
  const delThreadTimers = db.prepare("DELETE FROM thread_timer WHERE thread_slug = ?")
  const confirmAwaitingWaitStmt = db.prepare(`
    UPDATE session
    SET awaiting_fence_id = ?, awaiting_confirmed_at = ?, snoozed_until = ?
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
      AND archived = 0 AND COALESCE(state, 'open') = 'open'
  `)
  const clearAwaitingWaitIfSessionStmt = db.prepare(`
    UPDATE session
    SET awaiting_fence_id = NULL, awaiting_confirmed_at = NULL, snoozed_until = NULL
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  const clearAwaitingWaitIfCurrentStmt = db.prepare(`
    UPDATE session
    SET awaiting_fence_id = NULL, awaiting_confirmed_at = NULL, snoozed_until = NULL
    WHERE slug = ? AND session_id = ? AND awaiting_fence_id = ?
  `)
  // Only a PROMPTLESS snooze expires here. One that carries a prompt still owes the thread a bump, and
  // the scheduler — not the board — clears it once that wake reaches a terminal state. Erasing it on
  // elapse (the board refreshes far more often than the waker ticks) would drop the follow-up entirely.
  const clearExpiredSnoozesStmt = db.prepare(`
    UPDATE session SET snoozed_until = NULL
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= ? AND snooze_prompt IS NULL
  `)
  // Both human-title writers LOCK as they write: the text, the "not a guess" flag, and the lock move in
  // one statement, so no concurrent tail tick can land a backend auto-title between them.
  const titleStmt = db.prepare("UPDATE session SET title = ?, title_auto = 0, title_locked = 1, title_agent = 0 WHERE slug = ?")
  const titleCasStmt = db.prepare(
    "UPDATE session SET title = ?, title_auto = 0, title_locked = 1, title_agent = 0 WHERE slug = ? AND session_id = ? AND title IS ? AND title_auto = ?",
  )
  // Gated on the LOCK, not on title_auto: a caller-supplied dispatch title (`Investigate acme/app#391`,
  // a parent agent's guess) is unlocked, so the worker's own title supersedes it. title_auto is left
  // alone — the row's DISPLAY provenance is unchanged by which machine produced the current text.
  // `title_agent` IS moved, because it describes the text this statement is writing: the worker's own
  // name. It is what lets the display trust a persisted codex title once the live telemetry is gone.
  const autoTitleCasStmt = db.prepare(`
    UPDATE session SET title = ?, title_agent = 1
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ?
      AND runtime_generation = ? AND title_locked = 0
  `)
  const delSession = db.prepare("DELETE FROM session WHERE slug = ?")
  const putRetiredOp = db.prepare("INSERT OR IGNORE INTO retired_op (slug, session_id, op_id, retired_at) VALUES (?, ?, ?, ?)")
  const getRetiredOps = db.prepare<[string, string], { op_id: string }>("SELECT op_id FROM retired_op WHERE slug = ? AND session_id = ?")
  const delRetiredOps = db.prepare("DELETE FROM retired_op WHERE slug = ?")
  const delRetiredOp = db.prepare("DELETE FROM retired_op WHERE slug = ? AND session_id = ? AND op_id = ?")
  const putTomb = db.prepare("INSERT OR IGNORE INTO tombstone (transcript_id, slug, forgotten_at) VALUES (?, ?, ?)")
  const allTombs = db.prepare<[], { transcript_id: string }>("SELECT transcript_id FROM tombstone")
  // Storage is constructed before the disabled app-server bridge, so this table may appear later in
  // the process. Resolve it lazily inside the same registry transaction. Detaching first makes a
  // matching native binding non-actionable even if the post-commit process cleanup is interrupted.
  const detachCodexBinding = (threadSlug: string, sessionId: string, at: string) => {
    const exists = db.prepare<[], { present: number }>(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'codex_app_server_session'
    `).get()
    if (!exists) return
    db.prepare(`
      UPDATE codex_app_server_session
      SET state = 'detached', current_turn_id = NULL, updated_at = ?
      WHERE thread_slug = ? AND frizz_session_id = ?
    `).run(at, threadSlug, sessionId)
  }
  const forgetOwnedRow = (existing: SessionRow): SessionRow => {
    const at = new Date().toISOString()
    interactions.cancelForSession(existing.slug, existing.session_id, "session-deleted")
    detachCodexBinding(existing.slug, existing.session_id, at)
    putTomb.run(existing.session_id, existing.slug, at)
    if (existing.transcript_id) putTomb.run(existing.transcript_id, existing.slug, at)
    if (existing.agent_session_id) putTomb.run(existing.agent_session_id, existing.slug, at)
    const claim = selAdoptionClaim.get(existing.slug)
    if (claim?.state === "finalized" && claim.session_id === existing.session_id) {
      retireAdoptionAttempt(claim)
      delFinalizedAdoptionClaim.run(existing.slug, existing.session_id)
    }
    // Retirements are scoped to a session that no longer exists. Dropping them with the row keeps the
    // table from growing forever across re-dispatches of a busy slug; the (slug, session_id) key means
    // a replacement session could never have read them anyway.
    delRetiredOps.run(existing.slug)
    // Same reasoning for the thread's one-off timers: an alarm set for a thread that no longer exists
    // has nothing to wake, and the scheduler would otherwise carry the armed row for up to thirty days.
    delThreadTimers.run(existing.slug)
    delSession.run(existing.slug)
    return existing
  }

  // One transaction: drop the row and graveyard its transcript id(s), so a rescan mid-delete can never see
  // a half-forgotten state (row gone but transcript un-tombstoned, or vice-versa).
  const forget = db.transaction((slug: string): SessionRow | undefined => {
    const existing = selOne.get(slug)
    return existing ? forgetOwnedRow(existing) : undefined
  })

  const forgetIfCurrent = db.transaction(
    (slug: string, expected: ForgetSessionExpectation): SessionRow | undefined => {
      const existing = selOne.get(slug)
      if (
        !existing ||
        existing.session_id !== expected.sessionId ||
        (existing.runtime_generation ?? 0) !== expected.runtimeGeneration
      ) return undefined
      const claim = selAdoptionClaim.get(slug)
      if (expected.adoptionAttemptToken === null) {
        if (claim) return undefined
      } else if (
        !claim || claim.state !== "finalized" || claim.session_id !== expected.sessionId ||
        claim.attempt_token !== expected.adoptionAttemptToken
      ) {
        return undefined
      }
      return forgetOwnedRow(existing)
    },
  )
  const backendStmt = db.prepare("UPDATE session SET backend = ? WHERE slug = ?")
  const agentSessionStmt = db.prepare("UPDATE session SET agent_session_id = ? WHERE slug = ?")
  const codexRuntimeStmt = db.prepare("UPDATE session SET codex_runtime = ? WHERE slug = ?")
  const claudeRuntimeStmt = db.prepare("UPDATE session SET claude_runtime = ? WHERE slug = ?")
  // Stamps profile_set_at alongside model/effort: the OPERATOR's set-time (the codex setThreadProfile
  // path), which the board uses to outrank an older observed turn_context so a just-picked model/effort
  // shows on the composer selector immediately (see resolveSessionProfile). Sibling of permissionModeStmt.
  const profileStmt = db.prepare("UPDATE session SET model = ?, effort = ?, profile_set_at = ? WHERE slug = ?")
  // Stamps permission_set_at alongside the mode: this is the OPERATOR's set-time, which the board uses
  // to outrank an older observed telemetry reading (see resolveSessionPermission). The tailer's
  // observed write-back uses observedPermissionIfCurrentStmt and deliberately does NOT touch it.
  const permissionModeStmt = db.prepare("UPDATE session SET permission_mode = ?, permission_set_at = ? WHERE slug = ?")
  const permissionPendingStmt = db.prepare("UPDATE session SET permission_pending = ? WHERE slug = ?")
  const beginRuntimeControlStmt = db.prepare(`
    UPDATE session
    SET runtime_control = ?, runtime_control_revision = runtime_control_revision + 1
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
  `)
  const releaseRuntimeControlStmt = db.prepare(`
    UPDATE session SET runtime_control = NULL
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
      AND runtime_control = ? AND runtime_control_revision = ?
  `)
  const profileTargetIfCurrentStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_revision = profile_revision + 1, control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
  `)
  const armProfileChangeStmt = db.prepare(`
    UPDATE session
    SET profile_pending_model = ?, profile_pending_effort = ?,
        profile_revision = profile_revision + 1,
        profile_handoff = ?,
        runtime_control = 'profile', runtime_control_revision = runtime_control_revision + 1,
        control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND runtime_control IS NULL AND permission_pending IS NULL
      AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
  `)
  const checkpointProfileChangeStmt = db.prepare(`
    UPDATE session SET profile_handoff = ?, control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const commitProfileChangeStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = NULL
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const restoreProfileChangeStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = ?
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const blockProfileChangeStmt = db.prepare(`
    UPDATE session SET control_error = ?
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const failProfileChangeStmt = db.prepare(`
    UPDATE session
    SET profile_pending_model = NULL, profile_pending_effort = NULL,
        profile_handoff = NULL, runtime_control = NULL, control_error = ?
    WHERE slug = ? AND session_id = ? AND agent_session_id IS ? AND runtime_generation = ?
      AND profile_revision = ? AND runtime_control = 'profile' AND runtime_control_revision = ?
      AND profile_pending_model = ? AND profile_pending_effort = ? AND profile_handoff IS ?
  `)
  const observedProfileIfCurrentStmt = db.prepare(`
    UPDATE session
    SET model = ?, effort = ?, profile_revision = profile_revision + 1
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
      AND runtime_control IS NULL AND profile_pending_model IS NULL AND profile_pending_effort IS NULL
      AND (model IS NOT ? OR effort IS NOT ?)
  `)
  const beginRuntimeGenerationStmt = db.prepare(`
    UPDATE session
    SET runtime_generation = runtime_generation + 1, spawned_at = ?, exited = 0
    WHERE slug = ? AND session_id = ? AND runtime_generation = ? AND permission_pending IS ?
      AND runtime_control IS ?
  `)
  const permissionStateIfCurrentStmt = db.prepare(`
    UPDATE session
    SET exited = ?, permission_mode = ?, permission_pending = ?, control_error = ?,
        runtime_control = CASE
          WHEN ? IS NULL AND runtime_control = 'permission' THEN NULL
          ELSE runtime_control
        END
    WHERE slug = ? AND session_id = ? AND runtime_generation = ? AND permission_pending IS ?
      AND runtime_control IS ?
  `)
  const observedPermissionIfCurrentStmt = db.prepare(
    "UPDATE session SET permission_mode = ? WHERE slug = ? AND session_id = ? AND runtime_generation = ? AND permission_mode IS NOT ?",
  )
  const controlErrorIfCurrentStmt = db.prepare(
    "UPDATE session SET control_error = ? WHERE slug = ? AND session_id = ? AND runtime_generation = ?",
  )
  const controlErrorStmt = db.prepare("UPDATE session SET control_error = ? WHERE slug = ?")
  const deliveryLedgerStmt = db.prepare("UPDATE session SET delivery_ledger = ? WHERE slug = ?")
  const getSet = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
  const putSet = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
  const delSet = db.prepare("DELETE FROM settings WHERE key = ?")

  const normalizeSessionRow = (row: SessionRow) => ({
    ...row,
    title_locked: sessionTitleLocked(row) ? 1 : 0,
    backend: row.backend ?? "claude",
    agent_session_id: row.agent_session_id ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    profile_pending_model: row.profile_pending_model ?? null,
    profile_pending_effort: row.profile_pending_effort ?? null,
    profile_set_at: row.profile_set_at ?? null,
    profile_revision: row.profile_revision ?? 0,
    profile_handoff: row.profile_handoff ?? null,
    permission_mode: row.permission_mode ?? null,
    permission_pending: row.permission_pending ?? null,
    permission_set_at: row.permission_set_at ?? null,
    snoozed_until: row.snoozed_until ?? null,
    snooze_prompt: row.snooze_prompt ?? null,
    awaiting_fence_id: row.awaiting_fence_id ?? null,
    awaiting_confirmed_at: row.awaiting_confirmed_at ?? null,
    control_error: row.control_error ?? null,
    delivery_ledger: row.delivery_ledger ?? null,
    runtime_generation: row.runtime_generation ?? 0,
    runtime_control: row.runtime_control ?? null,
    runtime_control_revision: row.runtime_control_revision ?? 0,
    codex_runtime: row.codex_runtime ?? null,
    claude_runtime: row.claude_runtime ?? null,
  })

  const getAdoptionRuntimeSnapshot = db.transaction((slug: string) => ({
    // Claim first is intentional: a finalized claim disappearing before the current-row validation
    // must never make a stale adopted row look like an unbound legacy runtime.
    claim: selAdoptionClaim.get(slug),
    session: selOne.get(slug),
  }))

  const validateSessionIdentity = (row: SessionRow) => {
    const slug = ThreadSlug.parse(row.slug)
    if (row.tmux_name !== threadIdentityName(slug)) throw new Error("invalid session thread identity")
  }

  const validateAdoptionReservation = (reservation: AdoptionReservation) => {
    ThreadSlug.parse(reservation.slug)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservation.attemptToken)) {
      throw new Error("invalid adoption attempt token")
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(reservation.sessionId)) {
      throw new Error("invalid adoption session id")
    }
    if (
      !Number.isSafeInteger(reservation.reservedAtMs) ||
      !Number.isSafeInteger(reservation.leaseExpiresAtMs) ||
      reservation.leaseExpiresAtMs <= reservation.reservedAtMs
    ) {
      throw new Error("invalid adoption lease")
    }
  }

  const validateAdoptionPane = (identity: AdoptionPaneIdentity) => {
    if (
      !/^%\d+$/.test(identity.paneId) ||
      !Number.isSafeInteger(identity.panePid) ||
      identity.panePid <= 0 ||
      !Number.isSafeInteger(identity.sessionCreated) ||
      identity.sessionCreated <= 0
    ) {
      throw new Error("invalid adoption pane identity")
    }
  }

  const retireAdoptionAttempt = (claim: AdoptionClaimRow, retiredAtMs = Date.now()): void => {
    putRetiredAdoptionAttempt.run(claim.attempt_token, claim.slug, claim.session_id, retiredAtMs)
  }

  const withAdoptionSpawnFence = <T>(
    slug: string,
    attemptToken: string,
    leaseExpiresAtMs: number,
    spawn: (bindPane: (identity: AdoptionPaneIdentity, leaseExpiresAtMs: number) => boolean) => T,
  ): AdoptionSpawnFenceResult<T> => {
    ThreadSlug.parse(slug)
    if (!Number.isSafeInteger(leaseExpiresAtMs)) return { acquired: false }
    db.exec("BEGIN IMMEDIATE")
    let bound = false
    try {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        (claim.state !== "reserved" && claim.state !== "spawned") ||
        claim.recovery_token !== null ||
        selRetiredAdoptionAttempt.get(attemptToken)
      ) {
        db.exec("ROLLBACK")
        return { acquired: false }
      }
      if (renewAdoptionSpawnFenceStmt.run(leaseExpiresAtMs, slug, attemptToken).changes !== 1) {
        db.exec("ROLLBACK")
        return { acquired: false }
      }
      // Hold BEGIN IMMEDIATE only through new-session. onCreated calls bindPane, which commits the
      // exact tuple and releases the recovery fence BEFORE remain-on-exit/status setup continues.
      // Thus a pre-bind SIGKILL rolls back to the durable token-only reservation, while every later
      // setup crash retains the exact tuple instead of rolling it back with the spawn fence.
      const bindPane = (identity: AdoptionPaneIdentity, nextLeaseExpiresAtMs: number): boolean => {
        if (bound || !db.inTransaction) return false
        validateAdoptionPane(identity)
        if (!Number.isSafeInteger(nextLeaseExpiresAtMs)) return false
        const changed = recordAdoptionPaneStmt.run({
          slug,
          attempt_token: attemptToken,
          pane_id: identity.paneId,
          pane_pid: identity.panePid,
          session_created: identity.sessionCreated,
          lease_expires_at_ms: nextLeaseExpiresAtMs,
        }).changes === 1
        if (!changed) return false
        db.exec("COMMIT")
        bound = true
        return true
      }
      const value = spawn(bindPane)
      if (!bound) {
        if (db.inTransaction) db.exec("ROLLBACK")
        throw new Error("adoption spawn returned without binding its exact pane")
      }
      return { acquired: true, value }
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK")
      throw error
    }
  }


  const finalizeAdoptionClaimTxn = db.transaction(
    (slug: string, attemptToken: string, row: SessionRow, finalizedAtMs: number): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        claim.session_id !== row.session_id ||
        // A broker-backed adoption never binds a pane, so the old 'spawned'+pane-columns gate is gone:
        // the reservation IS the claim and the broker session is the identity.
        (claim.state !== "reserved" && claim.state !== "spawned")
      ) {
        return false
      }
      if (insertSessionIfAbsentStmt.run(normalizeSessionRow(row)).changes !== 1) return false
      if (finalizeAdoptionClaimStmt.run(finalizedAtMs, slug, attemptToken, row.session_id).changes !== 1) {
        throw new Error("adoption claim changed during finalization")
      }
      return true
    },
  )

  const rearmFinalizedAdoptionClaimTxn = db.transaction(
    (reservation: AdoptionReservation, previousAttemptToken: string): boolean => {
      const claim = selAdoptionClaim.get(reservation.slug)
      if (
        !claim ||
        claim.state !== "finalized" ||
        claim.session_id !== reservation.sessionId ||
        claim.attempt_token !== previousAttemptToken ||
        Boolean(selRetiredAdoptionAttempt.get(reservation.attemptToken))
      ) return false
      retireAdoptionAttempt(claim, reservation.reservedAtMs)
      return rearmFinalizedAdoptionClaimStmt.run({
        slug: reservation.slug,
        session_id: reservation.sessionId,
        attempt_token: reservation.attemptToken,
        previous_attempt_token: previousAttemptToken,
        reserved_at_ms: reservation.reservedAtMs,
        lease_expires_at_ms: reservation.leaseExpiresAtMs,
      }).changes === 1
    },
  )

  const abandonAdoptionClaimTxn = db.transaction((slug: string, attemptToken: string): boolean => {
    const claim = selAdoptionClaim.get(slug)
    if (!claim || claim.attempt_token !== attemptToken || (claim.state !== "reserved" && claim.state !== "spawned")) {
      return false
    }
    retireAdoptionAttempt(claim)
    if (restoreAdoptionNoPaneStmt.run(slug, attemptToken).changes === 1) return true
    return deleteAbandonedAdoptionClaimStmt.run(slug, attemptToken).changes === 1
  })

  const finishAdoptionRecoveryTxn = db.transaction(
    (slug: string, attemptToken: string, recoveryToken: string): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim ||
        claim.attempt_token !== attemptToken ||
        claim.state !== "recovering" ||
        claim.recovery_token !== recoveryToken
      ) return false
      retireAdoptionAttempt(claim)
      if (restoreRecoveredAdoptionNoPaneStmt.run(slug, attemptToken, recoveryToken).changes === 1) return true
      return deleteRecoveredAdoptionClaimStmt.run(slug, attemptToken, recoveryToken).changes === 1
    },
  )

  const retireFinalizedAdoptionClaimTxn = db.transaction(
    (slug: string, sessionId: string, attemptToken: string): boolean => {
      const claim = selAdoptionClaim.get(slug)
      if (
        !claim || claim.state !== "finalized" || claim.session_id !== sessionId ||
        claim.attempt_token !== attemptToken
      ) return false
      retireAdoptionAttempt(claim)
      return retireFinalizedAdoptionClaimStmt.run(slug, sessionId, attemptToken).changes === 1
    },
  )

  const beginAdoptionRecoveryTxn = db.transaction(
    (
      slug: string,
      attemptToken: string,
      recoveryToken: string,
      nowMs: number,
      leaseExpiresAtMs: number,
    ): AdoptionClaimRow | undefined => {
      const changed = beginAdoptionRecoveryStmt.run(
        recoveryToken,
        leaseExpiresAtMs,
        slug,
        attemptToken,
        nowMs,
      ).changes === 1
      return changed ? selAdoptionClaim.get(slug) : undefined
    },
  )

  const upsertSessionTxn = db.transaction((row: SessionRow): SessionLifecycleEvent | undefined => {
    const existing = selOne.get(row.slug)
    upsertStmt.run(normalizeSessionRow(row))
    if (existing && existing.session_id !== row.session_id) {
      interactions.cancelForSession(existing.slug, existing.session_id, "session-replaced")
      detachCodexBinding(existing.slug, existing.session_id, new Date().toISOString())
      const replacedClaim = selAdoptionClaim.get(existing.slug)
      if (replacedClaim?.state === "finalized" && replacedClaim.session_id === existing.session_id) {
        retireAdoptionAttempt(replacedClaim)
      }
      delFinalizedAdoptionClaim.run(existing.slug, existing.session_id)
      return { type: "replaced", previous: existing, current: selOne.get(row.slug)! }
    }
    return undefined
  })

  const upsertSession = (row: SessionRow) => {
    validateSessionIdentity(row)
    const event = upsertSessionTxn(row)
    if (event) emitSessionLifecycle(event)
  }

  const forgetSession = (slug: string) => {
    const previous = forget(slug)
    if (previous) emitSessionLifecycle({ type: "deleted", previous })
    return previous
  }

  return {
    db,
    interactions,
    // Databases created before the canonical guard may contain an overlong or otherwise unsafe id.
    // Keep those legacy/corrupt rows inert so boot reconciliation and pollers never feed them to
    // tmux, filesystem, transcript, or event boundaries.
    getSession: (slug) => ThreadSlug.safeParse(slug).success ? selOne.get(slug) : undefined,
    allSessions,
    subscribeSessionLifecycle(listener) {
      lifecycleListeners.add(listener)
      return () => lifecycleListeners.delete(listener)
    },
    retireOp: (slug, sessionId, opId) => void putRetiredOp.run(slug, sessionId, opId, new Date().toISOString()),
    retiredOps: (slug, sessionId) => new Set(getRetiredOps.all(slug, sessionId).map((r) => r.op_id)),
    unretireOp: (slug, sessionId, opId) => void delRetiredOp.run(slug, sessionId, opId),
    // Profile fields are optional in SessionRow so pre-migration fixtures/callers still typecheck;
    // normalize them for better-sqlite3, whose named statement requires every referenced parameter.
    upsertSession: (row) => void upsertSession(row),
    insertSessionIfAbsent: (row) => {
      validateSessionIdentity(row)
      return insertSessionIfAbsentStmt.run(normalizeSessionRow(row)).changes === 1
    },
    getAdoptionClaim: (slug) => ThreadSlug.safeParse(slug).success ? selAdoptionClaim.get(slug) : undefined,
    getAdoptionRuntimeSnapshot: (slug) => ThreadSlug.safeParse(slug).success
      ? getAdoptionRuntimeSnapshot.deferred(slug)
      : { session: undefined, claim: undefined },
    allAdoptionClaims: () => selAllAdoptionClaims.all().filter((claim) => ThreadSlug.safeParse(claim.slug).success),
    allRetiredAdoptionAttempts: () => selAllRetiredAdoptionAttempts.all()
      .filter((attempt) => ThreadSlug.safeParse(attempt.slug).success),
    reserveAdoptionClaim: (reservation) => {
      validateAdoptionReservation(reservation)
      return reserveAdoptionClaimStmt.run({
        slug: reservation.slug,
        attempt_token: reservation.attemptToken,
        session_id: reservation.sessionId,
        reserved_at_ms: reservation.reservedAtMs,
        lease_expires_at_ms: reservation.leaseExpiresAtMs,
      }).changes === 1
    },
    recordAdoptionPane: (slug, attemptToken, identity, leaseExpiresAtMs) => {
      ThreadSlug.parse(slug)
      validateAdoptionPane(identity)
      if (!Number.isSafeInteger(leaseExpiresAtMs)) throw new Error("invalid adoption lease")
      return recordAdoptionPaneStmt.run({
        slug,
        attempt_token: attemptToken,
        pane_id: identity.paneId,
        pane_pid: identity.panePid,
        session_created: identity.sessionCreated,
        lease_expires_at_ms: leaseExpiresAtMs,
      }).changes === 1
    },
    withAdoptionSpawnFence,
    finalizeAdoptionClaim: (slug, attemptToken, row, finalizedAtMs) => {
      ThreadSlug.parse(slug)
      validateSessionIdentity(row)
      if (row.slug !== slug || !Number.isSafeInteger(finalizedAtMs)) return false
      return finalizeAdoptionClaimTxn(slug, attemptToken, row, finalizedAtMs)
    },
    rearmFinalizedAdoptionClaim: (reservation, previousAttemptToken) => {
      validateAdoptionReservation(reservation)
      return rearmFinalizedAdoptionClaimTxn(reservation, previousAttemptToken)
    },
    finalizeAdoptionRespawnClaim: (slug, attemptToken, sessionId, finalizedAtMs) =>
      ThreadSlug.safeParse(slug).success &&
      Number.isSafeInteger(finalizedAtMs) &&
      finalizeAdoptionRespawnClaimStmt.run(finalizedAtMs, slug, attemptToken, sessionId).changes === 1,
    abandonAdoptionClaim: (slug, attemptToken) =>
      ThreadSlug.safeParse(slug).success && abandonAdoptionClaimTxn(slug, attemptToken),
    beginAdoptionRecovery: (slug, attemptToken, recoveryToken, nowMs, leaseExpiresAtMs) => {
      if (
        !ThreadSlug.safeParse(slug).success ||
        !/^[0-9a-f-]{36}$/i.test(recoveryToken) ||
        !Number.isSafeInteger(nowMs) ||
        !Number.isSafeInteger(leaseExpiresAtMs) ||
        leaseExpiresAtMs <= nowMs
      ) {
        return undefined
      }
      return beginAdoptionRecoveryTxn(slug, attemptToken, recoveryToken, nowMs, leaseExpiresAtMs)
    },
    finishAdoptionRecovery: (slug, attemptToken, recoveryToken) =>
      ThreadSlug.safeParse(slug).success &&
      finishAdoptionRecoveryTxn(slug, attemptToken, recoveryToken),
    retireFinalizedAdoptionClaim: (slug, sessionId, attemptToken) =>
      ThreadSlug.safeParse(slug).success &&
      retireFinalizedAdoptionClaimTxn(slug, sessionId, attemptToken),
    markRead: (slug, at = new Date().toISOString()) => void readStmt.run(at, slug),
    setUnread: (slug, unread) => void unreadStmt.run(unread ? 1 : 0, slug),
    setUnreadIfCurrent: (slug, sessionId, generation, unread) =>
      unreadIfCurrentStmt.run(unread ? 1 : 0, slug, sessionId, generation).changes === 1,
    setExited: (slug, exited) => void exitedStmt.run(exited ? 1 : 0, slug),
    setExitedIfCurrent: (slug, sessionId, generation, exited) =>
      exitedIfCurrentStmt.run(exited ? 1 : 0, slug, sessionId, generation).changes === 1,
    completeIfCurrent: (slug, sessionId, generation) =>
      completeIfCurrentStmt.run(slug, sessionId, generation).changes === 1,
    // Six flags: archived, then the unread / snoozed_until / snooze_prompt / awaiting_fence_id /
    // awaiting_confirmed_at CASE guards, in statement order.
    setRestedAt: (slug, at) => void restedStmt.run(at, slug),
    setRestedAtIfCurrent: (slug, sessionId, generation, at) =>
      restedIfCurrentStmt.run(at, slug, sessionId, generation).changes === 1,
    setSeenAt: (slug, at) => void seenStmt.run(at, slug),
    setTranscriptId: (slug, transcriptId) => void transcriptIdStmt.run(transcriptId, slug),
    setTranscriptIdIfCurrent: (slug, sessionId, generation, transcriptId) =>
      transcriptIdIfCurrentStmt.run(transcriptId, slug, sessionId, generation).changes === 1,
    setState: (slug, state) =>
      void stateStmt.run(
        state,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        slug,
      ),
    setStateIfCurrent: (slug, sessionId, generation, state) =>
      stateIfCurrentStmt.run(
        state,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        state === "archived" ? 1 : 0,
        slug,
        sessionId,
        generation,
      ).changes === 1,
    // The instant and its follow-up are ONE fact: clearing the snooze (wake-now, archive, and a human
    // follow-up — see resume.wakeParkedThreadForFollowUp) always disarms the prompt, and a prompt can
    // never be written without a deadline to fire it.
    setSnoozedUntil: (slug, until, prompt = null) =>
      void snoozedUntilStmt.run(until, until === null ? null : prompt, slug),
    setSnoozedUntilIfCurrent: (slug, sessionId, generation, until) =>
      snoozedUntilIfCurrentStmt.run(until, slug, sessionId, generation).changes === 1,
    setBgSnoozeRestedAtIfCurrent: (slug, sessionId, generation, restedAt) =>
      bgSnoozeRestedAtIfCurrentStmt.run(restedAt, slug, sessionId, generation).changes === 1,
    setRecurringPromptIfCurrent: (slug, sessionId, generation, write) =>
      recurringStmt.run(...recurringArgs(write), slug, sessionId, generation).changes === 1,
    setRecurringPromptBySlug: (slug, write) =>
      recurringBySlugStmt.run(...recurringArgs(write), slug).changes === 1,
    armThreadTimer: (timer) => void armTimerStmt.run(timer),
    listThreadTimers: (slug, opts) =>
      (opts?.armedOnly ? armedTimersBySlugStmt : timersBySlugStmt).all(slug),
    getThreadTimer: (id) => timerByIdStmt.get(id),
    dueThreadTimers: (nowMs) => dueTimersStmt.all(nowMs),
    cancelThreadTimer: (slug, id, settledAtMs) =>
      cancelTimerStmt.run(settledAtMs, id, slug).changes === 1,
    markThreadTimerFired: (id, settledAtMs) => fireTimerStmt.run(settledAtMs, id).changes === 1,
    stampRecurringRestFired: (slug, armedAt, firedAt) =>
      recurringRestFiredStmt.run(firedAt, slug, armedAt).changes === 1,
    stampRecurringScheduleFired: (slug, armedAt, firedAt) =>
      recurringScheduleFiredStmt.run(firedAt, slug, armedAt).changes === 1,
    stampRecurringCompactFired: (slug, armedAt, firedAt) =>
      recurringCompactFiredStmt.run(firedAt, slug, armedAt).changes === 1,
    confirmAwaitingWait: (slug, sessionId, generation, fenceId, confirmedAt, snoozedUntil) =>
      confirmAwaitingWaitStmt.run(fenceId, confirmedAt, snoozedUntil, slug, sessionId, generation).changes === 1,
    clearAwaitingWaitIfSession: (slug, sessionId, generation) =>
      clearAwaitingWaitIfSessionStmt.run(slug, sessionId, generation).changes === 1,
    clearAwaitingWaitIfCurrent: (slug, sessionId, fenceId) =>
      clearAwaitingWaitIfCurrentStmt.run(slug, sessionId, fenceId).changes === 1,
    clearExpiredSnoozes: (now) => clearExpiredSnoozesStmt.run(now).changes,
    setTitle: (slug, title) => void titleStmt.run(title, slug),
    setTitleIfCurrent: (slug, title, expected) =>
      titleCasStmt.run(title, slug, expected.sessionId, expected.title, expected.titleAuto).changes === 1,
    setAutoTitleIfCurrent: (slug, title, expected) =>
      autoTitleCasStmt.run(
        title,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.runtimeGeneration,
      ).changes === 1,
    forgetSession,
    forgetSessionIfCurrent: (slug, expected) => {
      if (!ThreadSlug.safeParse(slug).success || !Number.isSafeInteger(expected.runtimeGeneration)) return undefined
      const previous = forgetIfCurrent(slug, expected)
      if (previous) emitSessionLifecycle({ type: "deleted", previous })
      return previous
    },
    forgottenIds: () => new Set(allTombs.all().map((r) => r.transcript_id)),
    setBackend: (slug, backend) => void backendStmt.run(backend, slug),
    setAgentSession: (slug, agentSessionId) => void agentSessionStmt.run(agentSessionId, slug),
    setCodexRuntime: (slug, runtime) => void codexRuntimeStmt.run(runtime, slug),
    setClaudeRuntime: (slug, runtime) => void claudeRuntimeStmt.run(runtime, slug),
    setProfile: (slug, model, effort) => void profileStmt.run(model, effort, new Date().toISOString(), slug),
    setPermissionMode: (slug, permissionMode) => void permissionModeStmt.run(permissionMode, new Date().toISOString(), slug),
    setPermissionPending: (slug, permissionMode) => void permissionPendingStmt.run(permissionMode, slug),
    beginRuntimeControl: (slug, expected, kind) => {
      const changed = beginRuntimeControlStmt.run(
        kind,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1
      if (!changed) return null
      const current = selOne.get(slug)
      return current?.runtime_control === kind ? current.runtime_control_revision ?? null : null
    },
    releaseRuntimeControl: (slug, expected) =>
      releaseRuntimeControlStmt.run(
        slug,
        expected.sessionId,
        expected.generation,
        expected.kind,
        expected.revision,
      ).changes === 1,
    setProfileTargetIfCurrent: (slug, expected, profile) =>
      profileTargetIfCurrentStmt.run(
        profile.model,
        profile.effort,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1,
    armProfileChange: (slug, expected, profile, handoff) => {
      const serialized = JSON.stringify(handoff)
      const changed = armProfileChangeStmt.run(
        profile.model,
        profile.effort,
        serialized,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
      ).changes === 1
      if (!changed) return null
      const current = selOne.get(slug)
      if (!current || current.runtime_control !== "profile") return null
      return {
        profileRevision: current.profile_revision ?? 0,
        controlRevision: current.runtime_control_revision ?? 0,
        profileHandoff: serialized,
      }
    },
    checkpointProfileChange: (slug, expected, handoff) => {
      const serialized = JSON.stringify(handoff)
      const changed = checkpointProfileChangeStmt.run(
        serialized,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1
      return changed ? serialized : null
    },
    commitProfileChange: (slug, expected) =>
      commitProfileChangeStmt.run(
        expected.model,
        expected.effort,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    restoreProfileChange: (slug, expected, previous, error) =>
      restoreProfileChangeStmt.run(
        previous.model,
        previous.effort,
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    blockProfileChange: (slug, expected, error) =>
      blockProfileChangeStmt.run(
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    failProfileChange: (slug, expected, error) =>
      failProfileChangeStmt.run(
        error,
        slug,
        expected.sessionId,
        expected.nativeSessionId,
        expected.generation,
        expected.profileRevision,
        expected.controlRevision,
        expected.model,
        expected.effort,
        expected.profileHandoff,
      ).changes === 1,
    setObservedProfileIfCurrent: (slug, expected, profile) =>
      observedProfileIfCurrentStmt.run(
        profile.model,
        profile.effort,
        slug,
        expected.sessionId,
        expected.generation,
        profile.model,
        profile.effort,
      ).changes === 1,
    beginRuntimeGeneration: (slug, expected, spawnedAt) => {
      const changed = beginRuntimeGenerationStmt.run(
        spawnedAt,
        slug,
        expected.sessionId,
        expected.generation,
        expected.permissionPending,
        expected.runtimeControl ?? null,
      ).changes === 1
      return changed ? expected.generation + 1 : null
    },
    setPermissionStateIfCurrent: (slug, expected, state) =>
      permissionStateIfCurrentStmt.run(
        state.exited ? 1 : 0,
        state.permissionMode,
        state.permissionPending,
        state.controlError,
        state.permissionPending,
        slug,
        expected.sessionId,
        expected.generation,
        expected.permissionPending,
        expected.runtimeControl ?? null,
      ).changes === 1,
    setObservedPermissionIfCurrent: (slug, sessionId, generation, permissionMode) =>
      observedPermissionIfCurrentStmt.run(permissionMode, slug, sessionId, generation, permissionMode).changes === 1,
    setControlErrorIfCurrent: (slug, sessionId, generation, error) =>
      controlErrorIfCurrentStmt.run(error, slug, sessionId, generation).changes === 1,
    setControlError: (slug, error) => void controlErrorStmt.run(error, slug),
    setDeliveryLedger: (slug, ledger) => void deliveryLedgerStmt.run(ledger, slug),
    getSetting: (key) => {
      const row = getSet.get(key)
      if (!row) return undefined
      try {
        return JSON.parse(row.value)
      } catch {
        return undefined
      }
    },
    setSetting: (key, value) => void putSet.run(key, JSON.stringify(value)),
    deleteSetting: (key) => void delSet.run(key),
    close: () => {
      if (closed) return
      closed = true
      lifecycleListeners.clear()
      interactions.dispose()
      db.close()
    },
  }
}
