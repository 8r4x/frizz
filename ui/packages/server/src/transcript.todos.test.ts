import { test } from "node:test"
import assert from "node:assert/strict"
import { projectClaudeTranscript, projectCodexTranscript } from "./transcript.ts"
import type { TranscriptToolCall } from "@fray-ui/shared"

// The built-in TO-DO LIST projection. What makes it worth its own file: Claude Code's Task* calls are
// DELTAS — `{taskId:"3", status:"completed"}` carries neither the subject nor the previous status — so
// every assertion here is really about the REGISTRY the fold accumulates across records, not about one
// call's input. The shapes are copied from real session logs (~/.claude/projects, 2026-07-29).

let seq = 0
function claudeLog(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n"
}
function call(name: string, input: unknown, id = `toolu_${++seq}`): unknown {
  return {
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: `m${seq}`, content: [{ type: "tool_use", id, name, input }] },
  }
}
function result(id: string, content: string): unknown {
  return {
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  }
}
// Every to-do call in a projected transcript, in order.
function todoCalls(messages: { tools: TranscriptToolCall[] }[]): TranscriptToolCall[] {
  return messages.flatMap((m) => m.tools).filter((t) => t.todos !== undefined)
}
function rows(t: TranscriptToolCall): string[] {
  return (t.todos ?? []).map((r) => `${r.status === "completed" ? "x" : r.status === "in_progress" ? ">" : " "}${r.changed ? "*" : " "}${r.text}`)
}

test("a Claude create/update sequence accumulates the list, and each card shows the state AFTER its own call", () => {
  const messages = projectClaudeTranscript(claudeLog([
    call("TaskCreate", { subject: "Rename env → envFile", description: "Across parser, schema, docs." }, "tu1"),
    result("tu1", "Task #1 created successfully: Rename env → envFile"),
    call("TaskCreate", { subject: "Cut the define field", description: "Maintainer approved cutting it." }, "tu2"),
    result("tu2", "Task #2 created successfully: Cut the define field"),
    // THE CASE THIS FEATURE EXISTS FOR: a status-only delta. The subject and the previous status can
    // only come from the registry — the call itself says `{taskId, status}` and nothing else.
    call("TaskUpdate", { taskId: "1", status: "in_progress" }, "tu3"),
    result("tu3", "Updated task #1 status"),
    call("TaskUpdate", { taskId: "1", status: "completed" }, "tu4"),
    result("tu4", "Updated task #1 status"),
  ]))
  const calls = todoCalls(messages)
  assert.equal(calls.length, 4)
  // Each snapshot is a point-in-time copy: the first create's card must NOT have grown a second row.
  assert.deepEqual(rows(calls[0]), [" *Rename env → envFile"])
  assert.deepEqual(rows(calls[1]), ["  Rename env → envFile", " *Cut the define field"])
  assert.deepEqual(rows(calls[2]), [">*Rename env → envFile", "  Cut the define field"])
  assert.deepEqual(rows(calls[3]), ["x*Rename env → envFile", "  Cut the define field"])
  // The delta card's headline is the SUBJECT, resolved from the registry — never the raw taskId, and
  // never (as the generic card did) the `description`.
  assert.equal(calls[3].detail, "Rename env → envFile")
  assert.deepEqual(calls.map((c) => c.todoChange), ["created", "created", "updated", "updated"])
  // The description moves to the expandable body instead of being the title.
  assert.equal(calls[0].input, "Across parser, schema, docs.")
  assert.equal(calls[3].input, undefined)
})

test("a Claude TaskUpdate resolves its subject only because the create's RESULT revealed the id", () => {
  // Without claimCreatedTodoId the row stays keyed by its tool_use id and the update below misses it.
  const withResult = todoCalls(projectClaudeTranscript(claudeLog([
    call("TaskCreate", { subject: "Fix the flaky test", description: "d" }, "tu1"),
    result("tu1", "Task #7 created successfully: Fix the flaky test"),
    call("TaskUpdate", { taskId: "7", status: "completed" }, "tu2"),
  ])))
  assert.equal(withResult[1].detail, "Fix the flaky test")
  assert.deepEqual(rows(withResult[1]), ["x*Fix the flaky test"])
  // A RESUMED session updates ids whose creates predate the transcript. It must still render a card —
  // a stub row, honestly labelled — rather than an empty list or a crash.
  const resumed = todoCalls(projectClaudeTranscript(claudeLog([
    call("TaskUpdate", { taskId: "4", status: "completed" }, "tu9"),
  ])))
  assert.deepEqual(rows(resumed[0]), ["x*Task #4"])
})

test("a Claude TaskList result REPLACES the registry, repairing a partial one", () => {
  const calls = todoCalls(projectClaudeTranscript(claudeLog([
    call("TaskUpdate", { taskId: "2", status: "completed" }, "tu1"), // a stub — this session never created it
    call("TaskList", {}, "tu2"),
    result("tu2", "#1 [pending] Confine reads on Windows\n#2 [completed] Fix the coarse network grant\n#3 [in_progress] Drop per-host on macOS"),
    call("TaskUpdate", { taskId: "3", status: "completed" }, "tu3"),
  ])))
  assert.deepEqual(rows(calls[0]), ["x*Task #2"])
  // The list result is authoritative, and the TaskList card is redrawn from it (not from the stub).
  assert.deepEqual(rows(calls[1]), ["  Confine reads on Windows", "x Fix the coarse network grant", "> Drop per-host on macOS"])
  assert.equal(calls[1].todoChange, undefined, "a whole-list read has no verb")
  // And the adopted subjects now resolve for later deltas.
  assert.equal(calls[2].detail, "Drop per-host on macOS")
  assert.deepEqual(rows(calls[2]), ["  Confine reads on Windows", "x Fix the coarse network grant", "x*Drop per-host on macOS"])
})

test("a Claude delete drops the row but still names it in the headline", () => {
  const calls = todoCalls(projectClaudeTranscript(claudeLog([
    call("TaskCreate", { subject: "Keep this one", description: "d" }, "tu1"),
    result("tu1", "Task #1 created successfully: Keep this one"),
    call("TaskCreate", { subject: "Created in error", description: "d" }, "tu2"),
    result("tu2", "Task #2 created successfully: Created in error"),
    call("TaskUpdate", { taskId: "2", status: "deleted" }, "tu3"),
  ])))
  const deleted = calls[2]
  assert.equal(deleted.todoChange, "deleted")
  assert.equal(deleted.detail, "Created in error")
  assert.deepEqual(rows(deleted), ["  Keep this one"], "the deleted row is gone from the list")
})

test("a Claude TaskUpdate that rewrites the subject renames the row for every later card", () => {
  const calls = todoCalls(projectClaudeTranscript(claudeLog([
    call("TaskCreate", { subject: "Propose the object syntax", description: "d" }, "tu1"),
    result("tu1", "Task #1 created successfully: Propose the object syntax"),
    call("TaskUpdate", { taskId: "1", status: "in_progress", subject: "Implement the object syntax", description: "Approved." }, "tu2"),
    call("TaskUpdate", { taskId: "1", status: "completed" }, "tu3"),
  ])))
  assert.equal(calls[1].detail, "Implement the object syntax")
  assert.equal(calls[1].input, "Approved.")
  assert.deepEqual(rows(calls[2]), ["x*Implement the object syntax"])
})

test("the legacy Claude TodoWrite ships the whole list and headlines the current step", () => {
  const calls = todoCalls(projectClaudeTranscript(claudeLog([
    call("TodoWrite", { todos: [
      { content: "Read the config parser", status: "completed", activeForm: "Reading" },
      { content: "Add the envFile field", status: "in_progress", activeForm: "Adding" },
      { content: "Update the docs", status: "pending", activeForm: "Updating" },
    ] }, "tu1"),
  ])))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].todoChange, undefined, "a whole-list write has no single subject row")
  assert.equal(calls[0].detail, "Add the envFile field")
  assert.deepEqual(rows(calls[0]), ["x Read the config parser", ">*Add the envFile field", "  Update the docs"])
})

test("a to-do card never folds into a repeat count, however identical two calls look", () => {
  // Two updates with the SAME input are two DIFFERENT list states; collapsing them would erase one.
  const messages = projectClaudeTranscript(claudeLog([
    call("TaskCreate", { subject: "A", description: "d" }, "tu1"),
    result("tu1", "Task #1 created successfully: A"),
    call("TaskCreate", { subject: "B", description: "d" }, "tu2"),
    result("tu2", "Task #2 created successfully: B"),
    {
      type: "assistant",
      timestamp: "2026-07-01T00:00:00.000Z",
      message: { id: "mx", content: [
        { type: "tool_use", id: "tu3", name: "TaskUpdate", input: { taskId: "1", status: "completed" } },
        { type: "tool_use", id: "tu4", name: "TaskUpdate", input: { taskId: "2", status: "completed" } },
      ] },
    },
  ]))
  const calls = todoCalls(messages)
  assert.equal(calls.length, 4)
  assert.deepEqual(rows(calls[2]), ["x*A", "  B"])
  assert.deepEqual(rows(calls[3]), ["x A", "x*B"])
})

// ---- codex `update_plan`: the whole plan, both protocols ----

function codexLog(payloads: unknown[]): string {
  return payloads.map((p) => JSON.stringify({ timestamp: "2026-07-01T00:00:00.000Z", type: "response_item", payload: p })).join("\n") + "\n"
}

test("a codex update_plan function_call renders as a to-do card with its explanation as the note", () => {
  const calls = todoCalls(projectCodexTranscript(codexLog([
    {
      type: "function_call",
      name: "update_plan",
      call_id: "call_1",
      arguments: JSON.stringify({
        explanation: "Instructions and PR context are loaded.",
        plan: [
          { step: "Read the review instructions", status: "completed" },
          { step: "Inspect the full diff", status: "in_progress" },
          { step: "Deliver ranked findings", status: "pending" },
        ],
      }),
    },
  ])))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, "Todos")
  assert.equal(calls[0].detail, "Inspect the full diff")
  assert.equal(calls[0].input, "Instructions and PR context are loaded.")
  assert.deepEqual(rows(calls[0]), ["x Read the review instructions", ">*Inspect the full diff", "  Deliver ranked findings"])
})

test("a codex JS-WRAPPER update_plan is scanned out of the object literal, mixed quoting and all", () => {
  // Verbatim shape from a real rollout: a bare `step` key beside a quoted `"status"` key, so the args
  // are JavaScript and not JSON — JSON.parse cannot read them.
  const source = 'const r = await tools.update_plan({plan:[{step:"Inspect the patch","status":"completed"},{step:"Trace the lifecycle",status:"in_progress"},{step:"Report findings","status":"pending"}]});text(String(r));'
  const calls = todoCalls(projectCodexTranscript(codexLog([
    { type: "custom_tool_call", name: "exec", call_id: "call_2", input: source },
  ])))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].detail, "Trace the lifecycle")
  assert.deepEqual(rows(calls[0]), ["x Inspect the patch", ">*Trace the lifecycle", "  Report findings"])
})

test("an all-complete plan headlines nothing — the counter is the whole reading", () => {
  const calls = todoCalls(projectCodexTranscript(codexLog([
    {
      type: "function_call",
      name: "update_plan",
      call_id: "call_3",
      arguments: JSON.stringify({ plan: [{ step: "One", status: "completed" }, { step: "Two", status: "completed" }] }),
    },
  ])))
  assert.equal(calls[0].detail, undefined)
  assert.deepEqual(rows(calls[0]), ["x One", "x Two"])
})
