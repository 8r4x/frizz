#!/usr/bin/env node
// @ts-check
// PreToolUse hook on the `Agent` tool (fray-worker). A worker MAY spin up its own helper
// sub-agents; this hook holds them to the same rules cc enforces for the orchestrator:
//   1) ENFORCE background dispatch — deny any Agent call lacking run_in_background:true (a
//      foreground agent blocks the worker's turn; a human interjection orphans it).
//   2) STRIP `name`/`team_name` — setting either strands a nested dispatch (its result routes
//      wrong and never returns cleanly), so scrub both silently.
//   3) AUTO-APPEND a repo-neutral ORCHESTRATION EPILOGUE so helpers return a useful handoff,
//      know how to reach their dispatcher mid-flight, and collect a helper of their OWN correctly
//      — without imposing build, test, git, compilation, or process-lifecycle policy on
//      arbitrary repos.
//
// WHY THE NESTED-DISPATCH PARAGRAPH EXISTS (2026-07-31): this hook fires at EVERY depth, but the
// fray worker contract reaches only the ROOT worker — so its "keep fan-out shallow / a rested agent
// is not reliably re-woken by grandchildren" rule was delivered exclusively to the one agent that
// does not spawn grandchildren, and withheld from the depth-1 child that does. Into that silence a
// user-level CLAUDE.md ("the parent stays awake and polls the child's transcript") supplied a
// hand-rolled polling recipe, and it failed: the `.output` path is a SYMLINK, so `stat` without -L
// returns the LINK's size (= the length of its target path) and its frozen creation mtime, while
// the `"type":"result"` record is never reliably written. Both halves of the predicate
// false-negatived at once, a live 413KB helper read as "size=153 age=325s results=0", and the
// dispatcher discarded it and redid the work itself. This paragraph is the only place that reaches
// a nested dispatcher without depending on its parent remembering to restate the norm.
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
[ORCHESTRATION EPILOGUE — auto-appended by the fray worker dispatch hook] You are a helper sub-agent for a fray-ui worker. Your final message is the handoff: report your outcome/status; what you did; changed files, artifacts, and commit SHA when applicable; verification or evidence and its result; caveats or unresolved work; and the next action when one remains. A bare "done" or progress-only message is not a complete handoff.
The worker's scratchpad is shared: merge your own scoped progress into it as you work rather than leaving the root as its sole writer. Re-read before every edit and preserve every other agent's content. This exact scratchpad is Fray coordination state, not a project deliverable or source edit: a scoped merge is an explicit exception to delegated phrases such as "write only <path>" or "do not modify the repo"; never classify it as unauthorized or roll it back. Never delete, truncate, reinitialize, move, or replace the whole file. Other project files, including repository-root files, remain governed by your delegated authority; their location alone neither permits nor forbids editing. Do not edit other \`.fray/\` state unless your prompt explicitly asks you to.
You have an upward channel while you work: \`SendMessage({to: "main", summary: "<5-10 words>", message: "…"})\` delivers to your dispatcher. Use it when the dispatcher acting before you finish could change the outcome—for example, when you hit an unresolved blocker, complete a milestone another task needs, or discover that your instructions should change. Do not use it for routine progress updates.
If you dispatch a helper of your own, its completion is delivered to you automatically. Never hand-roll a wait loop over a helper's transcript or \`.output\` path to decide whether it finished: that path is a SYMLINK, so \`stat\` without \`-L\` reports the link's own size (the length of its target path, ~150 bytes) and its frozen creation mtime, and the \`"type":"result"\` record is not reliably written — so a helper that is working hard reads as tiny, stale, and dead, and you will discard live work and redo it. Judge a helper only by its completion notification or the text it returns. Give it a \`description\` naming its narrower slice rather than restating your own, so the dispatch tree stays readable.`;

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
  // Idempotence is "this prompt ALREADY ENDS WITH the epilogue", not "this prompt mentions the
  // marker anywhere". A substring test silently ate the epilogue for any prompt that merely QUOTED
  // the marker — e.g. a worker asking a helper to report whether the epilogue reached it, which is
  // exactly how this was caught. endsWith still catches a genuine double-fire (the only real case).
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  const updatedInput = prompt.endsWith(EPILOGUE)
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
