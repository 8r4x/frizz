// The stop hook's two SERVER-side invariants (scheduler.ts SOURCE 5), each of which is a way the
// feature could silently loop forever or silently stop:
//
//   1. the fold's sentinel lifecycle — ALLDONE only means "nothing actionable" while it is the FINAL
//      word, so a later message that omits it must re-open the loop by itself;
//   2. the row's GENERATION — editing the text supersedes a bump already queued for the old words,
//      while merely toggling off and on must NOT (that would re-send a bump the operator watched land).
//
// The end-to-end proof that a real agent is bumped at rest, bumped again at its NEXT rest, and left
// alone once it answers ALLDONE lives in backend/_live_recurring_prompt.mts — a live probe, not a unit
// test, because the only thing worth asserting there is what a real worker does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type FenceView, type SessionTelemetry, type Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"

const assistant = (text: string, at = "2026-08-02T00:00:01.000Z") => ({
  type: "assistant",
  timestamp: at,
  message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
})

test("fold: ALLDONE on the final assistant message sets the flag; the next message without it clears it", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, assistant("Checked the queue — nothing to pick up.\n\nALLDONE"))
  assert.equal(s.lastAssistantAllDone, true)
  // The loop re-opens purely from the fold: a later rest message that does not carry the sentinel is
  // an agent that has something to say again, and nothing had to be stored or cleared to notice.
  applyRecord(s, assistant("Actually the build just broke — looking at it.", "2026-08-02T00:00:02.000Z"))
  assert.equal(s.lastAssistantAllDone, false)
})

test("fold: any user record supersedes a standing ALLDONE — the operator's next word re-opens the loop", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, assistant("ALLDONE"))
  assert.equal(s.lastAssistantAllDone, true)
  applyRecord(s, {
    type: "user",
    timestamp: "2026-08-02T00:00:03.000Z",
    message: { content: [{ type: "text", text: "one more thing" }] },
  })
  assert.equal(s.lastAssistantAllDone, false)
})

// The normalized (codex) path folds the same fact off its own event union, so a codex thread must not
// be a thread whose stop hook can never be closed.
test("fold: the normalized event path derives ALLDONE from the final text too", () => {
  const s = newTailState("t", "sid", "/x")
  applyEvent(s, { kind: "turn-end", at: "2026-08-02T00:00:01.000Z", finalText: "Nothing to do here.\nALLDONE" })
  assert.equal(s.lastAssistantAllDone, true)
  applyEvent(s, { kind: "user-message", at: "2026-08-02T00:00:02.000Z", text: "go on", synthetic: false })
  assert.equal(s.lastAssistantAllDone, false)
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-stophook-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "stophook-t"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  return {
    storage, slug,
    row: () => storage.getSession(slug)!,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("storage: toggling off and on KEEPS the generation and the last-fired stamp", () => {
  const f = fixture()
  try {
    assert.equal(f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" }), true)
    const armedAt = f.row().recurring_armed_at
    assert.equal(armedAt, "2026-08-02T00:00:00.000Z")
    f.storage.stampRecurringRestFired(f.slug, armedAt!, "2026-08-02T00:05:00.000Z")

    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:10:00.000Z" })
    assert.equal(f.row().recurring_on_rest, 0)
    assert.equal(f.row().recurring_armed_at, armedAt, "an off/on flip is not a re-arming")
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:11:00.000Z" })
    assert.equal(f.row().recurring_on_rest, 1)
    assert.equal(f.row().recurring_armed_at, armedAt)
    // The rate floor survives the flip too — otherwise toggling would be a way to bypass it.
    assert.equal(f.row().recurring_rest_fired_at, "2026-08-02T00:05:00.000Z")
  } finally {
    f.close()
  }
})

test("storage: EDITING the text mints a new generation and drops the last-fired stamp", () => {
  const f = fixture()
  try {
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    f.storage.stampRecurringRestFired(f.slug, f.row().recurring_armed_at!, "2026-08-02T00:05:00.000Z")
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "do something else", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:10:00.000Z" })
    assert.equal(f.row().recurring_armed_at, "2026-08-02T00:10:00.000Z", "new words are a new generation")
    assert.equal(f.row().recurring_rest_fired_at, null, "and the new words have never fired")
  } finally {
    f.close()
  }
})

test("storage: a null prompt clears the whole row, and a stale session/generation writes nothing", () => {
  const f = fixture()
  try {
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    assert.equal(
      f.storage.setRecurringPromptIfCurrent(f.slug, "other-sid", 0, { prompt: "hijack", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:01:00.000Z" }),
      false,
      "a tab looking at a superseded session fails closed",
    )
    assert.equal(f.row().recurring_prompt, "keep going")
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: null, stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:02:00.000Z" })
    assert.equal(f.row().recurring_prompt, null)
    assert.equal(f.row().recurring_armed_at, null)
    assert.equal(f.row().recurring_on_rest, 0, "a cleared row can never read as enabled")
  } finally {
    f.close()
  }
})

// ---- The worker's own path to the same row ------------------------------------------------------
// `mcp__frizz__recurring_prompt` writes by SLUG ALONE, with no session/generation guard, because the MCP server
// cannot satisfy one: it is spawned with its thread's slug and keeps it across every resume while the
// session id bumps underneath. These pin that the unguarded path behaves identically to the operator's
// on everything EXCEPT the guard — same generation semantics, same clear.
test("storage: the worker path writes by slug alone, across a session change the operator path rejects", () => {
  const f = fixture()
  try {
    // A resume: the row now belongs to a new session and generation, exactly as after a restart.
    f.storage.upsertSession({
      slug: f.slug, session_id: "sid-2", tmux_name: `frizz-${f.slug}`, spawned_at: new Date().toISOString(),
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
      title: f.slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
    } as SessionRow)

    // The operator path, holding the OLD session id, correctly fails closed.
    assert.equal(
      f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "stale tab", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" }),
      false,
      "a browser tab that has fallen behind must not write",
    )
    // The worker path, which only ever knew the slug, still reaches its own row.
    assert.equal(
      f.storage.setRecurringPromptBySlug(f.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:01:00.000Z" }),
      true,
      "the tool must survive the resume it was armed before",
    )
    assert.equal(f.row().recurring_prompt, "keep going")
    assert.equal(f.row().recurring_on_rest, 1)
  } finally {
    f.close()
  }
})

test("storage: the worker path keeps the generation on a re-arm with the SAME text, and clears on null", () => {
  const f = fixture()
  try {
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    const armedAt = f.row().recurring_armed_at
    f.storage.stampRecurringRestFired(f.slug, armedAt!, "2026-08-02T00:05:00.000Z")

    // A worker that re-registers on resume must not supersede a bump already queued for those words.
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:10:00.000Z" })
    assert.equal(f.row().recurring_armed_at, armedAt, "same text ⇒ same generation")
    assert.equal(f.row().recurring_rest_fired_at, "2026-08-02T00:05:00.000Z", "and the rate floor survives")

    // New words ARE a new generation, same as the operator path.
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: "do something else", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:11:00.000Z" })
    assert.equal(f.row().recurring_armed_at, "2026-08-02T00:11:00.000Z")
    assert.equal(f.row().recurring_rest_fired_at, null)

    // `action: "stop"` — the worker ending its own loop deliberately.
    f.storage.setRecurringPromptBySlug(f.slug, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:12:00.000Z" })
    assert.equal(f.row().recurring_prompt, null)
    assert.equal(f.row().recurring_armed_at, null)
    assert.equal(f.row().recurring_on_rest, 0)
  } finally {
    f.close()
  }
})

// ---- The heartbeat, and what holds a bump ------------------------------------------------------
// The firing rule in full: a bump fires as soon as the thread RESTS, and firing starts a fixed timer;
// nothing fires again until it completes. These drive the REAL scheduler pass over REAL storage with
// only the tailer stubbed (it is the input being varied), and `now` injected so the clock is exact.
const HEARTBEAT_MS = 10 * 60_000

function scheduler(
  tele: Partial<SessionTelemetry>,
  opts: { lastFiredAt?: string; now?: () => number; pauseOnQuestions?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-hb-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "hooked"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  // Frizz's built-in sign-off reminder (SOURCE 9) now fires on EVERY fenceless rest, independently of
  // the Goal — so it would add a second delivery to every count in this file. Silenced so these stay
  // about the Goal; the reminder has signoff-nudge.test.ts.
  storage.setSetting("signoffNudge", "off")
  storage.setRecurringPromptBySlug(slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: opts.pauseOnQuestions === true, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
  if (opts.lastFiredAt) storage.stampRecurringRestFired(slug, storage.getSession(slug)!.recurring_armed_at!, opts.lastFiredAt)
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-02T00:00:00.000Z",
        // The AGENT spoke last — the shape of a real rest, and the one thing frizz cannot fake, since
        // frizz only ever speaks as the user. Without it the trigger cannot tell "you stopped" from
        // "nothing is happening", which is how a worker-less thread was bumped every tick.
        lastAssistantAt: "2026-08-02T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
    // The awaiting poller runs on the same tick as the Goal, so a `pr-watch:` hint in any fence below
    // would otherwise shell out to `gh`. Stubbed to "reachable, nothing new", which is the state a
    // freshly parked PR watcher is actually in.
    fetchPr: async () => undefined,
    fetchGithubReview: async () => [],
  })
  return { s, storage, slug, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const at = (iso: string) => () => Date.parse(iso)
// Every fence built here carries the REQUIRED `for:` unless a case overrides it — the 2026-08-15
// grammar treats a fence with no duration as not-a-park, which is a different thing from the thing most
// of these cases are about.
const awaiting = (...hints: FenceView["hints"]): FenceView =>
  ({ kind: "awaiting", body: "", hints: hints.length ? [...hints, { kind: "for" as const, value: "2h" }] : [] })
const child = (state: "running" | "stale" | "rested") =>
  ({ label: "worker", startedAt: "2026-08-02T00:00:00.000Z", state, id: `t-${state}` })

test("heartbeat: the FIRST rest after arming is bumped at once — nothing has fired yet", async () => {
  const h = scheduler({}, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /keep going/)
  } finally { h.close() }
})

// It fires on EVERY rest, with no floor of its own: "the stop hook is also pretty simple in that it
// fires whenever the agent rests. That's it." There is a natural limit anyway — producing a new rest
// costs the worker a whole turn, and one rest yields exactly one bump (the delivery id is bound to the
// thread's activity stamp), so it cannot spin faster than the agent can actually run.
test("stop hook: a second rest is bumped again immediately — no interval of its own", async () => {
  const first = scheduler({}, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await first.s.tick()
    assert.equal(first.delivered.length, 1)
  } finally { first.close() }

  // The same thread having just been bumped seconds ago, resting again: bumped again.
  const again = scheduler({}, { lastFiredAt: "2026-08-02T00:00:05.000Z", now: at("2026-08-02T00:00:20.000Z") })
  try {
    await again.s.tick()
    assert.equal(again.delivered.length, 1, "no floor holds a stop hook back")
  } finally { again.close() }
})

// Removed the same day it shipped (maintainer: "the status of any sub-agents or background shells is
// irrelevant"). The heartbeat is the whole rate story, and consulting child liveness is also what would
// stop this rescuing a thread parked behind a child that never reports.
test("heartbeat: live sub-agents and background shells are IRRELEVANT to firing", async () => {
  for (const state of ["running", "stale", "rested"] as const) {
    const h = scheduler({ subAgents: [child(state)] as SessionTelemetry["subAgents"] }, { now: at("2026-08-02T00:00:05.000Z") })
    try {
      await h.s.tick()
      assert.equal(h.delivered.length, 1, `a ${state} child must not hold the bump`)
    } finally { h.close() }
  }
  const shell = scheduler({
    bgShells: [{ label: "vite dev", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "s1" }] as SessionTelemetry["bgShells"],
  }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await shell.s.tick()
    assert.equal(shell.delivered.length, 1, "a live shell must not hold the bump either")
  } finally { shell.close() }
})

// THE LOOP THIS TRIGGER SHIPPED WITH FOR MONTHS, and which only became dangerous when every dispatched
// thread started carrying a Goal. Frizz speaks as the USER, so its own bump lands in the transcript and
// advances `lastActivityAt` — the field the delivery id used to key on — minting a "rest" nobody rested.
// A thread whose worker is gone stays idle forever, so it was bumped every tick: 10 in 100 seconds,
// measured on a real stack. `turn === "idle"` cannot tell "you stopped" from "nothing is happening";
// only the agent having spoken LAST can.
test("a thread whose last word is frizz's own bump is not bumped again", async () => {
  const h = scheduler({
    lastAssistantAt: "2026-08-02T00:00:00.000Z",
    lastUserAt: "2026-08-02T00:00:30.000Z", // the bump landed after the agent's last word
    lastActivityAt: "2026-08-02T00:00:30.000Z",
  }, { now: at("2026-08-02T00:01:00.000Z") })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "it has not answered the last one yet")
  } finally { h.close() }
})

test("ALLDONE holds the bump for that rest only, and nothing is stored to undo", async () => {
  const held = scheduler({ lastAssistantAllDone: true }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await held.s.tick()
    assert.deepEqual(held.delivered, [])
  } finally { held.close() }

  // The same thread one rest later, having said something else: bumped as normal.
  const resumed = scheduler({ lastAssistantAllDone: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await resumed.s.tick()
    assert.equal(resumed.delivered.length, 1)
  } finally { resumed.close() }
})

// ---- The PARK (`parkedOnAWaitItCannotAdvance`) --------------------------------------------------
// THE LOOP THE MAINTAINER WATCHED, 2026-08-12, on the zod board. A worker parked on
// `pr-watch: colinhacks/zod#6382` was bumped 7 times in 46 minutes: each bump cost a whole turn whose
// only product was the same fence reworded, because "keep going" has no answer while a PR sits
// unreviewed. A second thread wrote `human: Colin to merge — the task barred me from merging` and was
// bumped anyway, until it took the only exit the trailer had ever shown it and signed off ```done on an
// unmerged PR. These pin both halves: the Goal does not bump a wait somebody else owns, and it still
// rescues a park nothing will ever fire.
test("an awaiting fence on a PR the scheduler is watching holds the bump", async () => {
  const h = scheduler({ lastFence: awaiting({ kind: "pr", value: "colinhacks/zod#6382" }) }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    // REGISTERED, which is what makes a wake actually coming. Since 2026-08-14 the fence line alone arms
    // nothing — `mcp__frizz__watch_pr` does — so the hold reads the registry rather than the hint.
    h.storage.armPrWatch({ id: "prw_1", slug: h.slug, owner: "colinhacks", repo: "zod", number: 6382, createdAtMs: 1 })
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the waker already owns this thread's next wake")
  } finally { h.close() }
})

// …AND THE SAME LINE WITH NOTHING REGISTERED GETS THE RESCUE. A `pr-watch:` line frizz will never fire is
// a thread that waits forever, which is exactly the shape this trigger exists to rescue — the same
// reading an unparseable ref has always had.
test("an awaiting fence on a PR NOBODY registered is bumped, like any other unfireable park", async () => {
  const h = scheduler({ lastFence: awaiting({ kind: "pr", value: "colinhacks/zod#6382" }) }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "nothing will ever fire that, so the rescue stands")
  } finally { h.close() }
})
// (A test for a deleted awaiting-hint kind was removed here on 2026-08-15. See the AwaitingHint doc
// block in @frizz/shared for why `human:`, `timer: <instant>` and `pr-watch:` no longer exist.)


// THE RESCUE, which is the whole reason this trigger fired over `awaiting` for months. A park frizz has
// no way to honour is a thread that waits forever, and these are exactly the shapes it cannot honour:
// no hint at all, a PR ref that does not parse, and the presentation-only `session:` kind.
test("an awaiting fence naming nothing frizz can fire is still bumped", async () => {
  const shapes: FenceView[] = [
    awaiting(),
    awaiting({ kind: "pr", value: "the auth PR" }),
    awaiting({ kind: "shell", value: "a-shell-that-is-not-running" }),
  ]
  for (const lastFence of shapes) {
    const h = scheduler({ lastFence }, { now: at("2026-08-02T00:00:05.000Z") })
    try {
      await h.s.tick()
      assert.equal(h.delivered.length, 1, `${JSON.stringify(lastFence.hints)} is a park nothing will ever settle`)
    } finally { h.close() }
  }
})

// ---- The HEARTBEAT (scheduler SOURCE 4) ----------------------------------------------------------
// The dumb sibling. Everything the stop hook consults, this ignores — that is its entire contract, and
// these are the tests that would catch it quietly growing a condition.
function heartbeatScheduler(
  tele: Partial<SessionTelemetry>,
  opts: { intervalMs?: number; armedAt?: string; lastFiredAt?: string; now?: () => number; tailerMiss?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-beat-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "beating"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  storage.setSetting("signoffNudge", "off")
  storage.setRecurringPromptBySlug(slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, pauseOnQuestions: false, intervalMs: opts.intervalMs ?? 3_600_000, armedAt: opts.armedAt ?? "2026-08-02T00:00:00.000Z" })
  if (opts.lastFiredAt) storage.stampRecurringScheduleFired(slug, storage.getSession(slug)!.recurring_armed_at!, opts.lastFiredAt)
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => opts.tailerMiss ? undefined : ({
        turn: "idle", lastActivityAt: "2026-08-02T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  return { s, storage, slug, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("heartbeat: nothing before the interval elapses, then the beat with its trailer", async () => {
  const early = heartbeatScheduler({}, { now: at("2026-08-02T00:30:00.000Z") })
  try {
    await early.s.tick()
    assert.deepEqual(early.delivered, [], "half an hour into an hourly beat")
  } finally { early.close() }

  const due = heartbeatScheduler({}, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await due.s.tick()
    assert.equal(due.delivered.length, 1)
    assert.ok(due.delivered[0].startsWith("check the deploy"), "the operator's text leads, verbatim")
    assert.match(due.delivered[0], /Goal — sent every 1 hr/, "and the trailer names the cadence")
    assert.match(due.delivered[0], /ONLY when the work is genuinely finished/, "and warns about the opt-out it offers")
  } finally { due.close() }
})

// The ONE thing that stops a beat. Everything else about this source is unconditional, but a worker
// that has declared there is no further work has ended the arrangement — and a run described as
// "permanently stalled" that keeps being woken every interval is not stalled at all.
test("heartbeat: ALLDONE suppresses a beat — it is the opt-out from BOTH sources", async () => {
  const h = heartbeatScheduler({ lastAssistantAllDone: true }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the opt-out has to reach the clock, or it is not an opt-out")
  } finally { h.close() }
})

test("heartbeat: live sub-agents and background shells do not suppress a beat either", async () => {
  const h = heartbeatScheduler({
    subAgents: [{ label: "w", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "t1" }] as SessionTelemetry["subAgents"],
    bgShells: [{ label: "vite", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "s1" }] as SessionTelemetry["bgShells"],
  }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.ok(h.delivered[0].startsWith("check the deploy"))
  } finally { h.close() }
})

// THE POINT OF THE FEATURE (maintainer 2026-08-03: "my intention was for the heartbeat to fire on its
// regular cadence, regardless of whether the agent is currently running or not"). Every other wake
// source is held by the delivery gate until the thread rests; this one is not, because a beat that
// waits for a rest is a stop hook wearing a clock — and a thread that never stops never hears it.
test("heartbeat: a beat due MID-TURN is delivered mid-turn, not held until rest", async () => {
  const h = heartbeatScheduler({ turn: "in-flight" }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "a busy thread must not hold the beat back")
    assert.ok(h.delivered[0].startsWith("check the deploy"))
  } finally { h.close() }
})

// And the cadence is REAL after a mid-turn delivery: the clock stamps from the beat that landed, so the
// next one is due an interval later. Before this, a thread busy across several intervals collected one
// stale catch-up beat at its next rest and the operator's schedule described nothing.
test("heartbeat: a mid-turn beat advances the clock, so the schedule keeps running through a long turn", async () => {
  const h = heartbeatScheduler({ turn: "in-flight" }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.equal(
      h.storage.getSession(h.slug)!.recurring_schedule_fired_at !== null,
      true,
      "the beat that landed mid-turn is what the next interval is measured from",
    )
    // Still inside the same turn, still inside the same interval: no second beat.
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "the interval still governs — mid-turn is not a free-for-all")
  } finally { h.close() }
})

// The exception is scoped to the heartbeat's fence, not widened into "deliver to busy threads". A
// SNOOZE also queues without consulting rest (its pass deliberately does not filter on idle), and it
// must still be held: a human's scheduled bump is about a thread that stopped.
test("the mid-turn exception is the HEARTBEAT's alone — a due snooze is still held while busy", async () => {
  const h = heartbeatScheduler({ turn: "in-flight" }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    h.storage.setSnoozedUntil(h.slug, "2026-08-02T00:30:00.000Z", "back to it")
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "a snooze waits for the thread to come to rest, as it always did")
  } finally { h.close() }
})

// `unknown` telemetry is not a thread we can safely address, heartbeat or not — the exception is for a
// thread we can SEE is busy, never for one we cannot read at all.
test("heartbeat: a beat is still held when the thread's telemetry cannot be read", async () => {
  const h = heartbeatScheduler({}, { now: at("2026-08-02T01:00:00.000Z"), tailerMiss: true })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "no telemetry, no delivery")
  } finally { h.close() }
})

// SWITCHING A TRIGGER OFF MUST NOT DESTROY THE CADENCE. This shipped broken for an afternoon and was
// caught by opening the panel in a browser, not by a test: the footer omitted `intervalSeconds` from the
// write whenever the schedule trigger was off, storage cleared the column, and the panel came back
// showing the 10-minute default — so an operator's 30 was silently discarded the moment they parked it.
// Pinned at the storage level, which is where "off keeps the settings" actually has to be true.
test("recurring prompt: switching the schedule trigger OFF keeps the cadence for switching it back on", async () => {
  // The clock sits AFTER the re-arm plus one interval, so the last assertion is about the cadence
  // surviving rather than about how far the fixed clock happens to have advanced.
  const h = heartbeatScheduler({}, { now: at("2026-08-02T02:30:02.000Z") })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: 1_800_000, armedAt: "2026-08-02T02:00:00.000Z" })
    const off = h.storage.getSession(h.slug)!
    assert.equal(off.recurring_on_schedule, 0, "the trigger is off")
    assert.equal(off.recurring_interval_ms, 1_800_000, "and the 30 minutes the operator chose is still there")
    assert.equal(off.recurring_prompt, "check the deploy", "as is the text")

    // Back on, at the SAME cadence, with no re-entry.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, pauseOnQuestions: false, intervalMs: 1_800_000, armedAt: "2026-08-02T02:00:01.000Z" })
    assert.equal(h.storage.getSession(h.slug)!.recurring_interval_ms, 1_800_000)
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "and it fires again on that cadence")
  } finally { h.close() }
})

test("heartbeat: a DISABLED heartbeat fires nothing but keeps its schedule and text", async () => {
  const h = heartbeatScheduler({}, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: 3_600_000, armedAt: "2026-08-02T00:00:00.000Z" })
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    const row = h.storage.getSession(h.slug)!
    assert.equal(row.recurring_prompt, "check the deploy", "the text survives the toggle")
    assert.equal(row.recurring_interval_ms, 3_600_000, "and so does the schedule")
  } finally { h.close() }
})

// The generation rule, which is what stops a re-arming worker from stacking beats or resetting its own
// clock on every resume.
test("heartbeat: the generation survives a bare toggle flip and is minted by a schedule change", async () => {
  const h = heartbeatScheduler({})
  try {
    const gen = h.storage.getSession(h.slug)!.recurring_armed_at
    h.storage.stampRecurringScheduleFired(h.slug, gen!, "2026-08-02T00:05:00.000Z")

    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: 3_600_000, armedAt: "2026-08-02T02:00:00.000Z" })
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, pauseOnQuestions: false, intervalMs: 3_600_000, armedAt: "2026-08-02T02:00:01.000Z" })
    assert.equal(h.storage.getSession(h.slug)!.recurring_armed_at, gen, "off/on is not a re-arming")
    assert.equal(h.storage.getSession(h.slug)!.recurring_schedule_fired_at, "2026-08-02T00:05:00.000Z", "so the clock is not reset either")

    // Same text, NEW schedule: a real change, so a new generation and a fresh clock.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, pauseOnQuestions: false, intervalMs: 900_000, armedAt: "2026-08-02T03:00:00.000Z" })
    assert.equal(h.storage.getSession(h.slug)!.recurring_armed_at, "2026-08-02T03:00:00.000Z")
    assert.equal(h.storage.getSession(h.slug)!.recurring_schedule_fired_at, null)

    // Clearing empties the row.
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T04:00:00.000Z" })
    const cleared = h.storage.getSession(h.slug)!
    assert.equal(cleared.recurring_prompt, null)
    assert.equal(cleared.recurring_armed_at, null)
    assert.equal(cleared.recurring_interval_ms, null)
  } finally { h.close() }
})

// ---- POST-COMPACTION (scheduler SOURCE 7) --------------------------------------------------------
// The trigger that replaced a worker-side hook splicing a canonical scratchpad into the emptied window.
// Its contract is narrow and every clause of it is load-bearing: it fires on a compaction NEWER than the
// arming, exactly once per compaction, and — unlike the rest trigger — it does not wait for the thread
// to stop, because a compaction happens while the worker is still working.
function compactScheduler(
  tele: Partial<SessionTelemetry>,
  opts: { armedAt?: string; now?: () => number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-compact-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "compacting"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  storage.setSetting("signoffNudge", "off")
  storage.setRecurringPromptBySlug(slug, {
    prompt: "Re-read .frizz/threads/sid/plan.md before continuing",
    stopHook: false, heartbeat: false, postCompaction: true, pauseOnQuestions: false,
    intervalMs: null, armedAt: opts.armedAt ?? "2026-08-02T00:00:00.000Z",
  })
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-02T00:00:00.000Z",
        // The AGENT spoke last — the shape of a real rest, and the one thing frizz cannot fake, since
        // frizz only ever speaks as the user. Without it the trigger cannot tell "you stopped" from
        // "nothing is happening", which is how a worker-less thread was bumped every tick.
        lastAssistantAt: "2026-08-02T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  return { s, storage, slug, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("post-compaction: a compaction after arming delivers the linked doc, once, with its own trailer", async () => {
  const h = compactScheduler({ lastCompactionAt: "2026-08-02T01:00:00.000Z" })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /Re-read \.frizz\/threads\/sid\/plan\.md before continuing/)
    // The trailer is what tells the worker WHERE it is; the rest trigger's "sent each time you come to
    // rest" would be a lie here, and the chat parses these two apart into different dividers.
    assert.match(h.delivered[0], /your context was just compacted/)
    // The SAME compaction never fires twice, however many ticks run over it.
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "one delivery per compaction, not per tick")
  } finally { h.close() }
})

test("post-compaction: a SECOND compaction fires again, and the stamp reads back for the panel", async () => {
  let compactedAt = "2026-08-02T01:00:00.000Z"
  const h = compactScheduler({ get lastCompactionAt() { return compactedAt } } as Partial<SessionTelemetry>)
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.ok(h.storage.getSession(h.slug)!.recurring_compact_fired_at, "the panel's last-sent readout")
    compactedAt = "2026-08-02T02:00:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "a new compaction is a new event")
  } finally { h.close() }
})

// The case that would otherwise make switching the toggle on feel broken-in-reverse: a thread that
// compacted an hour ago is the COMMON case, and delivering for an event the operator never saw is not
// what "send it when my context is compacted" asked for.
test("post-compaction: a compaction that PREDATES the arming never fires", async () => {
  const h = compactScheduler(
    { lastCompactionAt: "2026-08-01T12:00:00.000Z" },
    { armedAt: "2026-08-02T00:00:00.000Z" },
  )
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// THE ONE PLACE IT PARTS COMPANY WITH THE REST TRIGGER. A compaction lands mid-turn, and a re-grounding
// that waits for the worker to stop has missed the window it was written for.
test("post-compaction: it fires MID-TURN, where the rest trigger would hold", async () => {
  const busy = compactScheduler({ turn: "in-flight", lastCompactionAt: "2026-08-02T01:00:00.000Z" })
  try {
    await busy.s.tick()
    assert.equal(busy.delivered.length, 1, "a busy thread is exactly the one that needs re-grounding")
  } finally { busy.close() }

  // ...and the rest trigger genuinely does hold on the same telemetry, which is what makes this a
  // difference in the scheduler rather than in this test's setup.
  const resting = scheduler({ turn: "in-flight" })
  try {
    await resting.s.tick()
    assert.deepEqual(resting.delivered, [], "the rest trigger waits for rest")
  } finally { resting.close() }
})

// Switching it off must drop a delivery the outbox is still holding — the same supersession rule its two
// siblings follow, and the reason an operator's "off" is immediate rather than one-more-time.
test("post-compaction: switching the trigger off supersedes a queued delivery", async () => {
  const h = compactScheduler({ lastCompactionAt: "2026-08-02T01:00:00.000Z" })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "Re-read .frizz/threads/sid/plan.md before continuing",
      stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false,
      intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z",
    })
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ---- A PENDING QUESTION, and the two different things it does ------------------------------------
// The stop hook asks a thread "you stopped — is there more?". A rest whose final message carries a
// ```question fence has ALREADY answered that: there is more, and it needs the human. Bumping it there
// makes the worker re-ask its own question with a paragraph of apology in front, and the operator gets
// the same card twice.
//
// UNLESS THE OPERATOR SAID OTHERWISE, which is the whole of Autonomous mode: "it needs the human" is
// only an answer while the thread is one that waits for the human. So the question limb tracks the same
// column the wider hold does, inverted — and the two rules that remain are:
//   the HARD one — a ```done fence, or an ```awaiting on a wake frizz itself will deliver, holds the
//   STOP HOOK always, whatever is configured (pinned elsewhere in this file);
//   the SWITCHED one (`pauseOnQuestions`) — ANY way of waiting on the human holds ALL THREE triggers,
//   and its OFF position additionally lets the at-rest bump cross a question fence.
//
// The harness defaults `pauseOnQuestions` to FALSE, so an `opts`-less case here is AUTONOMOUS.
const nativeAsk = { id: "ask-1", questions: [{ question: "Which one?", header: "Pick", multiSelect: false, options: [] }] } as SessionTelemetry["pendingAsk"]

// The maintainer's report, 2026-08-14: a thread with a Goal armed at rest and Autonomous mode ON came to
// rest on a ```question and was never bumped, though the panel's gloss promises exactly this delivery.
test("stop hook: AUTONOMOUS mode bumps a rest that ends in a question fence", async () => {
  const asking = scheduler({ pendingQuestion: true }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await asking.s.tick()
    assert.equal(asking.delivered.length, 1, "autonomous mode is the operator saying they are not coming to answer it")
    // And the delivery is WORDED for it. Handed the bare goal on top of its own unanswered question, the
    // honest move for a worker is to ask again — which is the duplicate card the hold existed to prevent.
    assert.match(asking.delivered[0], /AUTONOMOUS MODE/)
    assert.match(asking.delivered[0], /Do NOT re-ask it/)
  } finally { asking.close() }

  // The control, on identical telemetry but for the flag — without it this test would pass against a
  // scheduler that had simply started firing at everything.
  const held = scheduler({ pendingQuestion: true }, { now: at("2026-08-02T00:00:05.000Z"), pauseOnQuestions: true })
  try {
    await held.s.tick()
    assert.deepEqual(held.delivered, [], "with the hold armed the fence still answers the stop hook")
  } finally { held.close() }
})

// The extra clause is for the crossing ONLY. A worker bumped on an ordinary rest is mid-work and has no
// question outstanding; telling it not to re-ask one would be frizz inventing a state it is not in.
test("stop hook: an ordinary autonomous rest is bumped with the plain trailer", async () => {
  const quiet = scheduler({ pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await quiet.s.tick()
    assert.equal(quiet.delivered.length, 1)
    assert.doesNotMatch(quiet.delivered[0], /Do NOT re-ask it/)
  } finally { quiet.close() }
})

// Per-rest, exactly like ALLDONE: the flag rides the FINAL assistant message and the fold clears it on
// the next user record, so answering the question re-opens the trigger with nothing stored to undo.
test("stop hook: answering the question re-opens the trigger by itself", async () => {
  const answered = scheduler({ pendingQuestion: false }, { lastFiredAt: "2026-08-02T00:00:05.000Z", now: at("2026-08-02T00:00:20.000Z"), pauseOnQuestions: true })
  try {
    await answered.s.tick()
    assert.equal(answered.delivered.length, 1, "nothing was written when the fence held it, so nothing has to be cleared")
  } finally { answered.close() }
})

// THE OVERRIDE REACHES THE QUESTION LIMB AND NOTHING ELSE. `done` is the loop's off switch, and a park on
// a wake frizz itself will deliver is a duplicate wake rather than a rescue — neither becomes negotiable
// because the operator asked the thread to decide its own questions. Both rows below are AUTONOMOUS.
test("stop hook: autonomous mode does NOT reopen the done fence or a scheduler-owned park", async () => {
  const done = scheduler({ lastFence: { kind: "done", body: "shipped", hints: [] }, pendingQuestion: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await done.s.tick()
    assert.deepEqual(done.delivered, [], "a finished thread is finished in either mode")
  } finally { done.close() }

  // A REAL park: the fence names a shell this thread actually has running, so frizz can see the wait is
  // honest. (It used to name a `human:` gate — that kind is deleted, and a name matching nothing live is
  // no longer a park at all, so the case has to be built out of something checkable.)
  const parked = scheduler({
    lastFence: awaiting({ kind: "shell", value: "bzvtnt3ig" }),
    bgShells: [{ label: "the suite", startedAt: "2026-08-02T00:00:00.000Z", state: "running", id: "toolu_x", taskId: "bzvtnt3ig" }],
    pendingQuestion: false,
  }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await parked.s.tick()
    assert.deepEqual(parked.delivered, [], "bumping a park frizz can verify is measured harm, whatever the mode")
  } finally { parked.close() }
})

// The HARD rule is the FENCE and only the fence. A native ask is a different signal — the thread is
// frozen on a modal rather than resting on a written question — and holding it unconditionally would be
// a second, unasked-for policy. That is what the operator's toggle is for, one test down.
test("stop hook: a native ask alone does NOT hold it — that is the toggle's job", async () => {
  const asked = scheduler({ pendingAsk: nativeAsk }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await asked.s.tick()
    assert.equal(asked.delivered.length, 1)
  } finally { asked.close() }

  const held = scheduler({ pendingAsk: nativeAsk }, { now: at("2026-08-02T00:00:05.000Z"), pauseOnQuestions: true })
  try {
    await held.s.tick()
    assert.deepEqual(held.delivered, [], "the operator armed the hold, so a native ask holds it too")
  } finally { held.close() }
})

// A permission prompt is a question with a "Do you want to proceed?" on it. It counts. The panel seeds
// the hold ON, but the COLUMN defaults off — an existing row, an older caller — so both states have to
// behave, and the harness sets each explicitly rather than leaning on either default.
test("the question hold counts a permission prompt, and does nothing while it is off", async () => {
  const held = scheduler({ permPrompt: true }, { now: at("2026-08-02T00:00:05.000Z"), pauseOnQuestions: true })
  try {
    await held.s.tick()
    assert.deepEqual(held.delivered, [])
  } finally { held.close() }

  const unheld = scheduler({ permPrompt: true }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await unheld.s.tick()
    assert.equal(unheld.delivered.length, 1, "a row without the hold is not held")
  } finally { unheld.close() }
})

// The heartbeat is the trigger that consults NOTHING — rest, sub-agents, shells, all irrelevant. The
// hold is the one operator-set exception, and the fence rule deliberately is not: "it has been an hour"
// is not a question a pending fence answers.
test("the question hold suppresses the HEARTBEAT; a fence alone does not", async () => {
  const fenced = heartbeatScheduler({ pendingQuestion: true }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    await fenced.s.tick()
    assert.equal(fenced.delivered.length, 1, "the beat asks a different question")
  } finally { fenced.close() }

  const held = heartbeatScheduler({ pendingQuestion: true }, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    held.storage.setRecurringPromptBySlug(held.slug, {
      prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false,
      pauseOnQuestions: true, intervalMs: 3_600_000, armedAt: "2026-08-02T00:00:00.000Z",
    })
    await held.s.tick()
    assert.deepEqual(held.delivered, [])
  } finally { held.close() }
})

test("the question hold suppresses POST-COMPACTION too", async () => {
  const held = compactScheduler({ lastCompactionAt: "2026-08-02T01:00:00.000Z", pendingQuestion: true })
  try {
    held.storage.setRecurringPromptBySlug(held.slug, {
      prompt: "Re-read .frizz/threads/sid/plan.md before continuing",
      stopHook: false, heartbeat: false, postCompaction: true, pauseOnQuestions: true,
      intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z",
    })
    await held.s.tick()
    assert.deepEqual(held.delivered, [])
  } finally { held.close() }

  const unheld = compactScheduler({ lastCompactionAt: "2026-08-02T01:00:00.000Z", pendingQuestion: true })
  try {
    await unheld.s.tick()
    assert.equal(unheld.delivered.length, 1, "off by default, and a compaction does not wait for an answer")
  } finally { unheld.close() }
})

// The hold changes neither the words nor the cadence, so a delivery already queued still describes the
// row exactly. Flipping it must not mint a generation or drop a "last sent" stamp — which would make the
// panel's readout lie and re-send a bump the operator already watched land.
test("storage: flipping the question hold keeps the generation and the last-fired stamp", () => {
  const f = fixture()
  try {
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: false, intervalMs: null, armedAt: "2026-08-02T00:00:00.000Z" })
    const armedAt = f.row().recurring_armed_at
    f.storage.stampRecurringRestFired(f.slug, armedAt!, "2026-08-02T00:05:00.000Z")
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: true, intervalMs: null, armedAt: "2026-08-02T00:10:00.000Z" })
    assert.equal(f.row().recurring_pause_on_questions, 1)
    assert.equal(f.row().recurring_armed_at, armedAt, "the hold is not a re-arming")
    assert.equal(f.row().recurring_rest_fired_at, "2026-08-02T00:05:00.000Z")
    // And it is cleared with everything else, so no row can hold a live hold over no prompt.
    f.storage.setRecurringPromptIfCurrent(f.slug, "sid", 0, { prompt: null, stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: true, intervalMs: null, armedAt: "2026-08-02T00:12:00.000Z" })
    assert.equal(f.row().recurring_pause_on_questions, 0)
  } finally {
    f.close()
  }
})

// A SIGNED-OUT PROVIDER answers in milliseconds, so the auth failure is a real assistant message and
// therefore a real rest — which satisfies every other guard. Measured on a live stack: the bump fired
// ten times in a hundred seconds against a thread whose worker could only ever reply "Not logged in".
// Re-prompting cannot help; the thread already cards its auth fault and the sign-in recovery.
test("an auth-faulted thread is never re-prompted — the Goal cannot fix a signed-out provider", async () => {
  const h = scheduler({ authFault: "authentication_rejected" } as never)
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})
