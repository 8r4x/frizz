import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkerPrompt } from "./workerPrompt.ts"

test("both worker backends receive the gerund activity-caption contract", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /Phrase every tool activity description as a concise sentence-case present-participle gerund/)
    assert.match(prompt, /Reading src\/config\.ts/)
    assert.match(prompt, /do not use a completed-action phrase/)
  }
})
