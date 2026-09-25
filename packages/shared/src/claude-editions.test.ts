import assert from "node:assert/strict"
import test from "node:test"
import { claudeEditionIsNewer, parseClaudeWireId } from "./claude-editions.ts"

test("a wire id parses to family + edition; a date snapshot and a 1M suffix are not editions", () => {
  assert.deepEqual(parseClaudeWireId("claude-opus-5-5[1m]"), { alias: "opus", edition: "5.5", resolvedModel: "claude-opus-5-5" })
  assert.deepEqual(parseClaudeWireId("claude-haiku-4-5-20251001"), { alias: "haiku", edition: "4.5", resolvedModel: "claude-haiku-4-5-20251001" })
  assert.deepEqual(parseClaudeWireId("claude-sonnet-5"), { alias: "sonnet", edition: "5", resolvedModel: "claude-sonnet-5" })
  assert.equal(parseClaudeWireId("claude-3-7-sonnet-20250219"), undefined)
  assert.equal(parseClaudeWireId("opus"), undefined)
  assert.equal(parseClaudeWireId("gpt-6-astra"), undefined)
})

test("editions compare numerically per segment, and only a strictly newer one counts", () => {
  assert.equal(claudeEditionIsNewer("5.5", "5"), true)
  assert.equal(claudeEditionIsNewer("5.10", "5.9"), true)
  assert.equal(claudeEditionIsNewer("6", "5.5"), true)
  assert.equal(claudeEditionIsNewer("5", "5.0"), false)
  assert.equal(claudeEditionIsNewer("5.5", "5.5"), false)
  assert.equal(claudeEditionIsNewer("5", "5.5"), false)
  // Unreadable is never "newer": an upgrade is only ever offered on two editions that both parsed.
  assert.equal(claudeEditionIsNewer("5.x", "5"), false)
})
