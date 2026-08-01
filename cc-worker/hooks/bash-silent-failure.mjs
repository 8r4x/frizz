#!/usr/bin/env node
// @ts-check
// PostToolUse hook on `Bash` (fray-worker). A shell block's exit status is only its LAST command's,
// and a pipeline's is only its LAST STAGE's — so a step that dies anywhere else leaves no trace in the
// status. The harness records success, the fray card reads "done", and the worker moves on with the
// edit / build / fetch that step owned never having happened.
//
// The case this was built from (2026-08-01, nub thread): step 1 was `python3 - <<PY … assert old in
// s … PY`, which raised AssertionError so the file edit never applied; step 2 ran `--selftest` on the
// UNEDITED file and printed "selftest ok"; step 3 was a `sed` that printed nothing and exited 0. The
// block exited 0, `is_error` was false, and the worker read the card's "done" as done.
//
// PRECISION COMES FROM THE HARNESS, NOT FROM GUESSING. A command that actually exits non-zero is
// already reported with `is_error` and an "Exit code N" body, and this hook stays silent on those. So
// "harness says success AND the output holds an unhandled interpreter exception" is a masked failure
// BY CONSTRUCTION — no need to parse the shell for `;`/`&&`/`|` structure to prove it.
//
// Measured over this machine's whole transcript corpus (976 transcripts, 59,155 Bash calls): the
// harness flagged 1,852 (3.1%), and this detector matches a further 693 that reported success while
// their output carried an unhandled exception. 85 are suppressed below as already-attended, leaving
// 608 — 1.03% of all Bash calls, 497 of them a pipeline that handed the shell `tail`/`grep`'s status
// instead of the program's, 111 a later step in a block. Hand-checking a 12-call spread of the
// survivors found 10 unmistakable (a test suite red behind `| tail -25`, a python heredoc dead of
// FileNotFoundError, a probe dead of ERR_MODULE_NOT_FOUND) and 2 ambiguous; the residual cost of
// those is one short advisory paragraph.
//
// GATE: inert unless FRAY_UI_THREAD is set (ordinary Claude sessions keep their native behavior).
// FAIL OPEN: any unrecognized shape or error emits NOTHING. A missed reminder costs one masked
// failure; a PostToolUse hook that throws disturbs every turn.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * An unhandled exception from an interpreter, paired with the commands that can produce one. BOTH
 * halves must match: a traceback in the output of `cat server.log` or `grep -A5 Traceback app.log` is
 * DATA the worker asked to see, not a failure of the command that printed it.
 */
const EXCEPTIONS = [
  {
    kind: 'Python',
    // The header line of an unhandled traceback. Python writes it only when the exception escaped to
    // the top level; a caught-and-printed `traceback.print_exc()` is the accepted residual.
    signature: /^Traceback \(most recent call last\):$/m,
    runners: ['python', 'python3', 'py', 'pytest', 'uv'],
  },
  {
    kind: 'Node',
    // A real stack FRAME — `at fn (/abs/path.js:12:5)` or `at node:internal/x:1:2` — anchored on the
    // file:line:col that only a thrown stack carries. The bare word "Error:" appears constantly in
    // ordinary log output and is not usable on its own.
    signature: /^\s+at (?:\S+ \()?(?:\/|file:|node:|[A-Za-z]:\\)\S*:\d+:\d+\)?$/m,
    runners: ['node', 'nub', 'nubx', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'tsx', 'vitest', 'jest'],
  },
];

// Stages that exist to READ output. The shell takes a pipeline's status from the last of these, not
// from the program whose output they are reading — the documented "never read an exit code through a
// pipe" trap, and the single largest masking channel in the corpus.
const READER_STAGE = /\|\s*(?:tail|head|grep|rg|less|cat|sed|awk|jq|toon|wc|sort|uniq|tee|fold|cut)\b/;

// The worker is already hunting this failure on purpose — `| grep -A12 AssertionError` is a request to
// SEE the exception, not a step that was supposed to succeed. Bounded to one pipeline stage so the
// ubiquitous `| grep -v "npm warn"` (which precedes a genuine masked failure in the corpus) is unaffected.
const HUNTS_THE_ERROR = /\b(?:grep|rg|ag)\b[^\n|]*(?:Error|Traceback|AssertionError|Exception|✖|FAIL|fail)/i;

/** @param {string} text @param {string} word */
function invokes(text, word) {
  return new RegExp(`(?:^|[\\s;|&(\`$])${word}(?=[\\s'"]|$)`).test(text);
}

/**
 * The exception kind this command both COULD have raised and DID print, or null.
 * @param {string} command @param {string} output
 */
export function maskedException(command, output) {
  if (!command.trim() || !output.trim()) return null;
  for (const { kind, signature, runners } of EXCEPTIONS) {
    if (!signature.test(output)) continue;
    if (runners.some((word) => invokes(command, word))) return kind;
  }
  return null;
}

/**
 * True when the INTERPRETER'S OWN invocation is piped into a reader — the distinction that decides
 * which masking channel to name, and which a whole-command test gets wrong. The call this hook was
 * built from ends `sed -n '…' file | tail -6`, so the command does contain a pipe; but the step that
 * died was an unpiped `python3` heredoc three lines earlier, and the status came from the block's last
 * command. Scoped to the line that invokes the runner, so each channel is attributed to the right one.
 * @param {string} command @param {string} kind
 */
export function pipedThroughReader(command, kind) {
  const runners = EXCEPTIONS.find((e) => e.kind === kind)?.runners ?? [];
  const line = command.split('\n').find((l) => runners.some((word) => invokes(l, word)));
  return line !== undefined && READER_STAGE.test(line);
}

/**
 * The combined stdout+stderr of a SUCCEEDING Bash call, or null when the result is anything else.
 *
 * Shapes verified against this machine's transcripts and a live control (2026-08-01): a zero exit
 * records an object `{stdout, stderr, interrupted, …}`, while a non-zero exit records the plain string
 * `"Error: Exit code N\n<output>"` and sets `is_error`. Anything not presenting as the success object —
 * a string, a missing `stdout`, a future shape — is left alone.
 * @param {unknown} response
 */
export function succeedingOutput(response) {
  if (typeof response !== 'object' || response === null) return null;
  const r = /** @type {Record<string, any>} */ (response);
  // agent-bind.mjs shows the harness sometimes nests the payload one level down.
  const body = typeof r.toolUseResult === 'object' && r.toolUseResult !== null ? r.toolUseResult : r;
  if (typeof body.stdout !== 'string') return null;
  if (body.interrupted === true) return null;
  const text = `${body.stdout}\n${typeof body.stderr === 'string' ? body.stderr : ''}`;
  // Belt and braces: were a failure ever to arrive in the success shape, the harness has already said
  // "Exit code N" and the worker does not need telling twice.
  if (/^(?:Error: )?Exit code \d+\b/.test(text.trimStart())) return null;
  return text;
}

/**
 * True when the worker is already attending to this failure, so a reminder would be noise.
 *
 * `$?` is deliberately NOT a blanket exemption. Reading it after a pipeline captures the READER's
 * status, not the program's — `npm test | tail; echo "EXIT=$?"` prints `EXIT=0` over a red suite, which
 * is the trap itself rather than an escape from it. So exit-code plumbing counts as attending only when
 * the failing program was not piped into a reader first.
 * @param {string} command @param {string} kind
 */
export function alreadyAttended(command, kind) {
  if (HUNTS_THE_ERROR.test(command)) return true;
  return /\$\?/.test(command) && !pipedThroughReader(command, kind);
}

/** @param {string} kind @param {boolean} piped */
function reminder(kind, piped) {
  const channel = piped
    ? 'the shell took this pipeline\'s status from its LAST STAGE — the pager/filter you piped into, which succeeded at reading — not from the command that threw'
    : 'a shell block\'s exit status is only its LAST command\'s, so the status came from a later step while this one died';
  return (
    `⚠️ This command reported success, but its output contains an unhandled ${kind} exception: ${channel}. ` +
    `The harness, this tool result and the Fray card all read "done" anyway.\n\n` +
    `So whatever that step was responsible for — an edit, a build, a fetch, a write — did NOT happen, and ` +
    `any later step that looked like it passed may have run against the unchanged input. Verify the intended ` +
    `EFFECT before you build on this: re-read the file, or re-run the failing part on its own. ` +
    (piped
      ? 'To see the real status next time, redirect instead of piping — `cmd > /tmp/out.log 2>&1; echo "EXIT=$?"` — or read `${PIPESTATUS[0]}`.'
      : 'To make the next one visible, chain the steps with `&&` or open the block with `set -e`.')
  );
}

export function evaluateBashSilentFailureHook(input, env = process.env) {
  if (!String(env.FRAY_UI_THREAD ?? '').trim()) return {};
  if (typeof input !== 'object' || input === null) return {};
  const command = String(input.tool_input?.command ?? '');
  // `is_error` is the harness's own verdict; where it is set the failure is already loud.
  if (input.is_error === true || input.tool_response?.is_error === true) return {};
  const output = succeedingOutput(input.tool_response);
  if (output === null) return {};
  const kind = maskedException(command, output);
  if (!kind || alreadyAttended(command, kind)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: reminder(kind, pipedThroughReader(command, kind)),
    },
  };
}

export function isDirectHookExecution(argv1, moduleUrl) {
  return typeof argv1 === 'string'
    && basename(argv1) === 'bash-silent-failure.mjs'
    && pathToFileURL(argv1).href === moduleUrl;
}

// Same guard as bash-background.mjs: the server bundles this module, and esbuild rewrites
// `import.meta.url` to the bundle URL, so URL equality alone would mistake the whole server for this
// executable and block startup reading hook JSON from stdin.
if (isDirectHookExecution(process.argv[1], import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(evaluateBashSilentFailureHook(JSON.parse(readFileSync(0, 'utf8')))));
  } catch {
    process.stdout.write('{}');
  }
  process.exit(0);
}
