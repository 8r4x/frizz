#!/usr/bin/env node
// @ts-check
// SCRATCHPAD REINFORCEMENT hook (fray-worker) — keeps the ONE per-thread scratchpad
// (`.fray/threads/<sid>/scratch.md`) written and re-grounded across compaction. Run directly with
// node (zero deps, max Node compat), mirroring the other hooks in this plugin.
//
// WHY THIS EXISTS: compaction is the largest source of context loss in a long session, and the
// scratchpad is fray's answer to it — but the scratchpad only works if two things happen, and
// nothing was enforcing either. It has to be WRITTEN while the work is happening, and it has to be
// RE-READ after the context is gone. A worker that forgets the first has nothing to recover; one
// that forgets the second has a recovery it never opens.
//
// This hook closes both, and deliberately targets scratch.md rather than a second file of its own.
// An earlier revision shipped a separate `carryover.md` brief; it was redundant with the scratchpad
// and made the worker maintain two overlapping documents. ONE doc per thread is the rule — the
// scratchpad the dispatcher already provisions, already names in the system prompt, and shares with
// sub-agents under the merge-only contract (see agent-dispatch.mjs).
//
// CODEX CHILD EPILOGUE — native Codex sub-agents inherit the root conversation's system/user
// scratchpad instructions even with `fork_turns:"none"`. Sharing the thread pad is useful: a child
// can persist progress even if the root later compacts. But an undifferentiated "keep it current"
// mandate once made a child replace the whole document with its task notes, then DELETE that
// replacement as a misguided rollback after realizing it had clobbered the root's state. The
// `subagent-start` mode preserves collaborative writes while requiring merge-only, scoped edits.
//
// THE RE-READ SIDE — injection, not a reminder. On compaction/resume the head of scratch.md is
// spliced into the context window by the harness, before the model's first token, alongside a
// pointer to read the rest. A bare "remember to read your scratchpad" routes recovery through a
// decision the model can skip, which is exactly the failure being fixed; injecting the head
// guarantees a floor of orientation even if the pointer is ignored. The cap keeps the guarantee
// affordable — a scratchpad is unbounded working memory and the whole file is not owed to every
// session start.
//
// THE WRITE SIDE — a staleness nudge on two channels:
//   UserPromptSubmit — the turn boundary.
//   PostToolUse      — MID-TURN, and this is the one that matters. A fray worker runs enormous
//                      autonomous turns (dozens of tool calls between human prompts), so a
//                      turn-boundary-only nudge can miss an entire session's worth of work and let
//                      it compact unpersisted. PostToolUse additionalContext was verified live
//                      against cli 2.1.220: a real session quoted a sentinel injected after a Bash
//                      call. Both channels share one state file, so the interval is global — moving
//                      to per-tool-call firing does NOT multiply the number of nudges.
//
// NO HOOK FIRES ON CONTEXT PRESSURE — measured, not assumed. Claude Code 2.1.220 exposes 31 hook
// events and not one of them signals an approaching context limit; no hook input carries a token
// count at all (the docs say plainly: poll the transcript yourself). So this computes the fill
// itself from the transcript's newest usage record — `input + cache_creation + cache_read` is the
// live context size — reading only the file's TAIL, since transcripts reach tens of megabytes.
//
// STALENESS IS GROWTH SINCE THE LAST WRITE, never an absolute threshold: the window size is not
// knowable from a hook (a real compaction in this project fired at preTokens 935,291 on a 1M-window
// session, while a 200k session compacts near 160k). Growth is window-independent and self-resetting.
//
// NOT A BLOCKING GATE. A Stop hook could refuse to let the worker rest until it writes, and that was
// tried and REMOVED on 2026-07-02 (maintainer's call): the block-until-file-edited nag forced even
// trivial workers into Read/Edit dances that render as noise in the chat UI. This nudges; it never
// blocks.
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { currentSessionId } from '../scripts/fray/config.mjs';

const SCRATCH_FILE = 'scratch.md';

/** Hard cap on injected characters. The scratchpad is unbounded working memory, so this bounds what
 *  a session start is charged; past the cap we inject the HEAD (a scratchpad's orientation lives at
 *  the top) and say plainly that it was clipped, pointing at the file for the rest. */
const MAX_INJECT_CHARS = intFromEnv('FRAY_SCRATCHPAD_MAX_CHARS', 12000);

/** Context-token growth since the last scratchpad write that marks it stale. 60k is ~a third of a
 *  200k window and ~6% of a 1M one: frequent enough that the pad is never many turns behind, rare
 *  enough not to be chatter. Also the first-write trigger — an untouched template counts as
 *  unwritten, so the baseline is zero and the first nudge lands once a session has accumulated 60k
 *  tokens actually worth persisting. */
const STALE_TOKENS = intFromEnv('FRAY_SCRATCHPAD_STALE_TOKENS', 60000);

/** @param {string} name @param {number} fallback */
function intFromEnv(name, fallback) {
  const n = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const argv = process.argv.slice(2);
/** @param {string} flag */
const flagValue = (flag) => {
  const hit = argv.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
};
const mode = flagValue('--mode') ?? 'session-start';
const via = flagValue('--via') ?? 'plugin';

// ALWAYS ON — deliberately not settings-gated. The scratchpad is the CANONICAL document for a thread,
// so re-grounding on it after a compaction is not an opinion a project opts into; it is what makes the
// pad worth writing at all. An earlier revision put this behind an opt-in setting that defaulted OFF,
// which meant the default worker got nothing back after a compaction — the exact failure the pad
// exists to prevent (maintainer's correction: the thing that should be opt-in is the FORK-based
// auto-updating, not the re-grounding).
//
// The escape hatch is an env var, not a setting, because it is for a one-off ("this session is doing
// something where the injection is in the way"), not a project posture. Anything affirmative-looking
// is ignored: only an explicit off value disables.
if (/^(off|0|false|no|disabled)$/i.test((process.env.FRAY_SCRATCHPAD_HOOK ?? '').trim())) process.exit(0);

// The repo-local registration defers to the plugin one for fray workers (see --via, and the
// registration note in DECISIONS.md) so a fray worker never injects twice.
if (via === 'project' && (process.env.FRAY_UI_THREAD ?? '').trim()) process.exit(0);

/** @type {{ agent_id?: unknown, agentId?: unknown, source?: string, trigger?: string, session_id?: string, transcript_path?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → fall back to env for the session id */
}
const childId = input.agent_id ?? input.agentId;
// Sub-agent contexts are silent on every reinforcement mode. The child-only epilogue is the one
// exception: it constrains the undifferentiated scratchpad instruction the child otherwise inherits.
if (childId && mode !== 'subagent-start') process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// WHICH session keys the pad. On Claude the hook's `session_id` IS fray's thread session id, so the
// derived path is correct. On CODEX it is NOT: codex reports its own rollout session id (measured —
// e.g. `019fb427-93aa-…`, with transcript_path pointing into ~/.codex/sessions), which has nothing to
// do with `.fray/threads/<fray sessionId>/scratch.md`. Deriving the path there would silently address
// a pad that does not exist and the worker would look unreinforced for a reason nobody could see. So
// fray bakes `--session=<fray sessionId>` into the codex hook command, and an explicit value always
// wins over the reported one.
const explicitSession = flagValue('--session');
let sid = null;
try {
  sid = explicitSession || currentSessionId(input.session_id);
} catch {
  /* best-effort */
}
// Without a session id there is no key, and an unkeyed pad would bleed between sessions.
if (!sid) process.exit(0);

const threadDir = join(projectDir, '.fray', 'threads', sid);
const relPath = '.fray/threads/' + sid + '/' + SCRATCH_FILE;
const absPath = join(threadDir, SCRATCH_FILE);

// ── mode: subagent-start (Codex child-only merge epilogue) ───────────────────────────────────────
if (mode === 'subagent-start') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext:
        '⟦shared scratchpad — merge only⟧ `' + relPath + '` is the canonical document shared with ' +
        'the top-level `/root` worker. Update your own task progress in it as you work rather than ' +
        'leaving the root as its sole writer. Before every edit, re-read the current file, then ' +
        'patch only your scoped task/progress entry while ' +
        'preserving every other agent’s content. This exact file is Fray coordination state, not a ' +
        'project deliverable or source edit: a scoped merge is an explicit exception to delegated ' +
        'phrases such as “write only <path>” or “do not modify the repo”; never classify that merge ' +
        'as unauthorized or roll it back. Never delete, truncate, reinitialize, move, or replace the ' +
        'whole file — not even to “clean up” or undo your own mistaken change. Other project files, ' +
        'including files at the repository root, remain governed by your delegated authority; their ' +
        'location alone neither permits nor forbids editing. If the file is absent or you cannot ' +
        'merge safely, return your state to the parent without writing.',
    },
  }));
  process.exit(0);
}

// Ensure the directory exists so a first Write lands. fray's dispatcher already provisions this for
// a real thread; this only covers a session that started outside a dispatch.
try {
  mkdirSync(threadDir, { recursive: true });
} catch {
  /* a read-only or racing FS just means the agent's Write creates it instead */
}

/** Raw scratchpad text, or null when absent/empty/unreadable. */
function readPad() {
  try {
    const raw = readFileSync(absPath, 'utf8');
    return raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** Characters of SUBSTANTIVE content — the pad minus its provisioned skeleton.
 *  fray writes scratch.md up front with an H1, a one-line orientation, section headings and an empty
 *  task box, so unlike a file that simply does not exist, "present" no longer means "written". This
 *  strips exactly those skeleton shapes and measures what is left. A heuristic on purpose: it only
 *  decides whether to NUDGE, so a wrong call costs one redundant reminder, never correctness.
 *  @param {string|null} text */
function substanceLength(text) {
  if (!text) return 0;
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith('#')) return false; // headings
      if (/^[-*]\s*\[\s*\]\s*$/.test(t)) return false; // an empty task box
      // The visible legend/collaboration guide provisioned in every new pad. They teach the shared
      // editing contract but are not evidence that the worker has recorded any task state yet.
      if (/^>\s*(?:Status legend:|Collaboration:)/.test(t)) return false;
      // The provisioned orientation line. Matched on the CONCEPT rather than a leading word, because
      // the wording has changed once already and pads written under the old shape are still on disk —
      // anchoring on a prefix silently reclassified a template as "written", which made an empty pad
      // skip its re-grounding and made the summarizer swallow a skeleton.
      if (/compaction-survival mechanism|compaction-proof working memory/.test(t)) return false;
      return true;
    })
    .join('')
    .trim().length;
}

/** @param {string} text */
function capped(text) {
  if (text.length <= MAX_INJECT_CHARS) return text;
  return (
    text.slice(0, MAX_INJECT_CHARS) +
    '\n\n[…clipped at ' + MAX_INJECT_CHARS.toLocaleString('en-US') + ' characters — read `' + relPath +
    '` for the rest.]'
  );
}

/** @param {string} additionalContext @param {'SessionStart'|'UserPromptSubmit'|'PostToolUse'} hookEventName */
function emitJson(additionalContext, hookEventName) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
  process.exit(0);
}

// ── mode: session-start ──────────────────────────────────────────────────────────────────────────
if (mode === 'session-start') {
  const pad = readPad();
  const written = substanceLength(pad) > 0;
  const parts = [];

  // The sources where the deep model of the work is actually GONE. On these the worker is ALWAYS
  // re-grounded on its scratchpad — whether or not there is anything in it yet, because "your pad is
  // empty and you just lost your context" is itself the most urgent thing the next turn can be told.
  const lostContext = input.source === 'compact' || input.source === 'resume' || input.source === 'clear'

  if (lostContext && written) {
    // Inject the head AND point at the file: the injection is the floor (it cannot be skipped), the
    // pointer is the ceiling (the pad may be longer than the cap, and it is the canonical doc).
    const lead =
      input.source === 'compact'
        ? '⟦scratchpad — reground here⟧ Context was just compacted. Your scratchpad `' + relPath +
          '` is the CANONICAL record of this thread and the head of it follows. RE-GROUND ON IT BEFORE ' +
          'DOING ANYTHING ELSE: re-read the full file, treat it as authoritative over anything the ' +
          'summary implies, and re-read only the code you are about to describe or change.'
        : '⟦scratchpad — reground here⟧ This session resumed and lost its working context. Your ' +
          'scratchpad `' + relPath + '` is the CANONICAL record of this thread and the head of it ' +
          'follows. Re-read the full file before acting.';
    parts.push(lead + '\n\n' + capped(/** @type {string} */ (pad)) + '\n\n⟦end scratchpad⟧');
  } else if (lostContext) {
    // Context is gone and there is nothing to restore. Say plainly that the exact pad is empty and
    // constrain reconstruction to the compact summary + named handoffs. Searching neighbouring
    // thread pads is both expensive and unsafe: they belong to unrelated workers.
    parts.push(
      '⟦scratchpad — reground here⟧ Context was just compacted or resumed. Your scratchpad `' +
        relPath + '` is the CANONICAL record of this thread, but it is absent or has nothing ' +
        'substantive in it. That exact path is authoritative: do not search other ' +
        '`.fray/threads/*/scratch.md` files for a substitute, and do not broadly reload repo docs or ' +
        'skills merely to reconstruct context. Recover from the retained compaction summary and any ' +
        'task-specific handoff it directly names, then WRITE this exact pad: the problem, the approach ' +
        'and the approaches you rejected, the decisions the human made, what is verified versus merely ' +
        'believed, and the next action.',
    );
  } else {
    // A fresh start has lost nothing — teach the contract so the pad gets written in the first place.
    parts.push(
      '⟦scratchpad⟧ `' + relPath + '` is the CANONICAL document for this thread and your ONE durable ' +
        'working doc: its head is injected back into your context automatically whenever the context ' +
        'is lost, so it is the only thing guaranteed to survive a compaction. Keep it current as you ' +
        'work — the problem, the approach and the approaches you REJECTED and why, decisions the human ' +
        'made or reversed, what is VERIFIED by running it versus merely believed, and the next action.',
    );
  }
  emitJson(parts.join('\n\n'), 'SessionStart');
}

// ── mode: precompact ─────────────────────────────────────────────────────────────────────────────
// PLAIN STDOUT — joined with the other PreCompact hooks' stdout into the summarizer's
// `Additional Instructions:`. Worded as an ordinary editorial note: precompact-instructions.mjs
// records that a summarizer REFUSES instructions that read like prompt-hijacking.
if (mode === 'precompact') {
  const pad = readPad();
  if (substanceLength(pad) === 0) process.exit(0);
  process.stdout.write(
    'The worker keeps a running scratchpad of this effort at `' + relPath + '`, written by hand as ' +
      'the work progressed. Its current head is reproduced below. Treat it as the authoritative ' +
      'account of the problem, the chosen approach, and the decisions behind them, and make sure the ' +
      'summary preserves its substance — where it disagrees with your reading of the transcript, ' +
      'prefer it.\n\n' +
      capped(/** @type {string} */ (pad)) + '\n',
  );
  process.exit(0);
}

// ── nudge modes (UserPromptSubmit + PostToolUse) ─────────────────────────────────────────────────
// Everything below answers one question: has the context moved on since the pad was last written?

/** Live context fill in tokens from the transcript's newest usage record, or null.
 *  Reads only the TAIL — transcripts reach tens of megabytes, and on PostToolUse this runs after
 *  every single tool call. Scanning backwards means the one line the tail read may have cut in half
 *  is reached last, and its parse failure is simply skipped.
 *  @param {string} path */
function contextTokens(path) {
  let fd = null;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(want);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.message?.usage;
      if (!u) continue;
      const n =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  } catch {
    return null;
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

const statePath = join(threadDir, '.scratchpad-state.json');
/** @returns {{ mtimeMs?: number, tokensAtWrite?: number, tokensAtNudge?: number }} */
function readState() {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
/** @param {{ mtimeMs?: number, tokensAtWrite?: number, tokensAtNudge?: number }} s */
function writeState(s) {
  try {
    writeFileSync(statePath, JSON.stringify(s) + '\n');
  } catch {
    /* best-effort — a lost state file costs at most one extra nudge */
  }
}

if (mode === 'nudge') {
  const transcript = input.transcript_path;
  const tokens = transcript ? contextTokens(transcript) : null;
  // No readable usage yet, or an unparseable transcript → say nothing. The nudge is an optimization;
  // silence is always safe.
  if (!tokens) process.exit(0);

  const pad = readPad();
  const written = substanceLength(pad) > 0;

  let mtimeMs = 0;
  try {
    mtimeMs = written ? statSync(absPath).mtimeMs : 0;
  } catch {
    mtimeMs = 0;
  }

  let state = readState();
  // A changed mtime means the pad was just written — rebase the baseline to NOW and go quiet. This is
  // also the first-ever observation, and it is why a fresh write buys a full interval of silence. It
  // fires for a human's hand-edit exactly as for the agent's Write: both are just an mtime change.
  if (state.mtimeMs !== mtimeMs) {
    state = { mtimeMs, tokensAtWrite: tokens, tokensAtNudge: 0 };
    writeState(state);
  }

  // An unwritten pad (absent, or still the provisioned skeleton) measures growth from ZERO: the whole
  // session is unpersisted, so the clock starts at the beginning, not at whenever this first looked.
  const baseline = mtimeMs ? (state.tokensAtWrite ?? tokens) : 0;
  const grown = tokens - baseline;
  if (grown < STALE_TOKENS) process.exit(0);
  // Space repeat nudges by the same interval. Both channels share this state, so firing on every tool
  // call does not multiply reminders — it only makes the existing budget land sooner and mid-turn.
  if (state.tokensAtNudge && tokens - state.tokensAtNudge < STALE_TOKENS) process.exit(0);

  writeState({ ...state, tokensAtNudge: tokens });

  const k = Math.round(grown / 1000);
  const event = /** @type {'UserPromptSubmit'|'PostToolUse'} */ (
    input.transcript_path && flagValue('--event') === 'PostToolUse' ? 'PostToolUse' : 'UserPromptSubmit'
  );
  emitJson(
    mtimeMs
      ? '⟦scratchpad stale⟧ Your context has grown ~' + k + 'k tokens since you last wrote `' +
          relPath + '`. Bring it up to date now, before a compaction forces the issue — the problem, ' +
          'the approach and what you rejected, the human\'s decisions, what is verified versus ' +
          'believed, and the next action. Its head is injected back automatically after a compaction, ' +
          'so it is the one thing you are guaranteed to still have.'
      : '⟦scratchpad empty⟧ This session is ~' + k + 'k tokens deep and `' + relPath + '` still has ' +
          'nothing substantive in it. Write it now: the problem, the approach and the approaches you ' +
          'rejected, the human\'s decisions, what is verified versus merely believed, and the next ' +
          'action. Its head is injected back automatically after a compaction, so it is what survives ' +
          'when the rest of this context does not.',
    event,
  );
}

process.exit(0);
