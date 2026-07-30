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

function harness(subAgent: (slug: string, id: string) => SubAgentInfo) {
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
  const tailer: Tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
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
        stops.push(input)
      },
    },
  } as unknown as AppContext
  return { dir, ctx, storage, router: createRouter(ctx), steers, stops }
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
    assert.deepEqual(result, { stopped: true })
    assert.deepEqual(h.stops, [{
      threadSlug: "t",
      sessionId: "sid-t",
      taskId: "agent-runtime-grandchild",
    }])
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
