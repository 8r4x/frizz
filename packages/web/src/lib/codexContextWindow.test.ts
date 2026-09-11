import assert from "node:assert/strict"
import test from "node:test"
import type { CodexModel } from "@frizz/shared"
import { CODEX_CONTEXT_WINDOW_DEFAULT, codexContextWindowOptions, formatTokens } from "./codexContextWindow.ts"

const model = (slug: string, displayName: string, contextWindow?: number, maxContextWindow?: number): CodexModel => ({
  slug, displayName, defaultEffort: "medium", efforts: ["medium"],
  ...(contextWindow === undefined ? {} : { contextWindow }),
  ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
})

// The catalogue on 2026-09-11 (codex-cli 0.153.2), in codex's own priority order.
const CATALOGUE: CodexModel[] = [
  model("gpt-6-astra", "GPT-6-Astra", 272_000, 872_000),
  model("gpt-5.6-sol", "GPT-5.6-Sol", 272_000, 872_000),
  model("gpt-5.6-terra", "GPT-5.6-Terra", 272_000, 872_000),
  model("gpt-5.6-luna", "GPT-5.6-Luna", 272_000, 872_000),
  model("gpt-5.5", "GPT-5.5", 272_000, 272_000),
  model("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", 128_000, 128_000),
]

test("the presets are the catalogue's own numbers: the default model's stock window, then each maximum that raises something", () => {
  assert.deepEqual(codexContextWindowOptions(CATALOGUE, undefined), [
    { value: CODEX_CONTEXT_WINDOW_DEFAULT, label: "Model default (272K on GPT-6-Astra)" },
    { value: "872000", label: "872K tokens (model maximum)" },
  ])
  // No 400K / 600K / 800K / 1M: nothing in the catalogue runs at those.
  assert.ok(!codexContextWindowOptions(CATALOGUE, undefined).some((o) => /^(400|600|800)K|1M/.test(o.label)))
})

test("a model whose maximum equals its stock window contributes no preset — a raise would change nothing for it", () => {
  const opts = codexContextWindowOptions([model("gpt-5.5", "GPT-5.5", 272_000, 272_000), model("spark", "Spark", 128_000, 128_000)], undefined)
  // Nothing raisable ⇒ the measured 872K fallback keeps the control usable, labelled as the maximum.
  assert.deepEqual(opts.map((o) => o.value), [CODEX_CONTEXT_WINDOW_DEFAULT, "872000"])
  assert.equal(opts[0]!.label, "Model default (272K on GPT-5.5)")
})

test("several distinct maxima each name the models they apply to", () => {
  const opts = codexContextWindowOptions([
    model("a", "Alpha", 272_000, 872_000),
    model("b", "Beta", 272_000, 1_000_000),
    model("c", "Gamma", 272_000, 872_000),
  ], undefined)
  assert.deepEqual(opts.slice(1), [
    { value: "872000", label: "872K tokens (Alpha, Gamma maximum)" },
    { value: "1000000", label: "1M tokens (Beta maximum)" },
  ])
})

test("no catalogue numbers at all (the fallback model, or an old cache) still offers the default and the measured maximum", () => {
  assert.deepEqual(codexContextWindowOptions([model("gpt-5.5", "GPT-5.5")], undefined), [
    { value: CODEX_CONTEXT_WINDOW_DEFAULT, label: "Model default" },
    { value: "872000", label: "872K tokens (model maximum)" },
  ])
  assert.deepEqual(codexContextWindowOptions(undefined, undefined).map((o) => o.value), [CODEX_CONTEXT_WINDOW_DEFAULT, "872000"])
})

test("a stored value outside the ladder is appended so the select never renders blank", () => {
  const opts = codexContextWindowOptions(CATALOGUE, 600_000)
  assert.deepEqual(opts.at(-1), { value: "600000", label: "600K tokens" })
  // …but a stored value that IS a preset is not duplicated.
  assert.equal(codexContextWindowOptions(CATALOGUE, 872_000).length, 2)
})

test("formatTokens spells the catalogue's numbers the way the dial does", () => {
  assert.equal(formatTokens(272_000), "272K")
  assert.equal(formatTokens(872_000), "872K")
  assert.equal(formatTokens(1_000_000), "1M")
  assert.equal(formatTokens(1_250_000), "1.25M")
  assert.equal(formatTokens(258_400), "258.4K")
  assert.equal(formatTokens(950), "950")
})
