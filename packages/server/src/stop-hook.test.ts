// The stop hook's two SERVER-side invariants (scheduler.ts SOURCE 5), each of which is a way the
// feature could silently loop forever or silently stop:
//
//   1. the fold's sentinel lifecycle — ALLDONE only means "nothing actionable" while it is the FINAL
//      word, so a later message that omits it must re-open the loop by itself;
//   2. the row's GENERATION — editing the text supersedes a bump already queued for the old words,
//      while merely toggling off and on must NOT (that would re-send a bump the operator watched land).
//
// The end-to-end proof that a real agent is bumped at rest, bumped again at its NEXT rest, and left
// alone once it answers ALLDONE lives in backend/_live_stop_hook.mts — a live probe, not a unit
// test, because the only thing worth asserting there is what a real worker does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"
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
  const dir = mkdtempSync(join(tmpdir(), "fray-stophook-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "stophook-t"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `fray-${slug}`, spawned_at: new Date().toISOString(),
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
    assert.equal(f.storage.setStopHookIfCurrent(f.slug, "sid", 0, "keep going", true, "2026-08-02T00:00:00.000Z"), true)
    const armedAt = f.row().stop_hook_armed_at
    assert.equal(armedAt, "2026-08-02T00:00:00.000Z")
    f.storage.stampStopHookFired(f.slug, armedAt!, "2026-08-02T00:05:00.000Z")

    f.storage.setStopHookIfCurrent(f.slug, "sid", 0, "keep going", false, "2026-08-02T00:10:00.000Z")
    assert.equal(f.row().stop_hook_enabled, 0)
    assert.equal(f.row().stop_hook_armed_at, armedAt, "an off/on flip is not a re-arming")
    f.storage.setStopHookIfCurrent(f.slug, "sid", 0, "keep going", true, "2026-08-02T00:11:00.000Z")
    assert.equal(f.row().stop_hook_enabled, 1)
    assert.equal(f.row().stop_hook_armed_at, armedAt)
    // The rate floor survives the flip too — otherwise toggling would be a way to bypass it.
    assert.equal(f.row().stop_hook_last_fired_at, "2026-08-02T00:05:00.000Z")
  } finally {
    f.close()
  }
})

test("storage: EDITING the text mints a new generation and drops the last-fired stamp", () => {
  const f = fixture()
  try {
    f.storage.setStopHookIfCurrent(f.slug, "sid", 0, "keep going", true, "2026-08-02T00:00:00.000Z")
    f.storage.stampStopHookFired(f.slug, f.row().stop_hook_armed_at!, "2026-08-02T00:05:00.000Z")
    f.storage.setStopHookIfCurrent(f.slug, "sid", 0, "do something else", true, "2026-08-02T00:10:00.000Z")
    assert.equal(f.row().stop_hook_armed_at, "2026-08-02T00:10:00.000Z", "new words are a new generation")
    assert.equal(f.row().stop_hook_last_fired_at, null, "and the new words have never fired")
  } finally {
    f.close()
  }
})

test("storage: a null prompt clears the whole row, and a stale session/generation writes nothing", () => {
  const f = fixture()
  try {
    f.storage.setStopHookIfCurrent(f.slug, "sid", 0, "keep going", true, "2026-08-02T00:00:00.000Z")
    assert.equal(
      f.storage.setStopHookIfCurrent(f.slug, "other-sid", 0, "hijack", true, "2026-08-02T00:01:00.000Z"),
      false,
      "a tab looking at a superseded session fails closed",
    )
    assert.equal(f.row().stop_hook, "keep going")
    f.storage.setStopHookIfCurrent(f.slug, "sid", 0, null, true, "2026-08-02T00:02:00.000Z")
    assert.equal(f.row().stop_hook, null)
    assert.equal(f.row().stop_hook_armed_at, null)
    assert.equal(f.row().stop_hook_enabled, 0, "a cleared row can never read as enabled")
  } finally {
    f.close()
  }
})

// ---- The worker's own path to the same row ------------------------------------------------------
// `mcp__fray__stop_hook` writes by SLUG ALONE, with no session/generation guard, because the MCP server
// cannot satisfy one: it is spawned with its thread's slug and keeps it across every resume while the
// session id bumps underneath. These pin that the unguarded path behaves identically to the operator's
// on everything EXCEPT the guard — same generation semantics, same clear.
test("storage: the worker path writes by slug alone, across a session change the operator path rejects", () => {
  const f = fixture()
  try {
    // A resume: the row now belongs to a new session and generation, exactly as after a restart.
    f.storage.upsertSession({
      slug: f.slug, session_id: "sid-2", tmux_name: `fray-${f.slug}`, spawned_at: new Date().toISOString(),
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
      title: f.slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
    } as SessionRow)

    // The operator path, holding the OLD session id, correctly fails closed.
    assert.equal(
      f.storage.setStopHookIfCurrent(f.slug, "sid", 0, "stale tab", true, "2026-08-02T00:00:00.000Z"),
      false,
      "a browser tab that has fallen behind must not write",
    )
    // The worker path, which only ever knew the slug, still reaches its own row.
    assert.equal(
      f.storage.setStopHookBySlug(f.slug, "keep going", true, "2026-08-02T00:01:00.000Z"),
      true,
      "the tool must survive the resume it was armed before",
    )
    assert.equal(f.row().stop_hook, "keep going")
    assert.equal(f.row().stop_hook_enabled, 1)
  } finally {
    f.close()
  }
})

test("storage: the worker path keeps the generation on a re-arm with the SAME text, and clears on null", () => {
  const f = fixture()
  try {
    f.storage.setStopHookBySlug(f.slug, "keep going", true, "2026-08-02T00:00:00.000Z")
    const armedAt = f.row().stop_hook_armed_at
    f.storage.stampStopHookFired(f.slug, armedAt!, "2026-08-02T00:05:00.000Z")

    // A worker that re-registers on resume must not supersede a bump already queued for those words.
    f.storage.setStopHookBySlug(f.slug, "keep going", true, "2026-08-02T00:10:00.000Z")
    assert.equal(f.row().stop_hook_armed_at, armedAt, "same text ⇒ same generation")
    assert.equal(f.row().stop_hook_last_fired_at, "2026-08-02T00:05:00.000Z", "and the rate floor survives")

    // New words ARE a new generation, same as the operator path.
    f.storage.setStopHookBySlug(f.slug, "do something else", true, "2026-08-02T00:11:00.000Z")
    assert.equal(f.row().stop_hook_armed_at, "2026-08-02T00:11:00.000Z")
    assert.equal(f.row().stop_hook_last_fired_at, null)

    // `action: "stop"` — the worker ending its own loop deliberately.
    f.storage.setStopHookBySlug(f.slug, null, false, "2026-08-02T00:12:00.000Z")
    assert.equal(f.row().stop_hook, null)
    assert.equal(f.row().stop_hook_armed_at, null)
    assert.equal(f.row().stop_hook_enabled, 0)
  } finally {
    f.close()
  }
})

// ---- The heartbeat, and what holds a bump ------------------------------------------------------
// The firing rule in full: a bump fires as soon as the thread RESTS, and firing starts a fixed timer;
// nothing fires again until it completes. These drive the REAL scheduler pass over REAL storage with
// only the tailer stubbed (it is the input being varied), and `now` injected so the clock is exact.
const HEARTBEAT_MS = 10 * 60_000

function scheduler(tele: Partial<SessionTelemetry>, opts: { lastFiredAt?: string; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fray-hb-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "hooked"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `fray-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  storage.setStopHookBySlug(slug, "keep going", true, "2026-08-02T00:00:00.000Z")
  if (opts.lastFiredAt) storage.stampStopHookFired(slug, storage.getSession(slug)!.stop_hook_armed_at!, opts.lastFiredAt)
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-02T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  return { s, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const at = (iso: string) => () => Date.parse(iso)
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

// ---- The HEARTBEAT (scheduler SOURCE 4) ----------------------------------------------------------
// The dumb sibling. Everything the stop hook consults, this ignores — that is its entire contract, and
// these are the tests that would catch it quietly growing a condition.
function heartbeatScheduler(tele: Partial<SessionTelemetry>, opts: { intervalMs?: number; armedAt?: string; lastFiredAt?: string; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fray-beat-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "beating"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `fray-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  storage.setHeartbeatBySlug(slug, "check the deploy", opts.intervalMs ?? 3_600_000, true, opts.armedAt ?? "2026-08-02T00:00:00.000Z")
  if (opts.lastFiredAt) storage.stampHeartbeatFired(slug, storage.getSession(slug)!.heartbeat_armed_at!, opts.lastFiredAt)
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    ...(opts.now ? { now: opts.now } : {}),
    tailer: {
      get: () => ({
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
    assert.match(due.delivered[0], /Heartbeat — sent every 1 hr/, "and the trailer names the cadence")
    assert.match(due.delivered[0], /permanently stalls/, "and warns about the opt-out it offers")
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

test("heartbeat: a DISABLED heartbeat fires nothing but keeps its schedule and text", async () => {
  const h = heartbeatScheduler({}, { now: at("2026-08-02T01:00:00.000Z") })
  try {
    h.storage.setHeartbeatBySlug(h.slug, "check the deploy", 3_600_000, false, "2026-08-02T00:00:00.000Z")
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    const row = h.storage.getSession(h.slug)!
    assert.equal(row.heartbeat_prompt, "check the deploy", "the text survives the toggle")
    assert.equal(row.heartbeat_interval_ms, 3_600_000, "and so does the schedule")
  } finally { h.close() }
})

// The generation rule, which is what stops a re-arming worker from stacking beats or resetting its own
// clock on every resume.
test("heartbeat: the generation survives a bare toggle flip and is minted by a schedule change", async () => {
  const h = heartbeatScheduler({})
  try {
    const gen = h.storage.getSession(h.slug)!.heartbeat_armed_at
    h.storage.stampHeartbeatFired(h.slug, gen!, "2026-08-02T00:05:00.000Z")

    h.storage.setHeartbeatBySlug(h.slug, "check the deploy", 3_600_000, false, "2026-08-02T02:00:00.000Z")
    h.storage.setHeartbeatBySlug(h.slug, "check the deploy", 3_600_000, true, "2026-08-02T02:00:01.000Z")
    assert.equal(h.storage.getSession(h.slug)!.heartbeat_armed_at, gen, "off/on is not a re-arming")
    assert.equal(h.storage.getSession(h.slug)!.heartbeat_last_fired_at, "2026-08-02T00:05:00.000Z", "so the clock is not reset either")

    // Same text, NEW schedule: a real change, so a new generation and a fresh clock.
    h.storage.setHeartbeatBySlug(h.slug, "check the deploy", 900_000, true, "2026-08-02T03:00:00.000Z")
    assert.equal(h.storage.getSession(h.slug)!.heartbeat_armed_at, "2026-08-02T03:00:00.000Z")
    assert.equal(h.storage.getSession(h.slug)!.heartbeat_last_fired_at, null)

    // Clearing empties the row.
    h.storage.setHeartbeatBySlug(h.slug, null, null, false, "2026-08-02T04:00:00.000Z")
    const cleared = h.storage.getSession(h.slug)!
    assert.equal(cleared.heartbeat_prompt, null)
    assert.equal(cleared.heartbeat_armed_at, null)
    assert.equal(cleared.heartbeat_interval_ms, null)
  } finally { h.close() }
})
