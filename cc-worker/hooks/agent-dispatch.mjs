#!/usr/bin/env node
// @ts-check
// PreToolUse hook on the `Agent` tool (frizz-worker). A worker MAY spin up its own helper
// sub-agents; this hook holds them to the same rules cc enforces for the orchestrator:
//   1) ENFORCE background dispatch — deny any Agent call lacking run_in_background:true (a
//      foreground agent blocks the worker's turn; a human interjection orphans it).
//   2) STRIP `name`/`team_name` — setting either strands a nested dispatch (its result routes
//      wrong and never returns cleanly), so scrub both silently.
//   3) AUTO-APPEND a short ORCHESTRATION EPILOGUE carrying only what a helper cannot discover on
//      its own: that its final message is the return value, the `SendMessage({to: "main"})` upward
//      channel, the own-file rule for the scratch directory, no fan-out of its own unless asked, and
//      how a helper it DID dispatch is collected. It carries no handoff format and no build, test,
//      git or process policy — the maintainer had the handoff-format doctrine cut on 2026-08-26.
//
// WHY NESTING IS DEFAULT-OFF (2026-08-04, maintainer's call): the epilogue used to speak about a
// helper's own helper only in the conditional ("if you dispatch a helper of your own…"), which reads
// as neutral permission, so a depth-1 child could decompose again purely because it could. A child is
// already one prong of a fan-out; another layer splits the context its dispatcher assembled and moves
// the real work further from the board. So the paragraph now LEADS with "do the work yourself unless
// your prompt says otherwise" and keeps the collection rules for the case where it does. This is a
// PROMPT-level default, not the hook-level depth-2 DENY rejected on 2026-07-31 as too blunt — an
// explicit instruction to fan out still dispatches, unmodified.
//
// WHY THE NESTED-DISPATCH PARAGRAPH EXISTS (2026-07-31): this hook fires at EVERY depth, but the
// frizz worker contract reaches only the ROOT worker — so its "keep fan-out shallow / a rested agent
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
// GATE: inert unless FRIZZ_THREAD is set (not a frizz worker → allow every dispatch unmodified).
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
[ORCHESTRATION EPILOGUE — auto-appended by the frizz worker dispatch hook] You are a helper sub-agent for a frizz worker. Your final message is the handoff your dispatcher reads: what you did, what you verified, what remains.
If the worker names its scratch directory: Write your OWN file there — never edit or delete a file another agent wrote. That file is Frizz coordination state, not a project deliverable or source edit, so it stays allowed under limits such as "write only <path>" or "do not modify the repo"; never classify it as unauthorized or roll it back. Every other file is governed by your delegated authority; its location alone neither permits nor forbids editing. Do not edit other \`.frizz/\` state unless your prompt asks.
Upward channel: \`SendMessage({to: "main", summary: "<5-10 words>", message: "…"})\` reaches your dispatcher while you work (load it first with ToolSearch \`select:SendMessage\` if it is deferred). Use it only when the dispatcher acting before you finish would change the outcome — a blocker, a milestone another task needs, instructions that should change — not for progress updates.
Do the work yourself: do NOT dispatch sub-agents of your own unless your dispatch prompt explicitly tells you to. You are already one prong of someone else's fan-out; a slice that feels large is still yours to work through in your own turn.
If your prompt DOES ask you to dispatch a helper, its completion is delivered to you automatically. Never hand-roll a wait loop over a helper's transcript or \`.output\` path: that path is a SYMLINK (\`stat\` without \`-L\` reports the link's own ~150-byte size and frozen mtime) and the \`"type":"result"\` record is not reliably written, so a helper working hard reads as tiny, stale and dead, and you will discard live work and redo it. Judge a helper only by its completion notification or the text it returns, and give it a \`description\` naming its narrower slice.`;

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

try {
  // WORKER GATE — inert outside a frizz worker session.
  if (!(process.env.FRIZZ_THREAD ?? '').trim()) emit({});

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const ti = input.tool_input ?? {};

  if (ti.run_in_background !== true) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'frizz worker (hook-enforced): Agent sub-agents MUST be dispatched with run_in_background:true — never foreground/blocking. A foreground agent blocks the worker turn and a human interjection orphans its work. Re-send this Agent call with run_in_background:true.',
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
