// The stop hook's two SERVER-side invariants (scheduler.ts SOURCE 5), each of which is a way the
// feature could silently loop forever or silently stop:
//
//   1. the fold's sentinel lifecycle — AWAITING only means "nothing actionable" while it is the FINAL
//      word, so a later message that omits it must re-open the loop by itself;
//   2. the row's GENERATION — editing the text supersedes a bump already queued for the old words,
//      while merely toggling off and on must NOT (that would re-send a bump the operator watched land).
//
// The end-to-end proof that a real agent is bumped at rest, bumped again at its NEXT rest, and left
// alone once it answers AWAITING lives in backend/_live_stop_hook.mts — a live probe, not a unit
// test, because the only thing worth asserting there is what a real worker does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"

const assistant = (text: string, at = "2026-08-02T00:00:01.000Z") => ({
  type: "assistant",
  timestamp: at,
  message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
})

test("fold: AWAITING on the final assistant message sets the flag; the next message without it clears it", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, assistant("Checked the queue — nothing to pick up.\n\nAWAITING"))
  assert.equal(s.lastAssistantAwaiting, true)
  // The loop re-opens purely from the fold: a later rest message that does not carry the sentinel is
  // an agent that has something to say again, and nothing had to be stored or cleared to notice.
  applyRecord(s, assistant("Actually the build just broke — looking at it.", "2026-08-02T00:00:02.000Z"))
  assert.equal(s.lastAssistantAwaiting, false)
})

test("fold: any user record supersedes a standing AWAITING — the operator's next word re-opens the loop", () => {
  const s = newTailState("t", "sid", "/x")
  applyRecord(s, assistant("AWAITING"))
  assert.equal(s.lastAssistantAwaiting, true)
  applyRecord(s, {
    type: "user",
    timestamp: "2026-08-02T00:00:03.000Z",
    message: { content: [{ type: "text", text: "one more thing" }] },
  })
  assert.equal(s.lastAssistantAwaiting, false)
})

// The normalized (codex) path folds the same fact off its own event union, so a codex thread must not
// be a thread whose stop hook can never be closed.
test("fold: the normalized event path derives AWAITING from the final text too", () => {
  const s = newTailState("t", "sid", "/x")
  applyEvent(s, { kind: "turn-end", at: "2026-08-02T00:00:01.000Z", finalText: "Nothing to do here.\nAWAITING" })
  assert.equal(s.lastAssistantAwaiting, true)
  applyEvent(s, { kind: "user-message", at: "2026-08-02T00:00:02.000Z", text: "go on", synthetic: false })
  assert.equal(s.lastAssistantAwaiting, false)
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

// ---- Adopting a pre-removal heartbeat ------------------------------------------------------------
// The interval heartbeat was removed 2026-08-02, and a database written before that still carries its
// columns AND whatever was armed in them. Nothing reads those columns any more, so without this
// migration a live autonomous loop would just go quiet at the upgrade with no trace on any surface.
//
// These tests build the legacy shape for real — the old columns added back onto a fresh database, a row
// written through them — and then reopen it, which is exactly what a server boot does.
function legacyDb() {
  const dir = mkdtempSync(join(tmpdir(), "fray-legacy-hb-"))
  const path = join(dir, "ui.db")
  const seed = createStorage(path)
  seed.upsertSession({
    slug: "old", session_id: "sid", tmux_name: "fray-old", spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: "old", state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  seed.close()
  // The four columns as they existed before the removal, re-added onto the row above.
  const raw = new DatabaseSync(path)
  for (const col of [
    "heartbeat_prompt TEXT",
    "heartbeat_interval_ms INTEGER",
    "heartbeat_paused INTEGER NOT NULL DEFAULT 0",
    "heartbeat_armed_at TEXT",
    "heartbeat_last_fired_at TEXT",
  ]) {
    try { raw.exec(`ALTER TABLE session ADD COLUMN ${col}`) } catch { /* already present */ }
  }
  return { path, raw, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("migration: a RUNNING heartbeat is adopted as an ENABLED stop hook, and the old row is cleared", () => {
  const { path, raw, cleanup } = legacyDb()
  try {
    raw.exec(`UPDATE session SET heartbeat_prompt = 'keep the epic moving', heartbeat_interval_ms = 900000,
      heartbeat_paused = 0, heartbeat_armed_at = '2026-08-01T00:00:00.000Z' WHERE slug = 'old'`)
    raw.close()

    const storage = createStorage(path) // ← the boot that migrates
    const row = storage.getSession("old")!
    assert.equal(row.stop_hook, "keep the epic moving", "the worker's own text carries over verbatim")
    assert.equal(row.stop_hook_enabled, 1, "a heartbeat that was running keeps running")
    assert.ok(row.stop_hook_armed_at, "and it is armed as of the migration, not of the old beat")
    assert.equal(row.stop_hook_last_fired_at, null, "the new hook has never fired")
    storage.close()

    // The source is cleared, which is what makes this one-shot. Read RAW: those columns are gone from
    // SessionRow (that is the point of the removal), so the typed row cannot see them.
    const check = new DatabaseSync(path, { readOnly: true })
    const legacyRow = check.prepare("SELECT heartbeat_prompt, heartbeat_armed_at FROM session WHERE slug = 'old'").get() as {
      heartbeat_prompt: string | null
      heartbeat_armed_at: string | null
    }
    check.close()
    assert.equal(legacyRow.heartbeat_prompt, null)
    assert.equal(legacyRow.heartbeat_armed_at, null)

    // Re-open: nothing further to adopt, and the adopted hook is untouched.
    const again = createStorage(path)
    assert.equal(again.getSession("old")!.stop_hook, "keep the epic moving")
    assert.equal(again.getSession("old")!.stop_hook_enabled, 1)
    again.close()
  } finally {
    cleanup()
  }
})

test("migration: a PAUSED heartbeat is adopted DISABLED — it keeps its text and fires nothing", () => {
  const { path, raw, cleanup } = legacyDb()
  try {
    raw.exec(`UPDATE session SET heartbeat_prompt = 'silenced', heartbeat_interval_ms = 60000,
      heartbeat_paused = 1, heartbeat_armed_at = '2026-08-01T00:00:00.000Z' WHERE slug = 'old'`)
    raw.close()
    const storage = createStorage(path)
    const row = storage.getSession("old")!
    assert.equal(row.stop_hook, "silenced")
    assert.equal(row.stop_hook_enabled, 0, "a beat the human had silenced must not start firing on upgrade")
    storage.close()
  } finally {
    cleanup()
  }
})

test("migration: an existing stop hook is never clobbered, and a bare/unarmed heartbeat is ignored", () => {
  const { path, raw, cleanup } = legacyDb()
  try {
    // A row that already has the operator's own hook plus a stale heartbeat: the operator's wins.
    raw.exec(`UPDATE session SET stop_hook = 'mine', stop_hook_enabled = 1, stop_hook_armed_at = '2026-08-02T00:00:00.000Z',
      heartbeat_prompt = 'theirs', heartbeat_armed_at = '2026-08-01T00:00:00.000Z' WHERE slug = 'old'`)
    raw.close()
    const storage = createStorage(path)
    assert.equal(storage.getSession("old")!.stop_hook, "mine")
    storage.close()
  } finally {
    cleanup()
  }
})

// The migration reads columns that a fresh database does not have, so this pins BOTH halves of that:
// the columns really are gone from new schemas (the removal was not a no-op), and their absence is not
// an error at boot.
test("migration: a fresh database has no legacy columns at all, and boots clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-fresh-"))
  const path = join(dir, "ui.db")
  try {
    const storage = createStorage(path)
    storage.close()
    const raw = new DatabaseSync(path)
    const cols = (raw.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>).map((c) => c.name)
    raw.close()
    assert.ok(!cols.some((c) => c.startsWith("heartbeat_")), `fresh schema still carries: ${cols.filter((c) => c.startsWith("heartbeat_")).join(", ")}`)
    assert.ok(cols.includes("stop_hook") && cols.includes("stop_hook_enabled"), "and it does carry the stop hook's own columns")
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

test("heartbeat: a rest INSIDE the interval is not bumped, and the same rest is bumped once it completes", async () => {
  // Fired at 00:00; the worker crashed straight back to rest. Nine minutes later: still inside.
  const early = scheduler({}, { lastFiredAt: "2026-08-02T00:00:00.000Z", now: at("2026-08-02T00:09:00.000Z") })
  try {
    await early.s.tick()
    assert.deepEqual(early.delivered, [], "a thread that rests instantly must not be hammered")
  } finally { early.close() }

  // The clock completing is enough on its own — no new activity is needed to release the bump.
  const due = scheduler({}, { lastFiredAt: "2026-08-02T00:00:00.000Z", now: () => Date.parse("2026-08-02T00:00:00.000Z") + HEARTBEAT_MS })
  try {
    await due.s.tick()
    assert.equal(due.delivered.length, 1, "once the timer completes the waiting rest is bumped")
  } finally { due.close() }
})

// The interval is measured from the last FIRING, not from this rest, so time the worker spent WORKING
// counts toward it. A turn that outlasts the interval is therefore bumped the instant it stops — which
// is the behaviour that makes a long autonomous effort keep moving without a stutter after every turn.
test("heartbeat: a turn LONGER than the interval is bumped the moment it rests", async () => {
  const h = scheduler({}, { lastFiredAt: "2026-08-02T00:00:00.000Z", now: at("2026-08-02T00:40:00.000Z") })
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
  } finally { h.close() }
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

test("AWAITING holds the bump for that rest only, and nothing is stored to undo", async () => {
  const held = scheduler({ lastAssistantAwaiting: true }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await held.s.tick()
    assert.deepEqual(held.delivered, [])
  } finally { held.close() }

  // The same thread one rest later, having said something else: bumped as normal.
  const resumed = scheduler({ lastAssistantAwaiting: false }, { now: at("2026-08-02T00:00:05.000Z") })
  try {
    await resumed.s.tick()
    assert.equal(resumed.delivered.length, 1)
  } finally { resumed.close() }
})
