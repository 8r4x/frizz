import Database from "./sqlite.ts"
import { ThreadSlug, slugify, threadIdentityName } from "@fray-ui/shared"
import { createInteractionStore, type InteractionStore } from "./interaction-store.ts"
import { log } from "./logging.ts"

// The UI-state store (never .fray/): session registry + settings. SQLite at
// stateDir/ui.db, WAL for concurrent read while the watcher writes. Fray thread files stay
// the source of truth for STATUS; this DB holds only runtime overlay (which tmux session
// backs a thread, unread, last-read) and settings.

export interface SessionRow {
  slug: string
  session_id: string
  // Legacy column NAME, live column: the thread identity string (`fray-<slug>`). It is not renamed
  // because every existing ui.db on disk carries it; see threadIdentityName.
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
  // 0 | 1 — a HUMAN named this thread (explicit rename, native /rename, or an adopted `.fray/<slug>.md`
  // heading), so no backend auto-title may ever replace it. A title HARD-CODED by a dispatch CALLER is
  // NOT this: `Investigate acme/app#391` from the GitHub batch, or a parent agent's guess through
  // `mcp__fray__spawn_thread`, is shown as a real name (title_auto = 0) yet stays replaceable, because
  // the worker's own title for the task is nearly always the more informative one. The human-facing
  // new-thread composer has no title field at all, so a dispatch title never means "a human typed this".
  // INVARIANT, relied on by the idempotent boot repair: title_locked = 1 ⇒ title_auto = 0.
  // Optional in the TS shape so the many pre-existing row literals keep their old semantics — absent
  // reads as "locked unless the title was a machine guess" (see sessionTitleLocked).
  title_locked?: number
  // ---- session-first columns (2026-07-09; all nullable — additive migration under a live server) ----
  title: string | null // dispatch title (new dispatches have no thread FILE to hold it); display prefers aiTitle
  // The filename stem of the DISCOVERED transcript when it drifted off the pinned `<session_id>.jsonl`
  // (a worker whose real transcript lives at a different id). NULL in the normal case — the read side
  // then binds `<session_id>.jsonl` directly. Cached by the tailer's discovery fallback so the drifted
  // path survives restarts AND so foreign-discovery doesn't surface the re-linked transcript as a
  // duplicate thread. See tailer.ts / discover.ts. session_id stays the pinned resume/scratchpad key.
  transcript_id: string | null
  // Lifecycle: 'open' | 'archived'. NULL = never explicitly set (pre-migration row) — the board derives
  // an effective state (archived flag ⇒ archived; paired legacy .fray file with terminal status ⇒
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
  // The thread's HEARTBEAT (scheduler.ts SOURCE 4): a prompt on a chosen clock. All of prompt/interval/
  // armed_at move together — a heartbeat is armed iff all three are set — and `heartbeat_armed_at` is
  // the GENERATION, so re-arming supersedes a beat already queued under the old settings.
  heartbeat_prompt?: string | null
  heartbeat_interval_ms?: number | null
  // 0 = armed but silent: the schedule and text are kept so re-enabling costs no retyping. (The old
  // heartbeat spelled this `paused` and inverted; `enabled` matches the stop hook's toggle.)
  heartbeat_enabled?: number
  heartbeat_armed_at?: string | null
  // When the last beat reached a terminal delivery. The next beat is due an interval after THIS, not
  // after the previous was queued, so a thread that stayed busy gets one catch-up beat rather than a
  // backlog.
  heartbeat_last_fired_at?: string | null
  // The OPERATOR's stop hook (scheduler.ts SOURCE 5), armed from the thread footer: text re-delivered
  // every time this thread comes to REST. `stop_hook_armed_at` is the GENERATION — editing the text
  // mints a new one so a bump already in the outbox for the old words reads as superseded — and
  // `stop_hook_enabled` is the popover's toggle: 0 keeps the text but fires nothing.
  stop_hook?: string | null
  stop_hook_enabled?: number
  stop_hook_armed_at?: string | null
  // When the last bump reached a terminal delivery — the HEARTBEAT's input (scheduler's
  // STOP_HOOK_HEARTBEAT_MS). No bump fires until that interval has elapsed since this stamp, so a
  // thread is prompted at most once per interval however often it stops.
  stop_hook_last_fired_at?: string | null
  // Operator confirmation for one exact final ```awaiting fence generation. The board/scheduler ignore a
  // transcript proposal unless these match its current fence identity.
  awaiting_fence_id?: string | null
  awaiting_confirmed_at?: string | null
  meta: string | null // JSON blob for future annotations (unparsed here)
  seen_at: string | null // ISO8601 — interaction clearance: recorded when the human opens the thread
  plan_path: string | null // project-relative .fray/plans/*.md this thread was dispatched from
  // Which agent backend serves this session (Codex-support epic). Optional in the TS shape (older rows
  // + the many test-fixture literals predate it); the SQLite column carries a "claude" DEFAULT so every
  // existing row and all current behavior are unchanged. Phase 1 only ever writes "claude".
  backend?: string
  // The backend's OWN native session id when it differs from the fray-minted session_id (Codex-support
  // epic, Phase 2). Claude pins session_id via --session-id, so its native id IS session_id and this
  // stays NULL. Codex mints its OWN rollout id (discovered post-spawn), so session_id remains the fray
  // UUID (the sentinel + scratchpad key) and the discovered codex id is pinned HERE — the id the tailer
  // locates the rollout with and resume re-attaches. Readers use `agent_session_id ?? session_id`, so a
  // claude row (NULL) is byte-identical to before.
  agent_session_id?: string | null
  // The resolved model + reasoning-effort values this session was STARTED with. These are deliberately
  // session metadata, not a live read of Settings: changing the global dispatch defaults later must not
  // relabel an existing thread. Nullable/optional keeps migrated, adopted-old, and foreign sessions honest
  // when fray never observed a concrete CLI value.
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
  // Monotonic process incarnation for this Fray session. Incremented atomically before every
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

export interface Storage {
  db: Database
  interactions: InteractionStore
  getSession(slug: string): SessionRow | undefined
  allSessions(): SessionRow[]
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
  // separate Fray processes/connections; a loser never reaches tmux.
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
  setArchived(slug: string, archived: boolean): void
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
  // Explicit lifecycle write (Archive button / Reopen). Keeps the legacy `archived` flag in sync so
  // pre-restart readers of that column stay honest; archiving also clears unread (never badge a
  // deliberately-shelved thread).
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
  // Arm/edit/clear the OPERATOR's stop hook in one write, because the popover's toggle and its
  // textarea are two views of one row. A null prompt clears the row; a new prompt TEXT mints a fresh
  // `armed_at` generation (superseding any bump already queued for the old words) while a pure toggle
  // flip keeps it, so enabling does not re-run a bump the operator just watched land. Session-guarded:
  // this comes from a browser tab that may be looking at a thread which has since been re-dispatched.
  setStopHookIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    prompt: string | null,
    enabled: boolean,
    armedAt: string,
  ): boolean
  // Arm / edit / clear the thread's HEARTBEAT (scheduler.ts SOURCE 4). Same generation discipline as the
  // stop hook: a change to the TEXT OR THE INTERVAL mints a fresh `armed_at` (superseding a beat queued
  // under the old settings and restarting the clock), while a bare toggle flip preserves both. A null
  // prompt clears the row. Session-guarded — this is the browser's path.
  setHeartbeatIfCurrent(
    slug: string,
    sessionId: string,
    generation: number,
    prompt: string | null,
    intervalMs: number | null,
    enabled: boolean,
    armedAt: string,
  ): boolean
  // The WORKER's path to the same row, from `mcp__fray__heartbeat`. Slug-only and unguarded, for the
  // reason spelled out on setStopHookBySlug.
  setHeartbeatBySlug(slug: string, prompt: string | null, intervalMs: number | null, enabled: boolean, armedAt: string): boolean
  // Stamp a delivered beat, guarded on the generation so a beat settling after a re-arm cannot write a
  // schedule onto settings it no longer describes.
  stampHeartbeatFired(slug: string, armedAt: string, firedAt: string): boolean
  // The WORKER's own path to the same row, from `mcp__fray__stop_hook`. Deliberately keyed on the slug
  // ALONE, with no session/generation guard, because the MCP server cannot satisfy one: it is spawned
  // with its thread's slug and keeps it across a resume, while the session id and generation bump
  // underneath it — so a guard here would fail exactly on the long-lived thread this exists for. The
  // slug is stamped into that server's env by fray itself and is not attacker-controlled.
  setStopHookBySlug(slug: string, prompt: string | null, enabled: boolean, armedAt: string): boolean
  // Stamp a delivered bump, guarded on the generation so a bump that settles after the operator
  // edited the text cannot write onto words it no longer describes.
  stampStopHookFired(slug: string, armedAt: string, firedAt: string): boolean
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
  // ended, and any re-prime — a fray restart above all — re-creates it as LIVE off a tool_use that
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
    -- shell writes NOTHING anywhere fray can re-read: not a tool_result in the session JSONL (verified
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
    // The thread's HEARTBEAT (scheduler.ts SOURCE 4) — a prompt on a chosen clock, fired regardless of
    // what the thread is doing. Re-added 2026-08-02 after a same-day removal: the stop hook replaced its
    // MECHANISM but not its job, and an operator who wants a thread revisited hourly needs a clock, not
    // a rest trigger the agent can defer.
    "heartbeat_prompt TEXT",
    "heartbeat_interval_ms INTEGER",
    "heartbeat_enabled INTEGER NOT NULL DEFAULT 0",
    "heartbeat_armed_at TEXT",
    "heartbeat_last_fired_at TEXT",
    // The OPERATOR's stop hook (scheduler.ts SOURCE 5). Armed from the thread
    // footer's popover; delivered every time the thread comes to REST until the worker replies with
    // the AWAITING sentinel. No interval column — "rest" is the trigger.
    "stop_hook TEXT",
    "stop_hook_enabled INTEGER NOT NULL DEFAULT 0",
    "stop_hook_armed_at TEXT",
    "stop_hook_last_fired_at TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE session ADD COLUMN ${col}`)
    } catch {
      // column already exists
    }
  }
  // (A one-shot migration that ADOPTED a pre-removal heartbeat as a stop hook lived here for a few
  // hours on 2026-08-02, between the heartbeat's removal and its reinstatement below. It is gone
  // because keeping it would now be actively destructive: with heartbeats armed again it would eat
  // every newly-armed one into the stop-hook row on the next boot. Threads it already converted keep
  // their stop hook; a heartbeat is re-armed from the footer or the tool.)
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
    // The tmux codex composer is gone, and with it every writer AND releaser of its durable
    // 'codex-input' runtime lock. A row that still holds one was locked by the retired subsystem and
    // nothing can ever clear it again: the board reports runtimeControlPending forever, which fences
    // that thread's composer, model, and sandbox controls permanently. Release it once, at boot.
    db.exec("UPDATE session SET runtime_control = NULL WHERE runtime_control = 'codex-input'")
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
    // every later resume and stalled on an approval nobody was watching. Fray workers are dispatched
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
  const archivedStmt = db.prepare("UPDATE session SET archived = ?, unread = CASE WHEN ? = 1 THEN 0 ELSE unread END, snoozed_until = CASE WHEN ? = 1 THEN NULL ELSE snoozed_until END, snooze_prompt = CASE WHEN ? = 1 THEN NULL ELSE snooze_prompt END, awaiting_fence_id = CASE WHEN ? = 1 THEN NULL ELSE awaiting_fence_id END, awaiting_confirmed_at = CASE WHEN ? = 1 THEN NULL ELSE awaiting_confirmed_at END WHERE slug = ?")
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
  const stopHookStmt = db.prepare(`
    UPDATE session SET
      stop_hook = ?,
      stop_hook_enabled = ?,
      stop_hook_armed_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN stop_hook_armed_at IS NOT NULL AND stop_hook IS ? THEN stop_hook_armed_at
        ELSE ? END,
      stop_hook_last_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN stop_hook_armed_at IS NOT NULL AND stop_hook IS ? THEN stop_hook_last_fired_at
        ELSE NULL END
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?
  `)
  // The 11 bound values HEARTBEAT_SET consumes, in order. Factored out because the two statements above
  // share the SET list verbatim and only differ in their WHERE — writing the argument list twice is how
  // the two paths silently drift apart.
  const heartbeatArgs = (prompt: string | null, intervalMs: number | null, enabled: boolean, armedAt: string) => {
    const ms = prompt === null ? null : intervalMs
    return [
      prompt,
      ms, ms,
      prompt === null ? 0 : enabled ? 1 : 0,
      prompt, prompt, ms, armedAt,
      prompt, prompt, ms,
    ] as const
  }
  // The heartbeat's SET list. Like the stop hook's, every expression reads the ORIGINAL row, so one
  // statement decides whether this write is a fresh arming or an edit: the generation (and with it the
  // beat clock) is preserved exactly when BOTH the text and the interval are unchanged.
  const HEARTBEAT_SET = `
      heartbeat_prompt = ?,
      heartbeat_interval_ms = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
      heartbeat_enabled = ?,
      heartbeat_armed_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN heartbeat_armed_at IS NOT NULL AND heartbeat_prompt IS ? AND heartbeat_interval_ms IS ? THEN heartbeat_armed_at
        ELSE ? END,
      heartbeat_last_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN heartbeat_armed_at IS NOT NULL AND heartbeat_prompt IS ? AND heartbeat_interval_ms IS ? THEN heartbeat_last_fired_at
        ELSE NULL END`
  const heartbeatStmt = db.prepare(`UPDATE session SET ${HEARTBEAT_SET}
    WHERE slug = ? AND session_id = ? AND runtime_generation = ?`)
  const heartbeatBySlugStmt = db.prepare(`UPDATE session SET ${HEARTBEAT_SET} WHERE slug = ?`)
  const heartbeatFiredStmt = db.prepare(`
    UPDATE session SET heartbeat_last_fired_at = ?
    WHERE slug = ? AND heartbeat_armed_at = ?
  `)
  // Same SET list, keyed on the slug alone — the worker-tool path (see setStopHookBySlug).
  const stopHookBySlugStmt = db.prepare(`
    UPDATE session SET
      stop_hook = ?,
      stop_hook_enabled = ?,
      stop_hook_armed_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN stop_hook_armed_at IS NOT NULL AND stop_hook IS ? THEN stop_hook_armed_at
        ELSE ? END,
      stop_hook_last_fired_at = CASE
        WHEN ? IS NULL THEN NULL
        WHEN stop_hook_armed_at IS NOT NULL AND stop_hook IS ? THEN stop_hook_last_fired_at
        ELSE NULL END
    WHERE slug = ?
  `)
  const stopHookFiredStmt = db.prepare(`
    UPDATE session SET stop_hook_last_fired_at = ?
    WHERE slug = ? AND stop_hook_armed_at = ?
  `)
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
  const titleStmt = db.prepare("UPDATE session SET title = ?, title_auto = 0, title_locked = 1 WHERE slug = ?")
  const titleCasStmt = db.prepare(
    "UPDATE session SET title = ?, title_auto = 0, title_locked = 1 WHERE slug = ? AND session_id = ? AND title IS ? AND title_auto = ?",
  )
  // Gated on the LOCK, not on title_auto: a caller-supplied dispatch title (`Investigate acme/app#391`,
  // a parent agent's guess) is unlocked, so the worker's own title supersedes it. title_auto is left
  // alone — the row's DISPLAY provenance is unchanged by which machine produced the current text.
  const autoTitleCasStmt = db.prepare(`
    UPDATE session SET title = ?
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
      WHERE thread_slug = ? AND fray_session_id = ?
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
    allSessions: () => selAll.all().filter((row) => ThreadSlug.safeParse(row.slug).success),
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
    setArchived: (slug, archived) =>
      void archivedStmt.run(
        archived ? 1 : 0, archived ? 1 : 0, archived ? 1 : 0,
        archived ? 1 : 0, archived ? 1 : 0, archived ? 1 : 0,
        slug,
      ),
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
    setStopHookIfCurrent: (slug, sessionId, generation, prompt, enabled, armedAt) =>
      stopHookStmt.run(
        prompt,
        prompt === null ? 0 : enabled ? 1 : 0,
        prompt, prompt, armedAt,
        prompt, prompt,
        slug, sessionId, generation,
      ).changes === 1,
    setHeartbeatIfCurrent: (slug, sessionId, generation, prompt, intervalMs, enabled, armedAt) =>
      heartbeatStmt.run(...heartbeatArgs(prompt, intervalMs, enabled, armedAt), slug, sessionId, generation).changes === 1,
    setHeartbeatBySlug: (slug, prompt, intervalMs, enabled, armedAt) =>
      heartbeatBySlugStmt.run(...heartbeatArgs(prompt, intervalMs, enabled, armedAt), slug).changes === 1,
    stampHeartbeatFired: (slug, armedAt, firedAt) =>
      heartbeatFiredStmt.run(firedAt, slug, armedAt).changes === 1,
    setStopHookBySlug: (slug, prompt, enabled, armedAt) =>
      stopHookBySlugStmt.run(
        prompt,
        prompt === null ? 0 : enabled ? 1 : 0,
        prompt, prompt, armedAt,
        prompt, prompt,
        slug,
      ).changes === 1,
    stampStopHookFired: (slug, armedAt, firedAt) =>
      stopHookFiredStmt.run(firedAt, slug, armedAt).changes === 1,
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
