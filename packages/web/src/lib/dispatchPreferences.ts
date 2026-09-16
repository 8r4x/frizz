import {
  acpModelSlug,
  type AcpAgent,
  type Backend,
  type CodexModel,
  type DispatchPreferences,
  type SetDispatchPreferenceInput,
} from "@frizz/shared"
import type { SelectGroup, SelectOption } from "../components/ui/Select.tsx"
import type { ProfileGridGroup } from "./profileGrid.ts"
import {
  CLAUDE_MODELS,
  claudeEfforts,
  claudeEffortOptions,
  codexEffortOptions,
  modelGroups,
} from "./options.ts"

export interface ResolvedDispatchPreferences {
  backend: Backend
  model: string
  effort: string
  codexModel?: CodexModel
  modelAvailable: boolean
  effortAvailable: boolean
  effortOptions: SelectOption[]
}

export function applyDispatchPreferenceUpdate(
  current: DispatchPreferences,
  update: SetDispatchPreferenceInput,
): DispatchPreferences {
  if (update.field === "backend") return { ...current, backend: update.value }
  if (update.field === "profile") {
    return {
      ...current,
      backend: update.backend,
      [update.backend]: {
        ...current[update.backend],
        model: update.model,
        effort: update.effort,
      },
    }
  }
  return {
    ...current,
    ...(update.field === "model" ? { backend: update.backend } : {}),
    [update.backend]: { ...current[update.backend], [update.field]: update.value },
  }
}

export function dispatchProfileGroups(codexModels: readonly CodexModel[], acpAgents: readonly AcpAgent[] = []): ProfileGridGroup[] {
  // Only the agents actually on the server's PATH get a row: the catalogue lists eight, and a grid of
  // "not installed" rows would bury the two the operator has. A SAVED agent that has since gone
  // missing surfaces through resolveDispatchPreferences's `modelAvailable`, not through a row here.
  const acpOptions = acpAgents.filter((agent) => agent.available).map((agent) => ({
    model: acpModelSlug(agent.id),
    label: agent.label,
    // No effort axis: an ACP agent runs on its own CLI's model and effort (ProfileGridSelector draws
    // one "Default" cell for an option with no efforts).
    efforts: [],
  }))
  return [
    {
      id: "claude",
      label: "Claude Code",
      options: CLAUDE_MODELS.map((option) => ({
        model: option.value,
        label: option.label,
        defaultEffort: "high",
        // Per-model, exactly like the codex rows below: the ultracode rung exists only on the
        // xhigh-capable models, so Haiku's row leaves that grid cell empty.
        efforts: claudeEfforts(option.value),
      })),
    },
    {
      id: "codex",
      label: "Codex",
      options: codexModels.map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: model.defaultEffort,
        efforts: model.efforts,
      })),
    },
    ...(acpOptions.length ? [{ id: "acp", label: "ACP agents", options: acpOptions }] : []),
  ]
}

export function resolveDispatchPreferences(
  preferences: DispatchPreferences,
  codexModels: readonly CodexModel[],
  acpAgents: readonly AcpAgent[] = [],
): ResolvedDispatchPreferences {
  const backend = preferences.backend
  // `acp` is optional on the record (older rows predate it), so an ACP backend with no saved profile
  // reads as an empty one and falls through to the first installed agent below.
  const profile = preferences[backend] ?? {}
  const firstAcpAgent = acpAgents.find((agent) => agent.available)
  const model = profile.model ?? (
    backend === "claude" ? "opus"
      : backend === "codex" ? codexModels[0]?.slug ?? ""
        : firstAcpAgent ? acpModelSlug(firstAcpAgent.id) : ""
  )
  const codexModel = backend === "codex"
    ? codexModels.find((candidate) => candidate.slug === model)
    : undefined
  const modelAvailable = backend === "claude"
    ? CLAUDE_MODELS.some((candidate) => candidate.value === model)
    : backend === "codex"
      ? codexModels.some((candidate) => candidate.slug === model)
      : acpAgents.some((candidate) => candidate.available && acpModelSlug(candidate.id) === model)
  const defaultEffort = backend === "claude" ? "high" : codexModel?.defaultEffort ?? ""
  // An ACP agent has no effort axis in Frizz — it runs on its own CLI's model and effort — so its
  // effort is "" and always "available": there is nothing to be unavailable.
  const effort = backend === "acp" ? "" : profile.effort ?? defaultEffort
  const baseEfforts = backend === "claude"
    ? claudeEffortOptions(model, { withDefault: false })
    : backend === "codex"
      ? codexEffortOptions(codexModel, { withDefault: false })
      : []
  const effortAvailable = backend === "acp" || baseEfforts.some((option) => option.value === effort)
  const effortOptions = effort && !effortAvailable
    ? [{ value: effort, label: `${effort} (unavailable)`, title: "Saved reasoning level is not available for this model" }, ...baseEfforts]
    : baseEfforts
  return {
    backend,
    model,
    effort,
    codexModel,
    modelAvailable,
    effortAvailable,
    effortOptions,
  }
}

export function dispatchModelGroups(
  codexModels: readonly CodexModel[],
  backend: Backend,
  selectedModel: string,
): SelectGroup[] {
  const groups = modelGroups(codexModels, { withDefault: false })
  if (!selectedModel || groups.some((group) => group.options.some((option) => option.value === selectedModel))) return groups
  const unavailable: SelectGroup = {
    label: backend === "codex" ? "Saved Codex model" : backend === "acp" ? "Saved ACP agent" : "Saved Claude model",
    options: [{ value: selectedModel, label: `${selectedModel} (unavailable)`, title: "This saved model is no longer in the runtime catalogue" }],
  }
  return [unavailable, ...groups]
}
