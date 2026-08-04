import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../cc-worker/hooks/agent-dispatch.mjs")

function decision(toolInput: Record<string, unknown>, worker = true): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: worker ? "thread-under-test" : "" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

function output(toolInput: Record<string, unknown>, worker = true): Record<string, any> {
  return decision(toolInput, worker).hookSpecificOutput ?? {}
}

const dispatch = { prompt: "Survey the dev server readouts.", run_in_background: true }

test("Agent dispatch hook denies foreground sub-agents", () => {
  for (const input of [
    { prompt: "p" },
    { prompt: "p", run_in_background: false },
    { prompt: "p", run_in_background: "true" },
  ]) {
    const denied = output(input)
    assert.equal(denied.permissionDecision, "deny", JSON.stringify(input))
    assert.match(denied.permissionDecisionReason, /run_in_background:true/)
  }
})

test("Agent dispatch hook strips name and team_name, which strand a nested dispatch", () => {
  const updated = output({ ...dispatch, name: "researcher", team_name: "research" }).updatedInput
  assert.equal(updated.name, undefined)
  assert.equal(updated.team_name, undefined)
  assert.equal(updated.run_in_background, true)
})

test("Agent dispatch hook appends the orchestration epilogue exactly once", () => {
  const once = output(dispatch).updatedInput.prompt as string
  assert.ok(once.startsWith(dispatch.prompt))
  assert.equal(once.match(/ORCHESTRATION EPILOGUE/g)?.length, 1)
  // Idempotence is "already ENDS WITH the epilogue" — a prompt that merely QUOTES the marker
  // (a worker asking a helper whether the epilogue arrived) must still get its own copy.
  assert.equal(output({ ...dispatch, prompt: once }).updatedInput.prompt, once)
  const quoting = output({ ...dispatch, prompt: "Report whether the ORCHESTRATION EPILOGUE reached you." })
  assert.equal((quoting.updatedInput.prompt as string).match(/ORCHESTRATION EPILOGUE/g)?.length, 2)
})

// The regression this hook's nested-dispatch paragraph exists for: a depth-1 helper backgrounded its
// own helper, hand-rolled a `stat`-based wait over the `.output` path — which is a SYMLINK, so the
// size/mtime it read were the LINK's, frozen forever — declared a live 413KB agent dead, and redid
// its work. The frizz worker contract never reaches a depth-1 helper, so this epilogue is the only
// place that can tell it how to collect a helper of its own.
// Nesting is DEFAULT-OFF. The conditional phrasing this replaced ("if you dispatch a helper of your
// own…") read as neutral permission, so a helper could fan out again purely because it could.
test("Agent dispatch hook tells every helper not to fan out unless its prompt asked", () => {
  const prompt = output(dispatch).updatedInput.prompt as string
  assert.match(prompt, /do NOT dispatch sub-agents of your own unless your dispatch prompt explicitly tells you to/)
  assert.match(prompt, /already one prong of someone else's fan-out/)
  assert.match(prompt, /still yours to work through in your own turn/)
})

test("Agent dispatch hook tells every helper how to collect a helper of its own", () => {
  const prompt = output(dispatch).updatedInput.prompt as string
  assert.match(prompt, /If your prompt DOES ask you to dispatch a helper/)
  assert.match(prompt, /completion is delivered to you automatically/)
  assert.match(prompt, /Never hand-roll a wait loop/)
  assert.match(prompt, /SYMLINK/)
  assert.match(prompt, /"type":"result". record is not reliably written/)
  assert.match(prompt, /discard live work and redo it/)
  assert.match(prompt, /description. naming its narrower slice/)
})

test("Agent dispatch hook keeps the handoff, scratchpad and upward-channel coordination", () => {
  const prompt = output(dispatch).updatedInput.prompt as string
  assert.match(prompt, /Your final message is the handoff/)
  assert.match(prompt, /never delete, truncate, reinitialize, move, or replace the whole file/i)
  assert.match(prompt, /SendMessage\(\{to: "main"/)
})

test("Agent dispatch hook is inert outside a frizz worker session", () => {
  assert.deepEqual(decision(dispatch, false), {})
  assert.deepEqual(decision({ prompt: "p" }, false), {})
})

test("Agent dispatch hook fails open on unparseable input", () => {
  const result = spawnSync(process.execPath, [hook], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, FRIZZ_THREAD: "thread-under-test" },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout || "{}"), {})
})
