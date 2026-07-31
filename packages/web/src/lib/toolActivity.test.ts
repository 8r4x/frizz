import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptToolCall } from "@fray-ui/shared"
import type { ChatMessage } from "../hooks.ts"
import {
  coalesceToolActivityMessages,
  currentToolActivity,
  historicalToolActivityMessages,
  isToolActivityException,
  liveToolActivityTail,
  editedFileCount,
  settledToolActivityLabel,
  toolActivityLabel,
} from "./toolActivity.ts"

function tool(name: string, over: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return { name, ...over }
}

function toolMessage(sourceId: string, calls: TranscriptToolCall[], at = "2026-07-30T12:00:00.000Z"): ChatMessage {
  return {
    sourceId,
    role: "assistant",
    text: "",
    tools: calls,
    parts: [{ kind: "tools", tools: calls }],
    at,
  }
}

test("ordinary tool turns coalesce across provider batches while retaining a stable source", () => {
  const messages = [
    toolMessage("batch-a", [tool("Read", { detail: "src/a.ts", status: "completed" })]),
    toolMessage("batch-b", [tool("Grep", { detail: "renderActivity", status: "pending" })], "2026-07-30T12:00:02.000Z"),
  ]

  const compact = coalesceToolActivityMessages(messages)
  assert.equal(compact.length, 1)
  assert.equal(compact[0].message.sourceId, "batch-a")
  assert.equal(compact[0].message.at, "2026-07-30T12:00:02.000Z")
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Read", "Grep"])
  assert.equal(compact[0].messageIndex, 0)
})

test("prose and sub-agent cards split runs while background Bash stays ordinary activity", () => {
  const background = toolMessage("background", [
    tool("Bash", { command: "nub run dev", backgroundState: "background", status: "pending" }),
  ])
  const agent = toolMessage("agent", [
    tool("Spawn agent", { agentId: "call-agent", detail: "inspect renderer", status: "pending" }),
  ])
  const prose: ChatMessage = {
    sourceId: "prose",
    role: "assistant",
    text: "I found the relevant renderer.",
    tools: [],
    parts: [{ kind: "text", text: "I found the relevant renderer." }],
  }
  const messages = [
    toolMessage("one", [tool("Read")]),
    background,
    {
      sourceId: "empty",
      role: "assistant",
      text: "",
      tools: [],
      parts: [],
    } satisfies ChatMessage,
    toolMessage("two", [tool("Grep")]),
    agent,
    toolMessage("three", [tool("Edit")]),
    prose,
    toolMessage("four", [tool("Bash")]),
  ]

  const compact = coalesceToolActivityMessages(messages)
  assert.deepEqual(compact.map((entry) => entry.message.sourceId), [
    "one",
    "agent",
    "three",
    "prose",
    "four",
  ])
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Read", "Bash", "Grep"])
  assert.equal(isToolActivityException(background.tools[0]), false)
  assert.equal(isToolActivityException(tool("Bash", { backgroundState: "unknown" })), false)
  assert.equal(isToolActivityException(agent.tools[0]), true)
  assert.equal(isToolActivityException(tool("Send message", { sendTo: "main" })), true)
  assert.equal(isToolActivityException(tool("Read")), false)
})

// codex's `list_agents` is a roster READ, not a dispatch. It used to sit in SUB_AGENT_TOOL_NAMES, so a
// model that polled it mid-burst broke one batch into `Ran 1 tool call` / a standalone Agents card /
// `Ran 4 tool calls`.
test("the agent listing folds into the ordinary activity run", () => {
  const listing = tool("Agents", { detail: "list live agents", output: "3 agents · 2 running · 1 completed", status: "completed", durationMs: 104 })
  assert.equal(isToolActivityException(listing), false)

  const compact = coalesceToolActivityMessages([
    toolMessage("one", [tool("Read", { detail: "src/a.ts" })]),
    toolMessage("listing", [listing], "2026-07-30T12:00:01.000Z"),
    toolMessage("two", [tool("Grep"), tool("Edit")], "2026-07-30T12:00:02.000Z"),
  ])

  assert.equal(compact.length, 1)
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Read", "Agents", "Grep", "Edit"])
})

test("a prose tool tail absorbs background Bash until the real rendered boundary", () => {
  const first = tool("Bash", { desc: "Starting the focused build", status: "completed" })
  const lead: ChatMessage = {
    sourceId: "lead",
    role: "assistant",
    text: "I found the build entry point.",
    tools: [first],
    parts: [
      { kind: "text", text: "I found the build entry point." },
      { kind: "tools", tools: [first] },
    ],
  }
  const messages = [
    lead,
    toolMessage("batch-a", [tool("Read", { status: "completed" })]),
    toolMessage("batch-edit", [tool("Edit", { status: "completed" })]),
    toolMessage("batch-b", [tool("Bash", { backgroundState: "background", status: "pending" })]),
    {
      sourceId: "empty",
      role: "assistant",
      text: "",
      tools: [],
      parts: [{ kind: "text", text: "  " }],
    } satisfies ChatMessage,
    toolMessage("batch-c", [tool("Bash", { status: "completed" })]),
    {
      sourceId: "finished-event",
      role: "assistant",
      kind: "event",
      boundary: true,
      text: "Background task finished",
      tools: [],
      parts: [],
    } satisfies ChatMessage,
  ]

  const compact = coalesceToolActivityMessages(messages)
  assert.equal(compact.length, 2)
  assert.equal(compact[0].message.sourceId, "lead")
  assert.equal(compact[0].message.text, lead.text)
  assert.deepEqual(compact[0].message.parts?.map((part) => part.kind), ["text", "tools"])
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Bash", "Read", "Edit", "Bash", "Bash"])
  assert.equal(compact[0].message.parts?.[1].kind, "tools")
  assert.equal(compact[0].message.parts?.[1].kind === "tools" ? compact[0].message.parts[1].tools.length : 0, 5)
  assert.equal(compact[0].message.tools[3].backgroundState, "background")
  assert.equal(compact[1].message.sourceId, "finished-event")
})

test("the latest tool stays at the runtime tail across the completed inter-call gap", () => {
  const settled = toolMessage("settled", [tool("Read", { status: "completed" })])
  const pending = toolMessage("pending", [tool("Bash", { desc: "Running focused tests", status: "pending" })])
  const queued: ChatMessage = {
    sourceId: "queued",
    role: "user",
    text: "Also check the narrow layout.",
    tools: [],
    parts: [],
    queued: true,
  }

  const compact = coalesceToolActivityMessages([settled, pending, queued])
  assert.equal(liveToolActivityTail(compact.map((entry) => entry.message)), pending.tools[0])
  const liveHistory = historicalToolActivityMessages(compact)
  assert.deepEqual(liveHistory.map((entry) => entry.message.sourceId), ["queued"])
  assert.equal(
    liveHistory.some((entry) => entry.message.role === "assistant"),
    false,
    "a live pure-tool run must not render a partial historical disclosure",
  )

  pending.tools[0].status = "completed"
  const completed = coalesceToolActivityMessages([settled, pending])
  assert.equal(liveToolActivityTail(completed.map((entry) => entry.message)), pending.tools[0])
  assert.deepEqual(
    historicalToolActivityMessages(completed),
    [],
    "individual completion must not flash the digest while the turn is still running",
  )
  assert.deepEqual(
    completed[0].message.tools.map((call) => call.name),
    ["Read", "Bash"],
    "the idle caller can reveal the unmodified coalesced digest",
  )
})

test("a live tool tail is removed without hiding the prose that introduced it", () => {
  const pending = tool("Read", { detail: "src/render.tsx", status: "pending" })
  const lead: ChatMessage = {
    sourceId: "lead",
    role: "assistant",
    text: "I found the renderer.",
    tools: [pending],
    parts: [
      { kind: "text", text: "I found the renderer." },
      { kind: "tools", tools: [pending] },
    ],
  }

  const compact = coalesceToolActivityMessages([lead])
  const liveHistory = historicalToolActivityMessages(compact)
  assert.equal(liveToolActivityTail(compact.map((entry) => entry.message)), pending)
  assert.equal(liveHistory.length, 1)
  assert.equal(liveHistory[0].message.text, "I found the renderer.")
  assert.deepEqual(liveHistory[0].message.tools, [])
  assert.deepEqual(liveHistory[0].message.parts, [{ kind: "text", text: "I found the renderer." }])

  pending.status = "completed"
  const settledHistory = coalesceToolActivityMessages([lead])
  assert.equal(settledHistory[0].message.tools.length, 1)
  assert.deepEqual(settledHistory[0].message.parts?.map((part) => part.kind), ["text", "tools"])
})

test("only the final live tail leaves history; an earlier pending run ended by prose remains", () => {
  const earlier = toolMessage("earlier", [tool("Read", { status: "pending" })])
  const boundary: ChatMessage = {
    sourceId: "boundary",
    role: "assistant",
    text: "That check is complete.",
    tools: [],
    parts: [{ kind: "text", text: "That check is complete." }],
  }
  const latest = toolMessage("latest", [tool("Bash", { status: "pending" })])

  const history = historicalToolActivityMessages(
    coalesceToolActivityMessages([earlier, boundary, latest]),
  )
  assert.deepEqual(history.map((entry) => entry.message.sourceId), ["earlier", "boundary"])
  assert.equal(history[0].message.tools[0].status, "pending")
})

test("activity labels are gerunds with a clean fallback for arbitrary tools", () => {
  assert.equal(toolActivityLabel(tool("Read", { detail: "src/render.tsx" })), "Reading src/render.tsx")
  assert.equal(toolActivityLabel(tool("Grep", { detail: "ToolCalls" })), "Searching for ToolCalls")
  assert.equal(toolActivityLabel(tool("Bash", { desc: "Run focused tests", detail: "nub --test" })), "Running focused tests")
  assert.equal(toolActivityLabel(tool("Bash", { desc: "Checking generated output" })), "Checking generated output")
  assert.equal(
    toolActivityLabel(tool("Bash", { desc: "Find relative links in the README", detail: "rg -n ']\\(' README.md" })),
    "Finding relative links in the README",
    "an imperative description is converted, never prefixed with `Running`",
  )
  assert.equal(
    toolActivityLabel(tool("Bash", { desc: "Final workflow validation", detail: "cd /a/very/long/path && actionlint" })),
    "Final workflow validation",
    "an authored noun-phrase description suppresses the raw command fallback and is shown as written",
  )
  assert.equal(toolActivityLabel(tool("Todos")), "Updating the plan")
  assert.equal(toolActivityLabel(tool("mcp__example__frobnicate")), "Using frobnicate")
})

test("in-project absolute paths render project-relative in the live label", () => {
  const root = "/Users/me/Documents/projects/fray"
  const edit = tool("Edit", { detail: `${root}/packages/web/src/lib/toolActivity.ts` })
  assert.equal(toolActivityLabel(edit, root), "Editing packages/web/src/lib/toolActivity.ts")
  // No root (a board snapshot that has not landed yet) leaves the label exactly as before.
  assert.equal(toolActivityLabel(edit), `Editing ${root}/packages/web/src/lib/toolActivity.ts`)
  assert.equal(toolActivityLabel(edit, `${root}/`), "Editing packages/web/src/lib/toolActivity.ts")

  // Every path in the label shortens, including the ones inside a Bash description's arguments and
  // the directory a Grep detail scopes to.
  assert.equal(
    toolActivityLabel(tool("Bash", { desc: `Compare ${root}/ui/a.ts against ${root}/ui/b.ts` }), root),
    "Comparing ui/a.ts against ui/b.ts",
  )
  assert.equal(
    toolActivityLabel(tool("Grep", { detail: `useProjectDir · ${root}/ui/packages/web` }), root),
    "Searching for useProjectDir · ui/packages/web",
  )

  // A worker's own worktree under the project keeps the directory that identifies it.
  assert.equal(
    toolActivityLabel(tool("Edit", { detail: `${root}/wt-relative-path/ui/a.ts` }), root),
    "Editing wt-relative-path/ui/a.ts",
  )

  // A sibling checkout that merely shares the prefix is NOT in the project, so it keeps its own path
  // (home-collapsed, not project-relative) — the trailing slash is part of the needle.
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/Documents/projects/fray-old/ui/a.ts" }), root),
    "Reading ~/Documents/projects/fray-old/ui/a.ts",
  )
  // Outside the project the home prefix still collapses, inferred from the project root's own.
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/.claude/CLAUDE.md" }), root),
    "Reading ~/.claude/CLAUDE.md",
  )
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/.claude/CLAUDE.md" }), "/opt/checkouts/fray"),
    "Reading /Users/me/.claude/CLAUDE.md",
  )
  // Anything with no home prefix stays absolute: there is no root that makes it shorter and honest.
  assert.equal(toolActivityLabel(tool("Read", { detail: "/etc/hosts" }), root), "Reading /etc/hosts")
  // A degenerate root would eat every leading slash; it is ignored instead.
  assert.equal(toolActivityLabel(tool("Read", { detail: "/etc/hosts" }), "/"), "Reading /etc/hosts")
  assert.equal(toolActivityLabel(tool("Read", { detail: "/etc/hosts" }), ""), "Reading /etc/hosts")
})

test("the newest call drives the live gerund even when an earlier call remains pending", () => {
  const earlier = tool("Read", { detail: "src/old.ts", status: "pending" })
  const newest = tool("Bash", { desc: "Inspect PR review state and comments", status: "completed" })
  const compact = coalesceToolActivityMessages([toolMessage("parallel", [earlier, newest])])
  assert.equal(liveToolActivityTail(compact.map((entry) => entry.message)), newest)
  assert.equal(toolActivityLabel(newest), "Inspecting PR review state and comments")
})

test("the newest pending call drives the live label, then the final call drives settled history", () => {
  const pending = tool("Read", { status: "pending" })
  assert.deepEqual(
    currentToolActivity([
      tool("Grep", { status: "completed" }),
      pending,
      tool("Bash", { status: "completed" }),
    ]),
    { tool: pending, pending: true },
  )
  const settled = [tool("Read", { status: "completed" }), tool("Edit", { status: "failed" })]
  assert.deepEqual(currentToolActivity(settled), { tool: settled[1], pending: false })
  assert.equal(settledToolActivityLabel(1), "Ran 1 tool call")
  assert.equal(settledToolActivityLabel(settled.length), "Ran 2 tool calls")
})

test("the digest reports how many distinct files the run edited", () => {
  assert.equal(settledToolActivityLabel(27, 4), "Ran 27 tool calls, edited 4 files")
  assert.equal(settledToolActivityLabel(3, 1), "Ran 3 tool calls, edited 1 file")
  // A run that wrote nothing keeps the bare reading rather than trailing an "edited 0 files".
  assert.equal(settledToolActivityLabel(3, 0), "Ran 3 tool calls")
})

test("edited files are counted once per file, whatever shape the write arrived in", () => {
  assert.equal(editedFileCount([]), 0)
  assert.equal(editedFileCount([{ name: "Read", detail: "src/a.ts" }, { name: "Bash", detail: "rm src/b.ts" }]), 0)
  assert.equal(
    editedFileCount([
      // The collapsed shape merges consecutive edits to one file into a single `edits` entry.
      { name: "Edit", detail: "src/a.ts", edits: [{ file: "src/a.ts" }, { file: "src/a.ts" }] },
      { name: "Edit", detail: "src/a.ts", edit: { file: "src/a.ts" } },
      // A creation reads as an edit — Write ships the whole file as the new side.
      { name: "Write", detail: "src/b.ts", edit: { file: "src/b.ts" } },
      { name: "Read", detail: "src/c.ts" },
    ]),
    2,
  )
  // A codex apply_patch the server could not reconstruct (a Delete File, a multi-file hunk) arrives
  // named Edit with the file only in `detail`.
  assert.equal(editedFileCount([{ name: "Edit", detail: "src/gone.ts" }, { name: "apply_patch", detail: "src/gone.ts" }]), 1)
})

function thoughtMessage(sourceId: string, text: string, at = "2026-07-30T12:00:01.000Z"): ChatMessage {
  return { sourceId, role: "assistant", kind: "event", text, tools: [], parts: [], at }
}

test("thinking inside a run folds into it instead of splitting one burst in two", () => {
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
    thoughtMessage("t", "Thought for 24s"),
    toolMessage("b", [tool("Bash", { detail: "git diff" })], "2026-07-30T12:00:02.000Z"),
  ])

  assert.equal(compact.length, 1)
  assert.equal(compact[0].message.sourceId, "a")
  assert.deepEqual(
    compact[0].message.tools.map((call) => call.thought ?? call.detail),
    ["git log", "Thought for 24s", "git diff"],
  )
})

test("a thought with no run above it keeps its own row", () => {
  const compact = coalesceToolActivityMessages([
    thoughtMessage("t", "Thought for 24s"),
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["t", "a"])
})

test("a wake divider is not thinking and still ends the run", () => {
  const boundary: ChatMessage = {
    sourceId: "wake", role: "assistant", kind: "event", boundary: true,
    text: "Background task «boot» finished", tools: [], parts: [],
  }
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash")]),
    boundary,
    toolMessage("b", [tool("Bash")]),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "wake", "b"])
})

test("folded thinking never becomes the live activity gerund", () => {
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log", status: "completed" })]),
    thoughtMessage("t", "Thought for 24s"),
  ])
  const live = liveToolActivityTail(compact.map((entry) => entry.message))

  assert.equal(live?.name, "Bash")
  assert.equal(currentToolActivity(compact[0].message.tools).tool?.name, "Bash")
})
