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
  // The board's live shells, so a shell stop can read its own label for the kill notice.
  bgShells?: readonly { id: string; label: string; state?: string }[]
  // The broker's answer to "is this session's daemon still up" — the gate on the kill notice. Default
  // true; false pins that fray reports the worker was NOT told rather than cold-starting a process.
  daemonAlive?: boolean
  // Make the notice delivery FAIL, to pin that a dead notice never turns a real kill into an error.
  followUpThrows?: Error
  // The codex app-server bridge, for the CODEX shell route. Absent ⇒ no bridge, which is itself a case
  // worth pinning (the route must not fire and the Claude path must be reached unchanged).
  codexTerminate?: (input: { threadSlug: string; sessionId: string; processId: string; notice?: string }) => { terminated: boolean; noticeFailed: string | null }
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
    get: opts.bgShells ? (() => ({ bgShells: opts.bgShells!.map((entry) => ({ state: "running", ...entry })) }) as unknown as ReturnType<Tailer["get"]>) : () => undefined,
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
  // Every message fray delivered into the worker's own conversation. For these tests that is only ever
  // the shell-kill notice — the one thing the provider does not tell a worker itself.
  const notices: { threadSlug: string; sessionId: string; text: string }[] = []
  const codexTerminations: { threadSlug: string; sessionId: string; processId: string; notice?: string }[] = []
  const ctx = {
    project,
    storage,
    board,
    tailer,
    ...(opts.codexTerminate ? {
      codexAppServer: {
        terminateBackgroundExec: async (input: { threadSlug: string; sessionId: string; processId: string; notice?: string }) => {
          codexTerminations.push(input)
          return opts.codexTerminate!(input)
        },
      },
    } : {}),
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
      isDaemonAlive: () => opts.daemonAlive !== false,
      followUp: async (input: { threadSlug: string; sessionId: string; text: string }) => {
        if (opts.followUpThrows) throw opts.followUpThrows
        notices.push({ threadSlug: input.threadSlug, sessionId: input.sessionId, text: input.text })
      },
    },
  } as unknown as AppContext
  return { dir, ctx, storage, router: createRouter(ctx), steers, stops, dismissals, notices, codexTerminations }
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
function seed(storage: ReturnType<typeof createStorage>, slug: string, runtime: { backend?: string; claudeRuntime?: string | null; codexRuntime?: string } = {}) {
  storage.upsertSession(row(slug))
  storage.setBackend(slug, runtime.backend ?? "claude")
  if (runtime.backend === "codex") storage.setCodexRuntime(slug, runtime.codexRuntime ?? "app-server")
  else if (runtime.claudeRuntime !== null) storage.setClaudeRuntime(slug, runtime.claudeRuntime ?? "broker")
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

  // A background SHELL on a runtime with no control channel says so in the SHELL's own words. The
  // refusal is now about the TRANSPORT, never about the row being a shell: until 2026-08-01 every shell
  // was refused categorically ("holds no handle on its process"), which was measured wrong.
  const shell = harness(
    () => ({ outputFile: "/tmp/sh.log", state: "running", direct: false, taskId: "bshell1" }),
    { backgroundShell: () => ({ command: "npm run dev", outputFile: "/tmp/sh.log", state: "running" as const }) },
  )
  try {
    seed(shell.storage, "t", { backend: "codex" })
    const result = await shell.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_sh" } })
    assert.equal(result.stopped, false)
    assert.equal(result.dismissed, true)
    assert.match(result.note ?? "", /exposes no way to end one/)
    assert.deepEqual(shell.notices, [], "a refusal must never tell the worker its shell was killed")
  } finally {
    rmSync(shell.dir, { recursive: true, force: true })
  }
})

// ── STOPPING A BACKGROUND SHELL ──────────────────────────────────────────────────────────────────
//
// The × was withheld from every running shell until 2026-08-01, on a premise that turned out to be
// false: fray DOES hold a handle on a background Bash — the provider's own task id, which it has been
// recording off the launch ack all along, and which `Query.stopTask` accepts (verified end-to-end in
// backend/_live_shell_stop.mts: the OS process dies within a second). The maintainer's case was a
// watcher wedged for 24 hours with no way to clear it.
//
// The NOTICE is the other half and is shell-only. Measured on a real session
// (backend/_live_shell_stop_notice.mts): stopping a sub-agent injects a `<task-notification>` the model
// reads and acts on; stopping a shell injects NOTHING, and the model goes on believing its shell is
// "presumably still running". These pin that fray fills exactly that gap, and only it.

const RUNNING_SHELL = () => ({ outputFile: "/tmp/sh.log", state: "running" as const, direct: false, taskId: "bshell1" })
const SHELL_LOOKUP = () => ({ command: "npx vite --port 5231", outputFile: "/tmp/sh.log", state: "running" as const })

test("the × STOPS a background shell for real, retires the row, and TELLS the worker", async () => {
  const h = harness(RUNNING_SHELL, {
    backgroundShell: SHELL_LOOKUP,
    bgShells: [{ id: "toolu_sh", label: "Watching CI" }],
  })
  try {
    seed(h.storage, "t")
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_sh" } })
    assert.deepEqual(result, { stopped: true, dismissed: true, note: null, descendantsStopped: 0 })
    assert.deepEqual(h.stops, [{ threadSlug: "t", sessionId: "sid-t", taskId: "bshell1" }], "the provider control ran on the shell's task id")
    assert.deepEqual(h.dismissals, [{ slug: "t", id: "toolu_sh" }], "and only then did the row leave tracking")
    assert.equal(h.notices.length, 1, "the worker is told exactly once")
    // The worker must be able to tell WHICH of its shells died, so the notice carries the label the
    // worker itself gave the launch — read off the live row BEFORE the kill retires it.
    assert.match(h.notices[0]!.text, /^\[fray\] /, "machine plumbing, hidden from the human's chat")
    assert.match(h.notices[0]!.text, /Watching CI/)
    assert.match(h.notices[0]!.text, /do not wait on it/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a shell that has been SILENT for hours is still stoppable — that is the whole point", async () => {
  // The sub-agent staleness ceiling would call this row "stale" (nothing has written to its output for
  // 15+ minutes) and the stop path would decline it as already-finished. A shell has no such ceiling:
  // its entry clears on a terminal notification and nothing else, so a watcher quiet for a day is
  // RUNNING. Reading `info.state` here instead of the shell's own state would refuse to kill precisely
  // the wedged shell the operator came for.
  const h = harness(
    () => ({ outputFile: "/tmp/sh.log", state: "stale", direct: false, taskId: "bshell1" }),
    { backgroundShell: SHELL_LOOKUP, bgShells: [{ id: "toolu_sh", label: "Watching CI" }] },
  )
  try {
    seed(h.storage, "t")
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_sh" } })
    assert.equal(result.stopped, true, "the shell's own liveness governs, not the sub-agent staleness rule")
    assert.deepEqual(h.stops, [{ threadSlug: "t", sessionId: "sid-t", taskId: "bshell1" }])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a shell kill whose NOTICE cannot land is still a kill — and says the worker was not told", async () => {
  // The process is dead by the time the notice is attempted. Turning a delivery failure into a thrown
  // stop would leave the row on the board over a message, and the operator would read it as "the kill
  // failed" — the opposite of what happened. It rides back in `note` instead.
  const h = harness(RUNNING_SHELL, {
    backgroundShell: SHELL_LOOKUP,
    bgShells: [{ id: "toolu_sh", label: "Watching CI" }],
    daemonAlive: false,
  })
  try {
    seed(h.storage, "t")
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_sh" } })
    assert.equal(result.stopped, true)
    assert.equal(result.dismissed, true)
    assert.match(result.note ?? "", /was not told/)
    assert.deepEqual(h.notices, [], "a dead daemon is never cold-started just to announce a kill")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("stopping a SUB-AGENT sends no fray notice — the provider already injects its own", async () => {
  const h = harness(() => RUNNING_DIRECT)
  try {
    seed(h.storage, "t")
    await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "toolu_child" } })
    assert.deepEqual(h.notices, [], "a second notice would tell the worker the same thing twice")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
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

// ── STOPPING A CODEX BACKGROUND EXEC ─────────────────────────────────────────────────────────────
//
// Codex reaches the same × by a completely different road, and the router keeps them apart rather than
// branching inside the Claude path: a codex shell never enters the fold's op map (neither
// `tailer.subAgent` nor `tailer.backgroundShell` can see one), its handle is a `processId` off the
// app-server item stream, and its kill is `thread/backgroundTerminals/terminate`.
//
// Both halves are measured, not assumed (backend/_live_codex_bgterm.mts + _live_codex_shell_stop.mts):
// terminate really kills the OS process, and codex — like Claude — tells its agent NOTHING, because
// completion there is polled rather than pushed. `thread/inject_items` is what closes that, and the
// live probe's worker then said "the background command has been stopped … because fray explicitly
// told me the operator stopped it."

test("the × on a CODEX shell terminates it by processId and injects the notice", async () => {
  const h = harness(() => undefined, {
    bgShells: [{ id: "24573", label: "gh run watch" }],
    codexTerminate: () => ({ terminated: true, noticeFailed: null }),
  })
  try {
    seed(h.storage, "t", { backend: "codex" })
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "24573" } })
    assert.deepEqual(result, { stopped: true, dismissed: true, note: null, descendantsStopped: 0 })
    assert.equal(h.codexTerminations.length, 1)
    const call = h.codexTerminations[0]!
    assert.equal(call.processId, "24573", "the row's id IS the processId — codex has exactly one handle")
    assert.match(call.notice ?? "", /^\[fray\] /, "machine plumbing, hidden from the human's chat")
    assert.match(call.notice ?? "", /gh run watch/, "the worker has to know WHICH command died")
    assert.match(call.notice ?? "", /do not wait on it or poll it again/, "codex completion is POLLED — saying 'do not wait' alone would leave it polling")
    assert.deepEqual(h.stops, [], "the Claude control was never touched")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a codex exec the app-server says was already gone is not reported as a kill", async () => {
  // `terminated:false` means the PTY had already exited. The row still clears — that is the ×'s other
  // honest job — but nothing may claim work was ended that had already ended.
  const h = harness(() => undefined, {
    bgShells: [{ id: "24573", label: "gh run watch" }],
    codexTerminate: () => ({ terminated: false, noticeFailed: null }),
  })
  try {
    seed(h.storage, "t", { backend: "codex" })
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "24573" } })
    assert.equal(result.stopped, false)
    assert.equal(result.dismissed, true, "the phantom still clears")
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("a codex kill whose notice failed still counts as a kill, and says the worker was not told", async () => {
  const h = harness(() => undefined, {
    bgShells: [{ id: "24573", label: "gh run watch" }],
    codexTerminate: () => ({ terminated: true, noticeFailed: "The worker could not be told: connection closed" }),
  })
  try {
    seed(h.storage, "t", { backend: "codex" })
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "24573" } })
    assert.equal(result.stopped, true, "the process is dead by then; a delivery problem must not read as a failed stop")
    assert.match(result.note ?? "", /could not be told/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("with no codex bridge the codex route never fires — the row just clears", async () => {
  const h = harness(() => undefined, { bgShells: [{ id: "24573", label: "gh run watch" }] })
  try {
    seed(h.storage, "t", { backend: "codex" })
    const result = await h.router.stopBackgroundOp.handler({ input: { slug: "t", id: "24573" } })
    assert.equal(result.stopped, false)
    assert.deepEqual(h.codexTerminations, [])
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})
