#!/usr/bin/env node
// @ts-check
// CARRYOVER hook (fray-worker) — a per-session, agent-authored brief that is re-injected VERBATIM
// into context at every session start and after every compaction. Run directly with node (zero deps,
// max Node compat), mirroring the other hooks in this plugin.
//
// WHY THIS EXISTS: compaction is the largest source of context loss in a long session, and the two
// mitigations that already existed both have a hole.
//   • The SCRATCHPAD (`.fray/threads/<sid>/scratch.md`) survives compaction on disk, but only helps
//     if the post-compaction turn CHOOSES to read it. That is a model decision, and it is skipped.
//   • `precompact-instructions.mjs` steers the SUMMARIZER, but the summary is a lossy retelling by a
//     model that never saw the reasoning, and it is regenerated from scratch every time.
// Neither is bulletproof, because both route the context through a decision. This hook removes the
// decision: whatever is in `carryover.md` is spliced into the context window itself, by the harness,
// before the model's first token. The model cannot forget to read it and the summarizer cannot
// paraphrase it away.
//
// THE FILE IS AUTHORED BY THE AGENT, NOT BY THIS HOOK. The agent Writes `carryover.md` the way it
// writes any file; this hook only stores, injects, and nags. Keeping it a plain markdown file (rather
// than a tool or a CLI) is deliberate — there is nothing to learn, nothing to install, and a human can
// read or hand-edit it mid-session and the next turn picks the edit up.
//
// KEYED BY SESSION: `.fray/threads/<session-id>/carryover.md`, a sibling of the scratchpad. The
// session id comes from the hook's stdin `session_id`, falling back to `CLAUDE_CODE_SESSION_ID` —
// the same value a Bash/Write tool call sees, which is what lets the agent compute the path itself.
// `.fray/` is gitignored in full, so a brief never reaches a commit. Nothing enumerates
// `.fray/threads/*` to build the board (threads come from the DB), so writing a directory here for a
// non-fray session cannot conjure a phantom thread card.
//
// THREE MODES, ONE SCRIPT — because all three need the same path resolution and the same read/cap:
//   --mode=session-start  SessionStart(startup|resume|clear|compact) → JSON additionalContext.
//                         Injects the brief verbatim. This is the load-bearing one.
//   --mode=precompact     PreCompact(auto|manual) → PLAIN STDOUT, appended to the summarizer's
//                         `Additional Instructions:`. A second, independent channel: even if the
//                         SessionStart injection were to fail, the summary still carries the brief.
//                         DO NOT emit JSON in this mode — see precompact-instructions.mjs, which
//                         documents the unusual plain-stdout contract this shares.
//   --mode=nudge          UserPromptSubmit → JSON additionalContext, but only when the brief has gone
//                         STALE. Without this the file is never written and the feature is
//                         decorative: an agent that is never reminded does not stop to journal.
//
// --via=project marks the registration in the repo's own `.claude/settings.json`, which exists so
// plain (non-fray) `claude` sessions in this repo get the same behavior. It EXITS when FRAY_UI_THREAD
// is set, because such a session already loads this plugin and would otherwise inject twice. The gate
// is deterministic — a flag plus an env check, no lock file and no race.
//
// STALENESS IS MEASURED IN CONTEXT TOKENS, NOT WALL CLOCK OR BYTES. The transcript's assistant records
// carry a real `usage` block, and `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
// is the live context fill (verified against this project's transcripts). Wall clock says nothing about
// context pressure, and transcript BYTES are a poor proxy — a single large tool result can add
// megabytes to the file without moving the window much. What we compare against is GROWTH SINCE THE
// BRIEF WAS LAST WRITTEN, never an absolute threshold, because the window size is not knowable here:
// a real compaction in this project fired at preTokens 935,291 (a 1M-window session) while a 200k
// session compacts near 160k. Growth is window-independent and self-resetting — writing the brief
// silences the nudge until the context has moved on again.
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { currentSessionId } from '../scripts/fray/config.mjs';

const CARRYOVER_FILE = 'carryover.md';

/** Hard cap on injected characters. The brief is a HIGH-LEVEL orientation, not an archive — ~24k
 *  chars is roughly 4,000 words, far past what a useful brief needs, and it bounds the tax this takes
 *  out of every single session start. Over the cap we inject the HEAD (the brief's own summary lives
 *  at the top) and say plainly that it was clipped, so nothing silently disappears. */
const MAX_INJECT_CHARS = intFromEnv('FRAY_CARRYOVER_MAX_CHARS', 24000);

/** Context-token growth since the brief was last written that marks it stale. 60k is ~a third of a
 *  200k window and ~6% of a 1M one: frequent enough that a brief is never many turns behind, rare
 *  enough that it is not chatter. Also the FIRST-WRITE trigger — with no brief on disk the baseline
 *  is zero, so the first nudge lands once a session has accumulated 60k tokens actually worth
 *  preserving, rather than nagging a session that has barely started. */
const STALE_TOKENS = intFromEnv('FRAY_CARRYOVER_STALE_TOKENS', 60000);

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

// Global kill switch — one env var disables every mode, for a session that wants the context back.
if ((process.env.FRAY_CARRYOVER ?? '').trim().toLowerCase() === 'off') process.exit(0);

// The repo-local registration defers to the plugin one for fray workers (see --via above).
if (via === 'project' && (process.env.FRAY_UI_THREAD ?? '').trim()) process.exit(0);

/** @type {{ agent_id?: unknown, agentId?: unknown, source?: string, trigger?: string, session_id?: string, transcript_path?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no stdin / not JSON → input stays {} → fall back to env for the session id */
}
// Sub-agent contexts (they carry agent_id) are skipped, matching session-seed.mjs: a sub-agent has
// its own short-lived context and no claim on the top-level worker's brief.
if (input.agent_id ?? input.agentId) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let sid = null;
try {
  sid = currentSessionId(input.session_id);
} catch {
  /* best-effort */
}
// Without a session id there is no key, and a shared unkeyed brief would bleed between sessions.
if (!sid) process.exit(0);

const threadDir = join(projectDir, '.fray', 'threads', sid);
const relPath = '.fray/threads/' + sid + '/' + CARRYOVER_FILE;
const absPath = join(threadDir, CARRYOVER_FILE);

// Ensure the directory exists so the agent's very first Write lands without a mkdir of its own. We
// deliberately do NOT create the FILE: absent means "never written", which is exactly the signal the
// nudge needs, and a stub template would inject as noise on every start.
try {
  mkdirSync(threadDir, { recursive: true });
} catch {
  /* a read-only or racing FS just means the agent's Write creates it instead */
}

/** The brief's contents, or null when absent/empty/unreadable. */
function readBrief() {
  try {
    const raw = readFileSync(absPath, 'utf8');
    return raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** @param {string} text */
function capped(text) {
  if (text.length <= MAX_INJECT_CHARS) return text;
  return (
    text.slice(0, MAX_INJECT_CHARS) +
    '\n\n[…clipped at ' + MAX_INJECT_CHARS.toLocaleString('en-US') + ' characters — read `' + relPath +
    '` for the rest, and consider trimming it: this brief is meant to be a high-level orientation.]'
  );
}

// How the agent is taught the mechanism. Injected on EVERY session start, brief or no brief, because
// a capability nobody knows about is never used. The scratchpad/carryover distinction is spelled out
// on purpose — without it the two files converge into one long duplicated log.
const contract =
  '⟦carryover brief⟧ `' + relPath + '` is YOUR note to your future self. Its contents are injected ' +
  'VERBATIM into your context at every session start and after every compaction — so unlike anything ' +
  'else you write, it cannot be summarized away or forgotten. Write it with the Write tool and keep ' +
  'it current.\n' +
  'WHAT BELONGS IN IT: what a competent replacement would need to hear in 60 seconds — the problem ' +
  'being solved, the approach and the approaches REJECTED and why, decisions the human made or ' +
  'reversed (in their wording), what is VERIFIED by running it versus merely believed, and the single ' +
  'next action. Rewrite it whenever the shape of the work changes; it is a living brief, not an ' +
  'append-only log.\n' +
  'NOT a second scratchpad: the scratchpad is where you WORK (task lists, findings, shared sub-agent ' +
  'state) and it can grow without limit. The carryover is the short high-level orientation, and it is ' +
  'charged against your context on every start — keep it tight.';

/** @param {string} additionalContext @param {'SessionStart'|'UserPromptSubmit'} hookEventName */
function emitJson(additionalContext, hookEventName) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
  process.exit(0);
}

// ── mode: session-start ──────────────────────────────────────────────────────────────────────────
if (mode === 'session-start') {
  const brief = readBrief();
  const parts = [contract];
  if (brief) {
    // `compact` and `resume` are the moments the deep model of the work is actually gone, so they get
    // an explicit re-grounding lead rather than a bare quotation.
    const lead =
      input.source === 'compact'
        ? '⟦carryover — restored after compaction⟧ Context was just compacted. This is the brief YOU ' +
          'wrote for exactly this moment; treat it as authoritative over anything the summary implies, ' +
          'and re-read the files it names before changing them.'
        : input.source === 'resume'
          ? '⟦carryover — restored on resume⟧ This is the brief you wrote earlier in this session.'
          : '⟦carryover — restored⟧ This is the brief you wrote earlier in this session.';
    parts.push(lead + '\n\n' + capped(brief) + '\n\n⟦end carryover⟧');
  }
  emitJson(parts.join('\n\n'), 'SessionStart');
}

// ── mode: precompact ─────────────────────────────────────────────────────────────────────────────
// PLAIN STDOUT — this is joined with the other PreCompact hooks' stdout into the summarizer's
// `Additional Instructions:`. Worded as an ordinary editorial note: precompact-instructions.mjs
// records that a summarizer REFUSES instructions that read like prompt-hijacking.
if (mode === 'precompact') {
  const brief = readBrief();
  if (!brief) process.exit(0);
  process.stdout.write(
    'The worker maintains a short high-level brief of this effort at `' + relPath + '`, written by ' +
      'hand as the work progressed. It is reproduced below. Treat it as the authoritative account of ' +
      'the problem, the chosen approach, and the decisions behind them, and make sure the summary ' +
      'preserves its substance — where it disagrees with your reading of the transcript, prefer it.\n\n' +
      capped(brief) + '\n',
  );
  process.exit(0);
}

// ── mode: nudge (UserPromptSubmit) ───────────────────────────────────────────────────────────────
// Everything below exists only to answer "has the context moved on since the brief was written?"

/** Live context fill in tokens from the transcript's most recent usage record, or null.
 *  Reads only the TAIL of the file — transcripts reach tens of megabytes in this project, so slurping
 *  one on every prompt would be a real cost. Scanning backwards means the one line the tail read may
 *  have cut in half is reached last, and its parse failure is simply skipped.
 *  @param {string} path */
function contextTokens(path) {
  let fd = null;
  try {
    const size = statSync(path).size;
    const want = Math.min(size, 256 * 1024);
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

const statePath = join(threadDir, '.carryover-state.json');
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
  // No readable usage yet (a brand-new session, or a transcript we cannot parse) → say nothing. The
  // nudge is an optimization; being silent is always safe.
  if (!tokens) process.exit(0);

  let mtimeMs = 0;
  try {
    mtimeMs = readBrief() ? statSync(absPath).mtimeMs : 0;
  } catch {
    mtimeMs = 0;
  }

  let state = readState();
  // A changed mtime means the brief was just (re)written — rebase the baseline to NOW and go quiet.
  // This is also the first-ever observation path, and it is why a freshly written brief buys a full
  // STALE_TOKENS of silence.
  if (state.mtimeMs !== mtimeMs) {
    state = { mtimeMs, tokensAtWrite: tokens, tokensAtNudge: 0 };
    writeState(state);
  }

  // With NO brief on disk the baseline is zero: the whole session is unpreserved, so growth is
  // measured from the start rather than from whenever this hook first happened to look.
  const baseline = mtimeMs ? (state.tokensAtWrite ?? tokens) : 0;
  const grown = tokens - baseline;
  if (grown < STALE_TOKENS) process.exit(0);
  // Space out repeat nudges by the same interval, so a session that declines to write one is reminded
  // occasionally rather than on every single prompt.
  if (state.tokensAtNudge && tokens - state.tokensAtNudge < STALE_TOKENS) process.exit(0);

  writeState({ ...state, tokensAtNudge: tokens });

  const k = Math.round(grown / 1000);
  emitJson(
    mtimeMs
      ? '⟦carryover stale⟧ Your context has grown by ~' + k + 'k tokens since you last updated `' +
          relPath + '`. Refresh it now, before a compaction forces the issue — the problem, the ' +
          'approach and what you rejected, the human\'s decisions, what is verified versus believed, ' +
          'and the next action. It is injected verbatim after every compaction, so it is the one thing ' +
          'you are guaranteed to still have.'
      : '⟦carryover missing⟧ This session is ~' + k + 'k tokens deep with no carryover brief at `' +
          relPath + '`. Write one now: what a competent replacement would need in 60 seconds — the ' +
          'problem, the approach and the approaches you rejected, the human\'s decisions, what is ' +
          'verified versus merely believed, and the next action. It is injected verbatim after every ' +
          'compaction, so it is what survives when the rest of this context does not.',
    'UserPromptSubmit',
  );
}

process.exit(0);
