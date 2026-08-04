import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDirectHookExecution } from "../../../cc-worker/hooks/bash-background.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../cc-worker/hooks/bash-background.mjs")

function decision(command: string, worker = true, extra: Record<string, unknown> = {}): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, ...extra } }),
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: worker ? "thread-under-test" : "" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

function output(command: string): Record<string, any> {
  return decision(command).hookSpecificOutput ?? {}
}

test("Bash background hook denies escaping shell jobs that bypass Claude's native task lifecycle", () => {
  for (const command of [
    "cargo test > /tmp/test.log 2>&1 &",
    "(nub scripts/remote-build.ts --job test > /tmp/f3.log 2>&1) &\nsleep 2; echo build started",
    "nohup nub scripts/ci-watch.ts --pr 587 > /tmp/ci.log 2>&1 & echo watcher started",
    "first & second & echo both-started",
  ]) {
    const denied = output(command)
    assert.equal(denied.permissionDecision, "deny", command)
    assert.match(denied.permissionDecisionReason, /cannot report completion or wake this agent/, command)
  }
})

test("Bash background hook denies escaping variants and asynchronous kill without wait", () => {
  for (const command of [
    "server & disown",
    "server & exit 0",
    "server & exec echo done",
    "(server &)",
    "server & pid=$!; kill $pid",
  ]) assert.equal(output(command).permissionDecision, "deny", command)
})

// A local wrapper forks the job and exits, so its `&` escapes exactly as a bare one does. Quoted
// regions are blanked to exempt `ssh host '… &'`, which backgrounds on the REMOTE host — that
// blanking also hid `bash -c 'job &'`, one token away from every command the guard already denies.
test("Bash background hook denies an escaping job inside a local shell wrapper", () => {
  for (const command of [
    `bash -c "nub scripts/ci-watch.ts > /tmp/ci.log 2>&1 &"`,
    "sh -c 'server &'",
    "zsh -lc 'server & echo started'",
    "/bin/sh -c 'server &'",
    "cd /tmp && bash -c 'server &'",
    `bash -c "sh -c 'server &'"`,
  ]) assert.equal(output(command).permissionDecision, "deny", command)
})

// A wrapper in ARGUMENT position belongs to the program before it, which decides where the script
// runs — the same call the `ssh` exemption makes. `xargs sh -c 'job &'` is the local form this gives
// up; the corpus never shows it, and over-blocking every containerized build would cost far more.
test("Bash background hook leaves a shell wrapper handed to another program alone", () => {
  for (const command of [
    "docker run --rm -w /src rust:1-bookworm bash -c 'cargo build &'",
    "limactl shell landlock-vm bash -lc 'df -h / | tail -1 &'",
    "ssh host bash -lc 'remote-job &'",
  ]) assert.deepEqual(decision(command), {}, command)
})

test("Bash background hook preserves self-contained concurrency and non-job ampersands", () => {
  for (const command of [
    "a & b & wait",
    "server & pid=$!; curl localhost:3000; kill $pid; wait $pid",
    "server & pid=$!; trap 'kill $pid' EXIT; curl localhost:3000",
    "printf '%s\\n' '&'",
    'echo "&"',
    `echo "--- decode: $(python3 -c 'v=851968;print(f"{v>>16}.{(v>>8)&255}.{v&255}")')"`,
    "echo one && echo two",
    "tool 2>&1 | tail -1",
    "ssh host 'nohup remote-job > /tmp/job.log 2>&1 &'",
    "ssh host 'bash -c \"remote-job &\"'",
    "cat > probe.sh <<'EOF'\nserver &\necho $!\nEOF",
    "bash -c 'a & b & wait'",
    "bash -c 'cd /tmp && for s in $(cat specs); do npm pack \"$s\"; done; echo DONE'",
    "echo 'bash -c \"server &\"' > note.txt",
  ]) assert.deepEqual(output(command), {}, command)
})

test("Bash background hook is inert outside a Frizz worker", () => {
  assert.deepEqual(decision("cargo test &", false), {})
})

test("Bash denial tells the worker the tracked replacement", () => {
  const reason = decision("cargo test & disown").hookSpecificOutput?.permissionDecisionReason ?? ""
  assert.match(reason, /^Frizz blocked an untracked shell background job/)
  assert.match(reason, /run_in_background:true/)
  assert.match(reason, /Claude task ID/)
  assert.match(reason, /finish with `wait`/)
})

test("Codex Bash denial points at the managed yield_control lifecycle", () => {
  const result = spawnSync(process.execPath, [hook, "--frizz-thread"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cargo test > /tmp/test.log 2>&1 &" },
      model: "gpt-5.6-sol",
    }),
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: "" },
  })
  assert.equal(result.status, 0, result.stderr)
  const reason = JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason ?? ""
  assert.match(reason, /yield_control\(\)/)
  assert.match(reason, /session_id.*foreground continuation/)
  assert.doesNotMatch(reason, /run_in_background/)
})

test("bundling the detector into Frizz cannot turn the server entry into the hook executable", () => {
  const serverEntry = "/artifact/runtime/src/index.js"
  assert.equal(isDirectHookExecution(serverEntry, "file:///artifact/runtime/src/index.js"), false)
  assert.equal(isDirectHookExecution(hook, pathToFileURL(hook).href), true)
})
