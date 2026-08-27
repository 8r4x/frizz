import assert from "node:assert/strict"
import test from "node:test"
import { dispatchProfileCell } from "./subagent-profile.ts"

// The dispatching turn every case below inherits from unless it names its own.
const turn = { turnModel: "claude-opus-5", turnEffort: "xhigh" }

test("an effort-only profile takes the model from the dispatch's own `model` parameter", () => {
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", model: "opus", ...turn }), "frizz:opus-high")
  assert.equal(dispatchProfileCell({ subagentType: "frizz:low", model: "haiku", ...turn }), "frizz:haiku-low")
  // The explicit model wins over the turn's, which is the whole point of naming one.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:max", model: "sonnet", ...turn }), "frizz:sonnet-max")
})

test("an omitted model is INHERITED from the dispatching turn, not left unknown", () => {
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", ...turn }), "frizz:opus-high")
  // The turn's model reads in the picker's words, not the API id.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:medium", turnModel: "claude-fable-5" }), "frizz:fable-medium")
  // …and a model id the catalogue does not know survives verbatim rather than vanishing.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", turnModel: "some-future-model" }), "frizz:some-future-model-high")
})

test("a profile that pins BOTH halves keeps them (the pre-2026-08-26 shape)", () => {
  assert.equal(dispatchProfileCell({ subagentType: "frizz:opus-high", ...turn }), "frizz:opus-high")
  assert.equal(dispatchProfileCell({ subagentType: "frizz:frizz-sonnet-medium", ...turn }), "frizz:sonnet-medium")
  // A model-only profile (the old haiku one) inherits the effort it never named.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:haiku", ...turn }), "frizz:haiku-xhigh")
})

test("a foreign agent type keeps its name and shows only what the CALL named", () => {
  assert.equal(dispatchProfileCell({ subagentType: "general-purpose", model: "opus", ...turn }), "general-purpose opus")
  // Nothing is inherited into it: `Explore`'s own definition may pin a model or effort frizz cannot
  // read, so claiming the dispatcher's would state a runtime the child never ran at.
  assert.equal(dispatchProfileCell({ subagentType: "Explore", ...turn }), "Explore")
})

test("nothing is invented when the turn recorded nothing", () => {
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high" }), "frizz:high")
  assert.equal(dispatchProfileCell({ subagentType: "general-purpose" }), "general-purpose")
  assert.equal(dispatchProfileCell({}), undefined)
  // Claude stamps `<synthetic>` on the records it fabricates itself; no child ran at that model.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", turnModel: "<synthetic>" }), "frizz:high")
  // Non-string provider fields are narrowed away rather than trusted.
  assert.equal(dispatchProfileCell({ subagentType: 7, model: {}, turnModel: null, turnEffort: [] }), undefined)
})

test("a dispatch with no profile at all still names the runtime it inherited", () => {
  assert.equal(dispatchProfileCell({ ...turn }), "frizz:opus-xhigh")
  assert.equal(dispatchProfileCell({ model: "haiku" }), "frizz:haiku")
})
