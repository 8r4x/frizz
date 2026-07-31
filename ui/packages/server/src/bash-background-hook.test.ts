import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isDirectHookExecution } from "../../../../cc-worker/hooks/bash-background.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../../cc-worker/hooks/bash-background.mjs")

function decision(command: string, worker = true, extra: Record<string, unknown> = {}): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, ...extra } }),
    encoding: "utf8",
    env: { ...process.env, FRAY_UI_THREAD: worker ? "thread-under-test" : "" },
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
    "cat > probe.sh <<'EOF'\nserver &\necho $!\nEOF",
  ]) assert.deepEqual(output(command), {}, command)
})

test("Bash background hook is inert outside a Fray worker", () => {
  assert.deepEqual(decision("cargo test &", false), {})
})

test("Bash denial tells the worker the tracked replacement", () => {
  const reason = decision("cargo test & disown").hookSpecificOutput?.permissionDecisionReason ?? ""
  assert.match(reason, /^Fray blocked an untracked shell background job/)
  assert.match(reason, /run_in_background:true/)
  assert.match(reason, /Claude task ID/)
  assert.match(reason, /finish with `wait`/)
})

test("bundling the detector into Fray cannot turn the server entry into the hook executable", () => {
  const serverEntry = "/artifact/runtime/src/index.js"
  assert.equal(isDirectHookExecution(serverEntry, "file:///artifact/runtime/src/index.js"), false)
  assert.equal(isDirectHookExecution(hook, pathToFileURL(hook).href), true)
})
