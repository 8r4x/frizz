import assert from "node:assert/strict"
import test from "node:test"
import { subAgentProfileLabel } from "./subAgentProfile.ts"

test("sub-agent profile readout formats provider cells without inventing missing values", () => {
  assert.equal(subAgentProfileLabel("fray:opus-high"), "opus › high")
  assert.equal(subAgentProfileLabel("fray:fray-sonnet-medium"), "sonnet › medium")
  assert.equal(subAgentProfileLabel("fray:haiku"), "haiku")
  assert.equal(subAgentProfileLabel("explorer gpt-5.6-terra/high"), "explorer · gpt-5.6-terra › high")
  assert.equal(subAgentProfileLabel("gpt-5.6-sol/ultra"), "gpt-5.6-sol › ultra")
  assert.equal(subAgentProfileLabel("general-purpose"), "general-purpose")
  assert.equal(subAgentProfileLabel(), "Profile unknown")
})
