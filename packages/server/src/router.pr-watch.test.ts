// THE PR WATCHER REGISTRY at the RPC boundary — the real router against real SQLite.
//
// `mcp__frizz__watch_pr` is proven callable over its real stdio transport in frizz-mcp.test.ts; that
// test stands a fake http server in for frizz, so it pins the tool's half of the wire and nothing about
// what the server does with it. This is the other half: given the exact body that tool sends, does a row
// appear, and do the refusals refuse?
//
// Every one of these is a way a worker could come to rest believing it is covered when it is not. That
// is the failure mode worth testing here — a watcher that cannot fire is worse than no watcher, because
// the worker stops looking.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@frizz/shared"
import { PR_WATCH_MAX_ARMED } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-pr-watch-rpc-"))
  const project: Project = { dir, id: "prw", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"))
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    storage,
    router: createRouter(ctx),
    refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, tmux_name: `frizz-${slug}`, spawned_at: "2026-08-14T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null, ...over,
  }
}

test("add registers the PR, normalizes the ref, and answers with the thread's armed set", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // A PR URL, because that is what a worker pastes out of `gh pr create` — and it must normalize to
    // the same `owner/repo#N` the board's rows and the poller's status book are keyed by, or the same
    // PR registered two ways would be two watchers and two wakes.
    const added = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "https://github.com/acme/app/pull/391" } })
    assert.equal(added.target, "acme/app#391")
    assert.equal(added.alreadyArmed, false)
    assert.deepEqual(added.watches.map((w) => w.target), ["acme/app#391"])
    const [stored] = h.storage.listPrWatches("t", { armedOnly: true })
    assert.deepEqual(
      { owner: stored.owner, repo: stored.repo, number: stored.number, state: stored.state, cursor: stored.cursor },
      { owner: "acme", repo: "app", number: 391, state: "armed", cursor: null },
    )
    assert.ok(h.refreshes() > 0, "the board is refreshed, so the strip shows the new watcher at once")
  } finally { h.close() }
})

// IDEMPOTENT PER PR, and this is the case that actually happens: a worker's context is compacted, it no
// longer remembers what it holds, and it re-registers to be careful. Minting a second row there would
// mean two wakes for every event, which reads to the operator as the watcher misfiring.
test("registering the same PR twice returns the SAME watcher rather than a duplicate", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const first = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391" } })
    const again = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "https://github.com/acme/app/pull/391" } })
    assert.equal(again.id, first.id)
    assert.equal(again.alreadyArmed, true)
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, 1)
  } finally { h.close() }
})

// REFUSED, NOT STORED. A ref frizz cannot parse names no PR, so the watcher could never fire — and the
// worker would rest believing it was covered. The refusal has to say what a good ref looks like, since
// the model's next move is to try again.
test("a ref that names no pull request is refused, and nothing is written", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "the auth PR" } }),
      /is not a pull request I can watch/,
    )
    assert.deepEqual(h.storage.listPrWatches("t"), [])
  } finally { h.close() }
})

test("an unregistered or archived thread cannot register a watcher", async () => {
  const h = harness()
  try {
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "ghost", target: "acme/app#391" } }),
      /is not registered/,
    )
    h.storage.upsertSession(row("shelved", { archived: 1, state: "archived" }))
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "shelved", target: "acme/app#391" } }),
      /Reopen this thread/,
    )
  } finally { h.close() }
})

// The cap is what makes "watch as many as you like" safe to offer: a tool call in a loop cannot fill the
// table, and the refusal NAMES the number so the worker drops one rather than retrying forever.
test("the armed cap refuses the next one and says what to do about it", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    for (let i = 1; i <= PR_WATCH_MAX_ARMED; i++) {
      await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: `acme/app#${i}` } })
    }
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#999" } }),
      new RegExp(`the limit is ${PR_WATCH_MAX_ARMED}`),
    )
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, PR_WATCH_MAX_ARMED)
  } finally { h.close() }
})

// DROP IS SCOPED TO THE CALLER'S OWN SLUG, in storage rather than in the handler, so an id belonging to
// another thread cannot be withdrawn even if a worker somehow learned it. And a drop that matched
// nothing is REPORTED rather than swallowed: a worker that believes it withdrew a wait it still holds
// will be woken by something it stopped caring about.
test("drop withdraws the caller's own watcher, and says so when it matched nothing", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("mine"))
    h.storage.upsertSession(row("theirs"))
    const mine = await h.router.addOwnPrWatch.handler({ input: { slug: "mine", target: "acme/app#391" } })

    const wrongThread = await h.router.dropOwnPrWatch.handler({ input: { slug: "theirs", id: mine.id } })
    assert.equal(wrongThread.dropped, false, "another thread's id is not droppable")
    assert.equal(h.storage.listPrWatches("mine", { armedOnly: true }).length, 1, "…and the row survives")

    const dropped = await h.router.dropOwnPrWatch.handler({ input: { slug: "mine", id: mine.id } })
    assert.equal(dropped.dropped, true)
    assert.deepEqual(dropped.watches, [], "the answer is the set it now holds — no second call needed")
    assert.equal(h.storage.getPrWatch(mine.id)?.state, "dropped")

    // Only an ARMED row moves: dropping one that already settled is a no-op, not a rewrite of history.
    const twice = await h.router.dropOwnPrWatch.handler({ input: { slug: "mine", id: mine.id } })
    assert.equal(twice.dropped, false)
  } finally { h.close() }
})

// The read-back carries each PR's CHECK STATE off the poller's status book, which is the reason a worker
// lists at all. It comes from the SAME book the board's rows read, so the tool and the card can never
// disagree about one PR — the drift that produced two cards saying different things about one wait.
test("list answers with each PR's latest checks, from the same book the board reads", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391" } })
    h.storage.setSetting("waker.github.status.v1", {
      "acme/app#391": {
        checks: "failing", running: 1, passed: 9, failed: 2, failing: ["lint"],
        merge: "blocked", state: "open", polledAt: "2026-08-14T00:05:00.000Z",
      },
    })
    const listed = await h.router.listOwnPrWatches.handler({ input: { slug: "t" } })
    assert.equal(listed.watches[0].github?.checks, "failing")
    assert.deepEqual(listed.watches[0].github?.failing, ["lint"])

    // An UNPOLLED PR carries no status at all rather than an invented one — "frizz has not looked yet"
    // and "this PR has no CI" are different facts, and only the second means the wait is nearly over.
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#392" } })
    const both = await h.router.listOwnPrWatches.handler({ input: { slug: "t" } })
    assert.equal(both.watches.find((w) => w.target === "acme/app#392")?.github, undefined)
  } finally { h.close() }
})

// Watchers die with the thread they belong to. A row on a hard-deleted thread has nothing to wake and
// would be polled on every tick forever.
test("forgetting a thread takes its watchers with it", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391" } })
    h.storage.forgetSession("t")
    assert.deepEqual(h.storage.listPrWatches("t"), [])
    assert.deepEqual(h.storage.armedPrWatches(), [])
  } finally { h.close() }
})
