import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { compactionPromptMessage, formatGithubWakeSteer, type GithubWatchStatus, prWatchWakeMessage, shellDoneMessage, isValidAwaitingTimer, restPromptMessage, schedulePromptMessage, timerPromptMessage, signoffNudgeMessage, wakeDeliveryToken, type QuotaSnapshot } from "@frizz/shared"
import { GITHUB_STATUS_SETTING } from "./awaiting.ts"
import type { SessionRow, Storage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import type { FenceView, SessionTelemetry } from "./tailer.ts"
import type { LimitFault } from "./backend/types.ts"
import { limitFaultResetKey, limitPauseIsStale, quotaWindowKeyFor, quotaWindowRecovered, textResetInstant } from "./backend/usage-limit.ts"
import { createWakeDeliveryStore, type WakeDelivery } from "./wake-store.ts"
import { ProducerStoppedError } from "./shutdown.ts"
import { completionsDueForRelay, relayMessage } from "./completion-relay.ts"
import {
  createGithubReviewFetcher,
  isBotGithubActor,
  parseGithubReviewActivities,
  type GithubReviewActivity,
  type GithubReviewFetchResult,
} from "./github-review.ts"

const execFileAsync = promisify(execFile)

export {
  isBotGithubActor,
  parseGithubReviewActivities,
  type GithubReviewActivity,
} from "./github-review.ts"
import { log as frizzLog } from "./logging.ts"

// ---- DURABLE TIMER WAKER + PR-WATCH + LEGACY COMPATIBILITY ----------------------------------------
// New workers use `awaiting` for a PR-activity watcher (`pr-watch:`), a specific external HUMAN gate
// (`human:`), or a wall-clock checkpoint (`timer:`). `pr-watch` wakes on ANY new activity on the PR
// after this fence — a review or a comment, from a human or a bot, with no actor filter whatsoever
// (most review today is filed by an app, and the ones that post findings as a conversation comment
// are precisely what a bot filter drops) — while a registered timer remains
// durable across server/worker restarts and resumes when it crosses. Historical transcripts may still
// carry `pr:`/`ci:` hints, so their existing
// out-of-band wake behavior remains as a compatibility bridge. Other automated waits should instead
// stay ACTIVE through Bash/Monitor (Claude) or a blocking
// exec wait (Codex). The resumed turn supersedes the fence, naturally making the wake idempotent.
//
// ---- THE BOOT-MASS-FIRE SAFETY GUARD (critical — the maintainer has ~14 real sessions) ----
// We fire ONLY on a wait registered by this scheduler, or a legacy condition we witness transition
// from UNMET → MET. Future timers and GitHub-review baselines are PERSISTED before they can fire, so a
// crossing/activity during downtime still wakes after restart. An already-past UNREGISTERED timer (an
// old transcript inherited during migration) never fires, preserving the boot no-mass-resume guard.
// Legacy pr/ci hints remain in-memory transition watches only. Once a condition fires, a deterministic
// SQLite outbox row is committed BEFORE terminal delivery. Atomic leases serialize multiple scheduler
// instances; delivery acknowledgement, transcript-token confirmation, and exact-fence supersession
// produce explicit terminal states. A crash leaves pending/leased work recoverable instead of burning
// a fired bit before the wake crossed tmux.

export interface PrRef {
  owner: string
  repo: string
  number: number
}

// The distilled PR status we act on (from one `gh pr view … --json state,mergedAt,statusCheckRollup`).
export interface PrStatus {
  state: string // OPEN | CLOSED | MERGED
  mergedAt: string | null
  rollup: RollupEntry[] // statusCheckRollup entries (CheckRun and/or StatusContext shapes)
  // GitHub's own merge verdict, as the merge box states it. MERGEABLE | CONFLICTING | UNKNOWN, plus the
  // review gate (APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "") — the two facts behind "can this
  // actually land", which the card renders and the queue rule reads.
  mergeable?: string
  reviewDecision?: string
  // Workflow runs queried by the PR's exact head SHA. statusCheckRollup can omit a fork-gated
  // ACTION_REQUIRED run, so it is never sufficient evidence that a legacy `ci:` fence passed.
  workflowRuns?: WorkflowRun[]
}

export interface WorkflowRun {
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string | null
  databaseId?: number
  event?: string
  createdAt?: string
}

interface RollupEntry {
  status?: string // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | PENDING | WAITING
  conclusion?: string // CheckRun: SUCCESS | FAILURE | NEUTRAL | CANCELLED | TIMED_OUT | ACTION_REQUIRED | SKIPPED | STALE
  state?: string // StatusContext: PENDING | SUCCESS | FAILURE | ERROR | EXPECTED
  name?: string // CheckRun's job name
  context?: string // StatusContext's context label
  workflowName?: string // CheckRun's parent workflow, when GitHub reports one
}

// Parse a PR reference out of a hint value: `owner/repo#123` or a GitHub PR URL. Undefined when neither
// shape matches (e.g. an actions-run URL with no PR number) → that hint is simply not actionable.
const PR_REF_RE = /(?:https?:\/\/github\.com\/)?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\/pull\/|\/pulls\/|#)(\d+)/
export function parsePrRef(value: string): PrRef | undefined {
  const m = value.trim().match(PR_REF_RE)
  if (!m) return undefined
  const number = parseInt(m[3], 10)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), number }
}
function refKey(r: PrRef): string {
  return `${r.owner}/${r.repo}#${r.number}`
}

// `gh pr view` does not accept owner/repo#N as its positional selector. Pin the CLI-compatible shape:
// numeric selector plus an explicit repository. Kept pure/exported so a regression cannot silently
// turn every healthy legacy PR/CI poll into an "unavailable" result again.
export function ghPrViewArgs(ref: PrRef): string[] {
  return ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state,mergedAt,statusCheckRollup,headRefOid,mergeable,reviewDecision"]
}

// Retries preserve obsolete failed/ACTION_REQUIRED runs on the same SHA. Match the plugin monitor:
// the newest run for a workflow/event is the current verdict, not the oldest blocked attempt.
export function latestWorkflowRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>()
  for (const run of runs) {
    if (!run || typeof run !== "object") continue
    const key = `${run.workflowName ?? run.name ?? "unknown"}\u0000${run.event ?? ""}`
    const old = latest.get(key)
    const stamp = String(run.createdAt ?? "")
    const oldStamp = String(old?.createdAt ?? "")
    const id = Number(run.databaseId ?? 0)
    const oldId = Number(old?.databaseId ?? 0)
    if (!old || stamp > oldStamp || (stamp === oldStamp && id > oldId)) latest.set(key, run)
  }
  return [...latest.values()]
}

// Reduce a statusCheckRollup to a terminal verdict. `done` = every check has reached a terminal state
// (nothing queued/in-progress/pending); `ok` = none concluded in failure. An EMPTY rollup is treated
// as still-pending (no checks reported yet) so a `ci:` wait never fires before any check exists.
export function evalRollup(rollup: RollupEntry[]): { done: boolean; ok: boolean } {
  if (!Array.isArray(rollup) || rollup.length === 0) return { done: false, ok: false }
  let pending = false
  let failed = false
  for (const c of rollup) {
    if (!c || typeof c !== "object") continue
    const status = typeof c.status === "string" ? c.status : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    // An entry is terminal ONLY if it AFFIRMATIVELY says so: a CheckRun with status COMPLETED, or a
    // StatusContext whose state is a settled value. An entry we can't classify (no recognizable
    // status/state — a `{}` or a future/unknown shape) is treated as still-PENDING, never as
    // done+green — so a shape surprise can never launder a `ci:` wait into a false "green" fire.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) pending = true
    if (rollupEntryFailed(conclusion, state)) failed = true
  }
  return { done: !pending, ok: !failed }
}

// The single definition of "this check concluded badly", shared by the pass/fail verdict and by the
// steer that NAMES the failures — so the wake can never say "CI failed" and then list nothing.
function rollupEntryFailed(conclusion: string | undefined, state: string | undefined): boolean {
  return (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED" ||
    conclusion === "STARTUP_FAILURE" ||
    state === "FAILURE" ||
    state === "ERROR"
  )
}

// Which checks actually failed. "❌ CI failed on owner/repo#N" told a worker only that SOMETHING went
// red, so its first move was always another `gh pr checks` round-trip; naming the jobs it must look at
// costs nothing here and saves that turn. Deduplicated and bounded — a red matrix can be 40 entries.
export function failedCheckNames(rollup: RollupEntry[], runs: WorkflowRun[] = [], cap = 8): { names: string[]; omitted: number } {
  const names: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined) => {
    const name = raw?.trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }
  for (const c of Array.isArray(rollup) ? rollup : []) {
    if (!c || typeof c !== "object") continue
    if (!rollupEntryFailed(typeof c.conclusion === "string" ? c.conclusion : undefined, typeof c.state === "string" ? c.state : undefined)) continue
    push(c.name ?? c.context ?? c.workflowName)
  }
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run !== "object") continue
    // An unapproved fork run reads ACTION_REQUIRED but is a pending approval, not a failure — the same
    // reading `evalHint` gives it, so it must not be listed as a failed job either.
    if (run.conclusion === "ACTION_REQUIRED") continue
    if (!rollupEntryFailed(run.conclusion ?? undefined, undefined)) continue
    push(run.workflowName ?? run.name)
  }
  return { names: names.slice(0, cap), omitted: Math.max(0, names.length - cap) }
}

// ---- WHAT A WATCHED PR'S CHECKS LOOK LIKE FROM OUTSIDE ------------------------------------------
// The same rollup the legacy `ci:` verdict reads, projected into the shape GitHub's own merge box
// states — because it now DECIDES A QUEUE RULE and not just a readout (maintainer 2026-08-14: "if
// there is a GitHub watcher registered and the GitHub actions are still running, then that should
// remain in the running active rail. Only if CI has failed or completed successfully should it show up
// back in the queue").
//
// `none` and `running` are deliberately different answers. An EMPTY rollup means no check has reported
// yet, which `evalRollup` already treats as pending — but a PR with no CI at all would then wait
// forever for checks that are never coming, so the two are split here: `none` lets the thread queue
// immediately, `running` is what parks it.
export function githubWatchStatus(pr: PrStatus, polledAt: string): GithubWatchStatus {
  const entries = Array.isArray(pr.rollup) ? pr.rollup.filter((c) => c && typeof c === "object") : []
  let running = 0
  let passed = 0
  let failed = 0
  for (const c of entries) {
    const status = typeof c.status === "string" ? c.status : undefined
    const state = typeof c.state === "string" ? c.state : undefined
    const conclusion = typeof c.conclusion === "string" ? c.conclusion : undefined
    // Terminal ONLY if it AFFIRMATIVELY says so, exactly as `evalRollup` reads it: an unrecognizable
    // entry counts as still running, never as quietly green.
    const terminal = status ? status === "COMPLETED" : state ? state !== "PENDING" && state !== "EXPECTED" : false
    if (!terminal) running++
    else if (rollupEntryFailed(conclusion, state)) failed++
    else passed++
  }
  const state = pr.state === "MERGED" ? "merged" as const : pr.state === "CLOSED" ? "closed" as const : "open" as const
  const checks: GithubWatchStatus["checks"] =
    entries.length === 0 ? "none" : failed > 0 ? "failing" : running > 0 ? "running" : "passing"
  // MERGEABILITY, in GitHub's own three words plus the review gate. `blocked` is deliberately coarse:
  // a required review and a failing required check are reported the same way, and frizz has no business
  // claiming to tell them apart.
  const merge: GithubWatchStatus["merge"] =
    pr.mergeable === "CONFLICTING" ? "conflicting"
    : pr.mergeable !== "MERGEABLE" ? "unknown"
    : checks === "failing" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED" ? "blocked"
    : "mergeable"
  return {
    checks,
    running,
    passed,
    failed,
    failing: failedCheckNames(entries, pr.workflowRuns ?? []).names,
    merge,
    state,
    polledAt,
  }
}

// The PR-activity watcher hint. A one-line predicate (rather than inlining `=== "pr-watch"`) keeps
// every scheduler branch reading uniformly and leaves an obvious seam if the watcher ever grows a
// second spelling again. (`github-review`, the prior name, was removed 2026-07-22.)
function isPrWatchHint(kind: FenceView["hints"][number]["kind"]): boolean {
  return kind === "pr-watch"
}

// Is a hint one this scheduler can act on? A current STRICT ISO `timer:`, a machine-readable
// `pr-watch:` PR ref, plus legacy `pr:`/`ci:` refs. `human:` is descriptive by
// definition and `session:` has no cross-session liveness signal, so neither is resolved here.
function isActionable(hint: FenceView["hints"][number]): boolean {
  if (hint.kind === "timer") return isValidAwaitingTimer(hint.value)
  // `pr-watch` IS NOT ACTIONABLE HERE ANY MORE (2026-08-14). It is a DECLARATION of a wait that
  // `mcp__frizz__watch_pr` created, and the registry pass (SOURCE 11) is what fires it. Leaving it armed
  // here too would wake a correctly-behaved worker TWICE for one review — register the PR, name it in
  // the fence, get told everything twice — which is the shape of bug that reads as "the watcher is
  // misfiring". A `pr-watch:` line with no registration behind it therefore wakes nobody, and the board
  // queues that thread as usual rather than parking it (fenceWatchViews / heldByRunningChecks).
  if (hint.kind === "pr" || hint.kind === "ci") return parsePrRef(hint.value) !== undefined
  return false
}

// A stable identity for the CURRENT awaiting rest of a thread: the sorted set of its actionable hints.
// A different set (the agent re-awaits something new) is a fresh arming cycle; the same set across ticks
// (and across a restart — hints are derived deterministically from the JSONL) is the same wait.
function fenceIdentity(hints: FenceView["hints"], fenceAt?: string): string {
  const hintId = hints
    .filter(isActionable)
    .map((h) => `${h.kind}:${h.value}`)
    .sort()
    .join("|")
  // The final-message timestamp is the generation id. Re-emitting the SAME hint after a follow-up is
  // a fresh wait/baseline even if the scheduler did not happen to tick while the old fence was clear.
  return `${fenceAt ?? ""}\u0001${hintId}`
}

function wakeDeliveryId(slug: string, sessionId: string, fenceId: string): string {
  return createHash("sha256").update(slug).update("\0").update(sessionId).update("\0").update(fenceId).digest("hex")
}

// ---- SOURCE 2: SUBSCRIPTION-LIMIT AUTO-RESUME -----------------------------------------------------
// The waker's other wake source. Where the fence source asks "did the wait this agent DECLARED come
// true?", this one asks "did the wall the provider put in front of this agent come down?" — and the
// set of agents behind that wall needs no registry, because the tailer's `limitFault` standing on a
// thread's tail IS the record that this agent was mid-turn when the window ran dry. It clears the
// instant any user record lands, so the "continue" we deliver erases the very fault that selected the
// thread: one wake per interruption, with no bookkeeping to drift.
//
// Both sources share ONE durable outbox (lease → deliver → ack, backend-aware delivery, retry with
// exponential backoff, supersession). Only the identity differs, and these two prefixes are what keep
// a limit wake and a fence wake for the same session from ever colliding on a delivery id.
const LIMIT_FENCE_PREFIX = "limit"
const LIMIT_HINT_PREFIX = "limit:"
// Deliberate slack past the provider's stated reset. Their clock and ours are not the same clock, and
// resuming a whole fleet one second early just re-hits the wall and burns every thread's wake.
const LIMIT_RESUME_GRACE_MS = 60_000

// The ACCOUNT-AVAILABILITY resume trigger (independent of the original window's own clock): a
// limit-paused thread also resumes when the blown window is no longer near-full on the CURRENTLY
// signed-in account — a fresh sign-in or a raised cap frees up quota the original clock knows nothing
// about. Two stateless guards keep it from resuming straight back into the wall:
//   • the FLOOR — a limit fault only happens at ~100% of the window, so requiring the current reading to
//     sit at/below 85% is the genuine down-edge while ignoring tick-to-tick jitter near 100%.
//   • the MIN FAULT AGE — the served quota reading can lag the fault by up to its cache TTL, and during
//     a fast fleet burn the window climbs 85→100 in well under a minute, so a reading OLDER than the
//     fault could still show pre-burn headroom. Only trusting the signal once the fault is comfortably
//     older than that staleness guarantees the reading POST-dates the fault (a real recovery), not a
//     stale pre-fault value. It adds no delay to the real case — an account switched hours after the
//     fault clears this instantly — it only holds off the first couple of minutes.
const LIMIT_RESUME_HEADROOM_PERCENT = 85
const LIMIT_HEADROOM_MIN_FAULT_AGE_MS = 2 * 60_000

// The generation id for one interruption. The limit record's timestamp is what makes it a generation:
// a thread that resumes and gets cut off AGAIN produces a later `at`, hence a different delivery id,
// hence its own single wake.
function limitFenceId(fault: LimitFault): string {
  return `${LIMIT_FENCE_PREFIX}${fault.at}`
}
function isLimitFenceId(fenceId: string): boolean {
  return fenceId.startsWith(LIMIT_FENCE_PREFIX)
}

// The message the resumed worker actually receives. Deliberately a plain continue — the agent's own
// transcript already holds everything it was doing, so the useful thing to add is only WHY it stopped
// and that it should pick the work back up rather than re-plan or re-report.
export function limitResumeSteer(window: LimitFault["window"]): string {
  const which = window === "weekly" ? "weekly usage limit" : window === "session" ? "session usage limit" : "usage limit"
  return `⏳ The ${which} that interrupted you has reset. Continue exactly where you left off.`
}

// ---- SOURCE 4: DROPPED SUB-AGENT REPORT REPAIR ---------------------------------------------------
// Where the limit source asks "did the wall come down?", this one asks "is this agent missing findings
// it believes it already has?" — and like that one it needs no registry, because the tailer's
// `droppedReports` standing on a thread's tail IS the record (see report-delivery.ts for the corpus:
// 242 of 498 completed sub-agent reports on one production thread reached the runtime's queue and
// never reached the model).
//
// It rides the same durable outbox as the other three, which is the whole reason to put it here rather
// than in a bespoke timer: lease → deliver → ack, retry with backoff, and — the load-bearing part —
// a delivery id of hash(slug, sessionId, fenceId). With the TASK ID as the generation, one dropped
// report can produce exactly ONE repair for a session, no matter how many ticks observe it. Re-nagging
// an agent about the same lost report every minute would be its own denial of service.
const REPORT_FENCE_PREFIX = "report"
const REPORT_HINT_PREFIX = "report:"

function reportFenceId(taskId: string): string {
  return `${REPORT_FENCE_PREFIX}:${taskId}`
}
function isReportFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${REPORT_FENCE_PREFIX}:`)
}

// ---- SOURCE 3: THE USER SNOOZE ------------------------------------------------------------------
// A snooze that carries a prompt is the human's own `awaiting timer:` — park until an instant, then
// resume with a message — differing only in WHO authored the message. So it wakes over this same
// outbox rather than a private timer of its own, inheriting crash-safety, retry/backoff, supersession
// and every-backend delivery for free.
//
// Its record of intent is the session row itself (`snoozed_until` + `snooze_prompt`), exactly as the
// limit source's record is the tail's limit fault. That is why `clearExpiredSnoozes` deliberately
// leaves a prompt-carrying snooze standing past its deadline: the row must outlive the crossing so a
// wake-now, a human follow-up, or a re-snooze can be READ here as supersession. It is cleared only
// once this wake reaches a terminal state — and only while it still matches the delivery it armed.
//
// The prompt is delivered VERBATIM, with no "⏰ your snooze fired" preamble: the human scheduled a
// follow-up, so the worker should receive precisely the turn they wrote, not a paraphrase of it.
const SNOOZE_FENCE_PREFIX = "snooze"
const SNOOZE_HINT_PREFIX = "snooze:"

// The prompt is part of the generation id, not just the instant: editing the follow-up on an
// already-due snooze must mint a NEW delivery rather than collide with the enqueued one's message.
function snoozeFenceId(until: string, prompt: string): string {
  const digest = createHash("sha256").update(prompt).digest("hex").slice(0, 16)
  return `${SNOOZE_FENCE_PREFIX}:${until}:${digest}`
}
function isSnoozeFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SNOOZE_FENCE_PREFIX}:`)
}

interface ArmedSnooze {
  until: string
  untilMs: number
  prompt: string
  fenceId: string
}
// A row's CURRENT scheduled bump, if it has one. A snooze without a prompt is the historical reminder
// (the board owns its expiry) and never reaches the waker.
function armedSnooze(row: Pick<SessionRow, "snoozed_until" | "snooze_prompt">): ArmedSnooze | undefined {
  const until = row.snoozed_until
  const prompt = row.snooze_prompt?.trim()
  if (!until || !prompt) return undefined
  const untilMs = Date.parse(until)
  if (!Number.isFinite(untilMs)) return undefined
  return { until, untilMs, prompt, fenceId: snoozeFenceId(until, prompt) }
}

// ---- SOURCE 4: THE RECURRING PROMPT, ON SCHEDULE --------------------------------------------------
// SOURCES 4 and 5 are two TRIGGERS on ONE stored prompt (`recurring_*`), not two features. They stayed
// two scheduler passes through the merge because they genuinely do not fold together: this one keys its
// delivery id on (generation, beat index) and must NOT filter on rest, while SOURCE 5 keys on
// (generation, rest instant) and must. One pass with a mode flag would be both of them wearing an if.
//
// THE DUMB TRIGGER: a prompt on a chosen clock. It consults nothing about the thread — not rest, not
// `--awaiting`, not sub-agents, not shells. If the interval has elapsed, a delivery is queued, and it
// GOES OUT whether or not the thread is mid-turn (`isDeliverableNow`, which carries the transport
// detail). It is the only source that does not wait for rest, and that is the feature.
//
// It is the sibling of SOURCE 5, not a rival: the rest trigger asks "you stopped — is there more?" and
// only a thread that stops ever hears it; this one asks "it has been an hour" and a thread hears it an
// hour later, working or not. An operator who needs a thread revisited on a schedule regardless of what
// the agent is doing needs this one.
//
// It also remains the only recurring wake a worker CAN have. Claude Code's own `CronCreate` /
// `ScheduleWakeup` cannot fire in the runtime frizz spawns: their gate stays shut while ANY background
// task is outstanding, so the thread most in need of a nudge — one parked behind a sub-agent that will
// never report — is exactly the one whose cron is dead (measured 2026-08-01: 3 fires in 150s with no
// background work, 0 with a background shell alive). Riding frizz's outbox sidesteps that entirely.
//
// Its record of intent is the session row, with `recurring_armed_at` as the GENERATION: re-arming mints
// a new one, so a delivery still in the outbox under the old settings reads as superseded.
//
// It never ABORTS the turn it lands in. Both transports accept a mid-turn message as an ordinary
// queued/steered input, so the running work finishes and the prompt is read at the next sampling
// boundary — which is what "fires on its cadence" means, and is also the only reading compatible with
// frizz's completion invariant.
//
// THE FENCE PREFIXES ARE THE PRE-MERGE ONES, on purpose. They are internal delivery-id namespaces that
// nothing outside this file reads, and renaming them would reclassify every delivery already sitting in
// a live outbox as an unknown fence across the upgrade — real churn to buy a nicer string.
const HEARTBEAT_FENCE_PREFIX = "heartbeat"
const HEARTBEAT_HINT_PREFIX = "heartbeat:"

// The generation is (armed_at, beat index). The index advances only once the previous delivery is
// TERMINAL, so a thread accumulates exactly one pending scheduled prompt rather than one per interval —
// an agent handed an hour of backlog at once is its own denial of service.
function heartbeatFenceId(armedAt: string, beat: number): string {
  return `${HEARTBEAT_FENCE_PREFIX}:${armedAt}:${beat}`
}
function isHeartbeatFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:`)
}

interface ArmedSchedule {
  prompt: string
  intervalMs: number
  armedAt: string
  /** When the next one becomes due: an interval after the last delivered one, else after arming. */
  dueAtMs: number
}

type RecurringRow = Pick<
  SessionRow,
  | "recurring_prompt" | "recurring_on_rest" | "recurring_on_schedule" | "recurring_on_compact"
  | "recurring_interval_ms" | "recurring_armed_at" | "recurring_pause_on_questions"
  | "recurring_rest_fired_at" | "recurring_schedule_fired_at" | "recurring_compact_fired_at"
>

// ---- WHAT A PENDING QUESTION DOES TO ALL THREE TRIGGERS -------------------------------------------
// A thread that has asked the human something is not stalled — it is waiting, correctly, and it is
// already sitting in the queue as a card with the answer's own input on it. Re-prompting it there is
// worse than useless: the worker reads "keep going" as an instruction to act, and the honest reply to
// its own question is to ask it again, so the operator gets the same card twice with a paragraph of
// agent apology between them.
//
// TWO RULES, and they are deliberately different in strength.
//
//   THE HARD ONE (`restMessageIsSignedOff`, below): the stop hook asks "you stopped — is there more?",
//   and a ```question, a ```done, or an ```awaiting on a wait somebody else owns has already answered it
//   in the very message that ENDED the turn. Firing over any of them is the trigger talking to itself.
//
//   ITS QUESTION LIMB IS THE ONE PART AUTONOMOUS MODE OVERRIDES, and that is not a softening of the rule
//   — it is the rule reading the operator's answer. "Is there more?" is answered by a question fence
//   only because the thread is waiting for a human; a thread whose operator has said "decide for
//   yourself, do not stop for me" is not waiting, so the fence has answered nothing. The other two limbs
//   are NOT settings-dependent and never become so: `done` is the loop's off switch (below), and a park
//   on a wake the scheduler itself will deliver is a duplicate wake rather than a rescue whatever mode
//   the thread is in — including a `human:` gate, which stays held because bumping one is measured
//   harm (see `parkedOnAWaitItCannotAdvance`) and because the fix for it is the operator, not a bump.
//
//   IT SHIPPED UNCONDITIONAL AND THAT WAS A BUG (maintainer 2026-08-14, "came to rest with a question,
//   despite the fact that I have a goal set and its autonomous mode is enabled"). The panel's own gloss
//   already promised this exact behaviour — "sends goal prompt when the agent asks questions instead of
//   waiting for an answer" — while this line silently held the ON REST trigger, which on a thread armed
//   at rest is the whole feature. Measured on the maintainer's board: project nub, thread
//   `read-the-file-read-up`, `recurring_pause_on_questions = 0` and `recurring_on_rest = 1`, rested
//   14:54:49Z on a ```question fence, and the Goal armed five minutes earlier never fired.
//
//   THE BUMP THAT CROSSES A QUESTION SAYS SO. A worker handed the bare goal on top of its own unanswered
//   question re-asks it, correctly — so `restPromptMessage(prompt, {overQuestion:true})` tells it no
//   answer is coming and to record the call instead. Without that clause this override would produce the
//   duplicate card the unconditional hold existed to prevent, rather than the forward motion asked for.
//
//   Its parts reach different distances, though. A ```done fence ends the arrangement, so it also
//   stops the HEARTBEAT (`saidDone`) — it is the successor to the ALLDONE sentinel and inherits its
//   reach exactly. A pending QUESTION and a parked ```awaiting stop the stop hook alone: the heartbeat
//   asks "it has been an hour" and the compaction trigger asks "your context is gone", and neither a
//   question the human has not answered nor a PR nobody has reviewed is an answer to either.
//
//   THE SWITCHED ONE (`pauseOnQuestions`) is the operator's, and it is BROADER on both axes: it holds
//   all three triggers, and it counts every way a thread can be blocked on a human — a fence, a native
//   ask, a backend modal, an interactive permission prompt. The panel seeds it ON alongside the stop
//   hook (maintainer 2026-08-11), because the two are one intent: "keep going" is not something to say
//   to a thread that stopped to ask you a question, whichever way it asked.
//
//   THE PANEL SHOWS IT INVERTED, as "Autonomous mode" — switching that ON clears this flag, so the goal
//   keeps arriving while an answer is outstanding and the agent decides for itself instead of waiting.
//   Same default, a name that describes the behaviour rather than the mechanism. The inversion lives in
//   the component; this column stays the mechanism it always was.
//
//   IT STOPS AT THE GOAL. It reached SOURCE 9 as well for one day (2026-08-13 → 2026-08-14), silencing
//   frizz's own sign-off reminder on an autonomously-driven thread, and that is reverted rather than
//   re-tuned: the reminder now OPENS by sending a half-finished thread back to the work, which is the
//   Goal's own instruction, so the "two deliveries pulling opposite ways" the suppression was built on no
//   longer exists — and the suppression cost the ```awaiting park, which the Goal's
//   trailer deliberately does not name (see restPromptMessage). Measured over five consecutive bare
//   rests: five bumps, no reminder, the park never mentioned. This column is about QUESTIONS.
//
//   THE `done` CARVE-OUT IS NOT ONE OF THESE, and is not switchable. It is the loop's OFF SWITCH: the
//   delivered trailer tells the worker to sign off with `done` to stop the prompts, so a goal that kept
//   firing over a `done` fence would be a loop with no terminating condition that frizz had also
//   promised terminates. Predictability cuts the other way here — an unconditional trigger is only
//   simpler until it is the thing reopening finished threads.
//
//   IT IS STILL A SWITCH, and the row's COLUMN still defaults to 0 — an existing armed row picks it up
//   off, and so does any caller that has never heard of it. The default lives in the panel, where a
//   default is a thing an operator can see and change, and not in the storage layer, where flipping it
//   would silently re-interpret every row already on disk.
type QuestionTele = Pick<
  SessionTelemetry,
  "pendingQuestion" | "pendingAsk" | "permPrompt" | "nativeInputRequired"
>

/** The thread SIGNED OFF: the message that ended the turn declares the work finished.
 *
 *  That is the ```done fence as of 2026-08-11, and the legacy `ALLDONE` sentinel for as long as sessions
 *  dispatched before the change are still running — they were told to reply it, and dropping the
 *  recogniser the same day would take their exit away and loop them forever.
 *
 *  Needs no stored state: both facts are folded off the FINAL assistant message, so either holds for
 *  exactly as long as that message is the thread's last word, and anything said afterwards re-opens the
 *  loop by itself. */
function saidDone(tele: Pick<SessionTelemetry, "lastFence" | "lastAssistantAllDone">): boolean {
  return tele.lastFence?.kind === "done" || tele.lastAssistantAllDone === true
}

/** The stop hook asks "you stopped — is there more?", and this is the message that ALREADY ANSWERED it:
 *  the thread declared itself finished, it parked on a wait somebody else owns, or it asked the human
 *  something AND is in a mode where waiting for the human is what it should do. Firing over any of them
 *  is the trigger talking to itself.
 *
 *  `autonomous` reaches the QUESTION limb only, and the asymmetry is the point — see the header block.
 *  Both callers must pass the same value or a bump would be enqueued and then superseded before it was
 *  ever delivered, so it is read from the row by `autonomousModeOn` at each. */
function restMessageIsSignedOff(
  tele: Pick<SessionTelemetry, "pendingQuestion" | "lastFence" | "lastAssistantAllDone">,
  autonomous: boolean,
  registeredPrWatches: ReadonlySet<string> = new Set(),
): boolean {
  if (saidDone(tele) || parkedOnAWaitItCannotAdvance(tele, registeredPrWatches)) return true
  return tele.pendingQuestion === true && !autonomous
}

/** The rest parked on a wait THIS TRIGGER CANNOT ADVANCE: an `awaiting` fence naming either a durable
 *  wake the scheduler itself will deliver (a parseable `pr-watch:`/`pr:`/`ci:` ref, a valid `timer:`)
 *  or a `human:` gate only the operator can open.
 *
 *  IT USED TO FIRE OVER THESE, on the reasoning that the stop hook is the one thing that rescues a
 *  thread parked behind something that will never report. That rescue is real, and it is kept below —
 *  but it never applied to these two shapes, and firing over them was a self-feeding loop rather than a
 *  rescue. Measured on the maintainer's own board 2026-08-12 (project zod): a worker parked on
 *  `pr-watch: colinhacks/zod#6382` was bumped 7 times in 46 minutes, each bump costing a turn whose only
 *  product was the SAME fence reworded, because "keep going" has no answer while a PR sits unreviewed. A
 *  second thread added `human: Colin to merge — the task barred me from merging` and was bumped anyway,
 *  until it escaped the loop the only way left to it: a ```done fence on a PR nobody had merged. The
 *  trigger corrupted the signal it exists to produce.
 *
 *  WHAT STILL GETS THE RESCUE: an `awaiting` fence with no hint at all, an unparseable PR ref, a
 *  malformed `timer:`, a bare `session:` — every park frizz has no way to fire. Those are the threads
 *  that genuinely wait forever, and this reads the SAME predicates the waker's own passes fire from, so
 *  the hold and the wake can never disagree about which is which.
 *
 *  A `pr-watch:` LINE IS THE ONE THAT NEEDS A SECOND FACT, since 2026-08-14: the fence no longer arms
 *  anything, so the line alone says nothing about whether a wake is coming. A REGISTERED watcher
 *  (`mcp__frizz__watch_pr`) will fire, so the Goal holds; a line with no registration behind it is a
 *  park frizz cannot honour, so it gets the rescue like any other unfireable hint. Without the first
 *  half this reintroduces the measured loop above verbatim. */
function parkedOnAWaitItCannotAdvance(
  tele: Pick<SessionTelemetry, "lastFence">,
  registeredPrWatches: ReadonlySet<string>,
): boolean {
  const fence = tele.lastFence
  if (fence?.kind !== "awaiting") return false
  return fence.hints.some((h) => {
    if (isActionable(h) || h.kind === "human") return true
    if (h.kind !== "pr-watch") return false
    const ref = parsePrRef(h.value)
    return ref !== undefined && registeredPrWatches.has(refKey(ref))
  })
}

/** The PRs a thread has actually registered, by `owner/repo#N`. Read where the Goal decides whether to
 *  bump, because a declaration alone no longer means a wake is coming. */
function registeredPrWatchesOf(storage: Storage, slug: string): ReadonlySet<string> {
  return new Set(storage.listPrWatches(slug, { armedOnly: true }).map((w) => `${w.owner}/${w.repo}#${w.number}`))
}

/** Is this thread blocked on the human RIGHT NOW, by any means? The `pauseOnQuestions` hold's input.
 *  Wider than the fence check above because the hold is the operator saying "don't nudge it while it is
 *  waiting on me", and a native ask or a permission prompt is exactly that. */
function blockedOnHuman(tele: QuestionTele): boolean {
  return tele.pendingQuestion === true
    || tele.pendingAsk !== undefined
    || tele.permPrompt === true
    || tele.nativeInputRequired !== undefined
}

/** Does this row's question hold apply, given what the thread is doing? False when the hold is off, so
 *  callers read as one line at each of the three fire sites. */
function heldByQuestion(row: Pick<SessionRow, "recurring_pause_on_questions">, tele: QuestionTele | undefined): boolean {
  if (row.recurring_pause_on_questions !== 1) return false
  return tele !== undefined && blockedOnHuman(tele)
}

/** The panel's "Autonomous mode": the same column `heldByQuestion` reads, inverted.
 *
 *  READING THE COLUMN ALONE IS SAFE HERE and nowhere else. It DEFAULTS TO 0, so on an arbitrary row
 *  "autonomous" and "never armed a Goal" are the same value, and a site that asks before establishing a
 *  live trigger reads the whole board as autonomous. Both callers of this one have already established
 *  an armed REST trigger before they ask, so the row in their hands is a Goal the operator configured
 *  and the 0 means what the switch says. Do not lift this to a site that has not. */
function autonomousModeOn(row: Pick<SessionRow, "recurring_pause_on_questions">): boolean {
  return row.recurring_pause_on_questions !== 1
}

// A row's live ON SCHEDULE trigger, if it has one. A switched-off trigger deliberately reads as ABSENT
// here — off must stop new deliveries AND drop queued ones — while the row keeps the text and the
// cadence so switching it back on resumes the same schedule rather than making anyone re-enter it.
function armedSchedule(row: RecurringRow): ArmedSchedule | undefined {
  const prompt = row.recurring_prompt?.trim()
  const intervalMs = row.recurring_interval_ms
  const armedAt = row.recurring_armed_at
  if (!prompt || !intervalMs || intervalMs <= 0 || !armedAt) return undefined
  if (row.recurring_on_schedule !== 1) return undefined
  const anchor = Date.parse(row.recurring_schedule_fired_at ?? armedAt)
  if (!Number.isFinite(anchor)) return undefined
  return { prompt, intervalMs, armedAt, dueAtMs: anchor + intervalMs }
}

// ---- SOURCE 5: THE RECURRING PROMPT, ON REST -----------------------------------------------------
// The SAME stored text as SOURCE 4, delivered every time the thread STOPS — which is the event an
// operator actually means when they want one to keep going.
//
// There is no cadence here and nothing to get wrong. An earlier interval-based version of this idea was
// removed 2026-08-02 for exactly that reason: an operator who wants "keep going until X" has no idea
// what number to put in a box. A thread that stops gets the text, and one that never stops never needed
// it — that thread is SOURCE 4's job.
//
// The loop's OFF SWITCH belongs to the worker, and it is the one part of this that is not optional. A
// rest trigger with no terminating condition is an infinite bump generator, so the delivered text
// carries a trailer (shared `restPromptMessage`) teaching the worker to sign off with a ```done fence
// when the work is genuinely finished. The tailer folds that fence onto the final message (`lastFence`)
// and this pass simply declines to fire while it stands — no state to write, and it re-opens by itself
// the moment the thread produces any other final message. See `saidDone`, which also still honours the
// legacy `ALLDONE` sentinel for sessions dispatched before 2026-08-11.
//
// Same generation as SOURCE 4 (`recurring_armed_at`), because it is the same prompt: editing the text
// supersedes a delivery queued for the old words on BOTH triggers at once.
const STOP_HOOK_FENCE_PREFIX = "stophook"
const STOP_HOOK_HINT_KEY = "stophook:rest"

// The rest a delivery is bound to: the AGENT'S OWN last word.
//
// It was `lastActivityAt`, the thread's high-water mark over ANY record, and that was a self-feeding
// loop for a thread whose worker is gone. Frizz speaks as the USER, so a delivered bump lands in the
// transcript and advances the high-water mark — minting a new "rest" that nobody rested, and with it a
// new delivery id. Measured 2026-08-12 on a real stack with the worker absent: 10 bumps in 100 seconds,
// climbing. It was survivable while a Goal was something an operator opted into on one thread; it stopped
// being survivable when every dispatched thread started carrying one.
//
// `lastAssistantAt` keeps the property that made the old key work — a genuine new rest necessarily
// carries a new one, so "at most one per rest" still falls out of delivery-id uniqueness — and adds the
// one frizz needs: nothing frizz says can move it. A thread with no assistant output yet has never
// rested.
function stopHookFenceId(armedAt: string, restedAt: string): string {
  return `${STOP_HOOK_FENCE_PREFIX}:${armedAt}:${restedAt}`
}
function isStopHookFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${STOP_HOOK_FENCE_PREFIX}:`)
}

interface ArmedRest {
  prompt: string
  armedAt: string
}

// A row's live ON REST trigger, if it has one. Switched off reads as ABSENT, exactly as for the
// schedule, and for the same reason.
function armedRest(row: RecurringRow): ArmedRest | undefined {
  const prompt = row.recurring_prompt?.trim()
  const armedAt = row.recurring_armed_at
  if (!prompt || !armedAt) return undefined
  if (row.recurring_on_rest !== 1) return undefined
  return { prompt, armedAt }
}

// ---- SOURCE 7: THE RECURRING PROMPT, ON COMPACTION -----------------------------------------------
// The THIRD trigger on the same stored text (2026-08-06), delivered every time the harness summarizes
// the thread's context away.
//
// WHY IT IS A TRIGGER AND NOT A HOOK. Compaction is the largest source of context loss there is, and
// frizz used to answer it by having a worker-side hook splice the head of a canonical `scratch.md` into
// the emptied window. That made the pad a load-bearing file every worker had to maintain whether or not
// it wanted one. The recurring prompt already solves the same problem better: the worker writes whatever
// doc it likes in its scratch directory and LINKS it here, and the link comes back at exactly the moment
// the context is gone. The row is durable, it is visible in the thread footer, and the operator can edit
// it — none of which a hook injection was.
//
// IT DOES NOT WAIT FOR REST, and that is the one place it deliberately parts company with SOURCE 5. A
// compaction lands MID-TURN: the worker is still working, and the whole value is re-grounding it before
// its next tool call rather than after it has finished acting on a summary. So this takes the SCHEDULE
// trigger's delivery gate, not the rest trigger's.
//
// Same generation (`recurring_armed_at`) as its two siblings, because it is the same prompt.
const COMPACT_FENCE_PREFIX = "compact"
const COMPACT_HINT_KEY = "recurring:compaction"

// The compaction a delivery is bound to. A new compaction necessarily carries a new instant, so "at most
// one per compaction" falls out of delivery-id uniqueness — the same trick the rest trigger plays with
// `lastActivityAt`, and the reason neither needs a counter.
function compactFenceId(armedAt: string, compactedAt: string): string {
  return `${COMPACT_FENCE_PREFIX}:${armedAt}:${compactedAt}`
}
function isCompactFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${COMPACT_FENCE_PREFIX}:`)
}

// A row's live ON COMPACTION trigger, if it has one. Switched off reads as ABSENT, same as the others.
function armedCompact(row: RecurringRow): ArmedRest | undefined {
  const prompt = row.recurring_prompt?.trim()
  const armedAt = row.recurring_armed_at
  if (!prompt || !armedAt) return undefined
  if (row.recurring_on_compact !== 1) return undefined
  return { prompt, armedAt }
}

// ---- SOURCE 6: THE WORKER'S ONE-OFF TIMERS -------------------------------------------------------
// The heartbeat with the repetition taken out: text the worker asked to be handed back at ONE instant,
// once. A thread may hold arbitrarily many, so unlike every other source here the record of intent is a
// TABLE (`thread_timer`) rather than a column on the session row — a row can hold one arrangement, and
// "check the deploy in 10 min AND re-read the spec in an hour" is two.
//
// It inherits the SCHEDULE trigger's delivery gate rather than the snooze's, deliberately: a timer set
// for 15:00 that a busy thread only hears at 15:50 has not kept the promise it made, and "in ten
// minutes" is the instruction being obeyed. See `isDeliverableNow`.
//
// It does NOT inherit the sign-off opt-out. That exists because a recurring trigger is an
// infinite bump generator with no terminating condition; a one-off has exactly one delivery in it, and a
// worker that scheduled an alarm and then said "nothing further right now" still wants the alarm.
//
// The GENERATION is the timer id itself — each row is armed once and never edited, so a delivery can
// only be superseded by the row leaving the `armed` state (the worker cancelled it, or it already
// fired). That is also what makes the row's own state, not the outbox, the durable "never twice" guard:
// terminal outbox rows are pruned past a cap, while `state = 'fired'` is permanent.
const TIMER_FENCE_PREFIX = "timer"
const TIMER_HINT_PREFIX = "timer:"

// Safe against the awaiting-fence namespace even though `timer:` is also an awaiting HINT kind: an
// awaiting fence id is `<fence instant><kind>:<value>…` (see fenceIdentity), so it can never begin
// with this prefix.
// A registered watcher's delivery namespace (scheduler SOURCE 8). Safe against every neighbour for the
// same reason the timer's is: an awaiting fence id begins with its own fence instant, and no other
// prefix here starts with these characters.
// The built-in sign-off nudge's delivery namespace (scheduler SOURCE 9), and its consecutive cap.
/** A finished background shell's delivery namespace. The shell's own launch tool_use id is the whole
 *  key, so one shell can wake its thread exactly once, ever — no counter, no cursor, no way to loop. */
const SHELL_FENCE_PREFIX = "shell"
function shellFenceId(toolUseId: string): string {
  return `${SHELL_FENCE_PREFIX}:${toolUseId}`
}
function isShellFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SHELL_FENCE_PREFIX}:`)
}

/** A registered PR watcher's delivery namespace. The id plus a monotonically-increasing REPORT number,
 *  because this watcher fires many times over one PR's life — the id alone would dedupe every wake after
 *  the first, which is exactly the bug a one-shot namespace would hide. */
const PR_WATCH_FENCE_PREFIX = "prwatch"
function prWatchFenceId(watchId: string, report: number): string {
  return `${PR_WATCH_FENCE_PREFIX}:${watchId}:${report}`
}
function isPrWatchFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${PR_WATCH_FENCE_PREFIX}:`)
}
/** How often a registered watcher re-reads GitHub, per PR. The fence poller's floor, for the same
 *  reason: this is somebody else's API and the answer changes on a human's timescale. */
const PR_WATCH_POLL_MS = 60_000

const SIGNOFF_FENCE_PREFIX = "signoff"
const SIGNOFF_HINT_KEY = "signoff:rest"
const SIGNOFF_NUDGE_MAX = 2
/** The kill switch. Not in the UI — this lands on every live thread at once, so there has to be a way
 *  to stop it that is not a code change. Absent (the default) means ON. */
const SIGNOFF_NUDGE_SETTING = "signoffNudge"

function signoffFenceId(restedAt: string): string {
  return `${SIGNOFF_FENCE_PREFIX}:${restedAt}`
}
function isSignoffFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${SIGNOFF_FENCE_PREFIX}:`)
}


function timerFenceId(timerId: string): string {
  return `${TIMER_FENCE_PREFIX}:${timerId}`
}
function isTimerFenceId(fenceId: string): boolean {
  return fenceId.startsWith(`${TIMER_FENCE_PREFIX}:`)
}
function timerIdOf(fenceId: string): string {
  return fenceId.slice(TIMER_FENCE_PREFIX.length + 1)
}

// A single hint's verdict this tick: met? + the steer to send when it fires. `undefined` = indeterminate
// (a PR fetch we couldn't complete) → neither arm nor fire; try again next poll.
interface Verdict {
  met: boolean
  steer: string
  reason: string
}
function evalHint(hint: FenceView["hints"][number], nowMs: number, prCache: Map<string, PrStatus>, fenceBody: string): Verdict | undefined {
  if (hint.kind === "timer") {
    const target = Date.parse(hint.value)
    if (!isValidAwaitingTimer(hint.value) || !Number.isFinite(target)) return undefined
    const desc = fenceBody.trim().replace(/\s+/g, " ").slice(0, 200)
    return { met: nowMs >= target, steer: `⏰ Your timer fired${desc ? `: ${desc}` : ""}. Continue.`, reason: `timer ${hint.value}` }
  }
  if (isPrWatchHint(hint.kind)) return undefined // evaluated against its persisted activity cursor below
  const ref = parsePrRef(hint.value)
  if (!ref) return undefined
  const s = prCache.get(refKey(ref))
  if (!s) return undefined // no PR data this window (fetch failed / not yet polled) → indeterminate
  if (hint.kind === "pr") {
    const merged = !!s.mergedAt || s.state === "MERGED"
    const closed = s.state === "CLOSED"
    const steer = merged
      ? `✅ PR ${refKey(ref)} merged. Continue.`
      : `ℹ️ PR ${refKey(ref)} was closed without merging. Continue.`
    return { met: merged || closed, steer, reason: `pr ${refKey(ref)} ${s.state}` }
  }
  // ci
  // Exact-head Actions runs are mandatory evidence for legacy CI. A partial rollup can look green
  // while a fork gate is ACTION_REQUIRED or a matrix job is still queued. An approved rerun replaces
  // its older same-workflow attempt, just as the worker-side CI monitor does.
  if (!Array.isArray(s.workflowRuns)) {
    return { met: false, steer: "", reason: `ci ${refKey(ref)} workflow runs unavailable` }
  }
  const runs = latestWorkflowRuns(s.workflowRuns)
  if (runs.length === 0) return { met: false, steer: "", reason: `ci ${refKey(ref)} no exact-head workflow runs` }
  // An old fork-gated check remains in statusCheckRollup after a maintainer approves a rerun. The
  // exact, deduplicated workflow list is authoritative for that one stale conclusion; other rollup
  // failures/pending contexts still participate in the combined verdict.
  const rollup = s.rollup.map((check) => check?.conclusion === "ACTION_REQUIRED"
    ? { ...check, conclusion: undefined }
    : check)
  const rollupVerdict = evalRollup(rollup)
  const workflowVerdict = evalRollup(runs.map((run) => {
    // GitHub reports an unapproved fork run as COMPLETED/ACTION_REQUIRED. It is semantically a
    // pending approval, not a terminal CI failure, until a newer rerun replaces it.
    if (run.conclusion === "ACTION_REQUIRED") return { status: "IN_PROGRESS" }
    return { status: run.status, conclusion: run.conclusion ?? undefined }
  }))
  const done = rollupVerdict.done && workflowVerdict.done
  const ok = rollupVerdict.ok && workflowVerdict.ok
  const failures = failedCheckNames(rollup, runs)
  const named = failures.names.length
    ? ` — ${failures.names.join(", ")}${failures.omitted > 0 ? `, and ${failures.omitted} more` : ""}`
    : ""
  const steer = ok ? `✅ CI is green on ${refKey(ref)}. Continue.` : `❌ CI failed on ${refKey(ref)}${named}. Continue.`
  return { met: done, steer, reason: `ci ${refKey(ref)} ${done ? (ok ? "green" : "failed") : "pending"}` }
}

// Default gh-backed PR fetcher. Uses the USER'S `gh` (their auth) via execFile — NO shell. Any failure
// (gh missing → ENOENT, not authed / rate-limited → nonzero exit, malformed JSON) resolves to undefined
// so the tick logs + skips and NEVER crashes. Timeout-bounded so a hung gh can't wedge the scheduler.
async function defaultFetchPr(ref: PrRef): Promise<PrStatus | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ghPrViewArgs(ref),
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const j = JSON.parse(stdout) as {
      state?: unknown; mergedAt?: unknown; statusCheckRollup?: unknown; headRefOid?: unknown
      mergeable?: unknown; reviewDecision?: unknown
    }
    // A SHAPE SURPRISE (valid JSON, but no string `state`) is INDETERMINATE, not "OPEN with no
    // checks" — returning a fabricated `{state:"", rollup:[]}` would read as UNMET and ARM the hint,
    // so a later accurate read could then fire an already-merged PR. Undefined = try again next poll.
    if (typeof j.state !== "string" || !j.state) return undefined
    if (typeof j.headRefOid !== "string" || !j.headRefOid) return undefined
    const runs = await execFileAsync(
      "gh",
      ["run", "list", "--repo", `${ref.owner}/${ref.repo}`, "--commit", j.headRefOid, "--limit", "100", "--json", "name,workflowName,status,conclusion,databaseId,event,createdAt"],
      { timeout: 15_000, maxBuffer: 8_000_000, env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" } },
    )
    const workflowRuns = JSON.parse(runs.stdout)
    if (!Array.isArray(workflowRuns)) return undefined
    return {
      state: j.state,
      mergedAt: typeof j.mergedAt === "string" ? j.mergedAt : null,
      rollup: Array.isArray(j.statusCheckRollup) ? (j.statusCheckRollup as RollupEntry[]) : [],
      mergeable: typeof j.mergeable === "string" ? j.mergeable : undefined,
      reviewDecision: typeof j.reviewDecision === "string" ? j.reviewDecision : undefined,
      workflowRuns: workflowRuns as WorkflowRun[],
    }
  } catch {
    return undefined
  }
}

// Per-thread arming state for the CURRENT awaiting rest (reset when the fence identity changes/clears).
interface ThreadWake {
  fenceId: string
  armed: Map<string, boolean> // hintKey → have we witnessed it UNMET at least once?
  fired: boolean // this rest already has a legacy fired marker or durable outbox row
  lastPollAt: number // last gh poll for this thread's pr/ci/review hints (throttle)
  prCache: Map<string, PrStatus> // last-known PR statuses, keyed by refKey (kept between polls)
  reviewCache: Map<string, GithubReviewActivity[]> // current review/comment activity snapshot by ref
}

const FIRED_CAP = 500 // legacy pre-outbox marker cap (read during rolling upgrade, never newly added)
/** How many PRs' readings the book keeps. Shared by ref, so two threads watching one PR see one reading
 *  and cost one fetch. The key itself lives in awaiting.ts, beside the parser the board reads it with. */
const GITHUB_STATUS_CAP = 200
const REGISTRATION_CAP = 500
const REVIEW_SEEN_CAP = 300
// (thread, PR) pairs whose pre-existing activity has already been replayed once. Sized like the other
// ledgers; an eviction costs at most one extra backlog wake on a thread that has been idle for hundreds
// of other parks, which is exactly the wake it would have wanted anyway.
const INTRODUCED_CAP = 500
// How many fresh activities a single wake steer enumerates. One poll interval can collect a whole
// review app's burst; naming ten of them is already a long steer, and the count line tells the worker
// how many it did not get named individually.
const REVIEW_STEER_CAP = 10

interface ReviewCursor {
  baseline: true
  seen: string[]
  // Every newly-observed event is recorded before the wake outbox is enqueued. If GitHub is
  // temporarily unavailable on restart, this cursor still reproduces the exact pending events; the
  // deterministic outbox id prevents a second delivery row for the same fence generation. It is a
  // LIST because one poll interval routinely collects several: naming only the newest while marking
  // the rest seen dropped the others on the floor, unmentioned to anyone, forever.
  pending?: GithubReviewActivity[]
  // How many fresh activities exceeded REVIEW_STEER_CAP and so were counted but not named. Persisted
  // so a retried delivery reproduces the SAME steer rather than quietly dropping the "and N more" line.
  pendingOmitted?: number
}
// Re-hydrate one persisted activity. Anything without the three load-bearing fields is dropped rather
// than half-restored, so a corrupt row can never synthesize a wake naming a `@undefined` actor.
function parsePersistedActivity(raw: unknown): GithubReviewActivity | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const p = raw as Record<string, unknown>
  if (typeof p.id !== "string" || typeof p.actor !== "string") return undefined
  if (p.kind !== "review" && p.kind !== "comment") return undefined
  return {
    id: p.id,
    actor: p.actor,
    actorType: typeof p.actorType === "string" ? p.actorType : undefined,
    at: typeof p.at === "string" ? p.at : undefined,
    kind: p.kind,
    ...(typeof p.reviewState === "string" ? { reviewState: p.reviewState } : {}),
    ...(typeof p.url === "string" && p.url ? { url: p.url } : {}),
  }
}

interface PersistedRegistration {
  key: string
  timers: Record<string, string> // hint key → exact ISO target; presence means durably armed
  reviews: Record<string, ReviewCursor> // hint key → durable activity baseline/cursor
}

export interface SchedulerDeps {
  storage: Storage
  tailer: Tailer
  // Resume/steer a thread (prod: the shared resumeThread; tests: a spy). `deliveryId` is a stable
  // idempotency key for the exact session + awaiting-fence generation. Implementations must carry it
  // through durable downstream queues and append wakeDeliveryToken(id) to terminal input so transcript
  // recovery can prove a crash-window delivery before retrying (the production composition does both).
  resume: (slug: string, message: string, deliveryId: string) => void | Promise<void>
  now?: () => number
  // The provider quota snapshot, used ONLY to decide whether an exhausted window has rolled when the
  // limit message's own text can't say (every weekly limit, since its clock carries no date). Absent
  // in tests that exercise the text path; a read that throws is treated as indeterminate.
  readQuota?: () => Promise<QuotaSnapshot>
  fetchPr?: (ref: PrRef) => Promise<PrStatus | undefined>
  // Tests may keep injecting the historical bare array/undefined result. Production uses the
  // structured result so the scheduler can distinguish auth, timeout, network, API, and shape faults.
  fetchGithubReview?: (ref: PrRef) => Promise<GithubReviewActivity[] | GithubReviewFetchResult | undefined>
  log?: (msg: string) => void
  tickMs?: number // how often to check (timers resolve at this cadence)
  pollMs?: number // minimum spacing between gh polls for a given thread's pr/ci hints
  deliveryLeaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  maxDeliveryAttempts?: number
  deliveryBatchSize?: number
  // Deterministic hard-crash fault injection. Throwing here escapes tick without compensating writes,
  // exactly like process death at the named durability boundary. Never configured in production.
  crashPoint?: (point: SchedulerCrashPoint, delivery: WakeDelivery) => void
}

export type SchedulerCrashPoint = "after-enqueue" | "after-claim" | "after-delivery" | "after-ack"

export interface Scheduler {
  start(): void
  stop(): Promise<void>
  tick(): Promise<void> // exposed for tests + boot
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  const fetchPr = deps.fetchPr ?? defaultFetchPr
  const fetchGithubReview = deps.fetchGithubReview ?? createGithubReviewFetcher({ now })
  const log = deps.log ?? ((m: string) => frizzLog.info("scheduler", m))
  const tickMs = deps.tickMs ?? 10_000
  const pollMs = deps.pollMs ?? 60_000
  const deliveryLeaseMs = Math.max(1, deps.deliveryLeaseMs ?? 30_000)
  const retryBaseMs = Math.max(1, deps.retryBaseMs ?? 5_000)
  const retryMaxMs = Math.max(retryBaseMs, deps.retryMaxMs ?? 5 * 60_000)
  const maxDeliveryAttempts = Math.max(1, deps.maxDeliveryAttempts ?? 6)
  const deliveryBatchSize = Math.max(0, deps.deliveryBatchSize ?? 50)
  const deliveryOwner = randomUUID()
  const outbox = createWakeDeliveryStore(deps.storage.db)

  const threads = new Map<string, ThreadWake>() // slug → arming state
  const reviewFailures = new Map<string, { signature: string; loggedAt: number; suppressed: number }>()
  // Compatibility for wakes fired by the pre-outbox scheduler during a rolling upgrade. New wakes
  // never enter this set; the durable wake_delivery table below owns their lifecycle.
  const fired = new Set<string>(loadFired())
  // Future timer registrations + GitHub review baselines. Unlike legacy pr/ci arming, these MUST
  // survive a process restart because their purpose is to own transitions while the worker/server is
  // absent. The exact fence generation (timestamp + hints) is part of each key.
  const registrations = new Map<string, PersistedRegistration>(loadRegistrations().map((r) => [r.key, r]))
  let timer: NodeJS.Timeout | null = null
  let activeTick: Promise<void> | null = null // guard + shutdown drain for a slow poll/delivery
  let stopped = false

  // ---- THE WATCHED-PR STATUS LEDGER ---------------------------------------------------------------
  // The poller is the only thing here that talks to GitHub, and the BOARD is what has to render the
  // result and decide the queue rule from it. So the poll publishes into a setting keyed by PR ref, and
  // the board reads it — one shared reading per PR, however many threads are watching it.
  //
  // A setting rather than a table because there is nothing to reconcile: it is a pure CACHE of GitHub's
  // own answer, every entry is replaceable, and an entry for a PR nobody watches any more is stale data
  // that costs a few bytes until it is evicted. Bounded like the ledgers beside it.
  function publishGithubStatus(key: string, pr: PrStatus, nowMs: number): void {
    const raw = deps.storage.getSetting(GITHUB_STATUS_SETTING)
    const book = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
    book[key] = githubWatchStatus(pr, new Date(nowMs).toISOString())
    const keys = Object.keys(book)
    // Newest-wins eviction on insertion order, which for this book is poll order — the entry evicted is
    // the one longest unpolled, i.e. the PR nobody is watching any more.
    for (const stale of keys.slice(0, Math.max(0, keys.length - GITHUB_STATUS_CAP))) delete book[stale]
    deps.storage.setSetting(GITHUB_STATUS_SETTING, book)
  }

  function loadFired(): string[] {
    const raw = deps.storage.getSetting("waker.fired")
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
  }
  function saveFired(): void {
    deps.storage.setSetting("waker.fired", [...fired].slice(-FIRED_CAP))
  }
  function forgetFired(key: string): void {
    if (fired.delete(key)) saveFired()
  }
  function loadRegistrations(): PersistedRegistration[] {
    const raw = deps.storage.getSetting("waker.registrations.v1")
    if (!Array.isArray(raw)) return []
    const out: PersistedRegistration[] = []
    for (const item of raw.slice(-REGISTRATION_CAP)) {
      if (!item || typeof item !== "object") continue
      const obj = item as Record<string, unknown>
      if (typeof obj.key !== "string" || !obj.key) continue
      const timers: Record<string, string> = {}
      if (obj.timers && typeof obj.timers === "object" && !Array.isArray(obj.timers)) {
        for (const [k, v] of Object.entries(obj.timers as Record<string, unknown>)) if (typeof v === "string") timers[k] = v
      }
      const reviews: Record<string, ReviewCursor> = {}
      if (obj.reviews && typeof obj.reviews === "object" && !Array.isArray(obj.reviews)) {
        for (const [k, v] of Object.entries(obj.reviews as Record<string, unknown>)) {
          if (!v || typeof v !== "object") continue
          const seen = (v as { seen?: unknown }).seen
          if (!Array.isArray(seen)) continue
          // `pending` was a single activity before the steer learned to enumerate a burst. A
          // registration written by that scheduler is still on disk across the upgrade, so read the
          // bare object as a one-element list rather than discarding a wake already owed to a worker.
          const rawPending = (v as { pending?: unknown }).pending
          const pending = (Array.isArray(rawPending) ? rawPending : rawPending === undefined ? [] : [rawPending])
            .map(parsePersistedActivity)
            .filter((p): p is GithubReviewActivity => p !== undefined)
            .slice(0, REVIEW_STEER_CAP)
          const rawOmitted = (v as { pendingOmitted?: unknown }).pendingOmitted
          const pendingOmitted = typeof rawOmitted === "number" && Number.isFinite(rawOmitted) && rawOmitted > 0
            ? Math.floor(rawOmitted)
            : 0
          reviews[k] = {
            baseline: true,
            // Cursors are stored newest-first (saveReviewCursor prepends the current page), so retain
            // the head on load too. Keeping the oldest tail would forget recent activity after a
            // restart and could misclassify it as a fresh human review.
            seen: seen.filter((x): x is string => typeof x === "string").slice(0, REVIEW_SEEN_CAP),
            ...(pending.length ? { pending } : {}),
            ...(pending.length && pendingOmitted ? { pendingOmitted } : {}),
          }
        }
      }
      out.push({ key: obj.key, timers, reviews })
    }
    return out
  }
  function saveRegistrations(): void {
    deps.storage.setSetting("waker.registrations.v1", [...registrations.values()].slice(-REGISTRATION_CAP))
  }
  function registration(key: string): PersistedRegistration {
    const existing = registrations.get(key)
    if (existing) return existing
    const created: PersistedRegistration = { key, timers: {}, reviews: {} }
    registrations.set(key, created)
    while (registrations.size > REGISTRATION_CAP) {
      const oldest = registrations.keys().next().value
      if (oldest === undefined) break
      registrations.delete(oldest)
    }
    return created
  }
  function armTimer(key: string, hintKey: string, target: string): void {
    const r = registration(key)
    if (r.timers[hintKey] === target) return
    r.timers[hintKey] = target
    saveRegistrations()
  }
  function saveReviewCursor(key: string, hintKey: string, seen: string[], pending?: GithubReviewActivity[], pendingOmitted = 0): void {
    const r = registration(key)
    const unique = [...new Set(seen)].slice(0, REVIEW_SEEN_CAP)
    const next: ReviewCursor = {
      baseline: true,
      seen: unique,
      ...(pending?.length ? { pending } : {}),
      ...(pending?.length && pendingOmitted > 0 ? { pendingOmitted } : {}),
    }
    if (JSON.stringify(r.reviews[hintKey] ?? null) === JSON.stringify(next)) return
    r.reviews[hintKey] = next
    saveRegistrations()
  }
  function forgetRegistration(key: string): void {
    if (registrations.delete(key)) saveRegistrations()
  }
  // ---- the pr-watch INTRODUCTION ledger ------------------------------------------------------------
  // Which (thread, PR) pairs have already had the PR's pre-existing activity replayed to them. It is a
  // ledger of its own, and it has to be, because every other piece of watcher state is keyed by FENCE
  // GENERATION and is therefore wiped between parks: `registrations` is keyed on the fence instant, and
  // runTick's sweep forgets it outright the moment the thread stops being idle. So "have I already told
  // this worker what was on this PR?" cannot be answered from any of it.
  //
  // Getting that wrong is not a cosmetic bug, it is an infinite loop: replay the backlog on every park
  // with no durable memory of having done it, and the wake makes the worker turn, the turn makes it
  // re-park, and the re-park replays the same backlog again, forever. This ledger is the one bit that
  // makes "once per thread per PR" true across re-parks, restarts and archival.
  const introduced = new Set<string>(loadIntroduced())
  function loadIntroduced(): string[] {
    const raw = deps.storage.getSetting("waker.prwatch.introduced.v1")
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(-INTRODUCED_CAP) : []
  }
  // Same NUL-delimiting rationale as firedKey: neither a slug nor a normalized owner/repo#N can contain
  // one, so no pair can forge another's key.
  const introducedKey = (slug: string, ref: PrRef) => `${slug}\u0000${refKey(ref)}`
  function markIntroduced(slug: string, ref: PrRef): void {
    const key = introducedKey(slug, ref)
    if (introduced.has(key)) return
    introduced.add(key)
    while (introduced.size > INTRODUCED_CAP) {
      const oldest = introduced.keys().next().value
      if (oldest === undefined) break
      introduced.delete(oldest)
    }
    deps.storage.setSetting("waker.prwatch.introduced.v1", [...introduced])
  }
  // NUL-delimited so no slug/fenceId content can forge a different pair's key (slugs match a
  // space-free regex and actionable hint values carry no NUL, so this is collision-proof).
  const firedKey = (slug: string, fenceId: string) => `${slug}\u0000${fenceId}`

  class InjectedSchedulerCrash extends Error {
    constructor(cause: unknown) {
      super("simulated scheduler hard crash", { cause })
    }
  }

  function checkpoint(point: SchedulerCrashPoint, item: WakeDelivery): void {
    if (!deps.crashPoint) return
    try {
      deps.crashPoint(point, item)
    } catch (error) {
      throw new InjectedSchedulerCrash(error)
    }
  }

  function retryDelay(attempts: number): number {
    return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, Math.min(30, attempts - 1)))
  }

  type DeliveryContext = "confirmed" | "superseded" | "current-idle" | "current-busy" | "unknown"

  function deliveryContext(item: WakeDelivery): DeliveryContext {
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return "superseded"
    if (row.state === "archived" || row.archived === 1) return "superseded"
    const tele = deps.tailer.get(item.slug)
    if (!tele) return "unknown"
    if (tele.lastUserText?.includes(wakeDeliveryToken(item.id))) return "confirmed"
    // A limit wake is bound to its interruption, not to a fence: it stays deliverable exactly as long
    // as THAT limit fault is still the thread's live tail state. The fault clears on the first user
    // record, so a delivery that crossed tmux before the process died reads as superseded on the next
    // pass instead of being sent twice — the same supersession safety the fence path gets, obtained
    // from the fold rather than from anything the scheduler had to persist.
    if (isLimitFenceId(item.fenceId)) {
      const fault = tele.limitFault
      if (!fault || limitFenceId(fault) !== item.fenceId) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A snooze wake is bound to the exact (instant, prompt) the human armed. Wake-now (clears the row),
    // a re-snooze (a different fence id) and an ordinary follow-up (clears the row too — see
    // resume.wakeParkedThreadForFollowUp) therefore all read as supersession here: each one is the human
    // replacing the promise we were holding. Reprompting a thread means "now", which is precisely the
    // instruction a bump scheduled for later no longer describes.
    // A SHELL-COMPLETION WAKE CANNOT BE SUPERSEDED BY ANYTHING THE THREAD SAYS. It is bound to a fact
    // that has already happened — this shell finished, and its agent was resting when it did — and no
    // later fence, rest or edit makes that untrue. So the only question is whether the thread is free to
    // receive it. (Without this branch it fell through to the awaiting-fence logic below, which compares
    // the delivery against the thread's CURRENT fence and superseded every wake for a bare rest: queued
    // on every tick, delivered never.)
    if (isShellFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A REGISTERED PR WATCHER's report is bound to something that happened on GitHub, not to anything
    // this thread wrote, so no fence, rest or edit can supersede it either. Same reasoning as the shell
    // wake directly above, and the same bug if it is missing.
    if (isPrWatchFenceId(item.fenceId)) {
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    if (isSnoozeFenceId(item.fenceId)) {
      if (armedSnooze(row)?.fenceId !== item.fenceId) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A scheduled delivery is bound to the exact GENERATION that queued it. Switching the trigger off, re-arming it
    // with different settings, and either side switching it off all read as
    // supersession here — each one means the queued text no longer describes what the thread wants.
    // Disabling therefore drops a beat already waiting, rather than delivering it on re-enable.
    if (isHeartbeatFenceId(item.fenceId)) {
      const armed = armedSchedule(row)
      if (!armed || !item.fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:${armed.armedAt}:`)) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A rest delivery is bound to the exact GENERATION that queued it AND to the exact REST it
    // was queued for. Disabling the toggle, editing the text, and the thread moving on to a new rest
    // all read as supersession here — and so does an AWAITING that landed between enqueue and delivery,
    // which is the case that matters: a worker that closed the loop while a bump sat in the outbox must
    // not be handed it anyway.
    if (isStopHookFenceId(item.fenceId)) {
      const armed = armedRest(row)
      if (!armed || item.fenceId !== stopHookFenceId(armed.armedAt, tele.lastAssistantAt ?? "")) return "superseded"
      if (restMessageIsSignedOff(tele, autonomousModeOn(row), registeredPrWatchesOf(deps.storage, item.slug))) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A post-compaction delivery is bound to the generation AND to the exact compaction it was queued
    // for — a SECOND compaction between enqueue and delivery supersedes the first, because re-grounding
    // on the older window is not what the operator asked for. Unlike the rest trigger it does NOT check
    // whether the thread signed off: `done` answers "you stopped, is there more?", and a compaction is
    // not that question.
    if (isCompactFenceId(item.fenceId)) {
      const armed = armedCompact(row)
      if (!armed || item.fenceId !== compactFenceId(armed.armedAt, tele.lastCompactionAt ?? "")) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A one-off timer is bound to its own row still being ARMED. The worker cancelling it, and a
    // previous attempt having already settled it as fired, both read as supersession here — which is
    // what makes "exactly once" hold even after the outbox has pruned this delivery's terminal row.
    if (isTimerFenceId(item.fenceId)) {
      if (deps.storage.getThreadTimer(timerIdOf(item.fenceId))?.state !== "armed") return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A registered watcher is bound to its own row still being ARMED, exactly as a timer is — and for
    // the same two reasons. The worker DROPPING it between enqueue and delivery must cancel the wake
    // (that is the whole point of a dismissable wait), and a previous attempt having already settled it
    // as fired is what makes "exactly once" hold after the outbox prunes this delivery's terminal row.
    //
    // This branch is load-bearing in a way the others are not: without it the fallthrough below reads
    // every watcher delivery as an awaiting fence, finds none, and supersedes it — the watcher enqueues
    // on every tick and never delivers, which looks exactly like a watcher that does not work.
    // The built-in nudge is bound to the exact rest it was queued for, and to that rest still being
    // fenceless. A worker that signed off between enqueue and delivery must not then be told how to
    // sign off — which is both useless and, arriving after a ```done, actively confusing.
    if (isSignoffFenceId(item.fenceId)) {
      if (item.fenceId !== signoffFenceId(tele.lastAssistantAt ?? "")) return "superseded"
      if (tele.lastFence || tele.pendingQuestion) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    // A report repair is bound to a report that is STILL missing from the model's context. If the
    // runtime delivered it late — between the tick that queued this repair and the tick that would
    // send it — the fold drops it out of `droppedReports` and the repair reads as superseded here.
    // That is what keeps a slow delivery from producing a repair for a report the agent has now read,
    // and it is obtained from the fold rather than from anything the scheduler had to persist.
    if (isReportFenceId(item.fenceId)) {
      const stillMissing = tele.droppedReports?.some((r) => reportFenceId(r.taskId) === item.fenceId)
      if (!stillMissing) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    const fence = tele.lastFence
    if (!fence || fence.kind !== "awaiting" || !fence.hints.some(isActionable)) return "superseded"
    if (fenceIdentity(fence.hints, tele.lastActivityAt) !== item.fenceId) return "superseded"
    return tele.turn === "idle" ? "current-idle" : "current-busy"
  }

  // May this item go out RIGHT NOW? Most sources wait for the thread to come to rest, because they are
  // answering a question about a thread that has stopped — an elapsed awaiting fence, a PR review, a bump
  // for a worker that just rested. Delivering those mid-turn would interrupt work the worker is already
  // doing about the very thing that woke it.
  //
  // THE CLOCK-DRIVEN PAIR ARE THE EXCEPTION — the recurring prompt's SCHEDULE trigger and the worker's
  // own ONE-OFF TIMER — and it is the whole point of both. What follows is written about the heartbeat
  // because that is where the behavior was settled; a timer is the same promise made once, so holding one
  // until rest would break it in exactly the same way.
  //
  // It fires on its cadence
  // regardless of what the thread is doing (maintainer 2026-08-03 — "my intention was for the heartbeat
  // to fire on its regular cadence, regardless of whether the agent is currently running or not"). It
  // used to be held here like everything else, which quietly made it a second rest trigger: one due at
  // 14:00 on a thread that stayed busy until 14:50 arrived at 14:50, so the cadence the operator set
  // described nothing.
  //
  // Both transports take a mid-turn message natively, so this is a gate change and not a new channel.
  // Claude's broker queues it into the running CLI's command queue, which Claude Code drains at its
  // first sampling boundary (see the bridge's `interruptTurn` contract for the measured latency); the
  // codex app-server steers the live turn through `turn/steer`. Neither ABORTS what is running, which is
  // the correct reading of "fires on its cadence" — the beat is delivered, the in-flight work is not
  // cut off, and frizz's completion invariant stays intact.
  //
  // `unknown` still defers on every source, this one included: telemetry we cannot read is not a thread
  // we can safely address.
  function isDeliverableNow(item: WakeDelivery, context: DeliveryContext): boolean {
    if (context === "current-idle") return true
    // The post-compaction trigger joins the mid-turn pair for the reason it exists at all: a compaction
    // happens WHILE the worker is working, and a re-grounding that waits for it to stop has missed the
    // window it was written for.
    return context === "current-busy"
      && (isHeartbeatFenceId(item.fenceId) || isTimerFenceId(item.fenceId) || isCompactFenceId(item.fenceId))
  }

  // Name the activity for the bump steer. A review carries a GitHub `state`, so an APPROVAL or a
  // CHANGES_REQUESTED is called out specifically (the two the worker most needs to act on); a plain
  // review or a conversation comment reads generically. Falls back to "activity" for an unknown state.
  // Every label fills a NOUN slot ("New GitHub ___ on owner/repo#N"), so GitHub's own verb-phrase
  // wording for CHANGES_REQUESTED is nominalized rather than pasted in.
  function activityLabel(a: GithubReviewActivity): string {
    if (a.kind === "comment") return "comment"
    switch (a.reviewState?.toUpperCase()) {
      case "APPROVED": return "approval"
      case "CHANGES_REQUESTED": return "change request"
      case "COMMENTED": return "review comment"
      case "DISMISSED": return "dismissed review"
      default: return "review"
    }
  }

  // Who + when + WHICH ONE. The steer used to name only the PR and the actor, which is not enough to
  // find the thing that woke the worker: its only move was a broad re-read of the thread
  // (`gh pr view N --json comments`), and that hands back every comment the actor ever left. A worker
  // woken for one fresh comment on nubjs/nub#587 pulled back TWO and re-litigated a stale one it had
  // already handled hours earlier. The permalink is the fix — it addresses exactly one item — and the
  // ISO timestamp lets the worker order it against its own last turn even if the URL is unavailable.
  //
  // The steer must never imply a person: an app filed most of what wakes this watcher. It must also
  // never read as an instruction to MUTATE the PR. "Re-open the PR and continue" meant "open the PR
  // again and read it", but a worker parses `gh pr reopen` — so the steer either burned a turn on the
  // ambiguity or, worse, reopened a PR the maintainer closed on purpose. The wake is a NOTIFICATION;
  // what to do about it is the worker's call. Keep the verb about reading, like the merged/closed/CI
  // steers that just say "Continue."
  //
  // The FORMAT itself lives in @frizz/shared beside its parser, because the chat rebuilds a
  // first-party card from this exact string — the structured activity never reaches the transcript.
  //
  // `activities` is chronological and may hold several: one poll interval routinely collects a burst,
  // and every one of them is marked seen, so anything this steer does not name is never mentioned to
  // anyone again. `omitted` is how many more than the cap were dropped from the enumeration.
  function activitySteer(activities: GithubReviewActivity[], ref: PrRef, omitted = 0, backlog = false): string {
    return formatGithubWakeSteer({
      ref: refKey(ref),
      omitted,
      items: activities.map((a) => ({
        label: activityLabel(a),
        actor: a.actor,
        bot: isBotGithubActor(a),
        ...(a.at ? { at: a.at } : {}),
        ...(a.url ? { url: a.url } : {}),
      })),
    }, { backlog })
  }

  // The operator-facing log line for this wake. Names the distinct actors rather than a count, since
  // "by pullfrog" is what makes a `waker: queued` line legible when scanning the server log.
  function reviewReason(ref: PrRef, activities: GithubReviewActivity[], omitted = 0): string {
    const actors = [...new Set(activities.map((a) => a.actor))]
    const total = activities.length + omitted
    return `pr-watch ${refKey(ref)} by ${actors.join(", ")}${total > 1 ? ` (${total} items)` : ""}`
  }

  function reviewVerdict(
    slug: string,
    persistKey: string,
    hint: FenceView["hints"][number],
    activities: GithubReviewActivity[],
    fenceAt: string | undefined,
  ): Verdict | undefined {
    const ref = parsePrRef(hint.value)
    if (!ref) return undefined
    const hintKey = `${hint.kind}:${hint.value}`
    const prior = registrations.get(persistKey)?.reviews[hintKey]
    // A previous delivery attempt failed. Retry the durable outbox item before consulting the latest
    // page; it must not disappear merely because GitHub is down or the item fell off a bounded page.
    if (prior?.pending?.length) {
      const omitted = prior.pendingOmitted ?? 0
      return {
        met: true,
        steer: activitySteer(prior.pending, ref, omitted),
        reason: reviewReason(ref, prior.pending, omitted),
      }
    }
    // No actor filter: every review and comment on the PR is a wake candidate.
    const newestFirst = [...activities].sort((a, b) => {
      const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
      return Number.isFinite(at) && at !== 0 ? at : b.id.localeCompare(a.id)
    })
    const priorSeen = new Set(prior?.seen ?? [])
    // THE FIRST PARK OF THIS THREAD ON THIS PR replays whatever is already there, once (maintainer
    // 2026-08-12, choosing this over merely showing it on the card). "Waiting on review" is a claim that
    // review has not arrived, and a worker that never read the PR makes that claim wrongly: one parked on
    // colinhacks/zod#6318 with two unaddressed reviews sitting on it, the old baseline recorded them as
    // handled, and the watcher slept on exactly what it was watching for. The trade is knowing and
    // accepted — a worker that DID answer its review gets one redundant wake, and the steer's backlog
    // tail tells it so — because being asleep on real review costs incomparably more.
    //
    // Once per (thread, PR), never once per park: see the introduction ledger for why that distinction
    // is the difference between a fix and a wake loop.
    const firstSight = !prior && !introduced.has(introducedKey(slug, ref))
    if (firstSight) markIntroduced(slug, ref)
    let fresh: GithubReviewActivity[]
    if (prior) {
      fresh = newestFirst.filter((a) => !priorSeen.has(a.id))
    } else if (firstSight) {
      fresh = newestFirst
    } else {
      // A review may land between the final fence and this scheduler's first poll (or while the server
      // is restarting before the baseline is persisted). The fence timestamp lets a brand-new grammar
      // distinguish that real post-fence activity from all pre-existing review history. If timestamp
      // telemetry is unavailable, baseline conservatively and wait for the next unseen id.
      const fenceMs = Date.parse(fenceAt ?? "")
      fresh = Number.isFinite(fenceMs)
        ? newestFirst.filter((a) => {
            const at = Date.parse(a.at ?? "")
            return Number.isFinite(at) && at > fenceMs
          })
        : []
    }
    // Persist the cursor BEFORE a possible resume. Union with the prior tail so a temporarily-shorter
    // API page cannot make an old id look new later; newest current ids win the bounded cap.
    if (fresh.length === 0) {
      saveReviewCursor(persistKey, hintKey, [...newestFirst.map((a) => a.id), ...(prior?.seen ?? [])])
      return undefined
    }
    // Enumerate the WHOLE burst, newest first so the cap keeps what matters most, then chronologically
    // for the steer — a conversation reads in the order it was written. Every id in `fresh` is about to
    // be marked seen, so a steer that named only `fresh[0]` silently discarded the rest.
    const named = fresh.slice(0, REVIEW_STEER_CAP)
    const omitted = fresh.length - named.length
    const chronological = [...named].reverse()
    saveReviewCursor(persistKey, hintKey, [...newestFirst.map((a) => a.id), ...(prior?.seen ?? [])], chronological, omitted)
    return {
      met: true,
      steer: activitySteer(chronological, ref, omitted, firstSight),
      reason: `${reviewReason(ref, chronological, omitted)}${firstSight ? " — already on the PR at park" : ""}`,
    }
  }

  function normalizeReviewResult(
    result: GithubReviewActivity[] | GithubReviewFetchResult | undefined,
  ): GithubReviewFetchResult {
    if (Array.isArray(result)) return { status: "ok", activity: result }
    return result ?? {
      status: "error",
      failure: { kind: "shape", message: "GitHub review fetcher returned no result" },
    }
  }

  function recordReviewFailure(key: string, slug: string, result: Extract<GithubReviewFetchResult, { status: "error" }>, at: number): void {
    const signature = `${result.failure.kind}:${result.failure.message}`
    const prior = reviewFailures.get(key)
    if (prior?.signature === signature && at - prior.loggedAt < 15 * 60_000) {
      prior.suppressed++
      return
    }
    const suppressed = prior?.suppressed ? ` (${prior.suppressed} identical repeats suppressed)` : ""
    log(`waker: GitHub review check failed for ${key} (${slug}) [${result.failure.kind}] — ${result.failure.message}${suppressed}`)
    reviewFailures.set(key, { signature, loggedAt: at, suppressed: 0 })
  }

  function recordReviewSuccess(key: string, slug: string): void {
    const prior = reviewFailures.get(key)
    if (!prior) return
    const suppressed = prior.suppressed ? `; ${prior.suppressed} identical repeats were suppressed` : ""
    log(`waker: GitHub review check recovered for ${key} (${slug})${suppressed}`)
    reviewFailures.delete(key)
  }

  async function evalThread(slug: string, sessionId: string, fence: FenceView, nowMs: number, fenceAt?: string): Promise<void> {
    const actionable = fence.hints.filter(isActionable)
    if (actionable.length === 0) {
      threads.delete(slug)
      return
    }
    const fenceId = fenceIdentity(fence.hints, fenceAt)
    const persistKey = firedKey(slug, fenceId)
    let st = threads.get(slug)
    if (!st || st.fenceId !== fenceId) {
      // A new/changed awaiting rest: drop the previous rest's persisted marker + arming, start fresh.
      if (st) {
        const oldKey = firedKey(slug, st.fenceId)
        forgetFired(oldKey)
        forgetRegistration(oldKey)
      }
      st = { fenceId, armed: new Map(), fired: false, lastPollAt: 0, prCache: new Map(), reviewCache: new Map() }
      const saved = registrations.get(persistKey)
      for (const h of actionable) {
        if (h.kind !== "timer") continue
        const hintKey = `${h.kind}:${h.value}`
        if (saved?.timers[hintKey] === h.value) st.armed.set(hintKey, true)
      }
      threads.set(slug, st)
    }
    if (fired.has(persistKey)) st.fired = true
    const deliveryId = wakeDeliveryId(slug, sessionId, fenceId)
    if (outbox.get(deliveryId)) st.fired = true
    if (st.fired) return // already queued/resumed for this rest — wait for delivery or fence supersession

    // Refresh PR statuses/review activity on the slow cadence (one fetch per distinct ref per kind).
    // LEGACY ONLY. `pr-watch` stopped being actionable on 2026-08-14 — the registry pass (SOURCE 11)
    // owns PR watching now — so nothing here can be a pr-watch hint any more, and both of these are
    // about the `pr:`/`ci:` spellings that pre-date it.
    const needsPr = actionable.some((h) => h.kind === "pr" || h.kind === "ci")
    const needsReview = actionable.some((h) => isPrWatchHint(h.kind))
    if ((needsPr || needsReview) && (st.lastPollAt === 0 || nowMs - st.lastPollAt >= pollMs)) {
      st.lastPollAt = nowMs
      const refs = new Map<string, PrRef>()
      const reviewRefs = new Map<string, PrRef>()
      // Which refs a legacy `pr:`/`ci:` VERDICT depends on. A `pr-watch:` ref is fetched too — its
      // check/merge status feeds the board's watched-PR rows and the queue rule that holds a thread out
      // of the queue while CI runs — but that reading is PRESENTATION, so a failed fetch for one of those
      // is silent. The card says "Checking…", the thread queues as usual, and nothing is lost. Logging it
      // would put a line on every poll of every parked PR, forever, for a thing nothing waits on.
      const verdictRefs = new Set<string>()
      for (const h of actionable) {
        const ref = parsePrRef(h.value)
        if (!ref) continue
        if (h.kind === "pr" || h.kind === "ci") { verdictRefs.add(refKey(ref)); refs.set(refKey(ref), ref) }
        if (isPrWatchHint(h.kind)) reviewRefs.set(refKey(ref), ref)
      }
      await Promise.all([
        ...[...refs].map(async ([k, ref]) => {
          try {
            const s = await fetchPr(ref)
            if (s) {
              st.prCache.set(k, s) // keep the last-known status on a transient failure
              publishGithubStatus(k, s, nowMs)
            } else if (verdictRefs.has(k)) {
              log(`waker: gh check skipped for ${k} (${slug}) — gh unavailable / not authed / rate-limited`)
            }
          } catch (err) {
            if (verdictRefs.has(k)) log(`waker: gh check errored for ${k} (${slug}): ${err instanceof Error ? err.message : String(err)}`)
          }
        }),
        ...[...reviewRefs].map(async ([k, ref]) => {
          try {
            const result = normalizeReviewResult(await fetchGithubReview(ref))
            if (result.status === "ok") {
              st.reviewCache.set(k, result.activity)
              recordReviewSuccess(k, slug)
            } else if (result.status === "error") {
              recordReviewFailure(k, slug, result, nowMs)
            }
            // `deferred` is the native fetcher's rate-budget guard. Keep the last-known cache and stay
            // silent; this is intentional pacing, not a GitHub failure.
          } catch (err) {
            recordReviewFailure(k, slug, {
              status: "error",
              failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
            }, nowMs)
          }
        }),
      ])
    }

    for (const h of actionable) {
      const key = `${h.kind}:${h.value}`
      const reviewRef = isPrWatchHint(h.kind) ? parsePrRef(h.value) : undefined
      const reviewActivity = reviewRef ? st.reviewCache.get(refKey(reviewRef)) : undefined
      const pendingReview = registrations.get(persistKey)?.reviews[key]?.pending
      const verdict = isPrWatchHint(h.kind)
        ? reviewActivity || pendingReview
          ? reviewVerdict(slug, persistKey, h, reviewActivity ?? [], fenceAt)
          : undefined
        : evalHint(h, nowMs, st.prCache, fence.body)
      if (!verdict) continue // indeterminate this tick
      if (!verdict.met) {
        st.armed.set(key, true) // WITNESSED unmet → this hint is now eligible to fire on a later met
        if (h.kind === "timer") armTimer(persistKey, key, h.value)
        continue
      }
      // PR-watch hints are eligible once a persisted baseline detects an unseen human id. Timer/legacy
      // conditions still require arming; for timers that arming was restored from durable registration.
      if (!isPrWatchHint(h.kind) && !st.armed.get(key)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug,
        sessionId,
        fenceId,
        hintKey: key,
        message: verdict.steer,
        reason: verdict.reason,
      }, nowMs).delivery
      st.fired = true
      // "PR watcher armed": if the human parked this pr-watch card with a user snooze, new PR
      // activity is exactly the thing it was hiding UNTIL — so clear the snooze here, the moment we
      // enqueue the wake, and the card re-surfaces in the queue (the preset instant was only a safety
      // timeout). A no-op when nothing was snoozed. Scoped to pr-watch: a human/timer park is a
      // deliberate hold this activity signal has no business clearing.
      if (isPrWatchHint(h.kind)) deps.storage.setSnoozedUntil(slug, null)
      log(`waker: queued ${slug} — ${verdict.reason}`)
      checkpoint("after-enqueue", item)
      return // one durable wake per thread per rest
    }
  }

  // ---- The limit auto-resume pass ------------------------------------------------------------------
  // Every non-archived thread whose tail still carries a limit fault and has come to rest. `turn` must
  // be idle: a thread that has already started moving again was resumed by someone else, and stepping
  // on a live turn is exactly what the fence path refuses to do too.
  interface LimitCandidate {
    slug: string
    sessionId: string
    backend: "claude" | "codex"
    fault: LimitFault
  }
  function limitCandidates(nowMs: number): LimitCandidate[] {
    const out: LimitCandidate[] = []
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      const fault = tele?.limitFault
      if (!fault || tele?.turn !== "idle") continue
      // The boot guard, and the same age policy the board renders — so a card never promises a wake
      // the waker has already written off.
      if (limitPauseIsStale(fault.window, Date.parse(fault.at), nowMs)) continue
      out.push({
        slug: row.slug,
        sessionId: row.session_id,
        backend: row.backend === "codex" ? "codex" : "claude",
        fault,
      })
    }
    return out
  }

  // The wall each thread has already spent its ONE early (account-headroom) resume on — see the guard
  // in limitRecovered. Keyed by slug, valued by limitFaultResetKey.
  //
  // The headroom trigger reads the ACCOUNT while the wall belongs to the THREAD's own process, so when
  // an early resume bounces off that wall the trigger's premise is untouched: the account still shows
  // headroom, so it fires again, and again. Each bounce writes a new fault, whose new `at` mints a new
  // fence id, so the once-per-interruption dedupe in evalLimits never bites either. Live on 2026-07-30
  // that ran every 2 minutes (exactly LIMIT_HEADROOM_MIN_FAULT_AGE_MS) for half an hour and buried a
  // worker's transcript under 184 limit records — a self-inflicted context burn on a thread that was
  // already stuck.
  //
  // In memory on purpose: a frizz restart costs one extra attempt per thread, and a durable table for a
  // guard this cheap would be a migration in exchange for nothing.
  const spentEarlyResume = new Map<string, string>()

  // Has this fault's window come back? Two independent triggers, whichever fires first:
  //   (1) the ORIGINAL window RESET — its own reset clock (5-hour session: exact, local, free) or, for a
  //       weekly whose text carries no date, the endpoint's window-identity roll.
  //   (2) quota FREED UP on the current account — the blown window now reads below the headroom floor,
  //       so a fresh sign-in or a raised cap made room even though the original clock hasn't passed
  //       (guarded by the floor + min-fault-age; see LIMIT_RESUME_HEADROOM_PERCENT).
  // `undefined` = indeterminate: wait for a later tick rather than guessing, since guessing "recovered"
  // resumes the fleet into a wall.
  function limitRecovered(
    c: LimitCandidate,
    quota: QuotaSnapshot | undefined,
    nowMs: number,
  ): boolean | undefined {
    const faultAtMs = Date.parse(c.fault.at)
    const provider = quota?.[c.backend]

    // (2) Account-availability: the blown window is no longer near-full on the signed-in account. Only
    // trusted once the fault is old enough that a warmed reading necessarily post-dates it (so we read a
    // real recovery, not a stale pre-fault value) and only when the window sits below the floor (so
    // jitter near 100% can't resume the fleet straight back into the wall).
    if (provider?.status === "ok" && Number.isFinite(faultAtMs) && nowMs - faultAtMs >= LIMIT_HEADROOM_MIN_FAULT_AGE_MS) {
      const key = quotaWindowKeyFor(c.fault.window)
      const w = key ? provider.windows.find((x) => x.key === key) : undefined
      const wall = limitFaultResetKey(c.fault)
      // One early resume per wall. A second fault naming the same reset instant is this thread bouncing
      // off the same wall, not a new interruption, so it gets no second attempt — it waits for trigger
      // (1), its own clock, below.
      if (w && typeof w.usedPercent === "number" && w.usedPercent <= LIMIT_RESUME_HEADROOM_PERCENT && spentEarlyResume.get(c.slug) !== wall) {
        spentEarlyResume.set(c.slug, wall)
        return true
      }
    }

    // (1) Original-window reset. Text first — exact, local, free, covers the common 5-hour session case.
    const textAt = c.fault.resetClock
      ? textResetInstant({ window: c.fault.window, resetClock: c.fault.resetClock }, faultAtMs)
      : undefined
    if (textAt !== undefined) return nowMs >= textAt + LIMIT_RESUME_GRACE_MS
    if (!provider || provider.status !== "ok") return undefined
    const rolled = quotaWindowRecovered(provider.windows, c.fault.window, faultAtMs, nowMs)
    if (rolled !== true) return rolled
    return nowMs >= faultAtMs + LIMIT_RESUME_GRACE_MS
  }

  async function evalLimits(nowMs: number): Promise<void> {
    const candidates = limitCandidates(nowMs)
    if (candidates.length === 0) return
    // Read the quota-warmed usage snapshot. The account-availability trigger needs it for EVERY
    // candidate — a session limit included, now that a fresh sign-in or raised cap can free it before
    // its own clock — and the weekly window-roll check needs it too. This is a cached read (the server
    // keeps it warm on its own cadence), so a fleet parked on a limit doesn't hammer the endpoint.
    let quota: QuotaSnapshot | undefined
    if (deps.readQuota) {
      try {
        quota = await deps.readQuota()
      } catch (err) {
        log(`waker: quota read failed while checking limit resumes: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const c of candidates) {
      const fenceId = limitFenceId(c.fault)
      const deliveryId = wakeDeliveryId(c.slug, c.sessionId, fenceId)
      if (outbox.get(deliveryId)) continue // this interruption already has its one wake
      if (limitRecovered(c, quota, nowMs) !== true) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: c.slug,
        sessionId: c.sessionId,
        fenceId,
        hintKey: `${LIMIT_HINT_PREFIX}${c.fault.window}`,
        message: limitResumeSteer(c.fault.window),
        reason: `${c.fault.window} usage limit reset (interrupted ${c.fault.at})`,
      }, nowMs).delivery
      log(`waker: queued ${c.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The dropped-report repair pass --------------------------------------------------------------
  // `turn === "idle"` is not a courtesy here, it is the CORRECTNESS condition. The runtime hands a
  // queued notification to the model at a turn boundary, so while a turn is in flight the report may
  // still be about to arrive and a repair would be a lie. Once the agent has come to rest without it,
  // the delivery that was going to happen already didn't.
  function repairDroppedReports(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      const dropped = tele?.droppedReports
      if (!dropped?.length || tele?.turn !== "idle") continue
      // No cap and no ordering games: the watermark in completion-relay.ts means only completions
      // dropped during THIS process are eligible, so the due set is the handful a live thread actually
      // lost — not the hundreds of historical drops sitting in a long transcript.
      for (const report of completionsDueForRelay(dropped, { nowMs, atRest: true })) {
        const fenceId = reportFenceId(report.taskId)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue // this report already has its one repair
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: `${REPORT_HINT_PREFIX}${report.taskId}`,
          message: relayMessage(report),
          reason: `sub-agent report never reached the model (${report.summary ?? report.taskId})`,
        }, nowMs).delivery
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
      }
    }
  }

  // ---- The user-snooze bump pass -------------------------------------------------------------------
  // Deliberately does NOT filter on `turn === "idle"` the way the fence pass does. A snooze deadline is
  // a promise to the human, so a thread that happens to be mid-turn when it crosses must not LOSE its
  // follow-up — the delivery gate below holds the item until the thread comes to rest instead.
  //
  // Unlike an unregistered legacy timer, an overdue snooze found at boot DOES fire: the DB row is
  // itself the durable registration, so a deadline that crossed while frizz was down is exactly the case
  // this is meant to honor. The blast radius stays bounded by the handful of threads a human snoozed.
  function evalSnoozes(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedSnooze(row)
      if (!armed || armed.untilMs > nowMs) continue
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, armed.fenceId)
      if (outbox.get(deliveryId)) continue // this snooze already has its one wake
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId: armed.fenceId,
        hintKey: `${SNOOZE_HINT_PREFIX}${armed.until}`,
        message: armed.prompt,
        reason: `snooze elapsed (${armed.until})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The one-off TIMER pass ----------------------------------------------------------------------
  // One indexed read for every due alarm on every thread, rather than the row-per-session walk the other
  // passes do: timers live in their own table precisely because a thread may hold many, and most threads
  // hold none.
  //
  // Like the snooze pass, an alarm that came due while frizz was DOWN still fires when it comes back —
  // the row is its own durable registration, and "you asked to be woken at 15:00" does not stop being
  // true because the server restarted at 14:59. Unlike the snooze pass, it does not wait for rest.
  // ---- SOURCE 9: THE BUILT-IN SIGN-OFF NUDGE ---------------------------------------------------
  // Frizz's own stop hook. Always on, not disableable per-thread, and invisible in the UI — orthogonal
  // to the operator's Goal, which keeps its own three triggers.
  //
  // THE PER-THREAD OFF SWITCH WAS TRIED AND REVERTED (2026-08-13 → 2026-08-14): the Goal's AUTONOMOUS
  // MODE silenced this for a day, on the argument that a thread told to keep going should not also be
  // handed a menu of ways to stop. What killed it is that the reminder no longer IS that menu — it opens
  // by sending a half-finished thread back to the work — and that suppressing it took the
  // ```awaiting park with it, which nothing else on that thread's deliveries names.
  // The maintainer's 2026-08-12 call stands: keep it separate from the Goal, enabled all the time, and
  // pay the one extra transcript record.
  //
  // It fires on a rest that carried NO FENCE AT ALL, and its message is the sign-off protocol itself.
  // The rules therefore arrive at the one moment they are about to be used, rather than 200k tokens
  // earlier in a system prompt the agent stopped attending to (maintainer 2026-08-11: "the agent seems
  // to often forget about this stuff when it's added to the additional system prompt anyway"). A thread
  // that signs off correctly never sees it, so the mechanism costs nothing except on exactly the rests
  // that were about to produce an item nobody can triage.
  //
  // THE CAP IS CONSECUTIVE AND IT IS NOT OPTIONAL. An agent that rests bare, is told how to sign off,
  // and rests bare again would otherwise be told forever — a nag loop frizz itself generates. After
  // SIGNOFF_NUDGE_MAX in a row with no fence appearing, it gives up and the item sits in the queue as a
  // plain bare rest, which is exactly today's behaviour.
  //
  // ONLY A FENCE GIVES THE ALLOWANCE BACK. This used to say a new word from the HUMAN did too, on the
  // reasoning that their message is a new task and the count was about the old one — but that was written
  // before the delivery-id fix below, and the code has never done it. It cannot: frizz's own nudge lands
  // as a USER record, so "the human spoke" is a condition the nudge satisfies by nudging, which is the
  // 22-deliveries-in-four-minutes loop that fix exists to close. The consequence is worth stating plainly
  // rather than leaving as a footnote — on a thread with a Goal armed, two bare rests exhaust this
  // permanently, and everything after is the Goal alone.
  //
  // TOP-LEVEL THREADS ONLY — a sub-agent's final message is a report to its parent, not a queue item.
  // That falls out of this pass reading session rows, which sub-agents do not have.
  function evalSignoffNudges(nowMs: number): void {
    if (deps.storage.getSetting(SIGNOFF_NUDGE_SETTING) === "off") return
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      // THE AGENT MUST HAVE SPOKEN LAST, and this is the load-bearing guard rather than a nicety.
      //
      // Frizz's own delivery lands in the transcript as a USER record, so it advances `lastActivityAt`
      // AND `lastUserAt`. Keying on either meant the nudge minted a fresh delivery id for a rest that
      // had not happened, and reset its own consecutive counter with its own message: measured on a real
      // stack, 22 deliveries in four minutes to one thread. The cap could not save it, because the thing
      // being counted was resetting the count.
      //
      // `lastAssistantAt > lastUserAt` is the honest question — did the AGENT end the exchange? — and it
      // is immune to anything frizz says, because frizz only ever speaks as the user. A thread whose last
      // word is frizz's own nudge is a thread that has not answered it yet.
      const spokeAt = tele.lastAssistantAt
      if (!spokeAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(spokeAt)) continue
      // Same trap as the stop hook's: a signed-out provider answers instantly, so the failure LOOKS like
      // a fenceless rest and satisfies every guard above. Teaching it to sign off cannot help — it never
      // reached the model.
      if (tele.authFault) continue
      // ANY fence means the thread already said where it stands — including `awaiting`, which is still
      // a legitimate sign-off until the registry replaces it. Nothing to teach, AND the allowance comes
      // back: signing off is the only event that proves the nudge worked, and the only one frizz cannot
      // cause by nudging. (Guarded on a non-zero count in storage, so this is a transition, not a write
      // on every tick.)
      if (tele.lastFence || tele.pendingQuestion) {
        if ((row.signoff_nudges ?? 0) > 0) deps.storage.resetSignoffNudges(row.slug)
        continue
      }
      // A native ask is a question by another route: the thread is frozen on a modal the human has to
      // answer, and telling it to write a ```question fence is telling it to do what it already did.
      if (tele.pendingAsk || tele.permPrompt) continue
      // The sentinel still ends the arrangement for sessions that predate the fence (see `saidDone`).
      if (tele.lastAssistantAllDone) continue
      // IT DOES NOT YIELD TO THE GOAL, and that is a deliberate reversal (maintainer 2026-08-12: "we
      // should keep it separate from goal… It should just be enabled all the time"). The reminder used
      // to ride the Goal's at-rest trailer so a rest produced one delivery instead of two — but that
      // made the protocol a thing a thread only learned if an operator had armed a Goal, and put a copy
      // of it in the trailer, which is its own kind of repetition. It is frizz's own hook now: identical
      // on every thread, whatever the operator has configured. The second delivery costs one transcript
      // record, collapsed to a hairline by the chat.
      // NO AUTONOMOUS-MODE EXEMPTION HERE — see the SOURCE 9 header for the day it had one.
      // THE CONSECUTIVE CAP. It counts fenceless rests and is cleared ONLY by a fence (above) — never by
      // a user record, because frizz's own delivery is one, and anchoring on that let the nudge reset its
      // own counter with its own message.
      if ((row.signoff_nudges ?? 0) >= SIGNOFF_NUDGE_MAX) continue
      const fenceId = signoffFenceId(spokeAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Bound to the AGENT'S OWN last word, so one nudge per rest falls out of delivery-id uniqueness.
      // Deliberately NOT `lastActivityAt`, which frizz's own delivery advances — see the guard above.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: SIGNOFF_HINT_KEY,
        // The reminder plus THIS THREAD's live ops and their ids, so the agent can write a correct
        // `watch:` line without going looking for an id it cannot see. Shells are named by `taskId` —
        // the handle the runtime actually showed the worker — because that is the string it will
        // naturally reach for, and the one the fence's own integrity check matches on.
        message: signoffNudgeMessage({
          shells: (tele.bgShells ?? []).filter((sh) => sh.state === "running").map((sh) => ({ id: sh.taskId ?? sh.id, label: sh.label })),
          subAgents: (tele.subAgents ?? []).filter((a) => a.state === "running").map((a) => ({ id: a.id, label: a.label })),
        }),
        reason: "rested without signing off",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Count a delivered nudge, anchored to the human's last word — the storage write decides reset vs
  // increment by comparing that anchor against the row's own.
  function settleSignoffNudge(item: WakeDelivery): void {
    if (!isSignoffFenceId(item.fenceId)) return
    // Anchored on the REST this nudge was for (the agent's own last word, which is the fence id), so a
    // retry of the same delivery cannot count twice while a genuinely new fenceless rest does.
    deps.storage.countSignoffNudge(item.slug, item.fenceId)
  }

  // ---- SOURCE 11: THE REGISTERED PR WATCHERS ------------------------------------------------------
  // A worker registers a pull request with `mcp__frizz__watch_pr` and frizz brings it back whenever
  // something happens on it (maintainer 2026-08-14: "The agent should have a tool to register a PR
  // watcher… it should get notified when CI either succeeds or failed and on follow-up reviews and
  // comments").
  //
  // IT REPORTS REPEATEDLY, which is what makes it unlike every other source here. A timer rings once and
  // is spent; this one stays armed across CI going red, a fix, CI going green and a reviewer's comment —
  // four wakes from one registration. So the delivery id carries a REPORT NUMBER: keyed on the watcher
  // id alone, the outbox would dedupe every wake after the first and the watcher would look broken from
  // the second event onward.
  //
  // ONLY A CHANGE FIRES. The cursor holds what has already been reported — the review activity ids, and
  // the last check verdict announced — so a poll that finds the same red CI and the same three comments
  // says nothing. A watcher that re-reported its own last message on every tick is a nag loop with an
  // API bill.
  //
  // THE FENCE IS NOT CONSULTED HERE, deliberately. Registration is a tool call and watching is a fact;
  // the ```awaiting fence separately STATES what the thread waits on, and a thread with no fence at all
  // is woken exactly the same way.
  interface PrWatchCursor { seen: string[]; checks?: string; report?: number }
  const prWatchPolledAt = new Map<string, number>() // refKey → last fetch, shared across threads

  function readPrWatchCursor(raw: string | null): PrWatchCursor {
    try {
      const parsed = raw ? JSON.parse(raw) : null
      if (!parsed || typeof parsed !== "object") return { seen: [] }
      const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((x: unknown): x is string => typeof x === "string") : []
      return { seen, checks: typeof parsed.checks === "string" ? parsed.checks : undefined, report: Number(parsed.report) || 0 }
    } catch {
      return { seen: [] }
    }
  }

  async function evalPrWatches(nowMs: number): Promise<void> {
    const armed = deps.storage.armedPrWatches()
    if (armed.length === 0) return
    // ONE FETCH PER PR, however many threads watch it. Two workers on the same PR is the ordinary shape
    // of a review round, and paying GitHub twice for one answer is how a rate limit arrives.
    const refs = new Map<string, PrRef>()
    for (const w of armed) {
      const key = `${w.owner}/${w.repo}#${w.number}`
      const last = prWatchPolledAt.get(key) ?? 0
      if (nowMs - last < PR_WATCH_POLL_MS) continue
      refs.set(key, { owner: w.owner, repo: w.repo, number: w.number })
    }
    const status = new Map<string, GithubWatchStatus>()
    const activity = new Map<string, GithubReviewActivity[]>()
    await Promise.all([...refs].map(async ([key, ref]) => {
      prWatchPolledAt.set(key, nowMs)
      try {
        const pr = await fetchPr(ref)
        if (pr) {
          status.set(key, githubWatchStatus(pr, new Date(nowMs).toISOString()))
          publishGithubStatus(key, pr, nowMs)
        }
      } catch (err) {
        log(`waker: pr-watch status fetch failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        const result = normalizeReviewResult(await fetchGithubReview(ref))
        if (result.status === "ok") {
          activity.set(key, result.activity)
          // RECOVERY IS SAID OUT LOUD, and it also clears the suppression counter. Without this the
          // failure entry for a ref lives forever, so a PR that failed once and then healed keeps
          // suppressing its own diagnostics and the operator is never told the outage ended.
          recordReviewSuccess(key, "pr-watch registry")
        } else if (result.status === "error") recordReviewFailure(key, "pr-watch registry", result, nowMs)
      } catch (err) {
        recordReviewFailure(key, "pr-watch registry", {
          status: "error",
          failure: { kind: "network", message: err instanceof Error ? err.message : String(err) },
        }, nowMs)
      }
    }))

    for (const w of armed) {
      const row = deps.storage.getSession(w.thread_slug)
      // No thread, or a shelved one: nothing to wake. The row is left ARMED rather than settled — an
      // archived thread can be reopened, and the watch is still the worker's own outstanding intent.
      if (!row || row.state === "archived" || row.archived === 1) continue
      const key = `${w.owner}/${w.repo}#${w.number}`
      const st = status.get(key)
      const acts = activity.get(key)
      if (!st && !acts) continue // nothing fetched for this PR this tick
      const cursor = readPrWatchCursor(w.cursor)

      // A MERGED OR CLOSED PR ends the watch. Report it once, then settle: there is nothing further to
      // say, and an armed row on a finished PR is a poll that can never produce another wake.
      if (st && st.state !== "open") {
        deps.storage.settlePrWatch(w.id, nowMs)
        enqueuePrWatchWake(row, w.id, nextReport(cursor), prWatchWakeMessage({
          target: key, merged: st.state === "merged", closed: st.state === "closed",
        }), `pr-watch ${key} ${st.state}`, nowMs)
        continue
      }

      // CI reaching a TERMINAL verdict, and only on the transition to it. `running` and `none` are not
      // news; going from either to green or red is the whole reason CI is watched.
      const terminal = st && (st.checks === "passing" || st.checks === "failing") ? st.checks : undefined
      const checksChanged = terminal !== undefined && cursor.checks !== terminal
      // NEW review activity, against everything already reported. On the FIRST poll there is nothing
      // reported yet, so the baseline is the REGISTRATION INSTANT: a worker registers when it opens or
      // pushes a PR, so anything already there is its own news and telling it would spend a turn — while
      // anything arriving in the up-to-60s before the first poll is real and must not be swallowed.
      // (Registering on an OLD PR is the same rule read the other way: the review you never read is
      // yours to go and read, and only what lands afterwards is a wake.)
      const seen = new Set(cursor.seen)
      const firstPoll = w.cursor === null
      // NEWEST FIRST, and it is load-bearing twice over: the cap must keep the items that matter MOST,
      // and the steer must then read in the order the conversation was written. The fetcher's own order
      // is neither — `parseGithubReviewActivities` returns every review, then every comment — so slicing
      // its front would enumerate a burst out of order AND, past the cap, drop the newest activity while
      // keeping the oldest. Same three lines as the fence path this replaced, for the same reasons.
      const newestFirst = [...(acts ?? [])].sort((a, b) => {
        const at = Date.parse(b.at ?? "") - Date.parse(a.at ?? "")
        return Number.isFinite(at) && at !== 0 ? at : b.id.localeCompare(a.id)
      })
      const fresh = newestFirst.filter((a) => {
        if (seen.has(a.id)) return false
        if (!firstPoll) return true
        const landed = Date.parse(a.at ?? "")
        return Number.isFinite(landed) && landed > w.created_at
      })
      const named = fresh.slice(0, REVIEW_STEER_CAP)
      const reviewSteer = fresh.length > 0
        ? formatGithubWakeSteer({
          ref: key,
          omitted: fresh.length - named.length,
          items: [...named].reverse().map((a) => ({
            label: activityLabel(a),
            actor: a.actor,
            bot: isBotGithubActor(a),
            ...(a.at ? { at: a.at } : {}),
            ...(a.url ? { url: a.url } : {}),
          })),
        })
        : undefined

      const nextCursor: PrWatchCursor = {
        seen: acts ? [...new Set([...cursor.seen, ...acts.map((a) => a.id)])].slice(-REVIEW_SEEN_CAP) : cursor.seen,
        checks: terminal ?? cursor.checks,
        report: cursor.report ?? 0,
      }
      if (!checksChanged && !reviewSteer) {
        // Nothing to say, but the baseline moved: record what was seen so the FIRST poll's backlog is
        // never re-reported, and so a later comment is measured against today rather than against the
        // registration.
        if (JSON.stringify(nextCursor) !== JSON.stringify(cursor)) {
          deps.storage.setPrWatchCursor(w.id, JSON.stringify(nextCursor))
        }
        continue
      }
      // "PR watcher armed": if the human parked this thread's card with a user snooze, news on the PR is
      // exactly the thing it was hiding UNTIL — so clear it here, the moment we enqueue, and the card
      // re-surfaces. A no-op when nothing was snoozed. (Ported from the fence poller this replaced.)
      deps.storage.setSnoozedUntil(row.slug, null)
      const report = nextReport(cursor)
      enqueuePrWatchWake(row, w.id, report, prWatchWakeMessage({
        target: key,
        ...(checksChanged && terminal
          ? { checks: { verdict: terminal, passed: st!.passed, failed: st!.failed, failing: st!.failing } }
          : {}),
        ...(reviewSteer ? { review: reviewSteer } : {}),
      }), `pr-watch ${key}${checksChanged ? ` CI ${terminal}` : ""}${reviewSteer ? " review" : ""}`, nowMs)
      deps.storage.setPrWatchCursor(w.id, JSON.stringify({ ...nextCursor, report }))
    }
  }

  /** The next report number for a watcher — ONE derivation, used both for the delivery id and for the
   *  cursor that records it. They were computed separately at two call sites and had to be kept in step
   *  by hand, which is a silent double-report waiting to happen. */
  function nextReport(cursor: { report?: number }): number {
    return (cursor.report ?? 0) + 1
  }

  function enqueuePrWatchWake(
    row: SessionRow,
    watchId: string,
    report: number,
    message: string,
    reason: string,
    nowMs: number,
  ): void {
    const fenceId = prWatchFenceId(watchId, report)
    const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
    if (outbox.get(deliveryId)) return
    const item = outbox.enqueue({
      id: deliveryId, slug: row.slug, sessionId: row.session_id, fenceId,
      hintKey: `${PR_WATCH_FENCE_PREFIX}:${watchId}`, message, reason,
    }, nowMs).delivery
    log(`waker: queued ${row.slug} — ${item.reason}`)
    checkpoint("after-enqueue", item)
  }

  // ---- SOURCE 10: A BACKGROUND SHELL FINISHED WHILE ITS AGENT WAS RESTING -------------------------
  // AUTOMATIC, for every thread, with nothing to register and nothing to declare. Maintainer 2026-08-14:
  // "the agent just uses the built-in tool from the harness to start a background shell. It should be
  // watched automatically: every time a background shell completes, the agent should be woken up. That's
  // how it should always work."
  //
  // It is not redundant with the runtime's own notification, and the split is the entire reason this
  // exists. Measured over this machine's whole session history (3972 shells): all 3011 delivered
  // notifications landed on an assistant record with stop_reason "tool_use" — i.e. MID-TURN — while 1601
  // shells outlived their worker's rest and 1191 of those were never delivered at all, though the session
  // provably kept writing for minutes to days afterwards. The runtime covers the running turn; this
  // covers the rest, and only the rest.
  //
  // WHICH IS EXACTLY WHAT `finishedAt` DECIDES. A shell that finished BEFORE the agent's last word was
  // reported to it by the runtime and folded into that turn; waking again would tell it twice. A shell
  // that finished AFTER it has nobody to tell. So the test is `finishedAt > lastAssistantAt`, and a
  // retirement carrying no instant (an older tail state) never fires — the safe direction.
  //
  // THE AWAITING FENCE HAS NOTHING TO DO WITH THIS. It does not register the wait and never did; it is
  // how an agent comes to REST and states what it is waiting on (see hasDeclaredBackgroundPark). A
  // thread with no fence at all is woken here exactly the same way, which is the point.
  function evalShellCompletions(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele) continue
      // AT REST ONLY. Mid-turn the runtime's own notification is the delivery, and frizz adding a second
      // one would land while the agent is still working — the noise this pass exists to avoid.
      if (tele.turn !== "idle") continue
      // A signed-out provider answers in milliseconds and every reply is a "rest", which makes it a
      // perfect loop generator for anything that re-prompts. Same guard as SOURCES 5 and 9.
      if (tele.authFault) continue
      const restedAt = Date.parse(tele.lastAssistantAt ?? "")
      if (!Number.isFinite(restedAt)) continue
      for (const shell of tele.retiredShells ?? []) {
        const finishedAt = Date.parse(shell.finishedAt ?? "")
        if (!Number.isFinite(finishedAt) || finishedAt <= restedAt) continue
        const fenceId = shellFenceId(shell.id)
        const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
        if (outbox.get(deliveryId)) continue // this shell has already had its one wake
        const item = outbox.enqueue({
          id: deliveryId,
          slug: row.slug,
          sessionId: row.session_id,
          fenceId,
          hintKey: `${SHELL_FENCE_PREFIX}:${shell.id}`,
          message: shellDoneMessage(shell),
          reason: `background shell finished (${shell.taskId ?? shell.label})`,
        }, nowMs).delivery
        log(`waker: queued ${row.slug} — ${item.reason}`)
        checkpoint("after-enqueue", item)
        return // one durable wake per thread per pass; the next tick takes the next shell
      }
    }
  }

  function evalTimers(nowMs: number): void {
    for (const timer of deps.storage.dueThreadTimers(nowMs)) {
      const row = deps.storage.getSession(timer.thread_slug)
      // No thread, or a shelved one: nothing to wake. The row is left armed rather than settled — an
      // archived thread can be reopened, and the alarm is still the worker's own outstanding intent.
      if (!row || row.state === "archived" || row.archived === 1) continue
      const fenceId = timerFenceId(timer.id)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue // this alarm already has its one wake
      const fireAt = new Date(timer.fire_at).toISOString()
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: `${TIMER_HINT_PREFIX}${timer.id}`,
        message: timerPromptMessage(timer.prompt, fireAt),
        reason: `one-off timer elapsed (${fireAt})`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Settle the timer a wake came from — the row's OWN "never again" record, which outlives the pruning
  // of the terminal outbox row that would otherwise dedupe it.
  //
  // Called from every terminal path EXCEPT SUPERSESSION, which is the one distinction that matters here.
  // A timer supersedes for two reasons: its row already left `armed` (the worker cancelled it, or a
  // previous attempt settled it) — where this would be a no-op anyway, since the write is guarded on
  // `armed` — or the SESSION moved underneath the queued delivery. In that second case the alarm has not
  // rung and the thread still exists, so leaving the row armed is what lets the next tick re-queue it
  // against the current session. Settling there would silently swallow the alarm mid-resume.
  //
  // A delivery that exhausted its attempts or was abandoned DOES settle: it has had its one shot, and an
  // alarm resurrected days later when the outbox prunes is worse than one that failed.
  function settleTimer(item: WakeDelivery): void {
    if (!isTimerFenceId(item.fenceId)) return
    deps.storage.markThreadTimerFired(timerIdOf(item.fenceId), now())
  }

  // ---- The ON SCHEDULE pass -----------------------------------------------------------------
  // Like the snooze pass, this does NOT filter on `turn === "idle"`. Unlike the snooze pass, the
  // delivery gate does not hold the result either: a beat due mid-turn goes out mid-turn
  // (`isDeliverableNow`). Being able to reach a thread that is NOT going quiet is the whole point —
  // it is exactly what Claude Code's own cron cannot do (see SOURCE 4 above).
  //
  // At most ONE beat is ever outstanding per thread: a new one is queued only when the previous has
  // reached a terminal state, and the beat clock runs from the last DELIVERED beat. So an interval that
  // elapses while an undelivered beat is still open is skipped rather than stacked — a thread cannot
  // accumulate a backlog and then be handed all of it at once.
  function evalSchedulePrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedSchedule(row)
      if (!armed || armed.dueAtMs > nowMs) continue
      // The ONE thing that silences a beat. Everything else about this source is unconditional — rest,
      // sub-agents, shells, all irrelevant — but a worker that has said there is no further work has
      // ended the arrangement, and a "permanently stalled" run that keeps being woken every interval is
      // not stalled at all. Needs no stored state: the flag is folded off the FINAL assistant message,
      // so anything the thread says or receives afterwards reopens it.
      const beatTele = deps.tailer.get(row.slug)
      if (beatTele && saidDone(beatTele)) continue
      // The OPERATOR's hold — the only other thing that silences a beat, and only because they asked
      // for it. The hard rest-fence rule deliberately does NOT apply here: a beat asks "it has been an
      // hour", which a pending question does not answer.
      if (heldByQuestion(row, beatTele)) continue
      // One in flight at a time. Any open scheduled delivery for this thread — whatever its
      // generation — means the previous beat has not landed yet, so this interval is skipped rather
      // than stacked behind it.
      if (openSchedulePrompt(row.slug, row.session_id)) continue
      const beat = beatIndex(row.recurring_schedule_fired_at ?? null, armed)
      const fenceId = heartbeatFenceId(armed.armedAt, beat)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: `${HEARTBEAT_HINT_PREFIX}${armed.intervalMs}`,
        message: schedulePromptMessage(armed.prompt, Math.round(armed.intervalMs / 1000)),
        reason: `recurring prompt every ${Math.round(armed.intervalMs / 1000)}s`,
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Is a beat for this thread still open (pending/leased)? Scanning the open set is cheap — the outbox
  // holds only live work — and it is the one check that makes "at most one beat outstanding" true
  // across restarts, since it reads the durable rows rather than in-memory arming.
  function openSchedulePrompt(slug: string, sessionId: string): boolean {
    return outbox.listOpen().some(
      (item) => item.slug === slug && item.sessionId === sessionId && isHeartbeatFenceId(item.fenceId),
    )
  }

  // A monotonic-enough beat number so consecutive beats get distinct delivery ids. Derived from elapsed
  // intervals rather than a stored counter: the row already carries everything needed, and a delivery
  // id only has to be unique per (session, generation), not meaningful.
  function beatIndex(lastFiredAt: string | null, armed: ArmedSchedule): number {
    const armedMs = Date.parse(armed.armedAt)
    const lastMs = Date.parse(lastFiredAt ?? armed.armedAt)
    if (!Number.isFinite(armedMs) || !Number.isFinite(lastMs)) return 0
    return Math.max(0, Math.round((lastMs - armedMs) / armed.intervalMs)) + 1
  }

  // Stamp the beat clock once a beat has genuinely REACHED the worker, so the next one is due an
  // interval after it actually landed. Called only from the three settle points that mean delivery
  // happened (acknowledged, or confirmed by the wake token in the transcript) — deliberately NOT from
  // the superseded/exhausted/abandoned ones the snooze settles on. A beat dropped because the human
  // pressed pause, or one that exhausted its attempts, never fired, and advancing the clock for it
  // would silently swallow the next interval.
  //
  // Guarded on the generation for the same reason as the snooze: a beat that settles after the worker
  // re-armed or switched off the trigger must not write a schedule onto settings it no longer describes.
  function settleSchedulePrompt(item: WakeDelivery): void {
    if (!isHeartbeatFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${HEARTBEAT_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringScheduleFired(item.slug, armedAt, new Date().toISOString())
  }

  // ---- The ON REST pass -----------------------------------------------------------------------
  // Unlike every other pass here this one DOES filter on `turn === "idle"`, because rest is not a
  // deadline it can queue against — it IS the trigger. Queueing a bump for a busy thread would bind it
  // to an activity stamp that is still moving, and the delivery gate would then supersede it on the
  // very next line the worker wrote.
  function evalRestPrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedRest(row)
      if (!armed) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue
      // THE AGENT MUST HAVE SPOKEN LAST. `turn === "idle"` alone is not "the agent rested": a thread
      // whose worker is gone is idle forever, and frizz's own bump keeps landing in its transcript. This
      // is the guard that makes the trigger mean "you stopped" rather than "nothing is happening" — see
      // `stopHookFenceId`. It costs the feature nothing: an agent that genuinely takes a turn and rests
      // again produces a NEW assistant timestamp, which is exactly when the Goal should fire.
      const restedAt = tele.lastAssistantAt
      if (!restedAt) continue
      if (tele.lastUserAt && Date.parse(tele.lastUserAt) >= Date.parse(restedAt)) continue
      // A SIGNED-OUT PROVIDER ANSWERS INSTANTLY, and that is a loop this trigger cannot see any other
      // way. The worker replies "Not logged in · Please run /login" in milliseconds, which is a genuine
      // new assistant message and therefore a genuine new rest — so every guard above is satisfied and
      // the bump fires again, ten times in a hundred seconds (measured 2026-08-12). Nothing the operator
      // has not done can change the outcome, so re-prompting is pure burn: the thread already cards its
      // auth fault and the sign-in recovery in the queue.
      if (tele.authFault) continue
      // WHAT THIS DELIBERATELY DOES NOT CONSULT: live sub-agents and background shells. A hold on them
      // shipped briefly and was removed the same day (maintainer 2026-08-02: "the status of any
      // sub-agents or background shells is irrelevant"). The SCHEDULE trigger is the whole rate story — a
      // thread parked behind children is bumped on the same schedule as any other, which is also what
      // makes this able to rescue one parked behind a child that will never report. A worker that
      // genuinely has nothing to do until something returns says AWAITING — and an AWAITING naming a
      // wait the scheduler itself will fire is honoured, not bumped (`parkedOnAWaitItCannotAdvance`).
      // THE REST ALREADY ANSWERED THIS TRIGGER'S QUESTION — the thread signed off as done, parked on a
      // wait it cannot advance by working, or asked the human something while still in a mode that waits
      // for the human. The first two hold whatever the settings say; the question limb is the one
      // Autonomous mode overrides, and the bump it lets through is worded for it. See
      // `restMessageIsSignedOff`.
      // Per-rest, and that is what makes it free: every fact it reads rides the FINAL assistant message,
      // so the next word on the thread re-opens the trigger with nothing stored to clear.
      const autonomous = autonomousModeOn(row)
      if (restMessageIsSignedOff(tele, autonomous, registeredPrWatchesOf(deps.storage, row.slug))) continue
      // And the operator's own broader hold, when they armed it.
      if (heldByQuestion(row, tele)) continue
      const fenceId = stopHookFenceId(armed.armedAt, restedAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Terminal rows stay in the store, so this alone is what makes a rest bump EXACTLY once: the same
      // rest yields the same delivery id, whatever happened to the first attempt.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: STOP_HOOK_HINT_KEY,
        message: restPromptMessage(armed.prompt, { overQuestion: autonomous && tele.pendingQuestion === true }),
        reason: "recurring prompt at rest",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // ---- The ON COMPACTION pass -----------------------------------------------------------------
  // Deliberately does NOT filter on `turn === "idle"` (see SOURCE 7): the point is to reach the worker
  // in the emptied window, and a compaction happens while it is working. Nor does it consult whether the
  // thread signed off — a ```done fence answers "you stopped, is there more?", which is not the question
  // a compaction asks. A worker that genuinely wants these to stop clears the Goal, or the operator does
  // it in the footer.
  function evalCompactPrompts(nowMs: number): void {
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue
      const armed = armedCompact(row)
      if (!armed) continue
      const tele = deps.tailer.get(row.slug)
      if (!tele?.lastCompactionAt) continue
      // NEVER fire for a compaction that predates the arming. Without this, switching the trigger on for
      // a thread that compacted an hour ago delivers immediately for an event the operator never saw —
      // and a thread that has compacted before is the common case, not the exotic one.
      if (tele.lastCompactionAt <= armed.armedAt) continue
      // The operator's hold applies here too. Nothing else does: re-grounding a worker whose context was
      // just emptied is worth doing whether or not it is mid-turn, and a fence it wrote before the
      // compaction says nothing about whether it still remembers what it was doing.
      if (heldByQuestion(row, tele)) continue
      const fenceId = compactFenceId(armed.armedAt, tele.lastCompactionAt)
      const deliveryId = wakeDeliveryId(row.slug, row.session_id, fenceId)
      // Terminal rows stay in the store, so this alone is what makes a compaction bump EXACTLY once: the
      // same compaction yields the same delivery id, whatever happened to the first attempt.
      if (outbox.get(deliveryId)) continue
      const item = outbox.enqueue({
        id: deliveryId,
        slug: row.slug,
        sessionId: row.session_id,
        fenceId,
        hintKey: COMPACT_HINT_KEY,
        message: compactionPromptMessage(armed.prompt),
        reason: "recurring prompt after compaction",
      }, nowMs).delivery
      log(`waker: queued ${row.slug} — ${item.reason}`)
      checkpoint("after-enqueue", item)
    }
  }

  // Stamp the POST-COMPACTION readout once its delivery is terminal. Cosmetic (the panel's "last sent"),
  // guarded on the generation for the same reason as its siblings: a bump settling after the operator
  // edited the text must not write onto words it no longer describes.
  function settleCompactPrompt(item: WakeDelivery): void {
    if (!isCompactFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${COMPACT_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringCompactFired(item.slug, armedAt, new Date().toISOString())
  }

  // Stamp the bump clock once a bump has genuinely REACHED the worker — the HEARTBEAT's input, and
  // called only from the settle points that mean delivery genuinely happened.
  // Guarded on the generation so a bump settling after the operator edited the text cannot write onto
  // words it no longer describes.
  function settleRestPrompt(item: WakeDelivery): void {
    if (!isStopHookFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    const armedAt = row.recurring_armed_at
    if (!armedAt || !item.fenceId.startsWith(`${STOP_HOOK_FENCE_PREFIX}:${armedAt}:`)) return
    deps.storage.stampRecurringRestFired(item.slug, armedAt, new Date().toISOString())
  }

  // Disarm the row a snooze wake came from, once that wake is terminal. Guarded on the fence id still
  // matching so a human who re-snoozed (or snoozed again) between enqueue and settlement keeps their
  // NEW deadline — the stale delivery must never erase state it no longer describes.
  function settleSnooze(item: WakeDelivery): void {
    if (!isSnoozeFenceId(item.fenceId)) return
    const row = deps.storage.getSession(item.slug)
    if (!row || row.session_id !== item.sessionId) return
    if (armedSnooze(row)?.fenceId !== item.fenceId) return
    deps.storage.setSnoozedUntil(item.slug, null)
  }

  function reconcileOutbox(nowMs: number): void {
    for (const item of outbox.listOpen()) {
      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, nowMs)
        settleSnooze(item)
        settleSchedulePrompt(item)
        settleRestPrompt(item)
        settleCompactPrompt(item)
        settleTimer(item)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, nowMs, "the exact awaiting fence or session was superseded")
        settleSnooze(item)
        continue
      }
      if (item.state !== "leased" || item.leaseUntil === null || item.leaseUntil > nowMs) continue
      // An expired lease is an interrupted/uncertain attempt. Re-open it only while the exact session
      // generation is still idly awaiting the exact fence. Busy or not-yet-loaded telemetry is held:
      // retrying there could duplicate an input that crossed the transport just before process death.
      //
      // DELIBERATELY NOT `isDeliverableNow`: a scheduled prompt may be SENT to a busy thread, but not
      // RE-sent to one on a guess. This branch runs precisely when we do not know whether the previous
      // attempt landed, and the transcript check that would tell us (`confirmed`, above) cannot see a
      // message still sitting in the CLI's queue. A beat that arrives one rest late is the old
      // behaviour; a beat that arrives twice mid-turn is a new defect.
      if (context !== "current-idle") continue
      const recovered = outbox.recoverExpired(
        item.id,
        nowMs,
        nowMs,
        maxDeliveryAttempts,
        item.lastError ?? "delivery lease expired before acknowledgement",
      )
      if (recovered?.state === "exhausted") {
        settleSnooze(item)
        settleTimer(item)
        log(`waker: delivery EXHAUSTED for ${item.slug} after ${recovered.attempts} attempts — ${recovered.lastError ?? "unknown error"}`)
      }
    }
  }

  async function deliverDue(): Promise<void> {
    for (let delivered = 0; delivered < deliveryBatchSize; delivered++) {
      // Condition polling can take seconds. Never derive a lease from the tick-start timestamp: a
      // sufficiently slow GitHub request would make a brand-new claim already expired to another
      // scheduler process. Every external-delivery boundary gets a fresh clock read instead.
      const claimedAt = now()
      const item = outbox.claim(deliveryOwner, claimedAt, claimedAt + deliveryLeaseMs, maxDeliveryAttempts)
      if (!item) return
      checkpoint("after-claim", item)

      const context = deliveryContext(item)
      if (context === "confirmed") {
        outbox.confirm(item.id, now())
        settleSnooze(item)
        settleSchedulePrompt(item)
        settleRestPrompt(item)
        settleCompactPrompt(item)
        settleTimer(item)
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, now(), "the exact awaiting fence or session was superseded before delivery")
        settleSnooze(item)
        continue
      }
      if (!isDeliverableNow(item, context)) {
        const deferredAt = now()
        outbox.deferFailure(
          item.id,
          deliveryOwner,
          deferredAt,
          deferredAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)),
          "delivery deferred until exact awaiting telemetry is idle and available",
        )
        continue
      }

      try {
        await deps.resume(item.slug, item.message, item.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failedAt = now()
        // A TERMINAL delivery verdict (a live worker owns this conversation but its exact identity
        // can't be confirmed for safe re-entry) will never change by retrying — retrying only burns
        // every attempt to a silent exhaustion. Abandon the item now, preserving the reason for the
        // human, instead of deferring it back into the retry pool. Duck-typed so the scheduler stays
        // decoupled from resume.ts (see TerminalDeliveryError).
        if ((error as { terminalDelivery?: unknown })?.terminalDelivery === true) {
          outbox.supersede(item.id, failedAt, message)
          settleSnooze(item)
          settleTimer(item)
          log(`waker: delivery ABANDONED for ${item.slug} (terminal, no retry): ${message}`)
          continue
        }
        // A thrown non-terminal operation can still be ambiguous (for example, text crossed tmux before
        // a later storage write failed). Keep the item leased through a confirmation window; recovery
        // checks the token/fence before making it retryable.
        outbox.deferFailure(
          item.id,
          deliveryOwner,
          failedAt,
          failedAt + Math.max(deliveryLeaseMs, retryDelay(item.attempts)),
          message,
        )
        log(`waker: delivery FAILED for ${item.slug} (attempt ${item.attempts} of ${maxDeliveryAttempts}): ${message}`)
        continue
      }

      // The happy path logs exactly one line, and it CONFIRMS something that already happened. A
      // pre-flight "delivering … (attempt 1)" reads like a retry counter — as if a previous try had
      // failed — on the first-and-only attempt every ordinary wake takes. Attempt counts belong on the
      // failure lines above, where they carry information; here one is worth printing only when the
      // delivery genuinely did take more than one.
      const retried = item.attempts > 1 ? ` (on attempt ${item.attempts})` : ""
      log(`waker: delivered ${item.slug} — ${item.reason}${retried}`)
      checkpoint("after-delivery", item)
      if (!outbox.acknowledge(item.id, deliveryOwner, now())) {
        log(`waker: delivery acknowledgement lost ownership for ${item.slug}; preserving the authoritative terminal state`)
        continue
      }
      settleSnooze(item)
      settleSchedulePrompt(item)
      settleRestPrompt(item)
      settleCompactPrompt(item)
      settleTimer(item)
      settleSignoffNudge(item)
      const acknowledged = outbox.get(item.id)
      if (acknowledged) checkpoint("after-ack", acknowledged)
    }
  }

  async function runTick(): Promise<void> {
    const nowMs = now()
    const seen = new Set<string>()
    const candidates: { row: SessionRow; fence: FenceView; fenceAt?: string }[] = []
    for (const row of deps.storage.allSessions()) {
      if (row.state === "archived" || row.archived === 1) continue // non-archived only
      const tele = deps.tailer.get(row.slug)
      if (!tele || tele.turn !== "idle") continue // only a thread genuinely AT REST is a waker candidate
      const fence = tele.lastFence
      if (!fence || fence.kind !== "awaiting" || !fence.hints.some(isActionable)) continue
      seen.add(row.slug)
      candidates.push({ row, fence, fenceAt: tele.lastActivityAt })
    }
    // Evaluate candidate threads together. The production review fetcher uses the resulting same-turn
    // calls to coalesce every distinct PR into one bounded GraphQL batch and to deduplicate duplicate
    // refs. Per-thread state remains isolated by slug; shared durable writes are synchronous.
    const candidateResults = await Promise.allSettled(candidates.map(async ({ row, fence, fenceAt }) => {
      try {
        await evalThread(row.slug, row.session_id, fence, nowMs, fenceAt)
      } catch (err) {
        if (err instanceof InjectedSchedulerCrash) throw err
        log(`waker: tick error for ${row.slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
    const crashed = candidateResults.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (crashed) throw crashed.reason
    // The awaiting fence vanished (superseded, archived, or no longer at rest): forget its arming +
    // persisted marker so a future re-await arms fresh and can fire again.
    for (const [slug, st] of [...threads]) {
      if (!seen.has(slug)) {
        const key = firedKey(slug, st.fenceId)
        forgetFired(key)
        forgetRegistration(key)
        threads.delete(slug)
      }
    }
    try {
      await evalLimits(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: limit-resume pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalSnoozes(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: snooze-bump pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalSchedulePrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt schedule pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalRestPrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt rest pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalCompactPrompts(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: recurring-prompt compaction pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalSignoffNudges(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: sign-off nudge pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await evalPrWatches(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: pr-watch registry pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalShellCompletions(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: shell-completion pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      evalTimers(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: one-off timer pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      repairDroppedReports(now())
    } catch (err) {
      if (err instanceof InjectedSchedulerCrash) throw err
      log(`waker: report-repair pass failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    reconcileOutbox(now())
    await deliverDue()
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.reject(new ProducerStoppedError("wake scheduler"))
    if (activeTick) return activeTick
    const task = runTick()
    activeTick = task
    task.then(
      () => { if (activeTick === task) activeTick = null },
      () => { if (activeTick === task) activeTick = null },
    )
    return task
  }

  return {
    start() {
      if (timer) return
      if (stopped) throw new ProducerStoppedError("wake scheduler")
      // Derive current state immediately (arms live waits; boot-safe — never fires on first sight).
      void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      timer = setInterval(() => {
        void tick().catch((error) => log(`waker: tick failed: ${error instanceof Error ? error.message : String(error)}`))
      }, tickMs)
      timer.unref?.()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      const draining = activeTick
      if (draining) await draining
    },
    tick,
  }
}
