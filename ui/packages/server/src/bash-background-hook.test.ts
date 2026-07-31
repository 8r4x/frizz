import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../../cc-worker/hooks/bash-background.mjs")

function decision(command: string, worker = true): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, FRAY_UI_THREAD: worker ? "thread-under-test" : "" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

function denied(command: string): boolean {
  return decision(command).hookSpecificOutput?.permissionDecision === "deny"
}

test("Bash background hook denies shell jobs that escape Claude's task registry", () => {
  for (const command of [
    "cargo test > /tmp/test.log 2>&1 &",
    "(nub scripts/remote-build.ts --job test > /tmp/f3.log 2>&1) &\nsleep 2; echo build started",
    "nohup nub scripts/ci-watch.ts --pr 587 > /tmp/ci.log 2>&1 & echo watcher started",
    "server & disown",
  ]) assert.equal(denied(command), true, command)
})

test("Bash background hook preserves self-contained concurrency and non-job ampersands", () => {
  for (const command of [
    "a & b & wait",
    "server & pid=$!; curl localhost:3000; kill $pid; wait $pid",
    "server & pid=$!; trap 'kill $pid' EXIT; curl localhost:3000",
    "printf '%s\\n' '&'",
    'echo "&"',
    "echo one && echo two",
    "tool 2>&1 | tail -1",
    "ssh host 'nohup remote-job > /tmp/job.log 2>&1 &'",
    "cat > probe.sh <<'EOF'\nserver &\necho $!\nEOF",
  ]) assert.equal(denied(command), false, command)
})

test("Bash background hook is inert outside a Fray worker", () => {
  assert.deepEqual(decision("cargo test &", false), {})
})

test("Bash background denial tells the worker the tracked replacement", () => {
  const reason = decision("cargo test &").hookSpecificOutput?.permissionDecisionReason ?? ""
  assert.match(reason, /run_in_background:true/)
  assert.match(reason, /cannot track it or wake you/)
  assert.match(reason, /background Agent/)
})
