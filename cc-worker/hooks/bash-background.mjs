#!/usr/bin/env node
// @ts-check
// PreToolUse hook on `Bash` (fray-worker). Claude's native `run_in_background` flag registers a
// task, output file, terminal notification, and wake. Shell job control (`cmd &`) does none of those:
// the child can survive after the Bash tool returns, but Claude and fray have no lifecycle identity
// for it. A worker can then rest forever waiting for a notification that cannot exist.
//
// Block only an ESCAPING local background job. Self-contained shell concurrency remains valid when
// the command explicitly waits for, kills, or traps its children before the Bash call returns.
//
// GATE: inert unless FRAY_UI_THREAD is set (ordinary Claude sessions keep their native behavior).
// FAIL OPEN: malformed hook input allows the command rather than wedging a worker.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

/**
 * Blank heredoc bodies while preserving line/character positions. A script being WRITTEN may contain
 * `&`; only the shell currently executing this tool call is relevant to the lifecycle escape.
 * @param {string} command
 */
function withoutHeredocBodies(command) {
  const lines = command.split('\n');
  /** @type {string[]} */
  const pending = [];
  let active;
  return lines.map((line) => {
    if (active !== undefined) {
      if (line.trim() === active) {
        active = pending.shift();
        return line;
      }
      return ' '.repeat(line.length);
    }

    // Shell accepts quoted and bare heredoc delimiters. Multiple heredocs on one command line are
    // consumed in declaration order.
    for (const match of line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))/g)) {
      const delimiter = match[1] ?? match[2] ?? match[3];
      if (delimiter) pending.push(delimiter);
    }
    active = pending.shift();
    return line;
  }).join('\n');
}

/**
 * Replace quoted regions with spaces. Operators sent inside `ssh host '…'` are remote, and quoted
 * prose such as `printf '&'` is not local shell job control. Backticks are also synchronous command
 * substitutions from the outer shell's perspective.
 * @param {string} command
 */
function withoutQuotedRegions(command) {
  let quote = '';
  let escaped = false;
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) {
      out += quote ? ' ' : c;
      escaped = false;
      continue;
    }
    if (c === '\\' && quote !== "'") {
      out += quote ? ' ' : c;
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Return true when this Bash call starts a local background job and can return without joining or
 * terminating it. This is deliberately a small shell-lifecycle recognizer, not a general parser.
 * @param {unknown} raw
 */
export function hasEscapingBackgroundJob(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const command = withoutQuotedRegions(withoutHeredocBodies(raw));
  /** @type {number[]} */
  const operators = [];
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== '&') continue;
    const before = command[i - 1] ?? '';
    const after = command[i + 1] ?? '';
    // `&&`, redirects (`2>&1`, `&>`), and an escaped literal are not background operators.
    if (before === '&' || after === '&' || before === '>' || before === '<' || after === '>' || before === '\\') continue;
    operators.push(i);
  }
  if (operators.length === 0) return false;

  // A lifecycle action AFTER the last launch makes the command self-contained. Bare `wait` joins all
  // jobs; targeted `wait`/`kill` and an EXIT trap are equally explicit ownership.
  const tail = command.slice(operators[operators.length - 1] + 1);
  return !/\b(?:wait|kill|trap)\b/.test(tail);
}

export function evaluateBashBackgroundHook(input, env = process.env) {
  if (!String(env.FRAY_UI_THREAD ?? '').trim()) return {};
  const command = input && typeof input === 'object'
    ? String(input.tool_input?.command ?? '')
    : '';
  if (!hasEscapingBackgroundJob(command)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'fray worker (hook-enforced): this Bash command starts a shell-backgrounded job (`&`) and returns without waiting for or stopping it. That child may keep running, but Claude and Fray cannot track it or wake you when it finishes. Remove `&`/`nohup` and re-send the long command in the foreground with Bash `run_in_background:true`; if you intend to rest until it finishes, dispatch a background Agent that owns the wait in its foreground. Self-contained concurrency is allowed when this Bash call explicitly `wait`s for or stops every child before returning.',
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    emit(evaluateBashBackgroundHook(JSON.parse(readFileSync(0, 'utf8'))));
  } catch {
    emit({});
  }
}
