import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseCodexModelsCache, readCodexModels, CODEX_MODELS_FALLBACK } from "./codex-models.ts"

// A REAL snippet of ~/.codex/models_cache.json (codex-cli 0.144.1, fields verbatim; the gpt-6-astra
// entry is the codex-cli 0.153.2 bundled shape, 2026-09-04). Deliberately includes: per-model effort
// sets (astra/sol → …/ultra, luna → …/max, 5.5 → …/xhigh), OUT-OF-ORDER priorities (5.5 before sol,
// astra LAST in the array but priority 1) to prove the ascending sort, a hidden model (codex-auto-review)
// to prove the visibility filter drops it, an api=false-but-listed model (spark) to prove it is KEPT
// (frizz spawns the TUI, not the Responses API), and the newer sidecar fields astra ships with
// (`minimal_client_version`, `service_tiers`, `additional_speed_tiers`) to prove the parser ignores
// them rather than tripping on them. Otherwise trimmed of the fat sidecar fields the parser ignores.
const REAL_CACHE = JSON.stringify({
  fetched_at: "2026-07-12T16:21:05.012098Z",
  etag: 'W/"db2a6dc50b1d003969cdc236274e488a"',
  client_version: "0.144.1",
  models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 7,
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
        { effort: "max", description: "" },
        { effort: "ultra", description: "" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 2,
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
        { effort: "max", description: "" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 3,
    },
    {
      slug: "gpt-5.3-codex-spark",
      display_name: "GPT-5.3-Codex-Spark",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
      ],
      visibility: "list",
      supported_in_api: false,
      priority: 26,
    },
    {
      slug: "codex-auto-review",
      display_name: "Codex Auto Review",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low", description: "" }],
      visibility: "hide",
      supported_in_api: true,
      priority: 43,
    },
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Our most capable model for complex, demanding work.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      visibility: "list",
      minimal_client_version: "0.153.0",
      supported_in_api: true,
      priority: 1,
      default_service_tier: null,
      service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
      additional_speed_tiers: ["fast"],
    },
  ],
})

test("parseCodexModelsCache: lists visible models priority-ASC with EXACT per-model effort sets", () => {
  const models = parseCodexModelsCache(REAL_CACHE)
  // codex-auto-review (visibility:hide) is dropped; the rest are priority-ascending (astra=1, sol=2, luna=3, 5.5=7, spark=26).
  assert.deepEqual(models.map((m) => m.slug), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"])
  const bySlug = Object.fromEntries(models.map((m) => [m.slug, m]))
  // Per-model efforts are the crux of the fix: astra and sol go to ultra, luna to max, 5.5 stops at xhigh.
  assert.deepEqual(bySlug["gpt-6-astra"]!.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"])
  // Astra's catalogue default is `low`, and the parser mirrors it rather than assuming `medium`.
  assert.equal(bySlug["gpt-6-astra"]!.defaultEffort, "low")
  assert.equal(bySlug["gpt-6-astra"]!.displayName, "GPT-6-Astra")
  assert.deepEqual(bySlug["gpt-5.6-sol"]!.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"])
  assert.deepEqual(bySlug["gpt-5.6-luna"]!.efforts, ["low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(bySlug["gpt-5.5"]!.efforts, ["low", "medium", "high", "xhigh"])
  assert.equal(bySlug["gpt-5.6-sol"]!.displayName, "GPT-5.6-Sol")
  assert.equal(bySlug["gpt-5.6-sol"]!.defaultEffort, "medium")
  // An api=false model is TUI-selectable (frizz spawns the TUI) — kept, not filtered.
  assert.ok(bySlug["gpt-5.3-codex-spark"])
})

test("parseCodexModelsCache: default effort falls back to the first supported level when absent/unsupported", () => {
  const raw = JSON.stringify({
    models: [
      // No default_reasoning_level → first supported (low).
      { slug: "m1", display_name: "M1", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], visibility: "list", priority: 1 },
      // default not in the supported set → first supported (medium), not the bogus value.
      { slug: "m2", display_name: "M2", default_reasoning_level: "bogus", supported_reasoning_levels: [{ effort: "medium" }], visibility: "list", priority: 2 },
    ],
  })
  const models = parseCodexModelsCache(raw)
  assert.equal(models.find((m) => m.slug === "m1")!.defaultEffort, "low")
  assert.equal(models.find((m) => m.slug === "m2")!.defaultEffort, "medium")
})

test("parseCodexModelsCache: malformed JSON, no models array, or all-dropped entries → the fallback", () => {
  assert.deepEqual(parseCodexModelsCache("{not json"), CODEX_MODELS_FALLBACK)
  assert.deepEqual(parseCodexModelsCache(JSON.stringify({ etag: "x" })), CODEX_MODELS_FALLBACK) // no models array
  assert.deepEqual(parseCodexModelsCache(JSON.stringify({ models: "nope" })), CODEX_MODELS_FALLBACK)
  // Every entry is unusable (hidden / no slug / no efforts) → nothing survives → fallback (never empty).
  const allBad = JSON.stringify({
    models: [
      { slug: "hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
      { display_name: "no slug", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "no-efforts", visibility: "list", supported_reasoning_levels: [] },
    ],
  })
  assert.deepEqual(parseCodexModelsCache(allBad), CODEX_MODELS_FALLBACK)
})

test("parseCodexModelsCache: a malformed entry is SKIPPED but good siblings survive", () => {
  const raw = JSON.stringify({
    models: [
      { slug: "good", display_name: "Good", supported_reasoning_levels: [{ effort: "low" }], visibility: "list", priority: 5 },
      { slug: 42, visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }, // slug not a string → skipped
      "junk",
      null,
    ],
  })
  assert.deepEqual(parseCodexModelsCache(raw).map((m) => m.slug), ["good"])
})

test("readCodexModels: reads a real cache from CODEX_HOME; a MISSING cache degrades to the fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-models-"))
  try {
    // Missing cache file → fallback (never throws).
    assert.deepEqual(readCodexModels(home), CODEX_MODELS_FALLBACK)
    // Write the real cache; a DISTINCT home dodges the module-level TTL memo (keyed on path).
    const home2 = mkdtempSync(join(tmpdir(), "codex-models-"))
    mkdirSync(home2, { recursive: true })
    writeFileSync(join(home2, "models_cache.json"), REAL_CACHE)
    assert.deepEqual(readCodexModels(home2).map((m) => m.slug), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"])
    rmSync(home2, { recursive: true, force: true })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
