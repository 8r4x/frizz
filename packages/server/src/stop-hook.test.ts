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
import { DatabaseSync } from "node:sqlite"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState } from "./tailer.ts"

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
