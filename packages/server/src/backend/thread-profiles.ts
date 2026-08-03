import type { Backend, ThreadProfileOption } from "@fray-ui/shared"
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

export const CLAUDE_THREAD_PROFILES: readonly ThreadProfileOption[] = [
  { model: "fable", label: "Fable", defaultEffort: "medium", efforts: claudeEffortsFor("fable") },
  { model: "opus", label: "Opus", defaultEffort: "medium", efforts: claudeEffortsFor("opus") },
  { model: "sonnet", label: "Sonnet", defaultEffort: "medium", efforts: claudeEffortsFor("sonnet") },
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

export function normalizeObservedThreadModel(backend: unknown, model: string): string | undefined {
  const value = model.trim()
  if (backend === "codex") return threadProfileOptions(backend).options.some((option) => option.model === value) ? value : undefined
  if (backend === "claude") {
    const exact = CLAUDE_THREAD_PROFILES.find((option) => option.model === value)
    if (exact) return exact.model
    return CLAUDE_THREAD_PROFILES.find((option) => value.toLowerCase().includes(option.model))?.model
  }
  return undefined
}
