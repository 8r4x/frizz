import { test } from "node:test"
import assert from "node:assert/strict"
import type { AcpAgentModels } from "@frizz/shared"
import { acpModelOptions } from "./acpModelOptions.ts"

const advertised: AcpAgentModels = {
  agentId: "opencode",
  models: [{ id: "openai/gpt-5.5", name: "GPT-5.5" }, { id: "anthropic/claude-opus-5", name: "Claude Opus 5" }],
  current: "anthropic/claude-opus-5",
  probedAt: "2026-09-16T00:00:00.000Z",
}

test("the agent's own default leads, named after the model it opens on, then every advertised model", () => {
  const rows = acpModelOptions(advertised, undefined)
  assert.deepEqual(rows.map((row) => [row.value, row.label]), [
    ["", "Default · Claude Opus 5"],
    ["openai/gpt-5.5", "GPT-5.5"],
    ["anthropic/claude-opus-5", "Claude Opus 5"],
  ])
})

test("a saved model the agent no longer lists stays visible and reads unavailable; while unknown it is shown verbatim", () => {
  assert.deepEqual(acpModelOptions(advertised, "openai/gpt-4o").slice(0, 2).map((row) => row.label), ["Default · Claude Opus 5", "openai/gpt-4o (unavailable)"])
  assert.deepEqual(acpModelOptions(undefined, "openai/gpt-4o").map((row) => row.label), ["Default", "openai/gpt-4o"])
  const failed: AcpAgentModels = { agentId: "cursor", models: [], error: "not logged in", probedAt: advertised.probedAt }
  assert.deepEqual(acpModelOptions(failed, "gpt-5.5").map((row) => row.label), ["Default", "gpt-5.5"])
  // A saved model that IS advertised is not duplicated.
  assert.equal(acpModelOptions(advertised, "openai/gpt-5.5").filter((row) => row.value === "openai/gpt-5.5").length, 1)
})
