import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, randomUUID } from "node:crypto"
import { formatGithubWakeSteer, isValidAwaitingTimer, wakeDeliveryToken, type QuotaSnapshot } from "@fray-ui/shared"
import type { SessionRow, Storage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import type { FenceView } from "./tailer.ts"
import type { LimitFault } from "./backend/types.ts"
import { limitPauseIsStale, quotaWindowKeyFor, quotaWindowRecovered, textResetInstant } from "./backend/usage-limit.ts"
import { createWakeDeliveryStore, type WakeDelivery } from "./wake-store.ts"
import { ProducerStoppedError } from "./shutdown.ts"
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
  return ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", "state,mergedAt,statusCheckRollup,headRefOid"]
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
  if (isPrWatchHint(hint.kind) || hint.kind === "pr" || hint.kind === "ci") return parsePrRef(hint.value) !== undefined
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
    const j = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown; statusCheckRollup?: unknown; headRefOid?: unknown }
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
const REGISTRATION_CAP = 500
const REVIEW_SEEN_CAP = 300
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
  // Whether the limit auto-resume source is armed at all (Settings.autoResumeOnLimit). Read per tick
  // so flipping it off in the UI takes effect immediately, without a restart. Absent ⇒ on.
  autoResumeOnLimit?: () => boolean
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
  const autoResumeOnLimit = deps.autoResumeOnLimit ?? (() => true)
  const fetchPr = deps.fetchPr ?? defaultFetchPr
  const fetchGithubReview = deps.fetchGithubReview ?? createGithubReviewFetcher({ now })
  const log = deps.log ?? ((m: string) => console.log(`[fray-ui] ${m}`))
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
    // A snooze wake is bound to the exact (instant, prompt) the human armed. Wake-now (clears the row)
    // and a re-snooze (a different fence id) therefore read as supersession here — the human replaced
    // the promise we were holding. An ordinary follow-up does NOT: it leaves the park armed on purpose
    // (router.followUp), so a thread the operator adds context to still gets the bump it was promised.
    if (isSnoozeFenceId(item.fenceId)) {
      if (armedSnooze(row)?.fenceId !== item.fenceId) return "superseded"
      return tele.turn === "idle" ? "current-idle" : "current-busy"
    }
    const fence = tele.lastFence
    if (!fence || fence.kind !== "awaiting" || !fence.hints.some(isActionable)) return "superseded"
    if (fenceIdentity(fence.hints, tele.lastActivityAt) !== item.fenceId) return "superseded"
    return tele.turn === "idle" ? "current-idle" : "current-busy"
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
  // The FORMAT itself lives in @fray-ui/shared beside its parser, because the chat rebuilds a
  // first-party card from this exact string — the structured activity never reaches the transcript.
  //
  // `activities` is chronological and may hold several: one poll interval routinely collects a burst,
  // and every one of them is marked seen, so anything this steer does not name is never mentioned to
  // anyone again. `omitted` is how many more than the cap were dropped from the enumeration.
  function activitySteer(activities: GithubReviewActivity[], ref: PrRef, omitted = 0): string {
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
    })
  }

  // The operator-facing log line for this wake. Names the distinct actors rather than a count, since
  // "by pullfrog" is what makes a `waker: queued` line legible when scanning the server log.
  function reviewReason(ref: PrRef, activities: GithubReviewActivity[], omitted = 0): string {
    const actors = [...new Set(activities.map((a) => a.actor))]
    const total = activities.length + omitted
    return `pr-watch ${refKey(ref)} by ${actors.join(", ")}${total > 1 ? ` (${total} items)` : ""}`
  }

  function reviewVerdict(
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
    let fresh: GithubReviewActivity[]
    if (prior) {
      fresh = newestFirst.filter((a) => !priorSeen.has(a.id))
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
    return { met: true, steer: activitySteer(chronological, ref, omitted), reason: reviewReason(ref, chronological, omitted) }
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
    const needsPr = actionable.some((h) => h.kind === "pr" || h.kind === "ci")
    const needsReview = actionable.some((h) => isPrWatchHint(h.kind))
    if ((needsPr || needsReview) && (st.lastPollAt === 0 || nowMs - st.lastPollAt >= pollMs)) {
      st.lastPollAt = nowMs
      const refs = new Map<string, PrRef>()
      const reviewRefs = new Map<string, PrRef>()
      for (const h of actionable) {
        const ref = parsePrRef(h.value)
        if (!ref) continue
        if (h.kind === "pr" || h.kind === "ci") refs.set(refKey(ref), ref)
        if (isPrWatchHint(h.kind)) reviewRefs.set(refKey(ref), ref)
      }
      await Promise.all([
        ...[...refs].map(async ([k, ref]) => {
          try {
            const s = await fetchPr(ref)
            if (s) st.prCache.set(k, s) // keep the last-known status on a transient failure
            else log(`waker: gh check skipped for ${k} (${slug}) — gh unavailable / not authed / rate-limited`)
          } catch (err) {
            log(`waker: gh check errored for ${k} (${slug}): ${err instanceof Error ? err.message : String(err)}`)
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
          ? reviewVerdict(persistKey, h, reviewActivity ?? [], fenceAt)
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
      if (w && typeof w.usedPercent === "number" && w.usedPercent <= LIMIT_RESUME_HEADROOM_PERCENT) return true
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
    if (!autoResumeOnLimit()) return
    const candidates = limitCandidates(nowMs)
    if (candidates.length === 0) return
    // Read the heartbeat-warmed usage snapshot. The account-availability trigger needs it for EVERY
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

  // ---- The user-snooze bump pass -------------------------------------------------------------------
  // Deliberately does NOT filter on `turn === "idle"` the way the fence pass does. A snooze deadline is
  // a promise to the human, so a thread that happens to be mid-turn when it crosses must not LOSE its
  // follow-up — the delivery gate below holds the item until the thread comes to rest instead.
  //
  // Unlike an unregistered legacy timer, an overdue snooze found at boot DOES fire: the DB row is
  // itself the durable registration, so a deadline that crossed while fray was down is exactly the case
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
      // retrying there could duplicate an input that crossed tmux just before process death.
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
        continue
      }
      if (context === "superseded") {
        outbox.supersede(item.id, now(), "the exact awaiting fence or session was superseded before delivery")
        settleSnooze(item)
        continue
      }
      if (context !== "current-idle") {
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
