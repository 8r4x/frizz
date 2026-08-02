// CI tests for the two things the canUseTool channel does with a Claude tool call: journal it as an
// approval card, or — for AskUserQuestion alone — refuse it.
//
// The refusal is the one worth pinning. Between 2026-07-27 and 2026-08-02 this file instead pinned an
// AskUserQuestion → agent-question mapping, byte for byte, and every one of those assertions passed
// while a live thread sat parked for 90 minutes behind the card they described. The card was correct;
// the mechanics were not. So what is asserted here is that a worker cannot reach the tool at all
// (WORKER_DISALLOWED_TOOLS, on BOTH Claude transports) and that a call arriving anyway is denied with a
// redirect the model can act on — never downgraded to an approval card, whose bare allow claude's own
// result mapper reads back to the model as "the user did not answer the questions".
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CLAUDE_ASK_DENY_MESSAGE,
  CLAUDE_ASK_USER_QUESTION_TOOL,
  buildClaudePermissionInteraction,
  claudePermissionDecisionFor,
} from "./claude-permission-interactions.ts"
import { WORKER_DISALLOWED_TOOLS } from "./types.ts"
import { workerDisallowedToolFlags } from "../dispatch.ts"
import type { ClaudePermissionRequest } from "./claude-agent-sdk-protocol.ts"

const OWNER = { projectId: "p1", threadSlug: "ask-thread", sessionId: "s1", cwd: "/tmp/repo" }

function requestFor(toolName: string, input: unknown): ClaudePermissionRequest {
  return {
    requestId: "perm-1",
    toolUseId: "toolu_1",
    toolName,
    input: input as ClaudePermissionRequest["input"],
    suggestions: [],
  }
}

test("AskUserQuestion is taken away from a worker on BOTH Claude transports", () => {
  assert.ok(WORKER_DISALLOWED_TOOLS.includes(CLAUDE_ASK_USER_QUESTION_TOOL))
  // The tmux argv and the broker's SDK option read the SAME list, which is the drift this constant
  // exists to prevent: the broker path silently kept the tool for a week after the tmux path dropped it.
  assert.deepEqual(workerDisallowedToolFlags(), [`--disallowedTools=${WORKER_DISALLOWED_TOOLS.join(",")}`])
})

test("the deny message sends the model to a ```question fence and tells it to END THE TURN", () => {
  // The redirect has to name the replacement, not just refuse: a worker told only "no" asks again.
  assert.match(CLAUDE_ASK_DENY_MESSAGE, /```question/)
  assert.match(CLAUDE_ASK_DENY_MESSAGE, /FINAL MESSAGE/)
  assert.match(CLAUDE_ASK_DENY_MESSAGE, /END YOUR TURN/)
  // And it has to say WHY, because the reason is the part a model can generalize from. "Nobody is at
  // the keyboard" was the old reason and it is false — fray can render the card. The true reason is
  // that the turn parks and the operator's follow-ups queue up behind it unread.
  assert.match(CLAUDE_ASK_DENY_MESSAGE, /parks|queue/)
})

test("an ordinary tool escalation still becomes a permission-approval card", () => {
  const request = requestFor("Bash", { command: "rm -rf build", description: "Clearing the build dir" })
  const built = buildClaudePermissionInteraction(request, OWNER)
  assert.ok(built)
  assert.equal(built.payload.kind, "permission-approval")
  assert.equal(built.provider.kind, "claude")
  assert.equal(built.source.kind, "tool")
  assert.deepEqual(built.allowedDecisions.map((d) => [d.id, d.semantic]), [["grant-turn", "approve"], ["deny", "deny"]])
  // The command leads the card — the operator reads a shell line, not a JSON blob or a tool name.
  assert.equal(built.payload.kind === "permission-approval" && built.payload.title, "Run a command?")
  assert.match(built.payload.kind === "permission-approval" ? built.payload.preview ?? "" : "", /^rm -rf build/)
})

test("only an explicit approve allows; every other decision id fails closed", () => {
  assert.equal(claudePermissionDecisionFor("grant-turn").behavior, "allow")
  assert.equal(claudePermissionDecisionFor("grant-session").behavior, "allow")
  for (const id of ["deny", "cancel", "answer", undefined, ""]) {
    assert.equal(claudePermissionDecisionFor(id).behavior, "deny", String(id))
  }
})
