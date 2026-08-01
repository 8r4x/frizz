import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@fray-ui/shared"
import type { BoardManager } from "./board.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

// STEERING A SUB-AGENT — the gate, not the transport.
//
// The transport itself is one addressed input message and is verified live (see the handoff notes and
// backend/claude-agent-broker-bridge.ts). What must be pinned HERE is the refusal set, because the
// failure mode is silent and asymmetric: measured against a real session, addressing a child that has
// already settled does NOT error — the CLI falls the message back onto the parent's MAIN thread,
// where the parent obeys an instruction the operator aimed at a child. So every "no" below is a
// misdelivery that did not happen, and `steerable` is what the drawer renders its prompt box off.

type SubAgentInfo = ReturnType<Tailer["subAgent"]>

function harness(subAgent: (slug: string, id: string) => SubAgentInfo, opts: {
  // Present ⇒ the id resolves as a background SHELL. Only stopBackgroundOp's tests need this; the
  // steer/stop tests never reach the shell branch because their ids resolve as agents.
  backgroundShell?: () => { command?: string; outputFile?: string; state: "running" | "done" } | undefined
  // Make the real provider stop FAIL, to pin that a failed stop must not retire the row.
  stopThrows?: Error
  // The live subtree hanging off the stopped row, deepest-first — what the tailer reads off sidecars.
  descendantTasks?: string[]
  // Task ids whose stop throws, to pin that a descendant fray cannot end is COUNTED and stated
  // rather than swallowed under a "stopped" the operator would read as "the work ended".
  stopFailsFor?: readonly string[]
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fray-subagent-steer-"))
  const project: Project = { dir, id: "steer", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"))
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => snapshot,
    start: async () => {},
    stop: async () => {},
  }
  const dismissals: { slug: string; id: string }[] = []
  const tailer: Tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
    dismissOp: (slug: string, id: string) => {
      dismissals.push({ slug, id })
      return true
    },
    ...(opts.backgroundShell ? { backgroundShell: opts.backgroundShell } : {}),
    ...(opts.descendantTasks ? { subAgentDescendantTasks: () => [...opts.descendantTasks!] } : {}),
  }
  const steers: { threadSlug: string; sessionId: string; subAgentId: string; text: string }[] = []
  const stops: { threadSlug: string; sessionId: string; taskId: string }[] = []
  const ctx = {
    project,
    storage,
    board,
    tailer,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
    claudeBroker: {
      steerSubAgent: async (input: { threadSlug: string; sessionId: string; subAgentId: string; text: string }) => {
        steers.push(input)
      },
      stopSubAgent: async (input: { threadSlug: string; sessionId: string; taskId: string }) => {
        if (opts.stopThrows) throw opts.stopThrows
        if (opts.stopFailsFor?.includes(input.taskId)) throw new Error(`cannot stop ${input.taskId}`)
        stops.push(input)
      },
    },
  } as unknown as AppContext
  return { dir, ctx, storage, router: createRouter(ctx), steers, stops, dismissals }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-28T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    permission_mode: null,
    ...over,
  } as SessionRow
}

// upsertSession does not carry `backend` / `claude_runtime` (they are set by their own writers), so a
// row's runtime identity is stamped after insert — exactly as dispatch does it.
function seed(storage: ReturnType<typeof createStorage>, slug: string, runtime: { backend?: string; claudeRuntime?: string | null } = {}) {
  storage.upsertSession(row(slug))
  storage.setBackend(slug, runtime.backend ?? "claude")
  if (runtime.claudeRuntime !== null) storage.setClaudeRuntime(slug, runtime.claudeRuntime ?? "broker")
}

const RUNNING_DIRECT: SubAgentInfo = { outputFile: "/tmp/child.jsonl", state: "running", direct: true, taskId: "agent-runtime-child" }

test("subAgentSteer delivers into the CHILD, addressed by its dispatch tool_use id", async () => {
  const h = harness(() => RUNNING_DIRECT)
  try {
    seed(h.storage, "t")
    const result = await h.router.subAgentSteer.handler({ input: { slug: "t", id: "toolu_child", message: "look at the other file instead" } })
    assert.deepEqual(result, { delivered: true })
    assert.deepEqual(h.steers, [{
      threadSlug: "t",
      sessionId: "sid-t",
      subAgentId: "toolu_child",
      text: "look at the other file instead",
      deliveryId: undefined,
    }])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentSteer refuses a child that already settled — the case that would MISDELIVER to the parent", async () => {
  const h = harness(() => ({ outputFile: "/tmp/child.jsonl", state: "done", direct: false }))
  try {
    seed(h.storage, "t")
    await assert.rejects(
      () => h.router.subAgentSteer.handler({ input: { slug: "t", id: "toolu_child", message: "too late" } }),
      /no longer running/,
    )
    assert.deepEqual(h.steers, [], "nothing crossed the bridge")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentSteer refuses a STALE child: 'probably finished' has to be treated as finished", async () => {
  const h = harness(() => ({ outputFile: "/tmp/child.jsonl", state: "stale", direct: true }))
  try {
    seed(h.storage, "t")
    await assert.rejects(() => h.router.subAgentSteer.handler({ input: { slug: "t", id: "toolu_child", message: "hello" } }), /no longer running/)
    assert.deepEqual(h.steers, [])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentSteer refuses a NESTED child — this session's CLI never issued that tool_use id", async () => {
  const h = harness(() => ({ outputFile: "/tmp/grandchild.jsonl", state: "running", direct: false }))
  try {
    seed(h.storage, "t")
    await assert.rejects(
      () => h.router.subAgentSteer.handler({ input: { slug: "t", id: "toolu_grandchild", message: "hello" } }),
      /Only sub-agents this thread dispatched itself/,
    )
    assert.deepEqual(h.steers, [])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentStop uses the provider task id and works for a nested child", async () => {
  const h = harness(() => ({ outputFile: "/tmp/grandchild.jsonl", state: "running", direct: false, taskId: "agent-runtime-grandchild" }))
  try {
    seed(h.storage, "t")
    const result = await h.router.subAgentStop.handler({ input: { slug: "t", id: "toolu_grandchild" } })
    assert.deepEqual(result, { stopped: true, descendantsStopped: 0, note: null })
    assert.deepEqual(h.stops, [{
      threadSlug: "t",
      sessionId: "sid-t",
      taskId: "agent-runtime-grandchild",
    }])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

// ── STOPPING A SUBTREE ──────────────────────────────────────────────────────────────────────────
//
// A stop names ONE task and the provider's registry is flat and session-wide, so stopping a sub-agent
// used to leave its own fan-out running — and that same flatness delivers a completion to the SESSION,
// so the orphans then reported into the ROOT thread under an agent the operator had watched die.
// Measured on nub session a0c5fba3 (2026-07-31): the × set `stoppedByUser` on `adabd4aeedf52ef6c`,
// whose transcript ends 19:54:22, while its two children — neither marked stopped — wrote until
// 19:56:09 and 19:56:44 and landed their reports in the root transcript.

test("a stop ends the whole live subtree, deepest-first, with the target last", async () => {
  // Deepest-first is the tailer's contract; what this pins is that the router preserves that order and
  // stops the TARGET after them, so no still-running parent can dispatch a fresh child into the gap.
  const h = harness(() => RUNNING_DIRECT, { descendantTasks: ["agent-great", "agent-grand-a", "agent-grand-b"] })
  try {
    seed(h.storage, "t")
    const result = await h.router.subAgentStop.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.deepEqual(result, { stopped: true, descendantsStopped: 3, note: null })
    assert.deepEqual(
      h.stops.map((s) => s.taskId),
      ["agent-great", "agent-grand-a", "agent-grand-b", "agent-runtime-child"],
      "every descendant is stopped before the row itself",
    )
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("the × stops the subtree too, and reports the count that the vanished row cannot", async () => {
  const h = harness(() => RUNNING_DIRECT, { descendantTasks: ["agent-grand-a", "agent-grand-b"] })
  try {
    seed(h.storage, "t")
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.deepEqual(result, { stopped: true, dismissed: true, note: null, descendantsStopped: 2 })
    assert.deepEqual(h.stops.map((s) => s.taskId), ["agent-grand-a", "agent-grand-b", "agent-runtime-child"])
    assert.deepEqual(h.dismissals, [{ slug: "t", id: "toolu_child" }])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a descendant that cannot be stopped is stated, not swallowed — and never blocks the rest", async () => {
  // The benign cause is a race (it settled between the sidecar read and the stop), but a real failure
  // is live work fray did not end, and the row is about to leave the board. Counting it and saying so
  // is the whole point; a silent success here is the original bug one level down.
  const h = harness(() => RUNNING_DIRECT, {
    descendantTasks: ["agent-grand-a", "agent-grand-b"],
    stopFailsFor: ["agent-grand-a"],
  })
  try {
    seed(h.storage, "t")
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.equal(result.stopped, true)
    assert.equal(result.descendantsStopped, 1, "the reachable descendant still stopped")
    assert.match(result.note ?? "", /1 descendant could not be stopped and may still be running/)
    assert.deepEqual(
      h.stops.map((s) => s.taskId),
      ["agent-grand-b", "agent-runtime-child"],
      "one failure does not abandon the remaining descendants or the target",
    )
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a childless stop is unchanged — no note, no count, one provider call", async () => {
  const h = harness(() => RUNNING_DIRECT, { descendantTasks: [] })
  try {
    seed(h.storage, "t")
    const result = await h.router.subAgentStop.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.deepEqual(result, { stopped: true, descendantsStopped: 0, note: null })
    assert.deepEqual(h.stops.map((s) => s.taskId), ["agent-runtime-child"])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentStop refuses runtimes without a real provider stop path", async () => {
  const codex = harness(() => RUNNING_DIRECT)
  try {
    seed(codex.storage, "t", { backend: "codex", claudeRuntime: null })
    await assert.rejects(
      () => codex.router.subAgentStop.handler({ input: { slug: "t", id: "toolu_child" } }),
      /Codex does not expose per-sub-agent interruption/,
    )
    assert.deepEqual(codex.stops, [])
  } finally {
    rmSync(codex.dir, { recursive: true, force: true })
  }

  const noId = harness(() => ({ outputFile: "/tmp/child.jsonl", state: "running", direct: true }))
  try {
    seed(noId.storage, "t")
    await assert.rejects(
      () => noId.router.subAgentStop.handler({ input: { slug: "t", id: "toolu_child" } }),
      /did not publish the task identifier/,
    )
    assert.deepEqual(noId.stops, [])
  } finally {
    rmSync(noId.dir, { recursive: true, force: true })
  }
})

// ── THE × ON A CHILD ROW (stopBackgroundOp) ─────────────────────────────────────────────────────
//
// The × used to ONLY retire tracking, which is what the maintainer hit (2026-07-30): "The fucking X
// button didn't actually kill the sub-agent. it removed it from my UI, but then I click on the title
// and it's still running." These pin the three branches that make the control honest again — a real
// stop where one exists, no silent retire when the stop failed, and a stated REASON when the runtime
// has no stop at all. The reason matters as much as the kill: a row that vanishes while the work
// keeps burning tokens is the bug, whether or not fray could have prevented it.

test("the × STOPS a broker-backed child for real, then retires the row", async () => {
  const h = harness(() => RUNNING_DIRECT)
  try {
    seed(h.storage, "t")
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.deepEqual(result, { stopped: true, dismissed: true, note: null, descendantsStopped: 0 })
    assert.deepEqual(h.stops, [{ threadSlug: "t", sessionId: "sid-t", taskId: "agent-runtime-child" }], "the provider control ran")
    assert.deepEqual(h.dismissals, [{ slug: "t", id: "toolu_child" }], "and only then did the row leave tracking")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a FAILED stop leaves the row on the board — hiding live work is the bug this replaced", async () => {
  const h = harness(() => RUNNING_DIRECT, { stopThrows: new Error("broker daemon is not holding this session") })
  try {
    seed(h.storage, "t")
    await assert.rejects(
      () => h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_child" } }),
      /broker daemon is not holding this session/,
    )
    assert.deepEqual(h.dismissals, [], "a child that may still be running must keep its row")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a runtime with no stop path still clears the row, but SAYS the work may survive", async () => {
  // A tmux claude thread — the maintainer's own repro. Its sub-agents run inside the CLI process and
  // there is no per-child control channel at all, so the × can only clear the row. It must not do that
  // silently: the note is the whole difference between an honest control and the original complaint.
  const tmux = harness(() => RUNNING_DIRECT)
  try {
    seed(tmux.storage, "t", { claudeRuntime: null })
    const result = await tmux.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.equal(result.stopped, false)
    assert.equal(result.dismissed, true, "the phantom-row escape hatch survives")
    assert.match(result.note ?? "", /needs the Claude session broker/)
    assert.deepEqual(tmux.stops, [], "nothing was sent to a bridge that could not carry it")
  } finally {
    rmSync(tmux.dir, { recursive: true, force: true })
  }

  // A background SHELL gets its own sentence rather than the taskId branch's "did not publish the task
  // identifier", which reads like a provider glitch instead of the categorical limit it is.
  const shell = harness(
    () => ({ outputFile: "/tmp/sh.log", state: "running", direct: false }),
    { backgroundShell: () => ({ command: "npm run dev", outputFile: "/tmp/sh.log", state: "running" as const }) },
  )
  try {
    seed(shell.storage, "t")
    const result = await shell.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_sh" } })
    assert.equal(result.stopped, false)
    assert.equal(result.dismissed, true)
    assert.match(result.note ?? "", /holds no handle on its process/)
  } finally {
    rmSync(shell.dir, { recursive: true, force: true })
  }
})

test("the × on an already-settled op is a quiet retire — no stop attempt, and nothing worth saying", async () => {
  const h = harness(() => ({ outputFile: "/tmp/child.jsonl", state: "stale", direct: true, taskId: "agent-runtime-child" }))
  try {
    seed(h.storage, "t")
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.deepEqual(result, { stopped: false, dismissed: true, note: null, descendantsStopped: 0 }, "a finished op needs no warning banner")
    assert.deepEqual(h.stops, [])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentSteer refuses a codex thread's child and says why", async () => {
  const h = harness(() => RUNNING_DIRECT)
  try {
    seed(h.storage, "t", { backend: "codex", claudeRuntime: null })
    await assert.rejects(
      () => h.router.subAgentSteer.handler({ input: { slug: "t", id: "toolu_child", message: "hello" } }),
      /Codex runs its sub-agents inside its own process/,
    )
    assert.deepEqual(h.steers, [])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentSteer refuses a tmux claude row — a steer rides the broker's live stream, and there is none", async () => {
  const h = harness(() => RUNNING_DIRECT)
  try {
    seed(h.storage, "t", { claudeRuntime: null })
    await assert.rejects(
      () => h.router.subAgentSteer.handler({ input: { slug: "t", id: "toolu_child", message: "hello" } }),
      /needs the Claude session broker/,
    )
    assert.deepEqual(h.steers, [])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("subAgentTranscript reports steerability + the reason the drawer shows in place of the box", async () => {
  const steerable = harness(() => RUNNING_DIRECT)
  try {
    seed(steerable.storage, "t")
    const live = await steerable.router.subAgentTranscript.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.equal(live.steerable, true)
    assert.equal(live.steerNote, null, "a box is offered, so there is nothing to explain")
    assert.equal(live.stoppable, true)
    assert.equal(live.stopNote, null)
  } finally {
    rmSync(steerable.dir, { recursive: true, force: true })
  }

  const codex = harness(() => RUNNING_DIRECT)
  try {
    seed(codex.storage, "t", { backend: "codex", claudeRuntime: null })
    const live = await codex.router.subAgentTranscript.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.equal(live.steerable, false)
    assert.match(String(live.steerNote), /Codex runs its sub-agents inside its own process/)
    assert.equal(live.stoppable, false)
    assert.match(String(live.stopNote), /Codex does not expose per-sub-agent interruption/)
  } finally {
    rmSync(codex.dir, { recursive: true, force: true })
  }

  // A SETTLED child gets no note: its transcript already reads as finished, and a banner saying so
  // would be noise on every drawer the operator opens to review completed work.
  const settled = harness(() => ({ outputFile: "/tmp/child.jsonl", state: "done", direct: false }))
  try {
    seed(settled.storage, "t")
    const done = await settled.router.subAgentTranscript.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.equal(done.steerable, false)
    assert.equal(done.steerNote, null)
    assert.equal(done.stoppable, false)
    assert.equal(done.stopNote, null)
  } finally {
    rmSync(settled.dir, { recursive: true, force: true })
  }

  // An id fray cannot place at all stays exactly as it was: "gone", empty, and no affordance.
  const gone = harness(() => undefined)
  try {
    seed(gone.storage, "t")
    const missing = await gone.router.subAgentTranscript.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.deepEqual(missing, { messages: [], state: "gone", steerable: false, steerNote: null, stoppable: false, stopNote: null })
  } finally {
    rmSync(gone.dir, { recursive: true, force: true })
  }
})
