#!/usr/bin/env node
// @ts-check
// SessionStart hook (frizz-worker) — SEEDS a frizz WORKER session's context. Run directly with
// node (zero deps, max Node compat), mirroring cc's hook idiom.
//
// A frizz worker is a top-level interactive `claude` the UI spawns per effort; the slug arrives in
// env FRIZZ_THREAD (and a `THREAD:` line in the first prompt). There are NO thread files, no
// frontmatter, no status field — a worker SIGNALS through its final message (fences) and PERSISTS
// through a scratchpad. This hook injects, on every session start (startup/resume/clear/compact):
//   1. `core` — a runtime re-grounding + pointer, NOT a second copy of the contract: the full worker
//      contract lives ONCE in the system prompt (workerPrompt.ts) the server injects at spawn. This
//      carries only what a static system prompt can't: the runtime scratch-directory PATH + an essential
//      signal-at-rest anchor + a pointer to the system-prompt contract.
//   2. the SCRATCH DIRECTORY — `.frizz/threads/<session_id>/`, a folder the worker may use as it likes.
//   3. on `compact` — a short re-grounding (compaction drops the deep model + this orientation).
//
// GATE: everything is gated on FRIZZ_THREAD being set, so the plugin is completely inert when
// loaded outside a frizz worker (e.g. a plain `claude --plugin-dir cc-worker` smoke run).
//
// STALE-INSTALL DEFENSE: the `cc` orchestrator plugin is retired — the marketplace ships only this
// worker plugin, and cc's hooks/skills/agents are gone. But a machine can still carry a CACHED cc
// install from before the retirement, whose hooks fire in every repo gated on cc's opt-IN sentinel.
// A fresh worker never runs `frizz on`, so such a cc is already dormant; we write cc's own per-session
// `off` sentinel anyway via the shared config API (board survives as cc-worker's board
// implementation) so a stale install is guaranteed inert. Cheap belt-and-suspenders. See DECISIONS.md.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setSessionOverride, currentSessionId } from '../scripts/frizz/config.mjs';

/** @type {{ agent_id?: unknown, agentId?: unknown, source?: string, session_id?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → input stays {} → proceed (fail-open to inject) */
}
// Skip inside sub-agent contexts (they carry agent_id) — the seed is for the top-level worker.
if (input.agent_id ?? input.agentId) process.exit(0);

// WORKER GATE — inert unless this is a frizz worker session.
const thread = (process.env.FRIZZ_THREAD ?? '').trim();
if (!thread) process.exit(0);

const dir = process.env.CLAUDE_PROJECT_DIR ?? '.';

// Neutralize the orchestrator cc plugin for THIS session (defensive; see header + DECISIONS.md).
// The session id also names the worker's scratch directory (`.frizz/threads/<session_id>/`).
let sid = null;
try {
  sid = currentSessionId(input.session_id);
  if (sid) setSessionOverride(dir, sid, 'off');
} catch {
  /* best-effort — a failed sentinel write just leaves cc at its dormant default */
}
const scratch = sid
  ? '.frizz/threads/' + sid + '/'
  : '.frizz/threads/<session-id>/';

// A RUNTIME re-grounding + pointer, NOT a second copy of the contract. The full worker contract
// (signal fences, scratch-directory rules, sub-agent rules, the question handback) lives
// ONCE in the system prompt frizz injects at spawn (workerPrompt.ts / loadWorkerPrompt) — which is
// re-applied on every resume and survives compaction. This hook adds only what a static system prompt
// CANNOT carry: the runtime-derived scratch-directory PATH, an essential signal-at-rest anchor, and (below)
// the compaction re-read nudge, gh guidance, and the defensive cc-orchestrator off-sentinel.
const core =
  '⟦frizz worker contract⟧ You are a frizz WORKER driving EXACTLY ONE effort. Your FULL operating contract — the end-of-turn signal fences, scratch-directory rules, sub-agent rules, and the question handback — lives in your SYSTEM PROMPT; follow it there (this is a runtime re-grounding, not a second copy). The human + the frizz app are the ORCHESTRATOR; you drive ONE effort and never scan the board or touch other efforts. There is no orchestrator mode and no fleet to run: doing the work yourself is the default, and you dispatch a sub-agent only when the work genuinely decomposes into independent prongs.\n' +
  'SCRATCHPAD (OPTIONAL): `' + scratch + '` — a scratch file kept FOR YOU, not a deliverable, and never a substitute for doing the work. A single direct task usually needs nothing in it. On a long effort it is crash insurance and your sub-agents\' shared blackboard: write the approach and what you rejected there AS YOU GO, mid-work, then KEEP WORKING; re-read it after any compaction or resume, and pass its PATH into every sub-agent prompt.\n' +
  'DO NOT REST WHILE THE INSTRUCTION HAS PARTS LEFT — finish them in THIS turn; a milestone, a green test run and a long turn are none of them stopping points, and announcing the next step or writing it into a scratch file is not doing it.\n' +
  'SIGNAL AT REST through your FINAL MESSAGE, per the fence rules in your system prompt: bare rest is the ordinary handoff and queues for the human; ```done only when the effort\'s real work is COMPLETE (code LANDED on the mainline — an open PR is NOT done, park it on ```awaiting until it MERGES) and is a DISMISSAL (its card files the thread away where nobody looks again), so if the thread points at future work AT ALL — a pre-fix investigation, a live code-change discussion — bare rest instead, and uncertain is not done; the ONE exception is a planning session whose plan file is fully written and persisted, because that artifact outlives the thread; ```awaiting parks only a human:/timer:/pr-watch: gate, never CI/releases/merge progression (those stay ACTIVE); ```question is the operator ask. Load `frizz:handoff` for the full fence reference.\n' +
  'DECIDE rather than ask: anything derivable from the code, the conventions, or ordinary engineering judgment is YOURS to settle — asking permission to do the work you were dispatched to do is not a question, it is the job. Reserve the operator for the irreversible and the genuinely human-owned.';

const grounding =
  '⟦frizz worker re-grounding (post-compaction)⟧ Context was just compacted. You are still the frizz worker for effort `' + thread + '` — read whatever you left yourself in `' + scratch + '` NOW to recover your working state and to-do list before asserting anything, and re-read any code before claiming how it is structured. Signal at rest through your FINAL MESSAGE: bare rest queues an ordinary handoff; ```done queues a checked completion until Archive and is a DISMISSAL — completed work only, and never when the thread still points at future work (a pre-fix investigation, a live code-change discussion); use a question or bare rest; ```awaiting parks only a human:/timer: gate (or a pr-watch: PR watcher, which wakes on any new review/comment, bot or human); ```question is the explicit higher-priority operator ask. CI/releases/merge progression stay active through Monitor/background Bash.';

// AUTH-GATED gh guidance — teach the worker to use `gh` well, but ONLY when signed in.
// Shell `gh auth status --active`: exit 0 = an active gh account is authenticated. The whole gate is
// wrapped so it can NEVER throw into SessionStart, and it fails CLOSED — no gh binary, not authed, a
// stall past the timeout, or any other error → we inject NOTHING (guidance is absent, not stale/wrong).
// It re-evaluates on every start/resume/clear/compact, so a later `gh auth login` starts injecting on
// the next turn boundary (and a `gh auth logout` stops it). See DECISIONS.md / plan §8.
const ghBlock =
  '⟦gh available⟧ You are signed into the `gh` CLI and in a GitHub repo. Use `gh` EAGERLY and well — it is the fastest path to issue/PR/CI/release context, and you should reach for it before guessing:\n' +
  '• READ freely: `gh issue view N -R OWNER/REPO --comments`, `gh pr view N`, `gh pr diff N`, `gh pr checks N`, `gh run list`/`gh run view`, `gh api repos/OWNER/REPO/…`. Prefer `--json <fields>` over scraping human text.\n' +
  '• SEARCH across the repo (and GitHub) with `gh search issues`/`gh search prs` when hunting related work, duplicates, or prior art.\n' +
  '• READ-ONLY BOUNDARY: never comment, label, assign, close, review, approve, or merge — no mutation of any kind — UNLESS the human explicitly asks in this session. Default to producing your findings/review as your final message, not as a GitHub post.\n' +
  '• TOON: pipe LARGE, FLAT `gh … --json` output through `toon` when `command -v toon` finds it. Skip it when unavailable, for tiny payloads, or for deeply-nested output — the savings are noise and nesting defeats tabularization.\n' +
  'Load the `frizz:gh` skill for the full playbook (recipes + explicit project-local monitor selection + native Monitor/background-Bash CI/PR watches).';

let ghAuthed = false;
try {
  execFileSync('gh', ['auth', 'status', '--active'], { stdio: 'ignore', timeout: 4000 });
  ghAuthed = true;
} catch {
  /* no gh / not authed / stalled → fail CLOSED: leave ghAuthed false, inject nothing */
}

const parts = [core];
if (input.source === 'compact') parts.push(grounding);
if (ghAuthed) parts.push(ghBlock);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  }),
);
process.exit(0);
