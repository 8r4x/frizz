import type { Backend, ThreadProfileOption } from "@frizz/shared"
import { readCodexModels } from "./codex-models.ts"
import { CLAUDE_ULTRACODE, claudeModelSupportsUltracode } from "./claude-effort.ts"

// Claude Code 2.1.207 accepts model and effort together on both a new session and --resume. Keep the
// native aliases here on the server: an existing-thread mutation must never depend on the browser's
// model-name classifier (whose historical unknown=>Claude fallback is intentionally irrelevant).
//
// "ultracode" rides the ladder as its top rung, exactly where Claude Code's own `/effort` puts it, but
// it is NOT an --effort value — claude-effort.ts translates it into (xhigh + the ultracode session
// setting) at the spawn edge. It is offered only on the xhigh-capable models, because Claude ignores
// the setting on Haiku rather than erroring (measured); see CLAUDE_ULTRACODE_MODELS.
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

/** The Claude effort ladder for one model — the ultracode rung only where the model can honour it. */
export function claudeEffortsFor(model: string): string[] {
  return claudeModelSupportsUltracode(model) ? [...CLAUDE_EFFORTS, CLAUDE_ULTRACODE] : [...CLAUDE_EFFORTS]
}

// The `[1m]` rows are the SAME models with the 1M-token context window. Claude Code parses the suffix
// client-side: `--model 'opus[1m]'` sends model=claude-opus-5 plus the `context-1m-2025-08-07` beta
// header on every /v1/messages request, where the bare alias sends no such header and the session
// auto-compacts at the 200K window (measured on claude 2.1.234 by capturing the outbound requests; the
// suffix works on the alias exactly like on a full id, on a fresh session and on --resume). Haiku has
// no 1M variant, so no sibling.
export const CLAUDE_THREAD_PROFILES: readonly ThreadProfileOption[] = [
  { model: "fable", label: "Fable", defaultEffort: "medium", efforts: claudeEffortsFor("fable") },
  { model: "fable[1m]", label: "Fable 1M", defaultEffort: "medium", efforts: claudeEffortsFor("fable[1m]") },
  { model: "opus", label: "Opus", defaultEffort: "medium", efforts: claudeEffortsFor("opus") },
  { model: "opus[1m]", label: "Opus 1M", defaultEffort: "medium", efforts: claudeEffortsFor("opus[1m]") },
  { model: "sonnet", label: "Sonnet", defaultEffort: "medium", efforts: claudeEffortsFor("sonnet") },
  { model: "sonnet[1m]", label: "Sonnet 1M", defaultEffort: "medium", efforts: claudeEffortsFor("sonnet[1m]") },
  { model: "haiku", label: "Haiku", defaultEffort: "medium", efforts: claudeEffortsFor("haiku") },
]

export function threadProfileOptions(backend: unknown): { backend: Backend; options: ThreadProfileOption[] } {
  if (backend === "claude") return { backend, options: CLAUDE_THREAD_PROFILES.map((option) => ({ ...option, efforts: [...option.efforts] })) }
  if (backend === "codex") {
    return {
      backend,
      options: readCodexModels().map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: model.defaultEffort,
        efforts: [...model.efforts],
      })),
    }
  }
  throw new Error("This thread has an unknown backend; its runtime profile cannot be changed")
}

export function validateThreadProfile(backend: unknown, model: string, effort: string): void {
  const catalogue = threadProfileOptions(backend)
  const option = catalogue.options.find((candidate) => candidate.model === model)
  if (!option || !option.efforts.includes(effort)) {
    throw new Error(`Unsupported ${catalogue.backend} model/effort pair: ${model} / ${effort}`)
  }
}

// The LIVE handoff journals the thread's CURRENT pair as its rollback target and RELAUNCHES the worker
// with it if the target profile fails (resume.ts spawns from `profiles.current`), so that pair must be
// launchable argv. Claude records a thread's model but frequently never its launch effort, so a known
// model with an absent/unrecognized effort is a NORMAL state, not corruption — rejecting it outright
// left such a thread permanently unable to change its model. Reconstruct the missing half from the
// catalogue's default effort (exactly what a fresh dispatch of that model would use) so the rollback
// stays launchable. An unknown MODEL still fails closed: there is no entry to rebuild a pair from.
export function resolveRollbackProfile(backend: unknown, model: string, effort: string): { model: string; effort: string } {
  const catalogue = threadProfileOptions(backend)
  const option = catalogue.options.find((candidate) => candidate.model === model)
  if (!option || !option.efforts.includes(option.defaultEffort)) {
    // Name the absent half explicitly: this pair comes from stored/observed state rather than a grid
    // click, so an empty model rendered a message ("pair:  / ") that identified nothing to act on.
    throw new Error(`Unsupported ${catalogue.backend} model/effort pair: ${model || "(unknown model)"} / ${effort || "(unrecorded effort)"}`)
  }
  return { model: option.model, effort: option.efforts.includes(effort) ? effort : option.defaultEffort }
}

// `current` is the thread's persisted launch pick, and it is LOAD-BEARING for the `[1m]` window
// variants rather than a nicety. The suffix is client-side only: Claude Code parses it off `--model`
// into the `context-1m-2025-08-07` beta header and puts the BARE id on the wire, so the model the API
// echoes back — which is all this function ever observes — can only name the family. Taking that at
// face value would rewrite a thread launched as `opus[1m]` down to `opus` on its first assistant
// record, and the persisted model IS the relaunch target (router.ts hands `row.model` to
// bridge.followUp for a cold resume), so the 1M window would vanish on the next restart with nothing
// on screen to say so. The launch pick is the only surviving record of the window, so carry its suffix
// through whenever the observed family agrees with it. A genuine model CHANGE still wins: a different
// family drops the suffix, because at that point nothing knows which window the new model got.
export function normalizeObservedThreadModel(backend: unknown, model: string, current?: string | null): string | undefined {
  const value = model.trim()
  if (backend === "codex") return threadProfileOptions(backend).options.some((option) => option.model === value) ? value : undefined
  if (backend === "claude") {
    const exact = CLAUDE_THREAD_PROFILES.find((option) => option.model === value)
    if (exact) return exact.model
    // The substring pass finds the FAMILY only — an observed id spells "claude-opus-5", which contains
    // "opus" but never the alias "opus[1m]".
    const family = CLAUDE_THREAD_PROFILES.find((option) => value.toLowerCase().includes(option.model))?.model
    if (!family) return undefined
    const windowVariant = `${family}[1m]`
    if (!CLAUDE_THREAD_PROFILES.some((option) => option.model === windowVariant)) return family
    // Prefer a suffix the observation itself spells (a future CLI may stop stripping it); otherwise
    // inherit the launch pick's.
    return value.endsWith("[1m]") || current?.trim() === windowVariant ? windowVariant : family
  }
  return undefined
}
