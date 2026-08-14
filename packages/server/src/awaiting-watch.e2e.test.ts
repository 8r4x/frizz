// THE `watch:` FENCE END TO END — real tailer folding a real transcript file, real scheduler, real
// SQLite, no fake telemetry anywhere.
//
// This is the seam a unit test cannot reach and the one that matters, because the whole mechanism is a
// hand-off between three things that each look fine alone: the fold has to turn a background-shell
// launch into a live `bgShells` row and its `<task-notification>` into a RETIREMENT, the fence parser
// has to carry the `watch:` hint, and the scheduler has to match the name the WORKER wrote against
// either of those. A mock at any one of those joints proves nothing about the other two — which is
// exactly how the previous version of this shipped a watcher that could never fire (`bf14128`).
//
// The transcript records are shape-accurate against a real ~/.claude/projects session (2026-07-23):
// the launch is a `tool_result` whose text carries "Command running in background with ID: <taskId>"
// with `toolUseResult.backgroundTaskId`, and the retirement is a `queue-operation` record whose
// `content` is the `<task-notification>` XML.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { createTailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { GITHUB_STATUS_SETTING, readGithubStatusBook } from "./awaiting.ts"
import { deriveNeedsYou, deriveAwaitingBackground, fenceWatchViews } from "./board.ts"

const SLUG = "watcher"
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000000000001"
const TASK_ID = "bzvtnt3ig"
const TOOL_USE = "toolu_01MkWatchProbe"

const line = (o: unknown) => JSON.stringify(o) + "\n"

function launchRecords(at: string): string {
  return (
    line({
      type: "assistant", timestamp: at, sessionId: SESSION, uuid: "u1",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use", id: TOOL_USE, name: "Bash",
          input: { command: "nub run test", description: "Running the suite", run_in_background: true },
        }],
      },
    }) +
    line({
      type: "user", timestamp: at, sessionId: SESSION, uuid: "u2",
      message: {
        role: "user",
        content: [{
          tool_use_id: TOOL_USE, type: "tool_result", is_error: false,
          content: `Command running in background with ID: ${TASK_ID}. Output is being written to: /tmp/${TASK_ID}.output. You will be notified when it completes.`,
        }],
      },
      toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: TASK_ID },
    })
  )
}

/** The worker's final message: an awaiting fence naming the shell by the handle the RUNTIME gave it —
 *  which is the string a real worker reaches for, and the one this whole change exists to honour. */
function parkRecord(at: string, target: string): string {
  const text = [
    "Kicked the suite off in the background; I'll fold the result in when it lands.",
    "",
    "```awaiting",
    `watch: ${target}`,
    "Waiting on the test run.",
    "```",
  ].join("\n")
  return line({
    type: "assistant", timestamp: at, sessionId: SESSION, uuid: "u3",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })
}

function retirementRecord(at: string): string {
  return line({
    type: "queue-operation", operation: "enqueue", timestamp: at, sessionId: SESSION,
    content: [
      "<task-notification>",
      `<task-id>${TASK_ID}</task-id>`,
      `<tool-use-id>${TOOL_USE}</tool-use-id>`,
      `<output-file>/tmp/${TASK_ID}.output</output-file>`,
      "<status>completed</status>",
      '<summary>Background command "nub run test" completed</summary>',
      "</task-notification>",
    ].join("\n"),
  })
}

async function harness(target: string) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-watch-e2e-"))
  const transcript = join(dir, `${SESSION}.jsonl`)
  const at = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(transcript, launchRecords(at) + parkRecord(at, target))
  const storage = createStorage(join(dir, "ui.db"))
  // Frizz's own sign-off nudge fires on a FENCELESS rest; every rest here carries a fence, so it cannot
  // fire — but silence it anyway so a delivery count is unambiguous about what produced it.
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, tmux_name: `frizz-${SLUG}`, spawned_at: at,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false, capturePane: () => "",
  })
  const delivered: string[] = []
  const s = createScheduler({
    storage,
    tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  const refold = () => { tailer.tick() }
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  refold()
  return {
    storage, tailer, s, delivered, transcript, refold,
    tele: () => tailer.get(SLUG),
    finish: async () => { appendFileSync(transcript, retirementRecord(new Date().toISOString())); refold() },
    close: () => { void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("a park on a LIVE shell stays parked, then wakes on the shell's own retirement", async () => {
  const h = await harness(TASK_ID)
  try {
    // The fold saw all three things, off the real file.
    const parked = h.tele()
    assert.equal(parked?.bgShells.some((sh) => sh.taskId === TASK_ID && sh.state === "running"), true, "the shell folded as live")
    assert.equal(parked?.lastFence?.kind, "awaiting", "the fence folded")
    assert.deepEqual(parked?.lastFence?.hints, [{ kind: "watch", value: TASK_ID }], "…carrying the watch hint")

    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the shell is still running — nothing to say")

    await h.finish()
    assert.equal(h.tele()?.bgShells.some((sh) => sh.taskId === TASK_ID), false, "the shell is gone from live")
    assert.equal(h.tele()?.retiredShells?.some((sh) => sh.taskId === TASK_ID), true, "…and onto the retirement ring")

    await h.s.tick()
    assert.equal(h.delivered.length, 1, "the retirement wakes the thread")
    assert.match(h.delivered[0], new RegExp(TASK_ID))
    assert.match(h.delivered[0], /finished/)

    // ONE wake per park, not one per tick. The outbox's delivery id is keyed on the fence identity, so
    // a thread that has not moved cannot be told twice.
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "and only once")
  } finally { h.close() }
})

// A name matching nothing live and nothing retired is INDETERMINATE, never "done". This is the property
// that makes the fence safe to fail open: a typo cannot report a completion that never happened, and it
// cannot park a thread on a wait that will never resolve either (the board queues it — declared-park.test).
test("a typo'd target never fires, however long the thread sits there", async () => {
  const h = await harness("bzvtnt3ig-typo")
  try {
    await h.s.tick()
    await h.finish()
    await h.s.tick()
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "no live shell and no retirement by that name — nothing is claimed")
  } finally { h.close() }
})

// The worker may equally name the shell by its LABEL, which is what its own transcript shows it beside
// the command. Refusing that would make the fence unusable for the case it exists for.
test("the shell's label works as a target too", async () => {
  const h = await harness("Running the suite")
  try {
    await h.finish()
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "matched by label")
  } finally { h.close() }
})

// ---- THE pr-watch HALF, across the SAME seam --------------------------------------------------------
// The poller writes a reading into a setting and the board reads it back through a zod parse. That is a
// serialization boundary between two files that never call each other, and it fails SILENTLY by design
// (a malformed entry is dropped so one bad row cannot take a board's worth of status with it) — which
// is exactly the shape of seam that a pair of green unit tests on either side proves nothing about.
test("a poll publishes a reading the BOARD can actually read, and the queue rule acts on it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-prwatch-e2e-"))
  const at = new Date(Date.now() - 60_000).toISOString()
  const transcript = join(dir, `${SESSION}.jsonl`)
  writeFileSync(transcript, line({
    type: "assistant", timestamp: at, sessionId: SESSION, uuid: "p1",
    message: { role: "assistant", content: [{ type: "text", text: "PR is up.\n\n```awaiting\npr-watch: acme/app#391\nWatching for review.\n```" }] },
  }))
  const storage = createStorage(join(dir, "ui.db"))
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, tmux_name: `frizz-${SLUG}`, spawned_at: at,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false, capturePane: () => "",
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  tailer.tick()
  const s = createScheduler({
    storage,
    tailer,
    resume: async () => {},
    log: () => {},
    // The one thing stubbed, and only because it shells out to `gh`. Its RETURN is the real shape
    // `defaultFetchPr` builds from `gh pr view --json …`.
    fetchPr: async () => ({
      state: "OPEN",
      mergedAt: null,
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      rollup: [
        { status: "IN_PROGRESS", name: "test" },
        { status: "COMPLETED", conclusion: "SUCCESS", name: "build" },
      ],
      workflowRuns: [],
    }),
  })
  try {
    const tele = tailer.get(SLUG)
    assert.deepEqual(tele?.lastFence?.hints, [{ kind: "pr-watch", value: "acme/app#391" }], "the fence folded off the real file")

    await s.tick()
    const book = readGithubStatusBook(storage.getSetting(GITHUB_STATUS_SETTING))
    const status = book["acme/app#391"]
    assert.ok(status, "the poll's reading survives the round trip through the setting")
    assert.equal(status.checks, "running")
    assert.deepEqual([status.running, status.passed, status.failed], [1, 1, 0])
    assert.equal(status.merge, "blocked", "MERGEABLE + REVIEW_REQUIRED is not a green light")

    const row = storage.getSession(SLUG)!
    // CI IS RUNNING → out of the queue, into the active rail. The card still states the wait.
    assert.equal(deriveNeedsYou(row, tele, "turn-idle", false, Date.now(), undefined, true, false, book), false)
    assert.equal(deriveAwaitingBackground(row, tele, "turn-idle", false, Date.now(), undefined, false, book), true)
    // …and the row the card draws carries the same reading, off the same book.
    assert.deepEqual(fenceWatchViews(SLUG, tele, tele?.lastAssistantAt, book)[0]?.github, status)

    // CHECKS DONE → straight back into the queue, with no new fence and no worker turn.
    const done = { "acme/app#391": { ...status, checks: "passing" as const, running: 0, passed: 2 } }
    assert.equal(deriveNeedsYou(row, tele, "turn-idle", false, Date.now(), undefined, true, false, done), true)
  } finally {
    void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true })
  }
})
