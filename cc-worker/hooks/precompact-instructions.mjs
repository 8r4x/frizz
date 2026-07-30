#!/usr/bin/env node
// @ts-check
// PreCompact hook (fray-worker) — steers WHAT SURVIVES a compaction. Run directly with node (zero
// deps, max Node compat), mirroring cc's hook idiom.
//
// WHY THIS EXISTS: compaction is the single largest source of context loss in a long worker session.
// A ~967k-token session collapses to a ~10-15k summary, and what gets dropped first is the HIGH-LEVEL
// approach — the plan, the alternatives rejected, the reasoning — leaving a worker that remembers
// mechanics but has lost the thread. `session-seed.mjs` already re-grounds AFTER the fact on
// SessionStart(compact); this hook is the other half, steering the summary itself BEFORE it is written.
//
// THE CHANNEL — and it is unusual, so do not "fix" it to JSON: unlike every other hook in this
// plugin, a PreCompact hook's PLAIN STDOUT becomes the compaction instructions. Claude Code collects
// the trimmed stdout of every succeeding, non-blocking PreCompact hook, joins them with a blank line,
// and splices the result into the summarization prompt as a literal `Additional Instructions:`
// section (verified live: cli 2.1.220, `FTe`/`Ysd`). Emitting `hookSpecificOutput` JSON here would
// send the summarizer a blob of JSON as its instructions. The matcher is the TRIGGER string
// (`auto` / `manual`), which is why hooks.json registers this twice.
//
// LENGTH IS ONLY STEERABLE BY AN EXPLICIT NUMBER — measured, so do not soften WORD_TARGET into prose.
// Single-variable differential, three `--fork-session` branches off one identical 345,898-token seed:
//
//   no hook (control)                    postTokens  4,060
//   qualitative "prefer a long summary"  postTokens  4,429   (+9% — noise)
//   explicit ">= 15,000 words"           postTokens 20,339   (5.0x the control)  <-- WORD_TARGET
//   explicit ">= 35,000 words"           postTokens  5,182   (WORSE, and slower + dearer)
//
// DO NOT RAISE WORD_TARGET without re-measuring: the response is NON-MONOTONIC. 35,000 words is past
// what the model will produce in one response and asking for it degraded compliance badly — a quarter
// the output of the 15,000 ask (2,174 words vs 9,829), at 11.2 min / $3.73 vs 8.6 min / $2.04. Three
// single samples, so treat the exact figures as indicative, but 15,000 was clearly the best of them.
//
// Adjectives do nothing; a hard number does the work. The COST is latency: the 15,000-word run
// produced no compaction result at all inside a 10-minute cap and only completed on a longer budget.
// That is acceptable here because fray workers run with `precomputeCompactionEnabled`, which arms
// summary generation in a background sidecar at ~80% of the window and swaps it in at the real
// threshold — so on an `auto` trigger the wait is largely hidden. A `manual` /compact pays it in
// front of the human.
//
// HARD CEILING: the summary is ONE model response, so it is bounded by max output tokens (64k for
// Opus 5 / Sonnet 5, ~48k words). A 200k-token summary is unreachable at any prompt.
//
// TONE MATTERS: an instruction that reads like injected prompt-hijacking gets REFUSED by the
// summarizer — measured: an early probe demanding a sentinel token produced a summary that explicitly
// declined to comply and called the instructions fake. Keep this legible as an ordinary editorial
// brief about what to retain.
//
// GATE: everything is gated on FRAY_UI_THREAD, so the plugin stays inert when loaded outside a
// fray-ui worker. Sub-agent contexts are skipped, matching session-seed.mjs — the scratchpad path
// below is only guaranteed correct for the top-level worker session.
import { readFileSync } from 'node:fs';
import { currentSessionId } from '../scripts/fray/config.mjs';

// See "LENGTH IS ONLY STEERABLE BY AN EXPLICIT NUMBER" above before changing this.
const WORD_TARGET = 15000;

/** @type {{ agent_id?: unknown, agentId?: unknown, trigger?: string, session_id?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → input stays {} → proceed with the generic brief */
}
// Skip inside sub-agent contexts (they carry agent_id) — see GATE above.
if (input.agent_id ?? input.agentId) process.exit(0);

// WORKER GATE — inert unless this is a fray-ui worker session.
const thread = (process.env.FRAY_UI_THREAD ?? '').trim();
if (!thread) process.exit(0);

let sid = null;
try {
  sid = currentSessionId(input.session_id);
} catch {
  /* best-effort — fall back to the generic path shape below */
}
const scratch = sid
  ? '.fray/threads/' + sid + '/scratch.md'
  : '.fray/threads/<session-id>/scratch.md';

// Written as an editorial brief, not as a command block — see TONE MATTERS above.
const brief = [
  'This is a fray-ui worker session driving one engineering effort (`' + thread + '`). Three things ' +
    'matter more here than brevity does, because they are what actually gets lost in compaction:',
  '',
  '1. LENGTH. Write an EXHAUSTIVE summary, not a condensed one: target at least ' +
    WORD_TARGET.toLocaleString('en-US') + ' words. There is ample room for it, so do not compress. ' +
    'A short summary is the failure mode here — omitting something load-bearing is far worse than ' +
    'including something redundant.',
  '',
  '2. THE HIGH-LEVEL APPROACH, AT HIGH FIDELITY. Preserve the shape of the work, not just its ' +
    'mechanics: what problem is being solved, the approach chosen, the approaches considered and ' +
    'REJECTED and why, and the reasoning that led there. Reproduce this in full rather than ' +
    'condensing it into a sentence — a summary that lists edits but loses the plan leaves the next ' +
    'turn unable to judge whether a step is still the right one. Include substantial verbatim ' +
    'excerpts of the code and output that matter rather than describing them from memory.',
  '',
  'Carry forward, in as much detail as you can:',
  '- The task list and its state — every item, marked done / in progress / not started / blocked.',
  '- Decisions made and the rationale for each, especially any the human made, approved, or reversed.',
  '- Constraints, conventions, and explicit human instructions or corrections — in the human\'s own ' +
    'wording where you can, since paraphrase is where intent gets lost.',
  '- Paths of every file created, read, or modified, and what changed in each.',
  '- Commands that matter (build / test / run / verification) and their OBSERVED results.',
  '- What has been VERIFIED by actually running it versus what is merely believed to work. Keep that ' +
    'distinction explicit — it is routinely lost in compaction and its loss causes false claims of ' +
    'completion.',
  '- Open questions, known failures, dead ends already ruled out, and anything left unfinished.',
  '',
  '3. RE-GROUNDING. End the summary with a final section headed exactly "Re-grounding before ' +
    'continuing:" that tells the next turn what to re-establish BEFORE it asserts anything or resumes ' +
    'editing. Make it concrete and specific to this session — not generic advice:',
  '- Re-read the scratchpad at `' + scratch + '` first. It is the durable working state and it ' +
    'outlives this summary.',
  '- Name the specific files to re-read before describing or changing them, rather than relying on ' +
    'remembered contents.',
  '- Name any verification that was in flight and should be re-run rather than assumed.',
  '- State the single next action to take.',
].join('\n');

process.stdout.write(brief + '\n');
process.exit(0);
