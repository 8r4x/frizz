import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"
import {
  coalesceToolActivityMessages,
  currentToolActivity,
  historicalToolActivityMessages,
  isToolActivityException,
  liveToolActivityRun,
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

test("prose, sub-agent cards AND background launches each split the activity run", () => {
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
    "background",
    "two",
    "agent",
    "three",
    "prose",
    "four",
  ])
  assert.deepEqual(
    compact[0].message.tools.map((call) => call.name),
    ["Read"],
    "the background launch ends the run above it instead of being absorbed into it",
  )
  assert.deepEqual(compact[1].message.tools.map((call) => call.backgroundState), ["background"])
  // A detached op keeps a dedicated card wherever it renders — the maintainer's whole point is that a
  // background task must not disappear behind `Ran N tool calls`. `unknown` (a blocked `&` job, an
  // orphaned poll) is a background shape too and gets the same treatment.
  assert.equal(isToolActivityException(background.tools[0]), true)
  assert.equal(isToolActivityException(tool("Bash", { backgroundState: "unknown" })), true)
  assert.equal(isToolActivityException(agent.tools[0]), true)
  assert.equal(isToolActivityException(tool("Send message", { sendTo: "main" })), true)
  // An ordinary foreground call is still ordinary activity — including a long one.
  assert.equal(isToolActivityException(tool("Read")), false)
  assert.equal(isToolActivityException(tool("Bash", { command: "nub --test", status: "pending" })), false)
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

test("a call whose result is a picture keeps its card and splits the run", () => {
  // An image Read: the harness returns the picture as the WHOLE result, so there is no excerpt text —
  // `outputImage` is the only signal that this Read is a screenshot rather than a source file.
  const imageRead = tool("Read", { detail: "/tmp/shots/board.png", outputImage: "/tmp/frizz-tool-images/ab.png", status: "completed" })
  const shot = tool("mcp__chrome-devtools__take_screenshot", { outputImage: "/tmp/frizz-tool-images/cd.png", status: "completed" })
  const delivery = tool("SendUserFile", { sentImages: ["/tmp/frizz-tool-images/ef.png"], caption: "before vs after", status: "completed" })
  for (const call of [imageRead, shot, delivery]) assert.equal(isToolActivityException(call), true)

  // A Read of ORDINARY source, and a delivery of non-image files, stay in the digest.
  assert.equal(isToolActivityException(tool("Read", { detail: "src/a.ts", read: "export const x = 1" })), false)
  assert.equal(isToolActivityException(tool("SendUserFile", { sentFiles: ["notes.pdf"] })), false)

  const compact = coalesceToolActivityMessages([
    toolMessage("one", [tool("Bash"), tool("Grep")]),
    toolMessage("shot", [imageRead], "2026-07-30T12:00:01.000Z"),
    toolMessage("two", [tool("Edit")], "2026-07-30T12:00:02.000Z"),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.tools.map((call) => call.name)), [
    ["Bash", "Grep"],
    ["Read"],
    ["Edit"],
  ])
})

test("a prose tool tail absorbs ordinary calls, and a background launch is what ends it", () => {
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
  assert.deepEqual(
    compact.map((entry) => entry.message.sourceId),
    ["lead", "batch-b", "batch-c", "finished-event"],
    "the detached launch gets its own row; the ordinary run resumes after it",
  )
  assert.equal(compact[0].message.text, lead.text)
  assert.deepEqual(compact[0].message.parts?.map((part) => part.kind), ["text", "tools"])
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Bash", "Read", "Edit"])
  assert.equal(compact[0].message.parts?.[1].kind, "tools")
  assert.equal(compact[0].message.parts?.[1].kind === "tools" ? compact[0].message.parts[1].tools.length : 0, 3)
  assert.equal(compact[1].message.tools[0].backgroundState, "background")
  // The empty-parts record between the launch and `batch-c` is still transparent — a provider shell with
  // nothing renderable in it never becomes a boundary of its own.
  assert.deepEqual(compact[2].message.tools.map((call) => call.name), ["Bash"])
})

test("the runtime gerund ends with its call; only the digest stays hidden across the inter-call gap", () => {
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
  assert.equal(
    liveToolActivityTail(completed.map((entry) => entry.message)),
    undefined,
    "with the last result landed nothing is executing — the slot reverts to the generic Thinking reading",
  )
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

test("expanding the shimmer opens exactly the run history is withholding, gap included", () => {
  const first = tool("Read", { detail: "src/a.ts", status: "completed" })
  const second = tool("Grep", { detail: "renderActivity", status: "pending" })
  const settled = toolMessage("batch-a", [first])
  const pending = toolMessage("batch-b", [second], "2026-07-30T12:00:02.000Z")

  const compact = coalesceToolActivityMessages([settled, pending])
  assert.deepEqual(
    liveToolActivityRun(compact.map((entry) => entry.message)),
    { tools: [first, second], at: "2026-07-30T12:00:02.000Z" },
    "the whole coalesced run backs the disclosure, not just the call the shimmer names — and the newest batch's clock rides with it, so an expanded pending card times itself",
  )

  // The INTER-CALL GAP: the label reverts to `Thinking…`, but history is still withholding the run, so
  // an expanded panel must keep showing it rather than emptying and refilling on the next call.
  second.status = "completed"
  const idle = coalesceToolActivityMessages([settled, pending])
  assert.equal(liveToolActivityTail(idle.map((entry) => entry.message)), undefined)
  assert.deepEqual(
    liveToolActivityRun(idle.map((entry) => entry.message))?.tools,
    [first, second],
    "a settled-but-still-hidden run stays open across the gap",
  )

  // Prose ends the run, and with it the shimmer's claim on those calls — they return as history's own
  // digest, so the live disclosure must not also hold them.
  const prose: ChatMessage = {
    sourceId: "prose",
    role: "assistant",
    text: "Found it.",
    tools: [],
    parts: [{ kind: "text", text: "Found it." }],
  }
  assert.equal(
    liveToolActivityRun(coalesceToolActivityMessages([settled, pending, prose]).map((entry) => entry.message)),
    undefined,
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
  const root = "/Users/me/Documents/projects/frizz"
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
    toolActivityLabel(tool("Read", { detail: "/Users/me/Documents/projects/frizz-old/ui/a.ts" }), root),
    "Reading ~/Documents/projects/frizz-old/ui/a.ts",
  )
  // Outside the project the home prefix still collapses, inferred from the project root's own.
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/.claude/CLAUDE.md" }), root),
    "Reading ~/.claude/CLAUDE.md",
  )
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/.claude/CLAUDE.md" }), "/opt/checkouts/frizz"),
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

  // …and when that straggler lands too, nothing in the batch is executing any more.
  earlier.status = "completed"
  const drained = coalesceToolActivityMessages([toolMessage("parallel", [earlier, newest])])
  assert.equal(liveToolActivityTail(drained.map((entry) => entry.message)), undefined)
})

test("a failed or cancelled result ends the gerund exactly like a completed one", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const compact = coalesceToolActivityMessages([toolMessage(status, [tool("Bash", { detail: "nub test", status })])])
    assert.equal(
      liveToolActivityTail(compact.map((entry) => entry.message)),
      undefined,
      `a ${status} call is no longer executing`,
    )
  }
})

test("a pre-restart transcript with no statuses keeps naming its newest call", () => {
  // Completion is simply not observable on this data, so the gerund is the best reading available —
  // falling to a permanent `Thinking…` for the whole turn would be strictly worse.
  const newest = tool("Grep", { detail: "resolver" })
  const compact = coalesceToolActivityMessages([toolMessage("legacy", [tool("Read", { detail: "src/a.ts" }), newest])])
  assert.equal(liveToolActivityTail(compact.map((entry) => entry.message)), newest)
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

function eventMessage(sourceId: string, text: string, at = "2026-07-30T12:00:01.000Z"): ChatMessage {
  return { sourceId, role: "assistant", kind: "event", text, tools: [], parts: [], at }
}

test("a queued steer is transparent to the run it sits inside", () => {
  // The bubble is pinned to the BOTTOM of the pane and never drawn inline, so nothing visible separates
  // the calls either side of it. It used to end the run anyway: the calls above stranded into a settled
  // `Ran N tool calls` digest, and the thought below — the next turn's opening pause — found no run to
  // fold into and took a row of its own (maintainer 2026-08-01: "I thought we'd dropped the 'thought for
  // the x seconds' thing entirely").
  const steer: ChatMessage = {
    sourceId: "steer", role: "user", queued: true,
    text: "So we still require TMUX?", tools: [], parts: [],
  }
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
    steer,
    toolMessage("b", [tool("Bash", { detail: "git diff" })], "2026-07-30T12:00:02.000Z"),
  ])

  // The bubble keeps its slot — the callers that pin it read this list — but the run is unbroken.
  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "steer"])
  assert.deepEqual(compact[0].message.tools.map((call) => call.detail), ["git log", "git diff"])
})

test("a DELIVERED steer still ends the run", () => {
  // The control for the case above: once the bubble lands it is a real inline message, so the calls
  // either side of it belong to two different turns and must not share one disclosure.
  const steer: ChatMessage = {
    sourceId: "steer", role: "user",
    text: "So we still require TMUX?", tools: [], parts: [],
  }
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
    steer,
    toolMessage("b", [tool("Bash", { detail: "git diff" })], "2026-07-30T12:00:02.000Z"),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "steer", "b"])
})

test("a quiet event line still ends the run it follows", () => {
  // Thinking no longer reaches the client at all, but a compaction note / "Agent … finished" line does,
  // and those are real transcript punctuation: the calls either side of one are not one batch.
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
    eventMessage("c", "Context compacted — 142k tokens dropped"),
    toolMessage("b", [tool("Bash", { detail: "git diff" })], "2026-07-30T12:00:02.000Z"),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "c", "b"])
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

test("the newest call in the landed tail names the live gerund", () => {
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log", status: "completed" }), tool("Grep", { detail: "resolver", status: "pending" })]),
  ])
  const live = liveToolActivityTail(compact.map((entry) => entry.message))

  assert.equal(live?.name, "Grep")
  assert.equal(currentToolActivity(compact[0].message.tools).tool?.name, "Grep")
})

// The maintainer's screenshot: the shimmer read "Restarting the census sweep · 11m 57s" for a shell they
// had force-killed two days earlier. The server pins a below-the-window background launch at the TAIL of
// the transcript, and the retirement projection used to strip `backgroundState` off it — which is the one
// field that keeps a background op out of the coalesced run. Stripped, the killed shell was just the
// newest ordinary call in the tail, and this function handed its description to the shimmer.
test("a retired background op never becomes the live gerund", () => {
  const retired = toolMessage("pinned-bg:abc", [
    tool("Bash", { command: "node census.ts", desc: "Restart the census sweep", backgroundState: "background", status: "cancelled", shellId: "toolu_sh" }),
  ])
  const compact = coalesceToolActivityMessages([toolMessage("a", [tool("Read", { detail: "src/a.ts", status: "completed" })]), retired])

  assert.equal(isToolActivityException(retired.tools[0]), true, "it is still a background card, not run filler")
  assert.equal(compact.length, 2, "and it never folds into the run above it")
  assert.equal(liveToolActivityTail(compact.map((entry) => entry.message)), undefined)
})
