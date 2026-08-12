#!/usr/bin/env node
// @ts-check
// Stop hook (frizz-worker) — puts the fence grammar next to the moment the worker decides to stop.
//
// WHY THIS EXISTS (maintainer 2026-08-11: "i find that longrunning tasks forget about ```done and
// ```question"). They have not LOST the rule. The contract states it once, in the real system prompt,
// and that text rides EVERY request: `claude-agent-sdk.ts` passes it as
// `systemPrompt: {type:"preset", preset:"claude_code", append}`, and compaction only rewrites the
// message array, never the system prompt. `session-seed.mjs` repeats a condensed form on
// SessionStart(compact), which does fire — that exact string appears in real transcripts on disk.
//
// The rule is therefore always PRESENT and always FAR: ~9% into a ~4.5k-token appended block, with
// however many hundred thousand tokens of conversation after it. And nothing spoke at the one moment it
// is needed — `hooks.json` registered PreToolUse, PostToolUse, UserPromptSubmit, PermissionRequest,
// PreCompact and SessionStart, but no Stop, and `mcp__frizz__recurring_prompt`'s `stop_hook` trigger is
// something each thread has to arm for itself.
//
// THE CHANNEL, and it is NOT `decision: "block"`. Stop accepts
// `hookSpecificOutput: {hookEventName: 'Stop', additionalContext}` — the SDK types call it "non-error
// feedback delivered to the model; the conversation continues so the model can act on it"
// (@anthropic-ai/claude-agent-sdk 0.3.207, `StopHookSpecificOutput` in sdk.d.ts). Blocking would surface
// as a refusal and read as an error; this is one more turn in which the worker can re-emit its handoff
// with the right fence, or simply rest again.
//
// COST DISCIPLINE. Every fire costs a full model turn, so silence is the default and the bar to speak is
// high. A worker that already fenced pays NOTHING — the common case exits before any I/O.
//
// AND IT MUST NOT PUSH TOWARD A FENCE. Bare rest is the contract's default and `done` is a DISMISSAL, so
// a reminder that nagged for a fence would trade a forgotten `done` for a premature one, which is the
// more expensive mistake (its card files the thread away). Both messages below therefore name bare rest
// FIRST and as correct.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSessionId } from '../scripts/frizz/config.mjs';
import { contextTokens } from '../scripts/frizz/transcript-usage.mjs';

/** @param {string} name @param {number} fallback */
function intFromEnv(name, fallback) {
  const n = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Context growth between two "you have four options" reminders. Deliberately much coarser than the
 *  scratchpad nudge's 60k: that one asks for a cheap side-effect mid-turn, this one costs a whole turn
 *  and interrupts a handoff the human may already be reading. */
const REMIND_TOKENS = intFromEnv('FRIZZ_STOP_FENCE_TOKENS', 150000);

/** Below this the "forgot" diagnosis does not apply — a short thread has the contract a few thousand
 *  tokens up, and a worker that bare-rests there is almost always right to. */
const MIN_TOKENS = intFromEnv('FRIZZ_STOP_FENCE_MIN_TOKENS', 120000);

/** Wall-clock floor between fires, whatever the token arithmetic says. Belt to the token braces: a
 *  transcript that stops reporting usage must never turn into a loop. */
const COOLDOWN_MS = intFromEnv('FRIZZ_STOP_FENCE_COOLDOWN_MS', 120000);

// One-off escape hatch, matching scratchpad.mjs: an env var for "this session is doing something where
// the injection is in the way", not a project posture. Only an explicit off value disables.
if (/^(off|0|false|no|disabled)$/i.test((process.env.FRIZZ_STOP_FENCE_HOOK ?? '').trim())) process.exit(0);

// WORKER GATE — inert unless this is a frizz worker session. The plugin is loaded by ordinary Claude
// Code sessions too, and the fences mean nothing there.
if (!(process.env.FRIZZ_THREAD ?? '').trim()) process.exit(0);

/** @type {{ agent_id?: unknown, agentId?: unknown, session_id?: string, transcript_path?: string, stop_hook_active?: boolean, last_assistant_message?: string }} */
let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // no event to reason about
}

// A sub-agent's stop is not a handoff to the human — it returns to its parent, which owns the fence.
if (input.agent_id ?? input.agentId) process.exit(0);

// The runtime's own re-entry flag: set when this stop was already extended by a Stop hook. Honouring it
// is the documented way not to spin. It is not the ONLY guard here (see `sameMessage` below) because a
// guard for a loop must not depend on the thing it guards against behaving as documented.
if (input.stop_hook_active) process.exit(0);

const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
if (!message.trim()) process.exit(0);

// Fenced code inside the handoff is not the handoff's own grammar: a pasted diff, a quoted log or an
// example block can carry both a stray `?` and the literal word "question". Strip fenced blocks before
// asking what the message DOES, and keep the fence scan on the raw text so a real signal still counts.
const prose = message.replace(/^```[\s\S]*?^```/gm, '\n');

/** A signal fence the worker actually emitted, at the start of a line. */
const FENCE = /^```(?:done|awaiting|question)\b/m;
// THE COMMON CASE, AND IT COSTS NOTHING: the worker fenced, so it has not forgotten anything.
if (FENCE.test(message)) process.exit(0);

// An ask the dashboard cannot render. `?` is matched at end of line only, and the phrase list is the set
// that reliably means "I am handing this decision back" rather than musing in prose.
const ASK =
  /\?\s*$|\blet me know\b|\bshould I\b|\bshall I\b|\bdo you want\b|\bwant me to\b|\byour call\b|\bwhich (?:would|do) you\b|\btell me (?:if|which|whether)\b/im;
// Only the tail: a handoff's ask lives at the end, and scanning the whole message would flag every
// rhetorical question asked while narrating the work.
const asking = ASK.test(prose.slice(-1500));

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let sid = null;
try {
  sid = currentSessionId(input.session_id);
} catch {
  /* best-effort */
}
if (!sid) process.exit(0);
const threadDir = join(projectDir, '.frizz', 'threads', sid);
// The guards below are only as good as the state file, and the state file needs somewhere to live. A
// real dispatch provisions this directory, but a session started outside one would otherwise lose the
// loop guard silently — leaving `stop_hook_active` as the only thing between this and a spin.
try {
  mkdirSync(threadDir, { recursive: true });
} catch {
  /* read-only or racing FS — writeState below degrades to best-effort, as it already does */
}
const statePath = join(threadDir, '.stop-fence-state.json');

/** @returns {{ firedAtMs?: number, tokensAtFire?: number, lastMessage?: string }} */
function readState() {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}
/** @param {{ firedAtMs?: number, tokensAtFire?: number, lastMessage?: string }} s */
function writeState(s) {
  try {
    writeFileSync(statePath, JSON.stringify(s) + '\n');
  } catch {
    /* best-effort — a lost state file costs at most one extra reminder */
  }
}

const state = readState();
const now = Date.now();

// THE STRUCTURAL LOOP GUARD. If the worker rests again on the SAME text we just spoke about, it has
// considered the reminder and declined it. Saying it twice would be a loop, and an argument. A prefix is
// enough of a fingerprint and keeps the state file small.
const fingerprint = message.slice(0, 400);
if (state.lastMessage === fingerprint) process.exit(0);
if (state.firedAtMs && now - state.firedAtMs < COOLDOWN_MS) process.exit(0);

const tokens = input.transcript_path ? contextTokens(input.transcript_path) : null;

// An unfenced ASK is a defect at any depth: the human gets prose where the dashboard should have shown
// an answerable card, and they may not notice the thread is blocked on them at all. The periodic
// four-option reminder is the opposite — it fires on a turn that is probably CORRECT, so it waits for a
// thread long enough that "forgot" is the plausible reading, and then only once per REMIND_TOKENS.
let body = null;
if (asking) {
  // LEAD WITH THE ACTION, and keep the exits short and last. Measured against a real session: a probe
  // hook whose additionalContext was one flat imperative got obeyed immediately, while an earlier draft
  // of this text — which opened with the diagnosis and offered its escape hatch mid-paragraph — did not
  // move the model at all. A reminder the worker reads as optional is a turn spent for nothing.
  body =
    '⟦fence check⟧ Your final message asks the human something but carries no ` ```question ` block, so ' +
    'frizz files it as an ordinary handoff and they get prose where an answerable card belongs — on a ' +
    'board they may not open for hours. SEND IT AGAIN NOW with each question in its own fenced ' +
    '`question` block: the question on ONE line, lettered options with a one-line tradeoff each, exactly ' +
    'one marked `(recommended)` and placed first as `A`, and enough context to answer cold. Two exits, ' +
    'both fine: if you were only asking permission to do work you were already dispatched to do, do the ' +
    'work instead; if it was not really an ask, rest again unchanged and this will not ask twice.';
} else if (tokens && tokens >= MIN_TOKENS && (!state.tokensAtFire || tokens - state.tokensAtFire >= REMIND_TOKENS)) {
  body =
    '⟦fence check⟧ This thread is ~' + Math.round(tokens / 1000) + 'k tokens deep and your final message ' +
    'carries no fence. That is very often RIGHT — bare rest is the ordinary handoff and the default. ' +
    'Confirm rather than change by reflex, because the four states are not interchangeable: bare rest ' +
    'queues an ordinary handoff; ` ```done ` is a DISMISSAL that files the thread away, so it needs the ' +
    "effort's real work COMPLETE and never fits a thread still pointing at future work; ` ```awaiting ` " +
    'parks a durable wait on a `human:` / `timer:` / `pr-watch:` gate, never on CI or a merge; ' +
    '` ```question ` is the ask. If the instruction still has parts left, none of them apply — keep ' +
    'working in this same turn. If bare rest is right, rest again unchanged and this will not ask twice.';
}

if (!body) process.exit(0);

writeState({ firedAtMs: now, tokensAtFire: tokens ?? state.tokensAtFire, lastMessage: fingerprint });
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: body } }));
process.exit(0);
