#!/usr/bin/env node
// @ts-check
// PreToolUse hook on the `Agent` tool (fray-worker). A worker MAY spin up its own helper
// sub-agents; this hook holds them to the same rules cc enforces for the orchestrator:
//   1) ENFORCE background dispatch — deny any Agent call lacking run_in_background:true (a
//      foreground agent blocks the worker's turn; a human interjection orphans it).
//   2) STRIP `name`/`team_name` — setting either strands a nested dispatch (its result routes
//      wrong and never returns cleanly), so scrub both silently.
//   3) AUTO-APPEND a worker-flavored ORCHESTRATION EPILOGUE so helpers hand back an
//      orchestration-ready report, run long ops to completion inline, and know they have an
//      UPWARD channel (`SendMessage({to:"main"})`) for the blocker/milestone worth interrupting
//      the dispatcher for. Stripping `name` (rule 2) does not affect that channel: `to:"main"`
//      addresses the parent conversation, never a teammate by name.
//
// GATE: inert unless FRAY_UI_THREAD is set (not a fray-ui worker → allow every dispatch unmodified).
//
// DROPPED vs cc's agent-dispatch.mjs (see DECISIONS.md): the `.dispatch-count` bump (it only gates
// cc's SubagentStop rest-recorder, which cc-worker does not ship) and the THREAD:-ledger write +
// thread-existence DENY gate (that guards the orchestrator's "file the thread before dispatching"
// discipline; a worker owns exactly one already-existing thread and its helpers own no thread).
//
// FAIL OPEN: any parse error → allow unmodified. A broken dispatch hook must never halt work.
import { readFileSync } from 'node:fs';

const EPILOGUE = `

---
[ORCHESTRATION EPILOGUE — auto-appended by the fray worker dispatch hook] You are a helper sub-agent for a fray-ui worker. Your final message IS the handoff — make it orchestration-ready: verdict/status; what you did; changed files/artifacts/commit SHA when applicable; verification commands + their results; caveats/risks; one concrete next action. A bare "done" or progress-only final message is an INCOMPLETE handoff (a bug), not success.
RUN LONG OPS TO COMPLETION INLINE — meaning ops YOU own. Your final message ENDS this helper task, so never return while your own Monitor/background command is live. Keep a bounded wait in a foreground Bash call when practical; if a watch must outlive this helper, report the current state and exact watch command so the top-level worker can own it. Monitor and background Bash are available, but they are not permission to background-and-rest.
AN EXPLICIT SCOPE LIMIT IN YOUR PROMPT OUTRANKS THIS EPILOGUE. If your prompt says the dispatcher owns the build/test — the usual shape is several agents editing one tree, then ONE shared build — then do NOT run a build, a test, or any compiler, not even to check your work. Concurrent builds on one tree serialise on a single lock, so "just verifying" blocks every sibling and is the specific waste that batching exists to remove. Report the files you touched and stop; the dispatcher's build covers you.
DO NOT edit the dispatcher's scratchpad (\`.fray/threads/<session-id>/scratch.md\`) or any \`.fray/\` state — the fray worker who dispatched you OWNS it and folds your report in. If a scratchpad path is in your prompt, READ it for shared context but never write it. Report your findings/changes in your FINAL MESSAGE — that is your handoff, and it is what ends this task.
YOU ALSO HAVE AN UPWARD CHANNEL, mid-flight: \`SendMessage({to: "main", summary: "<5-10 words>", message: "…"})\` delivers into your dispatcher's queue while you keep working, and it reads the message at its next turn boundary. \`to\` must be exactly \`"main"\`. If \`SendMessage\` is not already callable it is a DEFERRED tool — load it first with \`ToolSearch\` using the query \`select:SendMessage\`. Use it ONLY when the dispatcher acting sooner changes the outcome: you have hit a blocker you cannot resolve, you finished a milestone another prong is waiting on, or you found something that should change your own instructions. Do NOT narrate progress — every message spends the dispatcher's context, and it cannot reply to a message you send after you have already returned.
If you COMMITTED: verify the tree COMPILES at your commit — unless the scope limit above applies, in which case say what you changed and leave the compile to the dispatcher. If there are no follow-ups, say "Follow-ups: none."`;

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

try {
  // WORKER GATE — inert outside a fray-ui worker session.
  if (!(process.env.FRAY_UI_THREAD ?? '').trim()) emit({});

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const ti = input.tool_input ?? {};

  if (ti.run_in_background !== true) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'fray worker (hook-enforced): Agent sub-agents MUST be dispatched with run_in_background:true — never foreground/blocking. A foreground agent blocks the worker turn and a human interjection orphans its work. Re-send this Agent call with run_in_background:true.',
      },
    });
  }

  // Strip name/team_name (they strand nested dispatches), then append the epilogue once.
  const { name: _droppedName, team_name: _droppedTeam, ...tiStripped } = ti;
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  const updatedInput = prompt.includes('[ORCHESTRATION EPILOGUE')
    ? tiStripped
    : { ...tiStripped, prompt: prompt + EPILOGUE };

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  });
} catch {
  emit({}); // fail open — allow unmodified
}
