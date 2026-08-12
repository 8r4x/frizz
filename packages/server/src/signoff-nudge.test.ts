// THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9) — frizz's own stop hook, always on and invisible.
//
// It exists to make ONE invariant true: every item in the queue is a question you can answer or a
// checkmark you can archive. So it fires on exactly one thing — a rest that carried NO fence — and on
// nothing else. Every test here is a way that could go wrong: nudging a thread that DID sign off (which
// arrives after a ```done and reads as frizz not having noticed), or nudging one forever (a nag loop
// frizz itself generates).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"

function nudger(tele: Partial<SessionTelemetry>, opts: { setting?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-signoff-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "resting"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  if (opts.setting) storage.setSetting("signoffNudge", opts.setting)
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-12T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  return { s, storage, slug, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a rest with no fence is told how to sign off, and the text names all three ways", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /```question/)
    assert.match(h.delivered[0], /```done/)
    assert.match(h.delivered[0], /mcp__frizz__watch/)
    // `done` must arrive with its COST attached, or it becomes the cheapest way to stop being nudged —
    // the exact failure the retired ALLDONE warning existed for.
    assert.match(h.delivered[0], /DISMISSAL/)
    // And the shape the maintainer asked for, since this is the one place it is guaranteed to be read.
    assert.match(h.delivered[0], /one to three sentences, then bullets/)
  } finally { h.close() }
})

// A thread that signed off is not an untriageable item, whichever way it signed off. `awaiting` counts
// too while it still exists — it is a legitimate answer to "where do you stand".
for (const [what, tele] of [
  ["a done fence", { lastFence: { kind: "done" as const, body: "", hints: [] } }],
  ["an awaiting fence", { lastFence: { kind: "awaiting" as const, body: "", hints: [] } }],
  ["a question fence", { pendingQuestion: true }],
  ["a native ask", { pendingAsk: { id: "a1", questions: [] } }],
  ["a permission prompt", { permPrompt: true }],
  ["the legacy ALLDONE sentinel", { lastAssistantAllDone: true }],
] as Array<[string, Partial<SessionTelemetry>]>) {
  test(`${what} is already a sign-off, so nothing is injected`, async () => {
    const h = nudger(tele)
    try {
      await h.s.tick()
      assert.deepEqual(h.delivered, [])
    } finally { h.close() }
  })
}

// A thread that is still working has not failed to sign off — it has not finished.
test("a busy thread is never nudged", async () => {
  const h = nudger({ turn: "in-flight" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ONE PER REST falls out of the delivery id being bound to the rest instant — no counter needed for it.
test("one nudge per rest, however many ticks run over it", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
  } finally { h.close() }
})

// THE CONSECUTIVE CAP. Without it, an agent that keeps resting bare is told forever — a nag loop frizz
// itself generates. After the cap it gives up and the item sits in the queue as a plain bare rest,
// which is exactly the behaviour that existed before this source.
test("the cap stops a nag loop, and the human's next word re-opens the allowance", async () => {
  let restedAt = "2026-08-12T00:00:00.000Z"
  let lastUserAt: string | undefined = "2026-08-12T00:00:00.000Z"
  const h = nudger({
    get lastActivityAt() { return restedAt },
    get lastUserAt() { return lastUserAt },
  } as Partial<SessionTelemetry>)
  try {
    // Three consecutive bare rests; only the first two are nudged.
    await h.s.tick()
    restedAt = "2026-08-12T00:01:00.000Z"
    await h.s.tick()
    restedAt = "2026-08-12T00:02:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, `capped at 2 consecutive`)
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 2)

    // The human speaks: a new task, so the count was about the old one.
    lastUserAt = "2026-08-12T00:03:00.000Z"
    restedAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 3, "a new word from the human re-opens it")
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 1, "and restarts the count")
  } finally { h.close() }
})

// It lands on every live thread at once, so there has to be a way to stop it that is not a code change.
test("the kill switch silences it everywhere", async () => {
  const h = nudger({}, { setting: "off" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})
