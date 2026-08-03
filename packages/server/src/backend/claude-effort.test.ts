import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CLAUDE_ULTRACODE,
  claudeModelSupportsUltracode,
  claudeUltracodeFlags,
  claudeUltracodeSettings,
  resolveClaudeEffort,
} from "./claude-effort.ts"

test("ordinary effort levels pass through untouched and carry no settings blob", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const resolved = resolveClaudeEffort(effort)
    assert.deepEqual(resolved, { effort, ultracode: false })
    assert.deepEqual(claudeUltracodeFlags(resolved), [], "a normal dispatch must not gain a --settings flag")
  }
  assert.deepEqual(resolveClaudeEffort(undefined), { effort: undefined, ultracode: false })
})

test("ultracode resolves to xhigh PLUS the session setting, never one without the other", () => {
  const resolved = resolveClaudeEffort(CLAUDE_ULTRACODE)
  // Both halves are load-bearing. Claude's effort resolver reads the launch effort BEFORE it consults
  // settings.ultracode, so a launch effort of anything but xhigh silently discards the setting —
  // measured on claude 2.1.220: `--effort high --settings '{"ultracode":true}'` reports ultracode OFF.
  assert.equal(resolved.effort, "xhigh", "ultracode must pin xhigh or the setting is silently ignored")
  assert.equal(resolved.ultracode, true)
  // And "ultracode" must never reach --effort itself: the CLI's ladder stops at max and warns on
  // anything else ("Unknown --effort value … using the default effort").
  assert.notEqual(resolved.effort, CLAUDE_ULTRACODE)
})

test("the ultracode argv fragment is the settings flag the CLI actually accepts", () => {
  assert.deepEqual(
    claudeUltracodeFlags(resolveClaudeEffort(CLAUDE_ULTRACODE)),
    ["--settings", '{"ultracode":true}'],
  )
  assert.deepEqual(claudeUltracodeSettings(), { ultracode: true })
})

test("ultracode is gated to the xhigh-capable models", () => {
  for (const model of ["fable", "opus", "sonnet"]) {
    assert.equal(claudeModelSupportsUltracode(model), true, `${model} is xhigh-capable`)
  }
  // Measured: `--model haiku --settings '{"ultracode":true}'` reports ultracode OFF rather than
  // erroring, so offering the rung there would be a silent no-op in the UI.
  assert.equal(claudeModelSupportsUltracode("haiku"), false)
  assert.equal(claudeModelSupportsUltracode(undefined), false)
  assert.equal(claudeModelSupportsUltracode(""), false)
})
