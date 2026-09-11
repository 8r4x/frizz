import type { CodexModel } from "@frizz/shared"

// The Settings "Context window" presets for Codex, built from the catalogue's OWN numbers rather than a
// round ladder. The first cut offered 400K / 600K / 800K / 1M, and none of those is a number codex runs
// at: the window is clamped to the model's `max_context_window` (872K on GPT-5.6), so "1M" ran at 872K
// and "800K" was simply a smaller version of the same cap (maintainer 2026-09-11: "have the Codex
// dropdown reflect the actual numbers. There's no need for them to be multiples of 100k").
//
// So the ladder is exactly the set of maxima that RAISE at least one listed model above its stock
// window — one option per distinct value, each naming the models it is the maximum for. A model whose
// two numbers coincide (Spark at 128K, GPT-5.5 at 272K) contributes nothing: there is no value that
// would change what it runs at. "Model default" always leads and stores nothing (the key is unset), so
// an untouched install sends codex no override.
//
// A stored value that is none of these (a number typed at the RPC, or a preset from before the ladder
// was catalogue-driven) is appended as its own option so the select never renders blank.

export const CODEX_CONTEXT_WINDOW_DEFAULT = "default"

export interface CodexContextWindowOption {
  value: string
  label: string
}

// 272000 → "272K", 872000 → "872K", 1000000 → "1M", 1250000 → "1.25M". Whole thousands are what the
// catalogue carries; the decimal survives only when the value is not a round number of thousands.
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `${trim(n / 1_000)}K`
  return String(n)
}

function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

// The catalogue as shipped in the fallback (or before the window fields existed) carries no numbers at
// all. Rather than a drawer with nothing to raise, offer the one maximum measured on 2026-09-11 so the
// control still works; the label says what it is.
const FALLBACK_LADDER: readonly { value: number; models: readonly string[] }[] = [{ value: 872_000, models: [] }]

export function codexContextWindowOptions(models: readonly CodexModel[] | undefined, stored: number | undefined): CodexContextWindowOption[] {
  const listed = models ?? []
  // The default model (index 0 = codex's own priority 1) names the number "Model default" runs at.
  const lead = listed.find((m) => m.contextWindow !== undefined)
  const defaultLabel = lead ? `Model default (${formatTokens(lead.contextWindow!)} on ${lead.displayName})` : "Model default"

  const raises = new Map<number, string[]>()
  for (const m of listed) {
    if (m.maxContextWindow === undefined || m.contextWindow === undefined) continue
    if (m.maxContextWindow <= m.contextWindow) continue
    raises.set(m.maxContextWindow, [...(raises.get(m.maxContextWindow) ?? []), m.displayName])
  }
  const ladder = raises.size
    ? [...raises.entries()].sort((a, b) => a[0] - b[0]).map(([value, names]) => ({ value, models: names }))
    : FALLBACK_LADDER

  const options: CodexContextWindowOption[] = [{ value: CODEX_CONTEXT_WINDOW_DEFAULT, label: defaultLabel }]
  for (const step of ladder) {
    // One raise shared by every raisable model is simply "the maximum"; several distinct maxima name
    // their models so the reader knows which one a given number applies to.
    const suffix = ladder.length === 1 || step.models.length === 0 ? "model maximum" : `${step.models.join(", ")} maximum`
    options.push({ value: String(step.value), label: `${formatTokens(step.value)} tokens (${suffix})` })
  }
  if (stored !== undefined && !options.some((o) => o.value === String(stored))) {
    options.push({ value: String(stored), label: `${formatTokens(stored)} tokens` })
  }
  return options
}
