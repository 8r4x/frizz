import assert from "node:assert/strict"
import test from "node:test"
import { agentProfileLabel, parseAgentProfile } from "./agentProfile.ts"

test("a fray worker-profile cell reads as its model + effort", () => {
  assert.deepEqual(parseAgentProfile("fray:opus-high"), { model: "opus", effort: "high" })
  assert.deepEqual(parseAgentProfile("fray:sonnet-xhigh"), { model: "sonnet", effort: "xhigh" })
  assert.deepEqual(parseAgentProfile("fray:fable-max"), { model: "fable", effort: "max" })
  assert.equal(agentProfileLabel("fray:opus-high"), "opus › high")
})

test("the older doubled fray:fray- namespace still resolves to the same pair", () => {
  // Live transcripts still carry this shape; a "fray-opus" model would be a visible regression.
  assert.deepEqual(parseAgentProfile("fray:fray-opus-high"), { model: "opus", effort: "high" })
  assert.equal(agentProfileLabel("fray:fray-sonnet-medium"), "sonnet › medium")
})

test("a profile with no effort axis names the model alone", () => {
  assert.deepEqual(parseAgentProfile("fray:haiku"), { model: "haiku" })
  assert.equal(agentProfileLabel("fray:haiku"), "haiku")
})

test("an unrecognized trailing segment stays part of the model, never a fabricated effort", () => {
  // A profile fray adds later ("fray:opus-turbo") must degrade to a readable model, not mis-split.
  assert.deepEqual(parseAgentProfile("fray:opus-turbo"), { model: "opus-turbo" })
})

test("a codex cell reads through its slash, dropping the agent-type word", () => {
  // describeCell() in server/src/codex-subagents.ts builds both of these.
  assert.deepEqual(parseAgentProfile("gpt-5.6-sol/high"), { model: "gpt-5.6-sol", effort: "high" })
  assert.deepEqual(parseAgentProfile("worker gpt-5.6-terra/medium"), { model: "gpt-5.6-terra", effort: "medium" })
  assert.equal(agentProfileLabel("worker gpt-5.6-terra/medium"), "gpt-5.6-terra › medium")
})

test("a named agent type carries no profile, so none is invented", () => {
  // These are real Claude subagent_type values. Guessing a model for them would be worse than silence.
  for (const type of ["general-purpose", "Explore", "Plan", "claude-code-guide", "statusline-setup"]) {
    assert.deepEqual(parseAgentProfile(type), {}, type)
    assert.equal(agentProfileLabel(type), undefined, type)
  }
})

test("an absent or blank subagent_type yields no tag", () => {
  assert.deepEqual(parseAgentProfile(undefined), {})
  assert.deepEqual(parseAgentProfile("   "), {})
  assert.deepEqual(parseAgentProfile("fray:"), {})
  assert.equal(agentProfileLabel(undefined), undefined)
  assert.equal(agentProfileLabel("fray:"), undefined)
})
