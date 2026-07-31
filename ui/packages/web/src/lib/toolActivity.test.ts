import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptToolCall } from "@fray-ui/shared"
import type { ChatMessage } from "../hooks.ts"
import {
  coalesceToolActivityMessages,
  currentToolActivity,
  hasPendingToolActivityTail,
  isToolActivityException,
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

test("background shells stay in the run while visible prose and sub-agent cards split it", () => {
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
  assert.equal(isToolActivityException(tool("Bash", { backgroundState: "unknown" })), true)
  assert.equal(isToolActivityException(agent.tools[0]), true)
  assert.equal(isToolActivityException(tool("Send message", { sendTo: "main" })), true)
  assert.equal(isToolActivityException(tool("Read")), false)
})

test("a prose message's ordinary tool tail owns following provider batches until the next block", () => {
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
    toolMessage("batch-b", [tool("Bash", { backgroundState: "background", status: "pending" })]),
    {
      sourceId: "empty",
      role: "assistant",
      text: "",
      tools: [],
      parts: [{ kind: "text", text: "  " }],
    } satisfies ChatMessage,
    toolMessage("batch-c", [tool("Write", { status: "completed" })]),
  ]

  const compact = coalesceToolActivityMessages(messages)
  assert.equal(compact.length, 1)
  assert.equal(compact[0].message.sourceId, "lead")
  assert.equal(compact[0].message.text, lead.text)
  assert.deepEqual(compact[0].message.parts?.map((part) => part.kind), ["text", "tools"])
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Bash", "Read", "Bash", "Write"])
  assert.equal(compact[0].message.parts?.[1].kind, "tools")
  assert.equal(compact[0].message.parts?.[1].kind === "tools" ? compact[0].message.parts[1].tools.length : 0, 4)
})

test("the latest pending tool shimmer replaces the generic working tail", () => {
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
  assert.equal(hasPendingToolActivityTail(compact.map((entry) => entry.message)), true)
  pending.tools[0].status = "completed"
  assert.equal(hasPendingToolActivityTail(coalesceToolActivityMessages([settled, pending]).map((entry) => entry.message)), false)
})

test("activity labels are gerunds with a clean fallback for arbitrary tools", () => {
  assert.equal(toolActivityLabel(tool("Read", { detail: "src/render.tsx" })), "Reading src/render.tsx")
  assert.equal(toolActivityLabel(tool("Grep", { detail: "ToolCalls" })), "Searching for ToolCalls")
  assert.equal(toolActivityLabel(tool("Bash", { desc: "Run focused tests", detail: "nub --test" })), "Running focused tests")
  assert.equal(toolActivityLabel(tool("Bash", { desc: "Checking generated output" })), "Checking generated output")
  assert.equal(toolActivityLabel(tool("Todos")), "Updating the plan")
  assert.equal(toolActivityLabel(tool("mcp__example__frobnicate")), "Using frobnicate")
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
