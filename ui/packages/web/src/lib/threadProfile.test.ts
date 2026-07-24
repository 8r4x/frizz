import { test } from "node:test"
import assert from "node:assert/strict"
import {
  selectThreadProfileTarget,
  threadProfileControlState,
  threadProfileEffectMessage,
  threadProfileLabel,
} from "./threadProfile.ts"

test("threadProfileLabel: shows the pinned model and effort compactly", () => {
  assert.equal(threadProfileLabel("opus", "high"), "opus · high")
  assert.equal(threadProfileLabel("gpt-5.6-sol", "ultra"), "gpt-5.6-sol · ultra")
})

test("threadProfileLabel: degrades cleanly for partial and legacy/unknown profiles", () => {
  assert.equal(threadProfileLabel("claude-fable-5", undefined), "claude-fable-5")
  assert.equal(threadProfileLabel(undefined, "high"), "high effort")
  assert.equal(threadProfileLabel("  ", ""), null)
  assert.equal(threadProfileLabel(undefined, undefined), null)
})

test("selectThreadProfileTarget: emits one complete supported pair and fails closed", () => {
  const options = [
    { model: "sonnet", efforts: ["low", "high"], defaultEffort: "high" },
    { model: "opus", efforts: ["high", "max"], defaultEffort: "max" },
  ]
  assert.deepEqual(selectThreadProfileTarget(options, "high", "opus"), { model: "opus", effort: "high" })
  assert.deepEqual(selectThreadProfileTarget(options, "low", "opus"), { model: "opus", effort: "max" })
  assert.equal(selectThreadProfileTarget(options, "high", "unknown"), null)
  assert.equal(selectThreadProfileTarget([{ model: "broken", efforts: ["high"], defaultEffort: "max" }], "low", "broken"), null)
})

test("threadProfileControlState: exited legacy profiles can be repaired without opening an invalid effort", () => {
  const options = [
    { model: "sonnet", efforts: ["low", "high"], defaultEffort: "high" },
    { model: "opus", efforts: ["high", "max"], defaultEffort: "max" },
  ]
  assert.deepEqual(
    threadProfileControlState(options, "retired-model", "retired-effort", true),
    {
      selectedProfile: undefined,
      modelKnown: false,
      effortKnown: false,
      profileKnown: false,
      modelSelectable: true,
      effortSelectable: false,
    },
  )
  const retiredEffort = threadProfileControlState(options, "sonnet", "retired-effort", true)
  assert.equal(retiredEffort.modelSelectable, true)
  assert.equal(retiredEffort.effortSelectable, true)
  assert.equal(retiredEffort.modelKnown, true)
  assert.equal(retiredEffort.effortKnown, false)
})

test("threadProfileControlState: a live thread with an unknown model stays fail closed", () => {
  const options = [{ model: "sonnet", efforts: ["low", "high"], defaultEffort: "high" }]
  const unknownModel = threadProfileControlState(options, "retired-model", "high", false)
  assert.equal(unknownModel.modelSelectable, false)
  assert.equal(unknownModel.effortSelectable, false)
})

test("threadProfileControlState: a live thread with a known model but unknown effort can be re-profiled", () => {
  // The common Claude case: model is recorded in the transcript, launch effort never was. The model
  // may still be re-selected (every committed pair is complete + validated), while effort-only editing
  // stays gated on the full pair being known.
  const options = [{ model: "sonnet", efforts: ["low", "high"], defaultEffort: "high" }]
  const unknownEffort = threadProfileControlState(options, "sonnet", "retired-effort", false)
  assert.equal(unknownEffort.modelKnown, true)
  assert.equal(unknownEffort.effortKnown, false)
  assert.equal(unknownEffort.modelSelectable, true)
  assert.equal(unknownEffort.effortSelectable, false)

  const known = threadProfileControlState(options, "sonnet", "high", false)
  assert.equal(known.modelSelectable, true)
  assert.equal(known.effortSelectable, true)
})

test("threadProfileEffectMessage: distinguishes a queued Claude handoff from Codex next-turn settings", () => {
  assert.equal(threadProfileEffectMessage("applied"), "Model and effort applied")
  assert.equal(
    threadProfileEffectMessage("queued"),
    "Model and effort queued — applies after the current work finishes",
  )
  assert.equal(
    threadProfileEffectMessage("next-turn"),
    "Model and effort applied — takes effect on the next turn",
  )
  assert.equal(threadProfileEffectMessage("next-resume"), "Model and effort saved for the next resume")
})
