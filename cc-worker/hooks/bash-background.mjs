#!/usr/bin/env node
// @ts-check
// PreToolUse hook on `Bash` (fray-worker). Claude's native `run_in_background` flag registers a
// task, output file, terminal notification, and wake. Shell job control (`cmd &`) does none of those:
// the child can survive after the Bash tool returns, but Claude and fray have no lifecycle identity
// for it. A worker can then rest forever waiting for a notification that cannot exist.
//
// Block only an ESCAPING local background job. Self-contained shell concurrency remains valid when
// the command explicitly waits for its children or owns them with an EXIT trap before Bash returns.
//
// GATE: inert unless FRAY_UI_THREAD is set (ordinary Claude sessions keep their native behavior).
// FAIL OPEN: malformed hook input allows the command rather than wedging a worker.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
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
      // Double quotes may contain a complete command substitution with its OWN quote grammar:
      // `"$(python -c 'print(f"{x&255}")')"`. Treating the f-string's double quote as the end of the
      // outer region exposed arithmetic `&` as fake job control in a real corpus call. The outer shell
      // waits for command substitution, so blank the balanced substitution as part of the quote.
      if (quote === '"' && c === '$' && command[i + 1] === '(') {
        out += '  ';
        i += 2;
        let depth = 1;
        let innerQuote = '';
        let innerEscaped = false;
        for (; i < command.length; i++) {
          const inner = command[i];
          out += inner === '\n' ? '\n' : ' ';
          if (innerEscaped) {
            innerEscaped = false;
            continue;
          }
          if (inner === '\\' && innerQuote !== "'") {
            innerEscaped = true;
            continue;
          }
          if (innerQuote) {
            if (inner === innerQuote) innerQuote = '';
            continue;
          }
          if (inner === "'" || inner === '"' || inner === '`') {
            innerQuote = inner;
            continue;
          }
          if (inner === '(') depth++;
          else if (inner === ')' && --depth === 0) break;
        }
        continue;
      }
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

  // A lifecycle action AFTER the last launch makes the command self-contained. `kill` alone does not:
  // the signal is asynchronous, so the shell still needs a wait before returning. An EXIT trap owns
  // cleanup at the shell boundary.
  const tail = command.slice(operators[operators.length - 1] + 1);
  return !(/\bwait\b/.test(tail) || /\btrap\b[^\n;]*\b(?:EXIT|0)\b/.test(tail));
}

export function evaluateBashBackgroundHook(input, env = process.env) {
  if (!String(env.FRAY_UI_THREAD ?? '').trim()) return {};
  const command = input && typeof input === 'object'
    ? String(input.tool_input?.command ?? '')
    : '';
  if (!hasEscapingBackgroundJob(command)) return {};
  const codex = typeof input?.model === 'string';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        codex
          ? 'Fray blocked an untracked shell background job (`&`). Shell job control can return without a Codex lifecycle handle, so Fray cannot report completion or wake this agent. For work that must continue while you do something else, remove `&` and use the managed unified exec pattern: start `tools.exec_command(...)`, call `yield_control()`, then await and fully drain that same process. A returned `session_id` alone is only foreground continuation. For bounded parallel work inside one shell call, finish with `wait` (after `kill`, if used) or own cleanup with an EXIT trap.'
          : 'Fray blocked an untracked shell background job (`&`). Shell job control can return from Bash without a Claude task ID, so Fray cannot report completion or wake this agent. For a long-running local command, remove `&` and call Bash with `run_in_background:true`. For bounded parallel work inside one Bash call, finish with `wait` (after `kill`, if used) or own cleanup with an EXIT trap.',
    },
  };
}

export function isDirectHookExecution(argv1, moduleUrl) {
  return typeof argv1 === 'string'
    && basename(argv1) === 'bash-background.mjs'
    && pathToFileURL(argv1).href === moduleUrl;
}

// The server imports `hasEscapingBackgroundJob` and its production build bundles this module into
// `src/index.js`. esbuild rewrites `import.meta.url` to that bundle URL, so URL equality alone would
// mistake the whole server for this executable and block startup reading hook JSON from stdin.
if (isDirectHookExecution(process.argv[1], import.meta.url)) {
  try {
    const env = process.argv.includes('--fray-ui-thread')
      ? { ...process.env, FRAY_UI_THREAD: process.env.FRAY_UI_THREAD || 'codex-worker' }
      : process.env;
    emit(evaluateBashBackgroundHook(JSON.parse(readFileSync(0, 'utf8')), env));
  } catch {
    emit({});
  }
}
