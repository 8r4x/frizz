// THE WATCHER REGISTRY (storage half). One row per thing a thread is waiting on, so a wait finally has
// an IDENTITY — the property the ```awaiting fence could not have, because that fence is derived from
// the final assistant message and any newer record wipes it.
//
// What these pin is the lifecycle, because every one of its edges is a way a wait could silently outlive
// its thread or silently vanish from under the scheduler: only an ARMED row moves, a drop is scoped to
// the owning slug, a settled row is terminal, and the rows die with the session they belong to.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"
import { armDefaultGoal } from "./dispatch.ts"
import { resolveRecurringPrompt } from "./board.ts"
import { DEFAULT_GOAL_TRIGGERS, DEFAULT_RECURRING_PROMPT } from "@frizz/shared"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-watch-"))
  const storage = createStorage(join(dir, "ui.db"))
  const add = (slug: string) =>
    storage.upsertSession({
      slug, session_id: `sid-${slug}`, tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
      title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
    } as SessionRow)
  add("watcher")
  add("other")
  return { storage, close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const arm = (f: ReturnType<typeof fixture>, over: Partial<Parameters<typeof f.storage.armThreadWatch>[0]> = {}) =>
  f.storage.armThreadWatch({ id: "w1", slug: "watcher", kind: "pr", target: "acme/app#391", createdAtMs: 1000, ...over })

test("an armed watcher reads back on its own thread, and only there", () => {
  const f = fixture()
  try {
    arm(f)
    const [row] = f.storage.listThreadWatches("watcher", { armedOnly: true })
    assert.equal(row?.id, "w1")
    assert.equal(row?.kind, "pr")
    assert.equal(row?.target, "acme/app#391")
    assert.equal(row?.state, "armed")
    assert.equal(row?.cursor, null, "a fresh watcher has seen nothing yet")
    assert.deepEqual(f.storage.listThreadWatches("other"), [], "a watcher belongs to ONE thread")
  } finally { f.close() }
})

test("a thread holds MANY watchers at once — that is why this is a table", () => {
  const f = fixture()
  try {
    arm(f)
    arm(f, { id: "w2", kind: "ci", target: "acme/app#391" })
    arm(f, { id: "w3", kind: "shell", target: "vite dev", createdAtMs: 2000 })
    assert.deepEqual(f.storage.listThreadWatches("watcher", { armedOnly: true }).map((w) => w.id), ["w1", "w2", "w3"])
  } finally { f.close() }
})

// The dismissal the fence never had. Scoped to the slug so a worker can only ever drop its OWN.
test("drop settles an armed watcher, and only its owner can do it", () => {
  const f = fixture()
  try {
    arm(f)
    assert.equal(f.storage.dropThreadWatch("other", "w1", 2000), false, "a different thread cannot drop it")
    assert.equal(f.storage.getThreadWatch("w1")?.state, "armed")
    assert.equal(f.storage.dropThreadWatch("watcher", "w1", 2000), true)
    assert.equal(f.storage.getThreadWatch("w1")?.state, "dropped")
    assert.equal(f.storage.getThreadWatch("w1")?.settled_at, 2000)
    assert.deepEqual(f.storage.listThreadWatches("watcher", { armedOnly: true }), [], "and it leaves the armed set")
    // Terminal: dropping it again is a no-op rather than a rewrite of when it settled.
    assert.equal(f.storage.dropThreadWatch("watcher", "w1", 9999), false)
    assert.equal(f.storage.getThreadWatch("w1")?.settled_at, 2000)
  } finally { f.close() }
})

test("firing is terminal too, and a dropped watcher can never fire afterwards", () => {
  const f = fixture()
  try {
    arm(f)
    assert.equal(f.storage.markThreadWatchFired("w1", 3000), true)
    assert.equal(f.storage.getThreadWatch("w1")?.state, "fired")
    assert.equal(f.storage.markThreadWatchFired("w1", 4000), false, "one wake per watcher, whatever ticks")

    arm(f, { id: "w2" })
    f.storage.dropThreadWatch("watcher", "w2", 3000)
    assert.equal(f.storage.markThreadWatchFired("w2", 4000), false, "a dropped wait must not be resurrected by a poll")
  } finally { f.close() }
})

// The cursor is how a `pr` watcher knows what counts as NEW. It is guarded on `armed` for the same
// reason firing is: a poll that lands after the worker dropped the row must not write to it.
test("the cursor persists while armed, and stops being writable once settled", () => {
  const f = fixture()
  try {
    arm(f)
    assert.equal(f.storage.setThreadWatchCursor("w1", "2026-08-12T00:00:00.000Z"), true)
    assert.equal(f.storage.getThreadWatch("w1")?.cursor, "2026-08-12T00:00:00.000Z")
    f.storage.dropThreadWatch("watcher", "w1", 5000)
    assert.equal(f.storage.setThreadWatchCursor("w1", "later"), false)
    assert.equal(f.storage.getThreadWatch("w1")?.cursor, "2026-08-12T00:00:00.000Z")
  } finally { f.close() }
})

// The scheduler's one read per tick: every armed watcher on the machine, across threads.
test("armedThreadWatches spans threads and excludes everything settled", () => {
  const f = fixture()
  try {
    arm(f)
    arm(f, { id: "w2", slug: "other", kind: "shell", target: "nub run test", createdAtMs: 1500 })
    arm(f, { id: "w3", createdAtMs: 1800 })
    f.storage.markThreadWatchFired("w3", 2000)
    assert.deepEqual(f.storage.armedThreadWatches().map((w) => w.id), ["w1", "w2"])
  } finally { f.close() }
})

// A watcher on a thread that no longer exists has nothing to wake, and the scheduler would otherwise
// poll it on every tick forever.
test("removing a session takes its watchers with it", () => {
  const f = fixture()
  try {
    arm(f)
    arm(f, { id: "w2", slug: "other", kind: "ci", target: "acme/app#7" })
    f.storage.forgetSession("watcher")
    assert.equal(f.storage.getThreadWatch("w1"), undefined)
    assert.equal(f.storage.getThreadWatch("w2")?.state, "armed", "the other thread's watcher is untouched")
  } finally { f.close() }
})

// ---- SOURCE 8: the wake ---------------------------------------------------------------------------
// The shell watcher driven through the REAL scheduler pass over REAL storage, with only the tailer
// stubbed — it is the input being varied. What these pin is the rule that makes the watcher trustworthy:
// absence of a shell means "finished" ONLY after it has been observed alive.
function watchScheduler(shells: Array<{ id?: string; label: string; state: "running" | "stale" }>, opts: { tele?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-watchsched-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "watching"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  storage.armThreadWatch({ id: "w1", slug, kind: "shell", target: "vite dev", createdAtMs: 1000 })
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    tailer: {
      get: () => opts.tele === false ? undefined : ({
        turn: "idle", lastActivityAt: "2026-08-12T00:00:00.000Z",
        subAgents: [], bgShells: shells.map((sh) => ({ startedAt: "2026-08-12T00:00:00.000Z", ...sh })),
        pendingQuestion: false, permPrompt: false,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  return { s, storage, delivered, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("a shell watcher fires only once its target has been SEEN ALIVE and then goes", async () => {
  // Registered a beat before the shell appears: nothing has been observed, so nothing is claimed.
  const early = watchScheduler([])
  try {
    await early.s.tick()
    assert.deepEqual(early.delivered, [], "absence alone is not completion")
    assert.equal(early.storage.getThreadWatch("w1")?.state, "armed")
  } finally { early.close() }

  // Observed alive: still nothing to say, but the sighting is now durable on the row.
  const live = watchScheduler([{ id: "sh1", label: "vite dev", state: "running" }])
  try {
    await live.s.tick()
    assert.deepEqual(live.delivered, [])
    assert.equal(live.storage.getThreadWatch("w1")?.cursor, "seen")
  } finally { live.close() }
})

test("once seen, the shell going away wakes the thread exactly once and settles the row", async () => {
  const h = watchScheduler([])
  try {
    h.storage.setThreadWatchCursor("w1", "seen")
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /background shell you were waiting on has finished/)
    // The reply must say the registration is SPENT, or the worker rests expecting a second wake.
    assert.match(h.delivered[0], /no longer armed/)
    assert.equal(h.storage.getThreadWatch("w1")?.state, "fired")
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "one wake per watcher, whatever ticks")
  } finally { h.close() }
})

// Telemetry we cannot read is INDETERMINATE. Reading it as "gone" would fire every armed shell watcher
// on the machine the moment the tailer hiccups.
test("unreadable telemetry never counts as the shell finishing", async () => {
  const h = watchScheduler([], { tele: false })
  try {
    h.storage.setThreadWatchCursor("w1", "seen")
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.equal(h.storage.getThreadWatch("w1")?.state, "armed")
  } finally { h.close() }
})

// The worker's own withdrawal beats the poll: a dropped watcher must never wake anyone.
test("a dropped watcher is not woken, however many ticks run over it", async () => {
  const h = watchScheduler([])
  try {
    h.storage.setThreadWatchCursor("w1", "seen")
    h.storage.dropThreadWatch("watching", "w1", 2000)
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// A watcher matches by id OR by label, because the worker names its shells either way.
test("the target matches a shell's id as well as its label", async () => {
  const h = watchScheduler([{ id: "vite dev", label: "something else", state: "running" }])
  try {
    await h.s.tick()
    assert.equal(h.storage.getThreadWatch("w1")?.cursor, "seen", "matched on id")
  } finally { h.close() }
})

// ---- EVERY NEW THREAD IS BORN WITH A GOAL ---------------------------------------------------------
// Maintainer 2026-08-12: "A new chat should have the recurring prompt enabled, and the heart icon
// should be yellow." Before this, dispatch armed nothing — a freshly spawned thread had no Goal row at
// all, so its footer mark was grey and the stop hook never fired until someone opened the panel.
test("armDefaultGoal arms a brand-new thread exactly as the footer panel would seed it", () => {
  const f = fixture()
  try {
    armDefaultGoal(f.storage, "watcher")
    const row = f.storage.getSession("watcher")!
    assert.equal(row.recurring_prompt, DEFAULT_RECURRING_PROMPT)
    assert.equal(row.recurring_on_rest, 1, "the stop hook is what makes a new thread keep going")
    assert.equal(row.recurring_pause_on_questions, 1, "and it must not nag a thread that stopped to ask")
    assert.equal(row.recurring_on_schedule, 0, "a cadence nobody chose is the ambiguity the field exists to remove")
    assert.equal(row.recurring_on_compact, 0, "useless without a prompt that links the doc to re-read")
    assert.ok(row.recurring_armed_at, "and it is ARMED — without a generation the projection is absent")

    // The projection is what decides whether the footer mark is coloured: `live` is any trigger on.
    const view = resolveRecurringPrompt(row)!
    assert.equal(view.stopHook, true)
    assert.equal(view.pauseOnQuestions, true)
  } finally { f.close() }
})

// The two defaults must be ONE default. A panel that seeded something else would mean a brand-new
// thread and a thread the operator armed by hand disagree about what "the default" is.
test("the dispatch default and the panel's seeded default are the same object", () => {
  assert.deepEqual(DEFAULT_GOAL_TRIGGERS, { stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: true })
})

// A real dispatch needs credentials and burns quota, so what is pinned here is that BOTH transports
// call the arming — the one thing a storage-level test cannot see.
test("both dispatch transports arm the default Goal", () => {
  const src = readFileSync(join(import.meta.dirname, "dispatch.ts"), "utf8")
  assert.equal(
    src.split("armDefaultGoal(deps.storage, slug)").length - 1,
    2,
    "codex (app-server) and claude (broker) each arm it after registering the session",
  )
})
