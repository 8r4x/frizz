#!/usr/bin/env node
// @ts-check
// Stop hook (fray-worker) — catches a rest that hands a DECISION to the human in prose instead of in
// a ```question fence. Run directly with node (zero deps, max Node compat), mirroring the other hooks.
//
// WHY THIS EXISTS — measured, not felt. Scanning 532 real worker transcripts (session ids
// cross-referenced against every `~/.fray/projects/*/ui.db`), 4,709 rest turns, fence use decays
// monotonically with how deep the session is:
//
//   rest turn      #1    #2-3   #4-6   #7-10  #11-20  #21+
//   ```question    23%    22%    20%     20%     16%    9%
//   ```done        31%    23%    17%     13%     10%    2%
//   no fence       45%    53%    58%     60%     68%   83%
//
// It is DEPTH, not compaction: turns BEFORE a compaction boundary are already 82% fenceless, so the
// decay is fully present before any summary is written (compaction only correlates because only long
// sessions compact). The contract lives in the system prompt and does survive compaction — what decays
// is attention to it. So re-stating the rule earlier in the context cannot fix this; something has to
// look at the ACTUAL final message at the moment of rest. That is this hook.
//
// SCOPE — asks only, never completion. 9.8% of fenceless rests close by deferring a decision to the
// human ("your call", "want me to …?"); those are the expensive miss, because a prose ask renders as an
// ordinary handoff card with nothing to click and does not break through a Snooze, so the human has to
// read the whole message to discover they are blocking. Only 3% of fenceless rests carry a landed
// claim, and telling a worker "that looked done" is actively dangerous — ```done is a DISMISSAL that
// files the thread away, and "uncertain is not done" is the contract's own rule. Measured cost/benefit
// said ask-only; do not add a done detector without re-measuring.
//
// NOT COERCIVE, AND ONE-SHOT. A blocking Stop gate was tried and removed once before (2026-07-02: the
// block-until-file-edited nag forced trivial workers into Read/Edit dances that render as chat noise),
// so this one never demands work: its third branch is explicitly "this was rhetorical — just rest
// again". It fires at most ONCE per human turn (keyed on the turn ordinal, not on the message, so the
// re-emitted message cannot re-trigger it) and additionally stands down when `stop_hook_active` says a
// Stop hook is already driving the continuation.
import { readFileSync, writeFileSync, renameSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { currentSessionId } from '../scripts/fray/config.mjs';

/** How much of the message's CLOSING is searched for the ask. The deferral lives in the sign-off, and
 *  a whole-message search fires on a "say the word" from three paragraphs up in a report that then
 *  ends on a completion note. Tuned on the corpus: 900 chars keeps 316 of the 349 whole-message hits. */
const TAIL_CHARS = 900;

/** Below this, a message is a greeting or a one-liner, not a handback ("Hi! What would you like to
 *  work on?" was the only false positive the corpus sample turned up). */
const MIN_CHARS = 200;

/** Bytes of transcript tail read to find the final assistant message. Transcripts reach tens of
 *  megabytes; the last few records are all this needs. */
const TAIL_BYTES = 512 * 1024;

// ---- fence grammar ----------------------------------------------------------------------------
// Mirrors the server's scanners (packages/server/src/tailer.ts `QUESTION_BLOCK_RE` /
// `SIGNAL_FENCE_RE`) by hand — a hook cannot import from the app. Kept deliberately SIMPLE: a false
// "already fenced" reading only costs a missed nudge, which is the safe direction.
const QUESTION_BLOCK_RE = /^```question(?:[ \t]+[A-Za-z][^\r\n]*?)?[ \t]*\n[\s\S]*?\n```[ \t]*$/m;
const SIGNAL_FENCE_RE = /^```(done|awaiting)[ \t]*\n[\s\S]*?\n```[ \t]*$/gm;

/** The signal/question fence a final message already carries, or null. @param {string} text */
export function fenceOf(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n');
  if (QUESTION_BLOCK_RE.test(norm)) return 'question';
  SIGNAL_FENCE_RE.lastIndex = 0;
  let kind = null;
  let end = 0;
  for (let m = SIGNAL_FENCE_RE.exec(norm); m !== null; m = SIGNAL_FENCE_RE.exec(norm)) {
    kind = m[1]; // last-fence-wins, matching the server
    end = m.index + m[0].length;
  }
  // The fence only signals when it CLOSES the message — prose after it means it was quoted.
  return kind && norm.slice(end).trim() === '' ? kind : null;
}

// ---- the ask detector -------------------------------------------------------------------------
// Phrases that hand a decision back. Derived from the corpus, not invented: `say the word` (100),
// `your call` (100), `want me to` (84), `if you'd rather` (33) are the bulk of real misses. A
// trailing-question-mark rule was tried and DROPPED — over 3,239 fenceless rests it added exactly one
// hit these phrases had not already caught, for a whole extra false-positive surface.
const DEFERRALS = [
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bwant me to\b/i,
  /\bwould you (?:like|prefer|rather)\b/i,
  /\bdo you want\b/i,
  /\bshall I\b/i,
  /\bsay the word\b/i,
  /\bif you(?:'d| would)\s+(?:prefer|rather|like)\b/i,
  /\btell me which\b/i,
  /\bwhich (?:would you|do you|one would|of these)\b/i,
  /\byour (?:preference|decision)\b/i,
  /\blet me know\b/i,
  /\bshould I\b[^.?!\n]*\?/i,
];

/** The deferral phrase in a message's closing, or null. @param {string} text */
export function askPhrase(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (norm.length < MIN_CHARS) return null;
  const close = norm.length > TAIL_CHARS ? norm.slice(-TAIL_CHARS) : norm;
  for (const re of DEFERRALS) {
    const m = close.match(re);
    if (m) return m[0];
  }
  return null;
}

/** @param {string} phrase */
function nudge(phrase) {
  return (
    '⟦fence check⟧ You are coming to rest with no ```question / ```done / ```awaiting fence, and your ' +
    'closing text hands a decision back to the human ("' + phrase + '"). A prose ask is INVISIBLE in ' +
    'the queue: it renders as an ordinary handoff card with nothing to answer, it does not break ' +
    'through a Snooze, and the human has to read the whole message to discover they are blocking you. ' +
    'Decide which of these it actually is, then do exactly one:\n' +
    '1. It is genuinely the human\'s to call (irreversible, external-facing, or their taste to set) — ' +
    're-send your final message with the ask at the very END in a ```question block: the question on ' +
    'ONE line, lettered `- A. …` options with a one-line tradeoff each, your recommendation FIRST and ' +
    'marked `(recommended)`, and enough context to answer cold. One block per independent question.\n' +
    '2. It was yours to decide all along (reversible, derivable from the code or ordinary engineering ' +
    'judgment) — make the call, say which way you went, and carry on with the work.\n' +
    '3. It was a rhetorical aside or an offer of optional extra work, not a real blocker — just rest ' +
    'again as you were.\n' +
    'This note fires at most once per turn and will not repeat.'
  );
}

// ---- transcript ---------------------------------------------------------------------------------
/** The tail of a JSONL transcript, parsed, oldest-first. Partial first line is dropped.
 *  @param {string} path */
function tailRecords(path) {
  let fd = null;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(want);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8').split('\n');
    if (want < size) lines.shift(); // the read may have cut the first line in half
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a truncated/garbled record is simply skipped */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** @param {any} rec */
function assistantText(rec) {
  // Claude: an assistant record's text blocks. Codex: a rollout `event_msg`/`agent_message`.
  if (rec?.type === 'event_msg' && rec?.payload?.type === 'agent_message') return String(rec.payload.message ?? '');
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
}

/** @param {any} rec */
function isToolResult(rec) {
  const c = rec?.message?.content;
  return Array.isArray(c) && c.some((b) => b?.type === 'tool_result');
}

/**
 * The final assistant text of the top-level conversation, plus the ordinal of the human turn it
 * closes. FALLBACK ONLY — see `evaluateFenceStop`: the transcript is written asynchronously, so at
 * Stop time the message that just ended the turn may not be on disk yet. Measured live: of four real
 * broker workers driven to a fenceless prose ask, two had the final message flushed by the time the
 * hook ran and two did not, which is exactly the flakiness this is no longer the primary source for.
 * @param {any[]} records
 */
export function finalMessage(records) {
  const conv = records.filter(
    (r) => (r?.type === 'user' || r?.type === 'assistant' || r?.type === 'event_msg') && !r?.isSidechain
  );
  let text = null;
  for (let i = conv.length - 1; i >= 0; i--) {
    if (conv[i].type === 'user') break; // a trailing user record means the turn is not at rest
    const t = assistantText(conv[i]);
    if (t.trim()) {
      text = t;
      break;
    }
  }
  // Human turns in the window read. Tool results are the model's own loop, not a human turn; a
  // truncated window just yields a smaller (but still monotonic within a session) ordinal.
  const turn = conv.filter((r) => r.type === 'user' && !isToolResult(r)).length;
  return { text, turn };
}

// ---- one-shot state ------------------------------------------------------------------------------
/** @param {string} statePath */
function readState(statePath) {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {}; // missing/corrupt state is an unfired guard
  }
}

/** Persist BEFORE blocking: if the guard cannot be recorded, fail open rather than build a loop whose
 *  key can never advance. @param {string} statePath @param {string} key @param {number} now */
function writeState(statePath, key, now) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ key, firedAt: new Date(now).toISOString() }) + '\n', { mode: 0o600 });
    renameSync(tmp, statePath);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

/**
 * @param {{ transcript_path?: string, stop_hook_active?: boolean, last_assistant_message?: unknown, prompt_id?: unknown }} input
 * @param {{ projectDir: string, sessionId: string, now?: number }} context
 * @returns {{ decision?: 'block', reason?: string }}
 */
export function evaluateFenceStop(input, context) {
  if (!input || typeof input !== 'object' || !context.sessionId) return {};
  // Another Stop hook is already driving the continuation — adding a second instruction on top of it
  // is how stop loops get built.
  if (input.stop_hook_active) return {};

  // THE MESSAGE. `last_assistant_message` is the harness's own copy of the text that just ended the
  // turn (verified on the wire, cli 2.1.220), so it is exact and race-free. The transcript is the
  // fallback for a payload that lacks it — codex, or a future/older shape.
  const promptId = typeof input.prompt_id === 'string' ? input.prompt_id : '';
  const direct = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  // Only touch the transcript when something is actually missing from the payload.
  const fromDisk = direct.trim() && promptId ? null : finalMessage(tailRecords(input.transcript_path ?? ''));
  const text = direct.trim() ? direct : fromDisk?.text;
  if (!text) return {};
  if (fenceOf(text)) return {};
  const phrase = askPhrase(text);
  if (!phrase) return {};

  // THE ONE-SHOT KEY — one poke per human turn, so the message the worker re-sends cannot re-trigger
  // it. `prompt_id` identifies the prompt being answered and is stable across a blocked continuation,
  // which is exactly the boundary wanted; the transcript's human-turn ordinal is the fallback. Both
  // are STABLE within a rest, which is what makes a loop impossible — no timed cooldown is needed on
  // top (and one would silently swallow the poke on a rapid second turn).
  const key = promptId || `turn:${fromDisk?.turn ?? 0}`;

  const statePath = join(context.projectDir, '.fray', 'threads', context.sessionId, '.fence-stop-state.json');
  if (readState(statePath).key === key) return {};
  if (!writeState(statePath, key, context.now ?? Date.now())) return {};

  return { decision: 'block', reason: nudge(phrase) };
}

if (process.argv[1]?.endsWith('fence-stop.mjs')) {
  try {
    const argv = process.argv.slice(2);
    const explicit = argv.find((a) => a.startsWith('--session='));
    const input = JSON.parse(readFileSync(0, 'utf8'));
    // WORKER GATE — inert outside a fray-ui worker. Codex reports its own rollout id, so fray bakes
    // `--session=<fray sessionId>` into the codex hook command and that always wins.
    const sessionId = explicit ? explicit.slice('--session='.length) : currentSessionId(input?.session_id);
    if (!sessionId || !(explicit || (process.env.FRAY_UI_THREAD ?? '').trim())) {
      process.stdout.write('{}');
    } else {
      const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      process.stdout.write(JSON.stringify(evaluateFenceStop(input, { projectDir, sessionId })));
    }
  } catch {
    process.stdout.write('{}');
  }
}
