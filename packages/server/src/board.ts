import {
  existsSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs"
import { join } from "node:path"
import watcher from "@parcel/watcher"
import type { BoardSnapshot, ThreadView, RuntimeState, PlanView, ThreadRecurringPrompt } from "@frizz/shared"
import { BoardDiffer, PermissionMode, SnoozeUntil, ThreadSlug, isDirectSubAgent, isValidAwaitingTimer, type PermissionMode as PermissionModeValue } from "@frizz/shared"
import type { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { isHeadlessRow, isBrokerClaudeRow, sessionTitleLocked } from "./storage.ts"
import type { Storage, SessionRow } from "./storage.ts"
import { normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import type { Tailer, SessionTelemetry } from "./tailer.ts"
import type { InteractionChange } from "./interaction-store.ts"
import { frizzDirExists } from "./frizz.ts"
import { findByPath } from "./project-registry.ts"
import { parseDeliveryLedger } from "./delivery-ledger.ts"
import { effectivePermissionMode, resolveLegacyThreadFile } from "./dispatch.ts"
import { ProducerStoppedError } from "./shutdown.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"
import { listPlanFiles } from "./plan-files.ts"
import { limitPauseIsStale, textResetInstant } from "./backend/usage-limit.ts"
import { getSettings } from "./settings.ts"

// The read model is provenance-bound to the durable session registry. A session row exists only after
// Frizz dispatches or explicitly adopts a thread, so unrelated legacy `.frizz/*.md` files and raw
// terminal transcripts never enter this board (or its queue/error surface). The tailer contributes
// telemetry only for registered rows. Plan documents remain project artifacts and are read separately.

const DEBOUNCE_MS = 150
// Level-triggered reconcile period: a periodic full rebuild that re-publishes if anything drifted.
// NOTE: this bounds SERVER-side staleness, not end-to-end UI staleness. It is the ceiling only WHILE
// the SSE socket is delivering; if the socket dies silently the client keeps its last frame until ITS
// own heartbeat watchdog fires and reconnects — real worst case ≈45-60s (sse.ts HEARTBEAT_TIMEOUT 35s
// + the 10s health tick). See sse.ts.
const RECONCILE_MS = 15_000

// A codex app-server turn that reads in-flight but is driven by NOBODY. The rollout is a lagging log:
// when the app-server process dies mid-turn it simply stops, so the folded turn stays "in-flight"
// forever and the thread spins on `running` — never at rest, so never queued, so invisible (four
// threads sat like this for hours on 2026-07-22). The bridge is the authority on whether a turn is
// actually running; a rollout that has not advanced since frizz took the thread onto its current
// connection is being driven by nobody at all.
//
// Rollout activity AFTER that instant means some OTHER writer is driving the thread — the operator
// running `codex resume` in their own terminal — which is a real live turn frizz is mirroring. Keep it.
//
// The grace exists because the two signals are read from different places: the bridge clears its turn
// on `turn/completed` while the rollout's matching record still has to reach the tailer's next tick.
// Without it, the end of every normal turn could flash "stalled" for a beat. A genuine stall is a rare
// event nobody is watching in real time, so paying half a minute of latency to make a false stall
// impossible is the right trade.
const STALL_GRACE_MS = 30_000
export function appServerTurnStalled(
  liveness: { bridgeTurn: boolean; ownedSince: string } | undefined,
  lastActivityAt: string | undefined,
  nowMs: number,
): boolean {
  // Not bridge-owned — frizz has never held this thread, so it has no standing to call the turn dead.
  if (!liveness) return false
  if (liveness.bridgeTurn) return false
  const ownedSince = Date.parse(liveness.ownedSince)
  if (!Number.isFinite(ownedSince)) return false
  const advanced = lastActivityAt ? Date.parse(lastActivityAt) : NaN
  if (Number.isFinite(advanced) && advanced >= ownedSince) return false
  return nowMs - ownedSince > STALL_GRACE_MS
}

// Runtime derivation: no session row → never spawned (none); a row whose tmux session is dead/absent
// → exited; a live session paused on an interactive permission prompt → perm-prompt (pane-sniffed by
// the tailer, no jsonl signal); otherwise the tailer's turn state (running while a turn is in flight,
// turn-idle once it ends).
function deriveRuntime(
  slug: string,
  row: SessionRow | undefined,
  storage: Storage,
  turn: "in-flight" | "idle" | undefined,
  permPrompt: boolean,
  appServerStalled = false,
  // BROKER-ONLY: the daemon is gone AND this thread still tracks live sub-agents. Distinct from
  // appServerStalled, which is a MID-TURN predicate — see the headless branch below.
  headlessLostWork = false,
): RuntimeState {
  if (!row) return "none"
  // App-server codex sessions have NO tmux pane. A persisted bridge thread is always resumable, so
  // liveness is never "is a pane alive" — it's the rollout-tailed turn state. Deriving from tmux here
  // would mark every headless thread "exited" (and, mid-turn, trip the crash-net). Never do that.
  if (isHeadlessRow(row)) {
    if (permPrompt) return "perm-prompt"
    // Checked BEFORE the idle branch, which is the whole point. A worker that came to rest holding live
    // sub-agents and whose daemon then died is NOT at rest: an Agent child runs IN-PROCESS inside that
    // `claude` (orphan-reaper.ts: "a worker's only OS-level agent process is its session root — Agent
    // sub-agents are in-process"), so those children died with it, and the worker is parked forever on a
    // wake that can never arrive. Reading `turn === "idle"` first made this thread `turn-idle`, which
    // satisfied deriveNeedsYou's `runtime !== "exited"` guard while the phantom child kept hasLiveOwnWork
    // true — so it was EXCUSED from the queue and, needing "exited", never carded as crashed either.
    // Neither queued nor carded: invisible. The sub-agent twin of the shell phantom fixed in a24d5ec.
    if (headlessLostWork) return "exited"
    if (turn === "idle") return "turn-idle"
    // Mid-turn with nobody driving it: the process that owned this turn is gone. Reuse "exited" so the
    // pair (exited + in-flight) trips the SAME crash-net a dead pane does — the thread cards as
    // "Stalled" and enters the queue instead of spinning forever.
    return appServerStalled ? "exited" : "running"
  }
  // Every live row is headless and returned above. Anything reaching here is a PRE-CUTOVER row whose
  // transport was a tmux pane — there is none any more, so its process cannot be alive. Reporting
  // "exited" is what puts it in front of the operator (stalled card + Retry) instead of leaving it
  // spinning against a liveness probe that can never succeed.
  void slug; void permPrompt; void turn
  return "exited"
}

// A worker whose transcript never materialized (a boot failure the tailer flagged noTranscript) would
// otherwise read "running" forever — deriveRuntime sees a live tmux pane with no telemetry and defaults
// to running, so the row spins with nothing to tail. Downgrade ONLY that spinner to the degraded "exited"
// affordance ("Stalled", a "!" glyph); with the "in-flight" turn a transcript-less session keeps, this
// also trips deriveNeedsYou's crash-net so it cards for the human. Every other runtime is left as-is (a
// dead pane is already "exited"; a healthily-bound session is never noTranscript). Reused "exited" rather
// than minting a new RuntimeState — see session-transcript-drift (a distinct error enum is a follow-up).
export function degradeIfNoTranscript(runtime: RuntimeState, noTranscript: boolean | undefined): RuntimeState {
  return noTranscript && runtime === "running" ? "exited" : runtime
}

// Display fields are ONE-LINERS in every surface that renders them — cap them at the server so a
// thread whose agent wrote an essay into status_text can't fatten every snapshot push (on a large
// board these two fields alone were half a megabyte).
const LINE_CAP = 240
function capLine(s: string | undefined | null, cap = LINE_CAP): string | undefined {
  if (!s) return undefined
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s
}

// ---- Session threads (2026-07-09): the working rail's unit — exactly one ThreadView per durable
// registry row. The legacy frizz status vocabulary does not apply: `status` is synthesized "active"
// (the field is required but display keys on kind/state/needsYou), and block/dep fields are inert.

// Parse an ISO time to epoch-ms, or -Infinity when absent/unparseable (a missing clearance never
// beats a real activity time in the needsYou compare below).
function timeOrNegInf(s: string | null | undefined): number {
  if (!s) return -Infinity
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : -Infinity
}

// EFFECTIVE lifecycle state for a registered session row (open|archived). An explicit state write wins;
// otherwise the historical archived bit migrates older rows without consulting unrelated files.
function effectiveSessionState(row: SessionRow, registeredLegacyTerminal: boolean): "open" | "archived" {
  if (row.state === "open" || row.state === "archived") return row.state
  if (row.archived === 1) return "archived"
  if (registeredLegacyTerminal) return "archived"
  return "open"
}

// Pre-session-first Frizz rows may have state=NULL and derive their archived state from a paired
// terminal thread document. Preserve that migration behavior without scanning the directory: open
// only the canonical filename selected by a durable session row, reject symlinks at open time, and
// read only whether status is `done`/`dismissed`. Malformed or missing files fail open as an active session and never
// contribute a board parser error.
function registeredLegacyFileIsTerminal(projectDir: string, slug: string): boolean {
  const file = resolveLegacyThreadFile(projectDir, slug)
  if (!file) return false
  const frontmatter = file.contents.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  const raw = frontmatter?.match(/^status:\s*(.*?)\s*$/m)?.[1]
  const status = raw?.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2").trim()
  return status === "done" || status === "dismissed"
}

function futureSnooze(row: Pick<SessionRow, "snoozed_until">, nowMs: number): string | undefined {
  const parsed = SnoozeUntil.safeParse(row.snoozed_until)
  return parsed.success && Date.parse(parsed.data) > nowMs ? parsed.data : undefined
}

// The ONE signal that a rested top-level turn is still working: a live dispatched SUB-AGENT. A child
// exists only because this worker asked for it and intends to act on what it returns, so its liveness
// really does mean "not a handoff yet".
//
// A background SHELL deliberately does NOT count (maintainer 2026-07-22). `run_in_background` says
// only "don't block my turn" — it cannot distinguish a CI watcher the worker is parked on from a vite
// dev server it started as infrastructure and moved on from, and a corpus survey found 26% of real
// background launches are the latter (long-lived servers/stacks). Counting them buried a genuinely
// finished thread behind a process that is never going to end. Erring the other way is cheap: a
// spurious queue card costs one click, while a wrongly-held thread is invisible for hours. A worker
// that actually wants to wait dispatches a sub-agent to own the wait — see the worker contract.
//
// DIRECT children only (isDirectSubAgent). `subAgents` also carries the thread's live DESCENDANTS now —
// a sub-agent's own sub-agents — but those are a rendering concern and must never move thread state: a
// descendant's row is derived from a sidecar plus a liveness reading, so counting one would put thread
// state at the mercy of that reading rather than of a signal about this thread's OWN work. A running
// descendant implies a running-or-rested direct child anyway, so nothing is lost by reading only the
// top level.
function hasLiveBackgroundWork(tele: SessionTelemetry | undefined): boolean {
  return Boolean(tele?.subAgents?.some((agent) => isDirectSubAgent(agent) && agent.state === "running"))
}

// The same question asked of a thread whose owning process is PROVABLY GONE, where `stale` stops being
// ambiguous. Everywhere else `stale` means only "we lost this child's completion signal and its
// transcript has been quiet past the 15-minute ceiling" — it could equally be a finished child whose
// notification never landed, which is why hasLiveBackgroundWork deliberately counts `running` alone.
// Against a dead daemon there is nothing left to be ambiguous about: an Agent child ran IN-PROCESS
// inside that `claude`, so a still-unretired child of it was lost, full stop.
//
// This exists because the staleness clock quietly UNDID the stall. Measured on the real fold: a child
// whose owner died reads `running` for 15 minutes and `stale` for ever after — so keying the stall on
// `running` alone carded the thread correctly for 15 minutes and then let it settle into an ordinary
// bare rest, telling the human nothing about the work that died with it. Sizing the widened predicate
// against this machine's real board 2026-08-02: of 35 open broker rows, 14 had a dead daemon and ZERO
// held an unretired dispatch — so it cards nothing extra today, and is here for when it does.
function hasUnretiredOwnAgents(tele: SessionTelemetry | undefined): boolean {
  return Boolean(tele?.subAgents?.some((agent) => isDirectSubAgent(agent) && (agent.state === "running" || agent.state === "stale")))
}

// Whether each live child can ACTUALLY be ended, answered here because this is the only place that
// holds both the session row (which knows the transport) and the tailer's telemetry (which knows the
// children). The client renders the stop × off this and never re-derives it — see SubAgentView.stoppable.
//
// Only a broker-backed Claude thread has a per-child control channel: `Query.stopTask`, whose registry
// is session-wide (so a DESCENDANT is as reachable as a direct child — whether the × is offered on a
// descendant ROW is a separate client-side question about whether the row can then be cleared). A tmux
// claude thread runs its sub-agents inside the CLI process and a codex thread inside its own; neither
// exposes anything to address one child with, so their rows must not offer a stop at all.
//
// Only RUNNING rows are marked: a stale/rested row's × means "clear this from the list", which needs no
// provider control and works everywhere. The flag answers "can this be KILLED", not "can this be clicked".
function stampStoppable(agents: ThreadView["subAgents"], row: SessionRow): ThreadView["subAgents"] {
  if (!isBrokerClaudeRow(row)) return agents
  return agents.map((agent) => (agent.state === "running" ? { ...agent, stoppable: true } : agent))
}

// The same question for a background SHELL, and it is deliberately the other way round: the tailer has
// already said whether frizz holds a handle for each shell (BgShellView.stoppable), so all this adds is
// the TRANSPORT half — and on a thread with no control channel it must REVOKE the tailer's half rather
// than merely decline to add one. A shell on a TMUX thread carries a task id in its launch ack just the
// same; nothing can be done with it from outside that pane.
//
// BOTH headless runtimes have a per-shell channel, reached differently and verified separately:
//   claude broker    → `Query.stopTask(taskId)`                     (backend/_live_shell_stop.mts)
//   codex app-server → `thread/backgroundTerminals/terminate`       (backend/_live_codex_bgterm.mts)
// so the predicate is "headless", not "broker Claude" — and a codex row's shells, which only exist at
// all because the app-server stream reported them, are never stripped here.
function stampStoppableShells(shells: ThreadView["bgShells"], row: SessionRow): ThreadView["bgShells"] {
  if (isHeadlessRow(row)) return shells
  return shells.map((shell) => (shell.stoppable ? { ...shell, stoppable: false } : shell))
}

// The thread's OWN dispatched work is still live — a sub-agent OR a launched background shell. It drives
// the resting CARD (deriveAwaitingBackground) and its event-snooze, and deliberately NOT the queue
// excusal: hasLiveBackgroundWork (sub-agents only) is what excuses a rest from the queue, because a
// detached shell leaves a thread that is a handoff in substance (see deriveNeedsYou). Shells were folded
// into the excusal on 2026-08-01 and taken back out on 2026-08-04; the CARD spanned both kinds
// throughout, which is why the two predicates exist side by side.
//
// hasLiveBackgroundWork also owns the CRASH bit, where the same distinction is real: a dead pane with a
// child still reading "running" died mid-work, while a dead pane with a shell behind it is just a shell
// whose owner is gone.
function hasLiveOwnWork(tele: SessionTelemetry | undefined): boolean {
  return Boolean(
    tele?.subAgents?.some((agent) => isDirectSubAgent(agent) && agent.state === "running") ||
    tele?.bgShells?.some((shell) => shell.state === "running"),
  )
}

// The awaiting-background event-snooze is armed for the CURRENT rest iff the captured rested_at still
// equals the row's rested_at. rested_at only advances when the top-level turn comes to a NEW rest, so
// any advance — the exact event of a sub-agent/shell returning and the worker acting on it — auto-clears
// the snooze and re-surfaces the card. No scheduler, no reaper: the snooze expires itself on next rest.
// That self-clearing IS the promise the card's Snooze button makes to the human ("until one of the
// background shells completes, in which case the agent will resume automatically" — maintainer
// 2026-08-04): a Claude/Codex worker is re-invoked by its own completion notification, and the card comes
// back the moment that turn ends. A shell that never finishes therefore stays snoozed, which is the point.
function bgSnoozeArmed(row: Pick<SessionRow, "bg_snooze_rested_at" | "rested_at">): boolean {
  return row.bg_snooze_rested_at != null && row.rested_at != null && row.bg_snooze_rested_at === row.rested_at
}

// A declared wait excuses an idle thread from the queue only for a specific external-human gate or a
// valid future scheduler instant. Legacy PR/CI/session hints, malformed/elapsed timers, and hintless
// fences are agent-owned work; if the worker nevertheless comes to rest, the queue must surface that
// rest.
//
// `pr-watch` is DELIBERATELY NOT here (maintainer 2026-07-22): the review/approval/comment watcher
// keeps its thread a VISIBLE queue handoff rather than parking it, so a PR whose reviews may never
// arrive can't silently vanish. The scheduler still polls + bumps it on new activity (it keys on the
// hint, not on this excusal); the human hides it on demand via the "PR watcher armed" card's Snooze
// button (a user snooze, cleared by the next activity). Mirrors groups.parkedAwaitingHint — keep the
// two in lockstep.
function hasParkedExternalWait(tele: SessionTelemetry | undefined, nowMs: number): boolean {
  if (tele?.lastFence?.kind !== "awaiting") return false
  return tele.lastFence.hints.some((hint) =>
    hint.kind === "human" ||
    (hint.kind === "timer" && isValidAwaitingTimer(hint.value) && Date.parse(hint.value) > nowMs),
  )
}

// SERVER-DERIVED queue membership for a REGISTERED session thread (foreign/archived → false at the
// call site). Every otherwise-unexcused owned/open thread enters Queue when its top-level worker comes
// to rest. A user-owned snooze temporarily suppresses every queue reason—including a concrete ask,
// permission prompt, or crash—then the exact deadline restores the still-current reason. Truthful
// external waits place ordinary rest in Held without writing lifecycle state.
// A Claude follow-up frizz has delivered but the transcript has not yet reflected: it lives in the
// delivery ledger as `pending` (injected, no JSONL evidence yet) or `enqueued` (positively receipted by
// Claude Code's own queue). Both mean the human's message is handled and in flight. `unconfirmed` is
// NOT fresh — frizz could not confirm that send, so it must stay visible for the human to re-drive.
//
// `processGone` is what keeps "in flight" honest, and it is the whole reason this reads a second
// argument. Both live states are claims about a process HOLDING the message: `pending` says a process
// was handed it, `enqueued` says a process receipted it into its own queue. A daemon that has since
// died holds nothing — the message will never be read, and the ledger row ages out only after
// UNCONFIRMED_DROP_MS, so an hour of silent suppression follows a death that took milliseconds.
// Observed 2026-08-11 on `in-codex-threads-tool-calls-ike`: the operator's follow-up was receipted at
// 19:45:05.771 and the daemon died 760ms later (`session-stream-broken` — its cwd had been renamed out
// from under it). The thread's ```done card was already sitting in the queue; this excusal took it
// out, and nothing put it back. Neither queued nor carded: invisible — the delivery twin of the
// sub-agent phantom deriveRuntime's `headlessLostWork` fixed, and the same lesson.
function hasFreshDelivery(row: SessionRow, processGone: boolean): boolean {
  if (processGone) return false
  return parseDeliveryLedger(row.delivery_ledger).some((d) => d.state === "pending" || d.state === "enqueued")
}

export function deriveNeedsYou(
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  hasActionableInteraction = false,
  nowMs = Date.now(),
  // The RESOLVED pause for this row (resolveLimitPause), not the raw setting — its `autoResume` bit
  // already folds in staleness, so the queue excusal and the card can never disagree.
  limitPause: ThreadView["limitPause"] = undefined,
  // deriveAwaitingBackground passes false. The live-own-work excusal below is a QUEUE rule; the card
  // states a FACT about the thread that has to survive it, or the drawer and the full-screen page blank
  // out at rest and read as "the agent died". Every OTHER excusal is still inherited. (Named for
  // sub-agents until 2026-08-01, when background shells joined the same excusal — the flag was never
  // about which KIND of work, only about queue-vs-fact.)
  excuseLiveOwnWork = true,
  // BROKER-ONLY, and supplied by the caller because only it has the daemon probe: the process that
  // received this row's outstanding sends is gone. Read by hasFreshDelivery alone — see there. Defaults
  // false so every other caller (and every test) keeps today's behaviour.
  deliveryProcessGone = false,
): boolean {
  // Snooze is explicit operator lifecycle state. It must be checked before provider/question/crash
  // gates so choosing Snooze from any queue card actually parks that card until its exact deadline.
  // The underlying telemetry remains intact and is re-derived when the scheduler clears the instant.
  if (futureSnooze(row, nowMs)) return false
  // A typed request is already scoped to this exact registered session by the interaction journal.
  // It is a hard human gate even when the provider is mid-turn: the turn cannot advance until the
  // advertised response is delivered, so at-rest transcript heuristics do not apply.
  if (hasActionableInteraction) return true
  if (runtime === "perm-prompt") return true
  if (tele?.pendingAsk) return true
  // Codex connector/tool approvals and verified native selectors leave the rollout in-flight. They
  // are nevertheless hard human gates, so queue them independently of runtime/at-rest semantics.
  if (tele?.nativeInputRequired) return true
  const atRest = runtime === "turn-idle" || runtime === "exited"
  if (!atRest) return false
  // CRASH/STALL net: the pane EXITED while the turn was still in flight (last record a tool_use, never
  // reached end_turn) — the agent died mid-work. This is a stall the human MUST see, and it is NOT
  // clearable by a prior glance (a dead process produces no new activity to re-arm bare-rest, so
  // interaction-clearance would bury it forever after one view). The legacy needsAction had this net
  // (active/planning + exited/none); deriveNeedsYou dropped it — restored here (found 2026-07-09).
  if (runtime === "exited" && tele?.turn === "in-flight") return true
  // A human follow-up frizz has DELIVERED but the transcript has not YET reflected — the tailer folds
  // JSONL on a poll that runs seconds behind under load — sits in the delivery ledger as pending or
  // enqueued. The human has already responded, so the thread is NOT awaiting them: suppress it here,
  // from SERVER TRUTH, so a card the operator just steered leaves the queue and STAYS gone until the
  // turn is observed — instead of bouncing back when the client's 12s optimism expires first (the
  // "reappears after ~10s, then leaves again" flicker). This is the durable, reload-safe complement to
  // the client's optimistic steer. Placed AFTER the crash net (a delivered follow-up to a worker that
  // then died must still surface) and the hard live asks, but before the at-rest reasons a steer
  // resolves (a question, a done handoff, bare rest). `unconfirmed` is excluded on purpose: a send frizz
  // could not confirm is one the human may need to re-drive, so the ledger's own aging re-surfaces it.
  if (hasFreshDelivery(row, deliveryProcessGone)) return false
  // An unanswered ```question fence in the last assistant message is an EXPLICIT ask — a hard queue
  // member exactly like a native pendingAsk, NOT subject to interaction-clearance. VIEWING a question
  // is not ANSWERING it, so seen_at must never drop it off the stack (the whole point is that threads
  // needing input surface automatically and STAY until resolved). The tailer clears pendingQuestion the
  // moment a newer user message lands (an answer/steer supersedes the fence), which is what dequeues it.
  if (tele?.pendingQuestion) return true
  // Declared/limit parks are STRONGER excusals than the awaiting-background card below, so they are
  // checked first: a worker that declared an awaiting-human fence, or is limit-paused with auto-resume
  // promised, stays held even if a child of its is still live (it explicitly said what it is waiting on).
  if (hasParkedExternalWait(tele, nowMs)) return false
  // A thread parked by an exhausted subscription window is waiting on the clock, not on the human —
  // exactly like a timer wait — SO LONG AS frizz is actually going to continue it. Excusing it keeps a
  // limit event from dumping the entire running fleet into the queue at once. When auto-resume is off
  // (or the pause aged out), the promise is gone and it falls through to the ordinary handoff below,
  // which is the honest place for work only the human will restart.
  if (limitPause?.autoResume) return false
  // A top-level turn that came to rest while a dispatched SUB-AGENT is still running is EXCUSED from
  // the queue for exactly as long as that holds. The rail already shows it in the ACTIVE band (the
  // spinning rows above the rule — see ARCHITECTURE.md § Board nomenclature), and the two surfaces must
  // not both claim it (maintainer 2026-08-01: "if something is listed as currently running, then it
  // should never show up in the queue"). That invariant is what `groups.inActiveBand` is written
  // against — it bands on `isActivelyRunning && !needsYou`, so this excusal is the ONLY thing that puts
  // a rested-with-live-work row in the Active band, and nothing can land there carrying a card.
  //
  // The reason it is a sub-agent excusal (maintainer 2026-07-30): queueing them made the rail row drop
  // out of the running band into the rested band and bounce straight back up when the child returned —
  // "there's too much layout shift as things jump between those two sections … it should only show up
  // in the queue when it's fully rested and it has no running sub-agents". It is bounded by
  // construction: a child whose completion signal is lost goes `stale` at the tailer's 15-min ceiling,
  // and only `running` holds here, so a child that never returns stops excusing its parent.
  //
  // A BACKGROUND SHELL DOES NOT EXCUSE, and the round trip is worth recording. Shells joined this
  // excusal on 2026-08-01 and left it again on 2026-08-04 (maintainer: "if a thread has rested and the
  // only thing remaining is background shells, we should put it into the queue"). The difference from a
  // sub-agent is the same one the rail already draws: a child returns and re-invokes its parent within
  // seconds, so the thread is genuinely mid-flight and there is nothing for the human to do; a shell is
  // DETACHED — 26% of real launches are servers that never exit, and there is no staleness clock — so a
  // thread resting behind one has finished its turn in every sense that matters to the operator, and
  // burying it in the running band means it is never seen again. It is a handoff, so it queues.
  //
  // The layout-shift worry that motivated the 2026-08-01 excusal is answered instead by the SNOOZE on
  // the card (see the branch below): one click parks it until the shell returns and the worker re-rests.
  // That is the human's call to make per thread, which an unconditional excusal took away from them.
  //
  // A DECLARED FENCE outranks the excusal (hence the `!tele?.lastFence` guard), because a fence is the
  // worker's own statement about why it stopped and it earns its own card: a ```done handoff still
  // cards as done, and a non-parked ```awaiting — pr-watch above all — stays a VISIBLE queue handoff
  // even with work out (maintainer 2026-07-24), so a PR watcher can never vanish merely because the
  // worker happens to have something running. Such a thread is NOT in the running band either
  // (deriveAwaitingBackground drops any fenced thread, so the client reads it as a rested-band row),
  // which is exactly why it must keep its card — the invariant above cuts both ways.
  if (excuseLiveOwnWork && runtime !== "exited" && hasLiveBackgroundWork(tele) && !tele?.lastFence) return false
  // THE CARD, AND ITS EVENT-SNOOZE. Three shapes reach here: a SHELL-ONLY rest (the common one since
  // 2026-08-04 — no fence, no live child, a launched shell still going), a fenced thread with live work
  // of either kind, and deriveAwaitingBackground asking for the FACT rather than the queue
  // (excuseLiveOwnWork false, which must never consult the queue-owned snooze — hence the nulled column
  // at its call site). All three card, and all three honour an armed event-snooze for the current rest.
  //
  // An EXITED parent with "running" children is a crash, not this card — the runtime!=="exited" guard
  // drops it to the crash/bare-rest net below (a dead pane's children keep reading "running" until their
  // transcript goes stale; the parent cannot actually still be waiting on them). A done fence outranks
  // this too: respect the worker's completion signal (show the done card).
  if (runtime !== "exited" && hasLiveOwnWork(tele) && tele?.lastFence?.kind !== "done") return !bgSnoozeArmed(row)
  // A final ```done fence is a CHECKED completion handoff: show its success card in the queue until the
  // human explicitly Archives the thread. Like a question, merely viewing it does not resolve it. The
  // at-rest gate above prevents a stale fence from carding while a follow-up turn is still running.
  if (tele?.lastFence?.kind === "done") return true
  // Bare rest is itself the handoff. It remains queued until the human explicitly sends more work,
  // snoozes it, or archives it; merely opening/seeing the thread cannot silently clear the card.
  return true
}

// Whether a thread is resting while its own background work is still live — the signal the client keys
// the awaiting-background card on, across all THREE surfaces (the queue card, the drawer and the
// full-screen page). True only when it is at rest (turn-idle) with live own work and NO stronger reason
// outranks it (a native/typed ask, permission prompt, chat question, or ANY signal fence all render their
// own card instead). Kept adjacent to deriveNeedsYou and delegating to it so the two never drift.
//
// The QUEUE surface is back as of 2026-08-04, for a SHELL-ONLY rest: those threads queue again
// (deriveNeedsYou excuses live sub-agents only), so the card renders there with its Snooze. A rest on a
// live sub-agent is still excused from the queue, so for that shape the drawer and the full-screen page
// remain the only places this state is stated in words — which is why the card must keep rendering
// without a queue card behind it, and why the snooze below is dropped.
//
// The queue's event-Snooze is deliberately NOT inherited (bg_snooze_rested_at is nulled out below).
// Snoozing is a QUEUE VERB — "stop showing me this card in the queue" — while this flag states a FACT
// about the thread, and AwaitingBackgroundCard renders that fact on the drawer and the standalone page
// too, where there is no Snooze affordance and nothing to dismiss. Inheriting the snooze let one queue
// click blank all three surfaces at once: the drawer then showed NOTHING at rest — the shimmer stops and
// the transcript just ends — which is exactly the "reads as if the agent died" failure the card exists to
// prevent (found 2026-07-29 on a shell-only thread; the report was "there's no card for it in the UI —
// when I click it, it opens it in a drawer"). The queue card itself stays hidden regardless, because the
// queue list gates on needsYou (groups.ts `queued`), which still honours the snooze.
//
// SHELL-ONLY is why this went unnoticed at the time: the client's hasLiveOps then read raw sub-agents,
// so a snoozed thread with a live child kept its spinner in the running band and stayed legibly alive,
// while a snoozed shell-only one fell all the way through to a rested-band row with nothing behind it
// anywhere. hasLiveOps now reads THIS flag, which is what makes a snoozed shell-only rest legible again:
// no queue card, but a running-band row wearing the pulsing dot until the shell returns.
export function deriveAwaitingBackground(
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  runtime: RuntimeState,
  hasActionableInteraction = false,
  nowMs = Date.now(),
  limitPause: ThreadView["limitPause"] = undefined,
  deliveryProcessGone = false,
): boolean {
  if (runtime !== "turn-idle" || !hasLiveOwnWork(tele)) return false
  // Any hard human gate or completion signal outranks this reason → the thread cards as THAT, not here.
  if (hasActionableInteraction || tele?.pendingAsk || tele?.nativeInputRequired || tele?.pendingQuestion) return false
  // A signal fence — ```done OR ```awaiting — is the worker's OWN explicit statement about why it
  // stopped, and it renders its own card in the transcript body. That is strictly more specific than
  // "it has background work running", so it wins: show the fence card ALONE, never both. This is the
  // pr-watch double-card fix (maintainer 2026-07-24): a pr-watch thread with a live sub-agent stays
  // queued (deriveNeedsYou keeps it, since pr-watch is a visible handoff) but now cards as its "Arm
  // watcher" fence, not as this banner. A parked human/timer fence never reached here anyway (it's
  // Held, not queued); this only changes the non-parked awaiting fences (pr-watch, legacy, hintless).
  if (tele?.lastFence?.kind === "done" || tele?.lastFence?.kind === "awaiting") return false
  // Every OTHER excusal deriveNeedsYou applies still outranks the card (a user wall-clock snooze, a
  // limit pause, a delivered-but-unobserved follow-up); only the queue-owned event-snooze is dropped,
  // and the queue's live-OWN-WORK excusal is opted out of (excuseLiveOwnWork: false). That opt-out is
  // what keeps this flag meaningful at all: the very threads it describes are precisely the ones that
  // excusal removes from the queue, so inheriting it would make this function always false and blank the
  // drawer and full-screen page for a healthy thread resting on its children or on a shell. Since
  // 2026-08-01 that covers a shell-only rest too — it now has NO queue card at all, so this card in the
  // drawer and on the standalone page is the only place that state is stated in words.
  return deriveNeedsYou({ ...row, bg_snooze_rested_at: null }, tele, runtime, hasActionableInteraction, nowMs, limitPause, false, deliveryProcessGone)
}

// A REGISTERED session thread's view (id = row.slug). Runtime via the shared deriveRuntime (tmux-aware);
// telemetry fields mirror the legacy path; title provenance is resolved before the snapshot is emitted.
export function resolveSessionProfile(
  row: Pick<SessionRow, "backend" | "model" | "effort" | "spawned_at" | "profile_set_at">,
  tele: Pick<SessionTelemetry, "model" | "effort" | "profileAt"> | undefined,
): { model?: string; effort?: string } {
  const persistedModel = row.model?.trim() || undefined
  const persistedEffort = row.effort?.trim() || undefined
  const observedAt = tele?.profileAt ? Date.parse(tele.profileAt) : NaN
  const spawnedAt = Date.parse(row.spawned_at)
  // A transcript is replayed from byte zero whenever a runtime generation changes. A persisted launch
  // target therefore remains authoritative until a genuinely post-spawn profile record arrives; old
  // turn_context/assistant records must not snap the controls back after reattach or server restart.
  // SIBLING of resolveSessionPermission's set-time rule (permission_set_at): a codex model/effort
  // change made eagerly through setThreadProfile takes effect from the next turn, so no fresh
  // turn_context exists yet and the last one still reports the OLD profile. When the OPERATOR set the
  // profile AFTER that observed reading, prefer the saved intent so the visible composer selector shows
  // the pick immediately; a genuinely newer turn (observedAt > setAt) re-establishes observed authority,
  // so it converges on its own. Claude never sets profile_set_at (setProfileTargetIfCurrent), so unchanged.
  const setAt = row.profile_set_at ? Date.parse(row.profile_set_at) : NaN
  const supersededByOperatorSet = Number.isFinite(setAt) && setAt > observedAt
  const observedIsCurrent = Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt && !supersededByOperatorSet
  const observedModel = tele?.model
    ? normalizeObservedThreadModel(row.backend ?? "claude", tele.model) ?? tele.model.trim()
    : undefined
  const model = (!persistedModel || observedIsCurrent ? observedModel : undefined) || persistedModel
  const effort = (!persistedEffort || observedIsCurrent ? tele?.effort?.trim() : undefined) || persistedEffort
  return { model, effort }
}

export function resolveSessionPermission(
  row: Pick<SessionRow, "backend" | "spawned_at" | "permission_mode" | "permission_pending" | "permission_set_at">,
  tele?: Pick<SessionTelemetry, "permissionMode" | "permissionModeAt">,
): ThreadView["permissionMode"] {
  const saved = PermissionMode.safeParse(row.permission_mode)
  const pending = PermissionMode.safeParse(row.permission_pending)
  const normalize = (mode: PermissionModeValue) => effectivePermissionMode(row.backend === "codex" ? "codex" : "claude", mode)
  // A successful controlled reattach stamps the exact argv mode before its transcript sidecar is
  // tailed. During that short reconciliation window the launched value is already authoritative.
  if (saved.success && pending.success && normalize(saved.data) === normalize(pending.data)) return normalize(saved.data)
  if (row.backend === "codex" && saved.success) {
    // Codex does not append a profile record merely by reopening an idle rollout. Ignore an older
    // turn_context from before this process generation, but accept a later /permissions or turn event.
    const observedAt = tele?.permissionModeAt ? Date.parse(tele.permissionModeAt) : NaN
    const spawnedAt = Date.parse(row.spawned_at)
    if (tele?.permissionMode && Number.isFinite(observedAt) && Number.isFinite(spawnedAt) && observedAt >= spawnedAt) {
      // …EXCEPT when the OPERATOR changed the sandbox eagerly (thread/settings/update) AFTER that
      // observed reading. The change takes effect from the next turn, so no fresh turn_context exists
      // yet and the last one still reports the OLD sandbox — showing it would lie about a change the
      // operator just made. Prefer the saved intent until a genuinely newer turn re-establishes the
      // observed value (then observedAt > setAt and this converges back to telemetry on its own).
      const setAt = row.permission_set_at ? Date.parse(row.permission_set_at) : NaN
      if (Number.isFinite(setAt) && setAt > observedAt) return normalize(saved.data)
      return normalize(tele.permissionMode)
    }
    return normalize(saved.data)
  }
  // The tailer writes every observed Claude permission-mode transition back to this row. Prefer the
  // durable value so a just-reattached process cannot be relabeled by the previous in-memory fold.
  if (saved.success) return normalize(saved.data)
  return tele?.permissionMode ? normalize(tele.permissionMode) : undefined
}

export function resolvePendingPermission(row: Pick<SessionRow, "permission_pending">): ThreadView["permissionPending"] {
  const parsed = PermissionMode.safeParse(row.permission_pending)
  return parsed.success ? parsed.data : undefined
}

// The recurring prompt as BOTH readers see it: the board's footer panel (through the thread view below)
// and the worker's own `mcp__frizz__recurring_prompt` with `action: "get"` (through the router). One
// projection because they must agree — a worker reading back a different row than the human is editing
// is exactly the confusion the read action exists to end.
//
// Present iff the text and its generation are both set (storage writes and clears them together).
// Projected even with EVERY TRIGGER OFF — that is the state switching them all off leaves, and the text
// and the cadence have to survive it or the panel would open empty.
export function resolveRecurringPrompt(
  row: Pick<
    SessionRow,
    | "recurring_prompt" | "recurring_armed_at" | "recurring_on_rest" | "recurring_on_schedule"
    | "recurring_on_compact" | "recurring_interval_ms" | "recurring_rest_fired_at"
    | "recurring_schedule_fired_at" | "recurring_compact_fired_at" | "recurring_pause_on_questions"
  >,
): ThreadRecurringPrompt | undefined {
  if (!row.recurring_prompt || !row.recurring_armed_at) return undefined
  return {
    prompt: row.recurring_prompt,
    stopHook: row.recurring_on_rest === 1,
    heartbeat: row.recurring_on_schedule === 1,
    postCompaction: row.recurring_on_compact === 1,
    pauseOnQuestions: row.recurring_pause_on_questions === 1,
    // Carried whenever a cadence has ever been chosen, INCLUDING while the heartbeat is off — the
    // minutes field has to read back what switching it on again would use.
    intervalSeconds: row.recurring_interval_ms ? Math.round(row.recurring_interval_ms / 1000) : undefined,
    armedAt: row.recurring_armed_at,
    lastRestFiredAt: row.recurring_rest_fired_at ?? undefined,
    lastScheduleFiredAt: row.recurring_schedule_fired_at ?? undefined,
    lastCompactFiredAt: row.recurring_compact_fired_at ?? undefined,
  }
}

// Project a fold-observed limit fault onto the wire view: which window blew, when, when it comes back,
// and whether frizz will deliver its own "continue". `resumesAt` is present only when the provider's
// own reset clock resolves it (a weekly clock never does — see textResetInstant); its ABSENCE does not
// cancel the auto-resume promise, because the scheduler can still resolve a weekly instant from the
// usage endpoint. The card then says "when the window resets" rather than naming a time known nowhere.
//
// Auto-resume is ALWAYS armed — there is no setting to turn it off. `autoResume` is therefore purely a
// staleness verdict: a fault whose window is long past no longer promises a wake it will never deliver.
export function resolveLimitPause(
  row: Pick<SessionRow, "backend">,
  tele: Pick<SessionTelemetry, "limitFault"> | undefined,
  nowMs: number,
): ThreadView["limitPause"] {
  const fault = tele?.limitFault
  if (!fault) return undefined
  const at = Date.parse(fault.at)
  const stale = limitPauseIsStale(fault.window, at, nowMs)
  // Resolve the clock relative to the FAULT, never to `now`. "resets 5:50pm" means the first 5:50pm
  // after the provider said it; anchoring on `now` would silently roll the answer to TOMORROW's 5:50pm
  // the moment the real one passed, so the promised time would run away from the reader forever.
  const resumesAtMs = fault.resetClock && Number.isFinite(at)
    ? textResetInstant({ window: fault.window, resetClock: fault.resetClock }, at)
    : undefined
  return {
    backend: row.backend === "codex" ? "codex" : "claude",
    window: fault.window,
    at: fault.at,
    ...(resumesAtMs !== undefined ? { resumesAt: Math.round(resumesAtMs / 1000) } : {}),
    autoResume: !stale,
  }
}


// Title provenance is resolved server-side as well as in the web display helper. A transcript title is
// eligible while the registry says nothing HUMAN has claimed the name; once a human commits one
// (setTitle atomically locks it), no later tail tick can put aiTitle back on the wire as a competing
// display value. Note the two flags are independent here: a title hard-coded by a dispatch caller is
// not a guess (titleAuto false, so the UI shows it verbatim while the session spins up) yet is still
// unlocked, so the worker's own aiTitle rides the wire and wins the moment it exists.
// The transcript title is LIVE telemetry and only exists while a session is being tailed; the registry
// copy (`title_agent = 1`, written by the auto-title CAS) is the same worker-authored name persisted,
// and it is all that is left once the thread rests, is archived, or the server restarts. Falling back
// to it is what stops a codex thread reading "Untitled thread" for the rest of its life: with no
// aiTitle on the wire the display side cannot tell a persisted worker title from the dispatch chop,
// so it must assume the chop. Telemetry still wins while present — it is the fresher of the two.
export function resolveSessionTitle(
  row: Pick<SessionRow, "title" | "title_auto" | "title_locked" | "title_agent">,
  tele: Pick<SessionTelemetry, "aiTitle"> | undefined,
): Pick<ThreadView, "title" | "titleAuto" | "titleLocked" | "aiTitle"> {
  const locked = sessionTitleLocked(row)
  const persisted = row.title_agent === 1 ? row.title?.trim() || undefined : undefined
  return {
    title: row.title ?? "",
    titleAuto: row.title_auto === 1,
    titleLocked: locked,
    aiTitle: locked ? undefined : (tele?.aiTitle ?? persisted),
  }
}

function sessionThreadView(
  projectDir: string,
  storage: Storage,
  row: SessionRow,
  tele: SessionTelemetry | undefined,
  registeredLegacyTerminal: boolean,
  interactionPresence: { pending: boolean; needsUser: boolean },
  nowMs: number,
  codexTurnLiveness: CodexTurnLivenessReader,
  claudeBrokerDaemonAlive: ClaudeBrokerLivenessReader,
): ThreadView {
  // A headless thread mid-turn with nobody driving it is a crash/stall, not a rest. For codex that is
  // an app-server that stopped advancing the rollout; for the broker it is a dead ownerless daemon (its
  // liveness is the daemon record, resolved live). Either way the (exited + in-flight) pair trips the
  // crash-net so the thread cards as "Stalled" instead of spinning `running` forever.
  const headlessStalled =
    row.codex_runtime === "app-server"
      ? appServerTurnStalled(codexTurnLiveness(row.slug, row.session_id), tele?.lastActivityAt, nowMs)
      : isBrokerClaudeRow(row)
      ? !claudeBrokerDaemonAlive(row.session_id)
      : false
  // App-server threads write their rollout synchronously at thread/start, so a transient "no transcript
  // yet" must not degrade a healthy headless thread to the "exited"/stalled crash affordance.
  //
  // That guarantee is CODEX's alone, and blanket-suppressing on isHeadlessRow took the broker with it.
  // A broker claude row writes nothing until the agent processes its first input, so zero transcript
  // bytes past DISCOVERY_GRACE_MS is not a transient — it is precisely the boot failure the tailer has
  // already captured (it sets noTranscript and captureStall together). The headlessStalled probe above
  // does not cover it either: that trips only on a DEAD daemon, and this failure leaves the daemon and
  // its claude child ALIVE and idle. Observed live 2026-07-31 on thread
  // `the-landlock-people-i-m-interested`: the tailer logged the boot failure at 60s, the board threw the
  // flag away here, and the thread spun `running` for 29 minutes on an agent that never received its
  // opening prompt — until a human archived it by hand.
  // A REST that is not one: the daemon is gone and this thread still tracks a live sub-agent, which an
  // in-process child of that dead process cannot be. Deliberately BROKER-ONLY. The codex arm of
  // `headlessStalled` is `appServerTurnStalled`, a mid-turn predicate — a rested rollout stops advancing
  // by definition, so reusing it here would card every quiet codex thread as crashed. The broker arm is a
  // direct pid probe, which means exactly what it says at rest as well as mid-turn.
  const headlessLostWork = isBrokerClaudeRow(row) && headlessStalled && hasUnretiredOwnAgents(tele)
  // The same dead-daemon reading, asked of the DELIVERY ledger instead of the sub-agent map: a send
  // still marked pending/enqueued is a claim that a process is holding it, and that process is gone.
  // BROKER-ONLY for the reason directly above — the codex arm of `headlessStalled` is a mid-turn
  // predicate, and a rested codex thread trips it by definition, which would retire an outstanding
  // rollout send early (8 of 75 measured codex sends took over 60s to materialise; three took minutes
  // to hours). The broker arm is a direct pid probe and means what it says at rest.
  const deliveryProcessGone = isBrokerClaudeRow(row) && headlessStalled
  const runtime = degradeIfNoTranscript(
    deriveRuntime(row.slug, row, storage, tele?.turn, tele?.permPrompt ?? false, headlessStalled, headlessLostWork),
    isHeadlessRow(row) && !isBrokerClaudeRow(row) ? false : tele?.noTranscript,
  )
  const state = effectiveSessionState(row, registeredLegacyTerminal)
  const archived = state === "archived"
  const limitPause = resolveLimitPause(row, tele, nowMs)
  const needsYou = archived ? false : deriveNeedsYou(row, tele, runtime, interactionPresence.needsUser, nowMs, limitPause, true, deliveryProcessGone)
  const awaitingBackground = archived ? false : deriveAwaitingBackground(row, tele, runtime, interactionPresence.needsUser, nowMs, limitPause, deliveryProcessGone)
  // A pane that exited with work still outstanding — a turn in flight, OR a sub-agent still reading
  // "running" (its parent is gone, so it cannot actually be live) — is a crash/stall, not a clean
  // handoff, so it cards as "stalled" not a bare "rest". Mirrors deriveNeedsYou's surfacing above.
  // hasLiveBackgroundWork keys on sub-agents only (a background shell is never treated as live work);
  // it flips back to bare rest once the child's transcript goes stale.
  // `headlessLostWork` joins the two classic signals rather than relying on them. It is already the
  // thing that made `runtime` "exited" here, and on its own neither of the others fires: the turn ENDED
  // cleanly (that is the whole case), and hasLiveBackgroundWork reads `running` only, so it goes false
  // the moment the 15-minute staleness clock trips. Without this the thread would spend 15 minutes
  // carded as a stall and then silently become an ordinary bare rest — same lost work, no longer
  // mentioned. See hasUnretiredOwnAgents.
  const crashed = runtime === "exited" && (tele?.turn === "in-flight" || hasLiveBackgroundWork(tele) || headlessLostWork)
  const snoozedUntil = futureSnooze(row, nowMs)
  const profile = resolveSessionProfile(row, tele)
  const permissionMode = resolveSessionPermission(row, tele)
  const permissionPending = resolvePendingPermission(row)
  const title = resolveSessionTitle(row, tele)
  return {
    id: row.slug,
    ...title,
    status: "active", // synthesized: the field is required but UNUSED for session rows (see note above)
    hasPlan: false,
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime,
    sessionId: row.session_id,
    tmuxName: row.tmux_name,
    unread: row.unread === 1,
    archived,
    lastAssistant: tele?.lastAssistant,
    spawnedAt: row.spawned_at,
    lastActivityAt: tele?.lastActivityAt,
    lastAssistantAt: tele?.lastAssistantAt,
    subAgents: stampStoppable(tele?.subAgents ?? [], row),
    bgShells: stampStoppableShells(tele?.bgShells ?? [], row),
    pendingAsk: tele?.pendingAsk ? { questions: tele.pendingAsk.questions } : undefined,
    nativeInputRequired: tele?.nativeInputRequired,
    pendingQuestion: tele?.pendingQuestion ?? false,
    lastUserAt: tele?.lastUserAt,
    // Runtime provider-auth rejection (claude-auth plan): only the typed category travels — the raw
    // error/pane text never leaves the server. Drives the trusted sign-in recovery card in ChatView.
    providerFault: tele?.authFault
      ? { backend: row.backend === "codex" ? "codex" as const : "claude" as const, category: tele.authFault }
      : undefined,
    // Subscription window exhausted mid-turn — the credential is fine, so this is a WAIT, not a
    // sign-in. Drives the pause card and (while an auto-resume is promised) the queue excusal above.
    limitPause,
    kind: "session",
    foreign: false,
    lastFence: tele?.lastFence,
    seenAt: row.seen_at ?? undefined,
    planPath: row.plan_path ?? undefined,
    state,
    snoozedUntil,
    // Only meaningful while the snooze is still pending — a prompt without a live deadline is an
    // already-delivered (or superseded) bump the row has not been swept clean of yet.
    snoozePrompt: snoozedUntil ? row.snooze_prompt ?? undefined : undefined,
    claudeRuntime: row.claude_runtime === "broker" ? "broker" as const : row.claude_runtime === "tmux" ? "tmux" as const : undefined,
    // The recurring prompt — the same projection the worker's own `action: "get"` reads back.
    recurringPrompt: resolveRecurringPrompt(row),
    needsYou,
    awaitingBackground,
    crashed,
    pendingInteraction: interactionPresence.pending,
    actionableInteraction: interactionPresence.needsUser,
    // Preserve only a durable, canonical backend identity. In particular, Claude is not inferred
    // from today's dispatch preference: unknown/migrated rows remain unmarked, while rows whose
    // database default was explicitly normalized to "claude" get the same per-thread identity as
    // Codex rows.
    backend: row.backend === "claude" || row.backend === "codex" ? row.backend : undefined,
    // Only a persisted, validated per-session value is exposed. A migrated row stays visibly unknown;
    // never label it with today's global defaults (which may not match its running process).
    permissionMode,
    permissionPending,
    permissionChangePending: row.permission_pending !== null && row.permission_pending !== undefined,
    permPolicy: tele?.permPolicy,
    permDenies: tele?.permDenies,
    profilePendingModel: row.profile_pending_model?.trim() || undefined,
    profilePendingEffort: row.profile_pending_effort?.trim() || undefined,
    profileChangePending:
      row.profile_pending_model !== null && row.profile_pending_model !== undefined ||
      row.profile_pending_effort !== null && row.profile_pending_effort !== undefined,
    runtimeControlPending: row.runtime_control !== null && row.runtime_control !== undefined,
    controlError: row.control_error?.trim() || undefined,
    // Session profile resolved from backend-observed transcript truth first, then pinned launch
    // metadata (which supplies immediate/pre-response values and Claude's unrecorded effort). Never
    // fall back to current Settings; when both durable sources are silent the readout is omitted.
    model: profile.model,
    effort: profile.effort,
    // Context fullness. Emitted only when the provider has given BOTH halves — a fraction with a
    // guessed denominator is a fabricated reading, and the client's contract is that absence means no
    // dial rather than an empty one. A Claude row therefore carries no `context` until its first turn
    // has ended; codex carries one from its first token_count.
    context: tele?.contextTokens !== undefined && tele?.contextWindow !== undefined && tele.contextWindow > 0
      ? { tokens: tele.contextTokens, window: tele.contextWindow }
      : undefined,
  }
}

// Plan artifacts (.frizz/plans/*.md): title from the first markdown heading in the securely resolved
// bytes (else the filename stem), mtime, and registered session slugs dispatched from it. Discovery and
// reading share one stable no-follow resolver; indirect or raced files are omitted.
function readPlans(projectDir: string, rows: readonly SessionRow[]): PlanView[] {
  return listPlanFiles(projectDir).map((file) => {
    let title = file.filename.replace(/\.md$/, "")
    const head = file.contents.toString("utf8").split("\n").slice(0, 50)
    const heading = head.find((line) => /^#{1,6}\s+\S/.test(line))
    if (heading) title = heading.replace(/^#{1,6}\s+/, "").trim() || title
    const threadIds = rows
      .filter((row) => row.plan_path === file.relativePath && ThreadSlug.safeParse(row.slug).success)
      .map((row) => row.slug)
    return { path: file.relativePath, title, updatedAt: new Date(file.mtimeMs).toISOString(), threadIds }
  })
}

export interface BoardManager {
  snapshot(): Promise<BoardSnapshot>
  // The seq the current snapshot corresponds to — the value a connect keyframe must advertise so the
  // client can adopt it and then apply deltas seq+1, seq+2 … (see the /events handler). Read
  // synchronously right after snapshot() so the two are consistent.
  currentSeq(): number
  // Full: revalidates registered-file migration state and secure plan discovery.
  rebuild(): Promise<BoardSnapshot>
  // Overlay-only: reuses file-backed caches; cheap + sync. Use for tailer/session changes.
  refresh(): BoardSnapshot
  // A durable typed-interaction transition changes queue membership independently of transcript or
  // .frizz files. The board caches per-session presence and refreshes on the journal's post-commit edge.
  interactionChanged?(change: InteractionChange): void
  start(): Promise<void>
  stop(): Promise<void>
}

// Reads the codex app-server bridge's turn-liveness authority for one thread; undefined for a thread
// the bridge does not own (and for every non-codex row). Injected rather than imported so the board
// keeps no dependency on the bridge — and so a context without one (tests, a bridge-less server)
// simply never downgrades.
export type CodexTurnLivenessReader = (
  slug: string,
  sessionId: string,
) => { bridgeTurn: boolean; ownedSince: string } | undefined

// Whether a broker-Claude session's ownerless daemon is running right now — the headless-stall signal
// for a broker row (its parallel of codexTurnLiveness). Absent (tests / bridge-less server) ⇒ assume
// alive, so a healthy broker row is never falsely carded as a crash.
export type ClaudeBrokerLivenessReader = (sessionId: string) => boolean

export interface BoardManagerDeps {
  subscribe?: typeof watcher.subscribe
  now?: () => number
  codexTurnLiveness?: CodexTurnLivenessReader
  claudeBrokerDaemonAlive?: ClaudeBrokerLivenessReader
}

export function createBoard(
  project: Project,
  storage: Storage,
  bus: Bus,
  tailer: Tailer,
  bootId: string,
  deps: BoardManagerDeps = {},
): BoardManager {
  const subscribe = deps.subscribe ?? watcher.subscribe
  const now = deps.now ?? Date.now
  const codexTurnLiveness = deps.codexTurnLiveness ?? (() => undefined)
  const claudeBrokerDaemonAlive = deps.claudeBrokerDaemonAlive ?? (() => true)
  let cached: BoardSnapshot | null = null
  let parcelSub: watcher.AsyncSubscription | null = null
  let watchSetup: Promise<void> | null = null
  let bootstrapWatch: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  let reconcileTimer: NodeJS.Timeout | null = null
  let snoozeTimer: NodeJS.Timeout | null = null
  let interactionRefreshQueued = false
  let snoozeRefreshQueued = false
  let stopped = false
  let stopPromise: Promise<void> | null = null
  const activeRebuilds = new Set<Promise<BoardSnapshot>>()
  // Pending presence and human actionability, keyed by BOTH slug and current session id. Provider
  // responses remain journal-pending until acknowledgement, but QUEUED/SENT is no longer a human ask:
  // keep its thread card readable while dropping it from Needs You. A replacement session therefore
  // cannot inherit either signal from the prior rollout.
  const pendingInteractionCache = new Map<string, { pending: boolean; needsUser: boolean }>()
  const interactionKey = (slug: string, sessionId: string) => `${slug}\u0000${sessionId}`
  // Per-slug "was this SESSION thread in the needs-you queue last build?" — drives the needs-decision
  // notify dedupe: we fire only on a false→true edge, and a thread leaving the queue re-arms it.
  const needsYouPrev = new Map<string, boolean>()
  // PRIME GUARD: the first assemble after boot records the baseline WITHOUT notifying, so a post-bounce
  // server doesn't fire a storm for every historical resting thread already in the queue.
  let notifyPrimed = false

  // Fire a needs-decision notify for every registered session that newly enters the queue.
  // Edge-triggered + deduped; primed on the first build.
  function notifyNeedsYou(sessionThreads: ThreadView[]): void {
    const seen = new Set<string>()
    for (const t of sessionThreads) {
      seen.add(t.id)
      const now = t.needsYou ?? false
      const was = needsYouPrev.get(t.id) ?? false
      if (notifyPrimed && now && !was) {
        bus.publish({ type: "notify", slug: t.id, kind: "needs-decision", title: t.aiTitle || t.title || t.id, body: capLine(t.lastAssistant) })
      }
      needsYouPrev.set(t.id, now)
    }
    // forget threads that vanished so a reappearance re-notifies
    for (const id of [...needsYouPrev.keys()]) if (!seen.has(id)) needsYouPrev.delete(id)
    notifyPrimed = true
  }

  // File-backed migration/plan caches are recomputed only on a full rebuild (the recursive .frizz
  // watcher catches changes). Overlay-only refreshes remain filesystem-free.
  let legacyTerminalCache = new Set<string>()
  let plansCache: PlanView[] = []

  // Build exactly the session-backed threads recorded by Frizz. The registry is the provenance
  // boundary: historical rows remain valid after migration/restart, and both Claude and Codex use the
  // same durable shape. Raw tailer discoveries never confer ownership.
  function buildSessionThreads(nowMs: number): ThreadView[] {
    // Old/corrupt databases predate the canonical storage guard. Keep such rows inert instead of
    // emitting an invalid board id or allowing it to reach tailer/tmux consumers.
    const rows = storage.allSessions().filter((row) => ThreadSlug.safeParse(row.slug).success)
    const currentInteractionKeys = new Set<string>()
    const out: ThreadView[] = []
    for (const row of rows) {
      const key = interactionKey(row.slug, row.session_id)
      currentInteractionKeys.add(key)
      let interactionPresence = pendingInteractionCache.get(key)
      if (interactionPresence === undefined) {
        try {
          const scope = {
            projectId: project.id,
            threadSlug: row.slug,
            sessionId: row.session_id,
          }
          const pending = storage.interactions.listPending(scope)
          interactionPresence = {
            pending: pending.length > 0,
            needsUser: pending.some((interaction) => {
              const delivery = storage.interactions.providerDelivery(scope, interaction.id)
              return !delivery || (delivery.state !== "queued" && delivery.state !== "sent")
            }),
          }
        } catch {
          // Fail visible. A corrupt/unreadable journal must not silently hide a request that may hold
          // provider authority; the queue card will surface the scoped RPC error instead.
          interactionPresence = { pending: true, needsUser: true }
        }
        pendingInteractionCache.set(key, interactionPresence)
      }
      out.push(sessionThreadView(
        project.dir,
        storage,
        row,
        tailer.get(row.slug),
        legacyTerminalCache.has(row.slug),
        interactionPresence,
        nowMs,
        codexTurnLiveness,
        claudeBrokerDaemonAlive,
      ))
    }
    for (const key of pendingInteractionCache.keys()) {
      if (!currentInteractionKeys.has(key)) pendingInteractionCache.delete(key)
    }
    return out
  }

  // Assemble a snapshot from registered sessions + plan artifacts. Unregistered legacy files and
  // foreign transcripts are excluded before any legacy parser is invoked, so they cannot contribute a
  // row, queue card, warning, or error. `.frizz/` presence is deliberately NOT reported: it gates only
  // plan/scratchpad storage (probed locally where that matters), never whether this project has a board.
  function assemble(): BoardSnapshot {
    // One clock sample owns every snooze decision in this snapshot: expiry clearing, visibility,
    // needs-you derivation, and timer selection cannot disagree at a deadline boundary.
    const assembledAtMs = now()
    // Canonical UTC strings sort chronologically, so one indexed write clears every elapsed snooze.
    // This runs on every edge-triggered refresh as well as the level-triggered reconcile.
    storage.clearExpiredSnoozes(new Date(assembledAtMs).toISOString())
    // The URL slug comes from the machine-wide registry, not from `project` — the same lookup every
    // other link goes through, so the board can never name itself differently from the rail.
    const base = {
      projectDir: project.dir,
      projectName: project.name,
      projectLabel: project.label,
      projectSlug: findByPath(project.dir)?.slug,
    }
    const sessionThreads = buildSessionThreads(assembledAtMs)
    armSnoozeWake(sessionThreads, assembledAtMs)
    notifyNeedsYou(sessionThreads)
    return {
      ...base,
      threads: sessionThreads,
      errors: [],
      warnings: [],
      errorItems: [],
      plans: plansCache,
    }
  }

  // Schedule the exact next user-snooze deadline instead of relying on the 15s reconciliation ceiling.
  // Long waits are chunked at Node's safe timeout limit; restart re-arms from the durable DB value.
  function queueSnoozeRefresh(): void {
    if (snoozeRefreshQueued) return
    snoozeRefreshQueued = true
    queueMicrotask(() => {
      snoozeRefreshQueued = false
      if (stopped) return
      refresh()
    })
  }

  function armSnoozeWake(threads: readonly ThreadView[], assembledAtMs: number): void {
    if (snoozeTimer) clearTimeout(snoozeTimer)
    snoozeTimer = null
    if (stopped) return
    let next = Infinity
    for (const thread of threads) {
      const at = Date.parse(thread.snoozedUntil ?? "")
      if (Number.isFinite(at) && at > assembledAtMs) next = Math.min(next, at)
    }
    if (!Number.isFinite(next)) return
    // Assembly can take long enough to cross the selected deadline. Rebuild immediately in that case
    // instead of dropping the now-due deadline and waiting for the 15s reconcile sweep.
    const schedulingNowMs = now()
    if (next <= schedulingNowMs) {
      queueSnoozeRefresh()
      return
    }
    const delay = Math.max(1, Math.min(next - schedulingNowMs + 1, 2_147_000_000))
    snoozeTimer = setTimeout(() => {
      snoozeTimer = null
      if (!stopped) queueSnoozeRefresh()
    }, delay)
    snoozeTimer.unref?.()
  }

  // Recompute the plans cache (full-read grade). Called on rebuild; empty when .frizz/ is absent.
  function recomputePlans(): void {
    plansCache = frizzDirExists(project.dir) ? readPlans(project.dir, storage.allSessions()) : []
  }

  function recomputeLegacyTerminalState(): void {
    legacyTerminalCache = new Set(
      storage.allSessions()
        // Auto-titled UI rows are session-first authority: a matching legacy filename is untrusted and
        // must not even be opened. Only a non-auto historical row can use the narrow terminal-status
        // migration bridge while its explicit lifecycle state is still absent.
        .filter((row) => row.state == null && row.archived !== 1 && row.title_auto !== 1 && registeredLegacyFileIsTerminal(project.dir, row.slug))
        .map((row) => row.slug),
    )
  }

  // Publish only what CHANGED. The differ holds the last-broadcast per-thread JSON; on each snapshot it
  // returns just the changed/added/removed threads (+ board-level meta when it moved), or null when
  // nothing moved — which is the dedupe that keeps the 1s tailer tick and 15s reconcile from streaming
  // identical multi-hundred-KB frames. A one-thread status change now ships ONE ThreadView, not 310KB.
  // Clients get the full board as their connect keyframe (see the /events handler), then these deltas.
  const differ = new BoardDiffer()
  function publish(snapshot: BoardSnapshot): void {
    const d = differ.diff(snapshot)
    if (!d) return
    bus.publish({ type: "board-delta", seq: d.seq, bootId, upserts: d.upserts, removed: d.removed, ...(d.meta ? { meta: d.meta } : {}) })
  }

  // FULL rebuild: recompute registered-file migration metadata + plans, then assemble.
  async function rebuildOnce(): Promise<BoardSnapshot> {
    if (stopped) throw new ProducerStoppedError("board")
    // One indexed expiry sweep per level-triggered reconcile keeps queue membership truthful even
    // with no browser mounted. Any transitions publish normal journal invalidations.
    storage.interactions.expireDue()
    recomputeLegacyTerminalState()
    recomputePlans()
    cached = assemble()
    publish(cached)
    return cached
  }

  function rebuild(): Promise<BoardSnapshot> {
    if (stopped) return Promise.reject(new ProducerStoppedError("board"))
    const task = rebuildOnce()
    activeRebuilds.add(task)
    task.then(
      () => activeRebuilds.delete(task),
      () => activeRebuilds.delete(task),
    )
    return task
  }

  // OVERLAY-ONLY rebuild: reuse the cached frizz data. For tailer/session-registry changes.
  function refresh(): BoardSnapshot {
    if (stopped) throw new ProducerStoppedError("board")
    cached = assemble()
    publish(cached)
    return cached
  }

  function interactionChanged(change: InteractionChange): void {
    if (stopped) return
    const key = interactionKey(change.threadSlug, change.sessionId)
    // Delivery-only transitions keep lifecycle/revision unchanged, so always evict and re-read the
    // durable join. This prevents awaiting→queued→sent→acknowledged from oscillating the queue based on
    // whichever layer happened to notify last.
    pendingInteractionCache.delete(key)
    // Store observers may fire from within a surrounding SQLite transaction or while listPending is
    // expiring records during assembly. Defer and coalesce the refresh to avoid re-entrant builds.
    if (interactionRefreshQueued) return
    interactionRefreshQueued = true
    queueMicrotask(() => {
      interactionRefreshQueued = false
      if (stopped) return
      refresh()
    })
  }

  function scheduleRebuild() {
    if (stopped) return
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void rebuild().catch(() => {}), DEBOUNCE_MS)
  }

  function watchFrizzDir(): Promise<void> {
    if (parcelSub || stopped) return Promise.resolve()
    if (watchSetup) return watchSetup
    const setup = (async () => {
      const next = await subscribe(join(project.dir, ".frizz"), () => scheduleRebuild())
      if (stopped) {
        await next.unsubscribe()
        return
      }
      parcelSub = next
    })()
    watchSetup = setup
    void setup.then(
      () => { if (watchSetup === setup) watchSetup = null },
      () => { if (watchSetup === setup) watchSetup = null },
    )
    return setup
  }

  return {
    snapshot: async () => {
      if (stopped) throw new ProducerStoppedError("board")
      return cached ?? (await rebuild())
    },
    currentSeq: () => differ.currentSeq(),
    rebuild,
    refresh,
    interactionChanged,
    async start() {
      if (stopped) throw new ProducerStoppedError("board")
      await rebuild()
      if (stopped) return
      // LEVEL-TRIGGERED reconciliation: a periodic full rebuild guarantees convergence even if every
      // edge (watcher event, SSE push, mutation hook) is missed or fails — the UI can lag one period,
      // never forever. Edge-triggered paths above make it feel instant; this makes it CORRECT.
      reconcileTimer = setInterval(() => void rebuild().catch(() => {}), RECONCILE_MS)
      if (frizzDirExists(project.dir)) {
        await watchFrizzDir()
      } else {
        // .frizz/ not created yet — watch the repo root (non-recursive) for its appearance,
        // then hand off to the recursive .frizz watcher. Avoids recursively watching the whole repo.
        try {
          bootstrapWatch = fsWatch(project.dir, (_e, name) => {
            if (name === ".frizz" && frizzDirExists(project.dir)) {
              bootstrapWatch?.close()
              bootstrapWatch = null
              void watchFrizzDir().catch(() => {})
              scheduleRebuild()
            }
          })
        } catch {
          // repo root unwatchable — board still serves on-demand via snapshot()
        }
      }
    },
    stop() {
      if (stopPromise) return stopPromise
      stopped = true
      stopPromise = (async () => {
        if (debounce) clearTimeout(debounce)
        debounce = null
        if (reconcileTimer) clearInterval(reconcileTimer)
        reconcileTimer = null
        if (snoozeTimer) clearTimeout(snoozeTimer)
        snoozeTimer = null
        bootstrapWatch?.close()
        bootstrapWatch = null
        const subscription = parcelSub
        parcelSub = null
        const pendingWatchSetup = watchSetup
        await Promise.all([
          pendingWatchSetup ?? Promise.resolve(),
          subscription?.unsubscribe() ?? Promise.resolve(),
        ])
        // Rebuilds are registry/plan reads only, but still drain them so a replacement generation never
        // publishes a stale delta after shutdown begins.
        await Promise.allSettled([...activeRebuilds])
      })()
      return stopPromise
    },
  }
}
