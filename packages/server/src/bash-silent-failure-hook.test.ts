import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../cc-worker/hooks/bash-silent-failure.mjs")

// The success shape a zero-exit Bash records; a NON-zero exit records the plain string
// `"Error: Exit code N\n…"` instead and sets `is_error` (verified against a live control, 2026-08-01).
function success(stdout: string, stderr = "") {
  return { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false }
}

function run(command: string, tool_response: unknown, { worker = true } = {}): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response }),
    encoding: "utf8",
    env: { ...process.env, FRAY_UI_THREAD: worker ? "thread-under-test" : "" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

function context(command: string, tool_response: unknown, opts?: { worker?: boolean }): string | undefined {
  return run(command, tool_response, opts).hookSpecificOutput?.additionalContext
}

const PY_TRACEBACK = 'Traceback (most recent call last):\n  File "<stdin>", line 22, in <module>\nAssertionError\n  selftest ok'
const NODE_STACK =
  "✖ the divider renders (0.71ms)\n  AssertionError [ERR_ASSERTION]: rail must render\n      at TestContext.<anonymous> (/repo/packages/web/src/x.test.ts:99:10)\n      at async Test.run (node:internal/test_runner/test:1389:7)"

// The call the maintainer screenshotted: a python heredoc whose `assert` blew up so the edit never
// applied, followed by two steps that ran anyway — the last of which exited 0 and set the block's status.
test("a python step that died mid-block is reported even though the block exited 0", () => {
  const command = [
    "cd /repo",
    "python3 - <<'PY'\np='search.mjs'; s=open(p).read()\nassert old in s; s = s.replace(old, new, 1)\nPY",
    'node --check search.mjs && node search.mjs --selftest >/dev/null 2>&1 && echo "  selftest ok"',
    "sed -n '/ASK NPM/,/^    };/p' search.mjs | tail -6",
  ].join("\n")
  const reminder = context(command, success(PY_TRACEBACK))
  assert.match(reminder ?? "", /unhandled Python exception/)
  assert.match(reminder ?? "", /exit status is only its LAST command's/)
  assert.match(reminder ?? "", /did NOT happen/)
})

// The corpus's single largest masking channel: 552 of 595 surviving hits pipe the failing program into
// a reader, so the shell reports the reader's status.
test("a pipeline names the reader stage as the masking channel and points at PIPESTATUS", () => {
  const reminder = context("npm test 2>&1 | tail -25", success(NODE_STACK))
  assert.match(reminder ?? "", /unhandled Node exception/)
  assert.match(reminder ?? "", /LAST STAGE/)
  assert.match(reminder ?? "", /PIPESTATUS/)
  assert.doesNotMatch(reminder ?? "", /set -e/)
})

test("the harness's own verdict is never restated", () => {
  // A non-zero exit arrives as a STRING, not the success object.
  assert.equal(context("npm test", "Error: Exit code 1\n" + NODE_STACK), undefined)
  // …and defensively, if one ever arrived in the success shape or carried the flag.
  assert.equal(context("npm test", success("Exit code 1\n" + NODE_STACK)), undefined)
  assert.equal(run("npm test", { ...success(NODE_STACK), is_error: true }).hookSpecificOutput, undefined)
})

test("an exception the command only READ is data, not a failure of that command", () => {
  for (const command of [
    "cat /var/log/app.log",
    "grep -A5 'Traceback' app.log",
    "rg --no-heading 'at TestContext' notes.md",
    "git show HEAD:crash-report.txt",
  ]) {
    assert.equal(context(command, success(PY_TRACEBACK)), undefined, command)
    assert.equal(context(command, success(NODE_STACK)), undefined, command)
  }
})

test("a worker already attending to the failure is not told about it", () => {
  // Hunting the exception on purpose.
  assert.equal(context("npx tsx --test x.test.ts 2>&1 | grep -A12 AssertionError | head -45", success(NODE_STACK)), undefined)
  // Exit-code plumbing with no reader stage between the program and the `$?`.
  assert.equal(context('node repro.mjs > /tmp/out.log 2>&1; echo "EXIT=$?"; cat /tmp/out.log', success("EXIT=1\n" + NODE_STACK)), undefined)
})

// `$?` after a pipeline reads the READER's status — `EXIT=0` over a red suite. That is the trap, not an
// escape from it, so exit-code plumbing must not exempt a piped command.
test("reading $? through a pipe is still a masked failure", () => {
  const reminder = context('npm test 2>&1 | tail -25; echo "EXIT=$?"', success(NODE_STACK + "\nEXIT=0"))
  assert.match(reminder ?? "", /LAST STAGE/)
})

test("a grep that merely filters noise does not suppress the reminder", () => {
  // `| grep -v "npm warn"` precedes genuine masked failures throughout the corpus.
  assert.match(context("npx tsx probe.mts 2>&1 | grep -v 'npm warn'", success(NODE_STACK)) ?? "", /unhandled Node exception/)
})

test("the hook is inert outside a fray worker", () => {
  assert.deepEqual(run("npm test 2>&1 | tail -25", success(NODE_STACK), { worker: false }), {})
})

test("anything but a recognized success payload is left alone", () => {
  for (const response of [null, undefined, "plain string", 42, {}, { stdout: 7 }, { ...success(NODE_STACK), interrupted: true }]) {
    assert.equal(context("npm test 2>&1 | tail -25", response), undefined, JSON.stringify(response))
  }
})

test("malformed hook input fails open rather than disturbing the turn", () => {
  const result = spawnSync(process.execPath, [hook], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, FRAY_UI_THREAD: "thread-under-test" },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout || "{}"), {})
})

test("clean output never fires, whatever the command ran", () => {
  assert.equal(context("npm test 2>&1 | tail -25", success("# tests 412\n# pass 412\n# fail 0")), undefined)
  assert.equal(context("python3 build.py", success("wrote 3 files")), undefined)
})
