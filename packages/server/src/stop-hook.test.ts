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
