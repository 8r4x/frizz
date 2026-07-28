// DESCENDANT resolution: a sub-agent's sub-agent, and so on down.
//
// The property under test is the one the drill-in drawer needs and could not previously have: a
// dispatch tool_use id that appears NOWHERE in this thread's own transcript — because a CHILD ran the
// Agent tool, not the thread — still resolves to the right transcript. Every fixture here is shaped
// from the real bytes a three-level broker run wrote to disk (`_live_broker_depth.mts`, 2026-07-28);
// the sidecar bodies are that run's verbatim, only the ids shortened.
//
// The counterpart property matters just as much and is asserted alongside every positive case: an id
// fray genuinely cannot place must keep returning undefined (the router maps that to "gone", the drawer
// states it plainly). This path may add resolutions; it may never invent one.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"
import type { ClaudeRuntimeTask } from "./backend/claude-runtime-ingest.ts"

const SESSION = "11111111-2222-3333-4444-555555555555"
const SLUG = "descendants"

function assistant(content: unknown[]): string {
  return JSON.stringify({ type: "assistant", timestamp: "2026-07-28T18:24:00.000Z", message: { id: "m1", stop_reason: "end_turn", content } })
}

/**
 * A session whose transcript dispatches ONE direct child, plus a flat `subagents/` dir holding that
 * child and its own descendants — exactly claude's layout: every descendant of every depth writes into
 * the ROOT session's dir, beside a `agent-<id>.meta.json` sidecar naming its dispatch tool_use id.
 */
function fixture(runtimeTasks?: readonly ClaudeRuntimeTask[]) {
  const dir = mkdtempSync(join(tmpdir(), "fray-descendants-"))
  const storage = createStorage(join(dir, "ui.db"))
  const subagents = join(dir, SESSION, "subagents")
  mkdirSync(subagents, { recursive: true })

  // The THREAD's own transcript knows only about its direct child — this is the whole point: the
  // grandchild's dispatch is not in here, so no fold over this file could ever produce it.
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${assistant([
    { type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "LEVEL-ONE", run_in_background: true } },
  ])}\n`)

  const sidecar = (agentId: string, body: unknown) => writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify(body))
  const transcript = (agentId: string, lines: string[]) => writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${lines.join("\n")}\n`)

  sidecar("aChild", { agentType: "general-purpose", description: "LEVEL-ONE", toolUseId: "toolu_child", spawnDepth: 1 })
  transcript("aChild", [assistant([{ type: "tool_use", id: "toolu_grand", name: "Agent", input: { description: "LEVEL-TWO", run_in_background: true } }])])

  sidecar("aGrand", { agentType: "general-purpose", description: "LEVEL-TWO", toolUseId: "toolu_grand", parentAgentId: "aChild", spawnDepth: 2 })
  transcript("aGrand", [assistant([{ type: "tool_use", id: "toolu_great", name: "Agent", input: { description: "LEVEL-THREE", run_in_background: true } }])])

  sidecar("aGreat", { agentType: "general-purpose", description: "LEVEL-THREE", toolUseId: "toolu_great", parentAgentId: "aGrand", spawnDepth: 3 })
  transcript("aGreat", [assistant([{ type: "text", text: "LEAF-DONE" }])])

  storage.upsertSession({
    slug: SLUG, session_id: SESSION, tmux_name: `fray-${SLUG}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")

  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false, capturePane: () => "",
    ...(runtimeTasks ? { runtimeTasks: () => runtimeTasks } : {}),
  })
  tailer.tick()
  return { tailer, storage, dir, subagents }
}

function cleanup(f: { tailer: { stop(): void }; storage: { close(): void }; dir: string }) {
  f.tailer.stop()
  f.storage.close()
  rmSync(f.dir, { recursive: true, force: true })
}

test("descendants: a GRANDCHILD resolves, though its dispatch is in the child's transcript and not the thread's", () => {
  const f = fixture()
  try {
    // Precondition, so a passing assertion below cannot be the direct-child path in disguise.
    assert.equal(f.tailer.get(SLUG)?.subAgents.some((view) => view.id === "toolu_grand"), false,
      "the grandchild is deliberately NOT a tracked child of this thread")

    const grand = f.tailer.subAgent(SLUG, "toolu_grand")
    assert.ok(grand, "the grandchild's dispatch id resolves")
    assert.equal(grand.outputFile, join(f.subagents, "agent-aGrand.jsonl"))
  } finally {
    cleanup(f)
  }
})

test("descendants: depth costs nothing — a GREAT-grandchild resolves the same way", () => {
  const f = fixture()
  try {
    const great = f.tailer.subAgent(SLUG, "toolu_great")
    assert.ok(great, "a depth-3 descendant resolves")
    assert.equal(great.outputFile, join(f.subagents, "agent-aGreat.jsonl"))
  } finally {
    cleanup(f)
  }
})

test("descendants: an id that resolves to nothing stays UNRESOLVED — never a guessed parent", () => {
  const f = fixture()
  try {
    assert.equal(f.tailer.subAgent(SLUG, "toolu_never_dispatched"), undefined,
      "an unknown id must degrade to gone, not to some nearby descendant")
  } finally {
    cleanup(f)
  }
})

test("descendants: a junk or half-written sidecar is skipped, never thrown on", () => {
  const f = fixture()
  try {
    writeFileSync(join(f.subagents, "agent-aTorn.meta.json"), '{"toolUseId":"toolu_to') // truncated mid-write
    writeFileSync(join(f.subagents, "agent-aList.meta.json"), "[1,2,3]") // valid JSON, wrong shape
    writeFileSync(join(f.subagents, "agent-aNull.meta.json"), "null")
    // The good ones still resolve, and the bad ones simply do not.
    assert.ok(f.tailer.subAgent(SLUG, "toolu_grand"), "a torn neighbour must not cost a healthy sidecar")
    assert.equal(f.tailer.subAgent(SLUG, "toolu_torn"), undefined)
  } finally {
    cleanup(f)
  }
})

test("descendants: the provider's terminal task says DONE; silence alone only says stale", () => {
  const finished: ClaudeRuntimeTask[] = [
    { taskId: "aGrand", terminal: true, outcome: "completed", seenInLevel: true, updatedAt: Date.now() },
  ]
  const done = fixture(finished)
  try {
    assert.equal(done.tailer.subAgent(SLUG, "toolu_grand")?.state, "done",
      "the task table is authoritative when it holds the row — its task id IS the agent id")
  } finally {
    cleanup(done)
  }

  const quiet = fixture()
  try {
    // No task table at all: a freshly-written transcript is "running", and nothing may call it done.
    assert.equal(quiet.tailer.subAgent(SLUG, "toolu_grand")?.state, "running")
    rmSync(join(quiet.subagents, "agent-aGrand.jsonl"))
    assert.equal(quiet.tailer.subAgent(SLUG, "toolu_grand")?.state, "stale",
      "a transcript that no longer stats is stale — never a completion nothing reported")
  } finally {
    cleanup(quiet)
  }
})
