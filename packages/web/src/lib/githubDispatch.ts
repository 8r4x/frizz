import type {
  CodexModel,
  DispatchProfileSnapshot,
  GithubBatchInput,
} from "@fray-ui/shared"
import { CLAUDE_MODELS, EFFORTS } from "./options.ts"

// Validate the picker's live model/effort pair immediately before the final mutation. A Codex cache
// refresh can invalidate a model or effort while the picker is open; that must stop visibly (the
// selector's own red line + a disabled dispatch) instead of falling back or downgrading.
// No permissionMode participates: the server stamps every created worker itself
// (workerDispatchPermission — the non-interactive floor, raised to bypass only when Settings asks), so
// the GitHub flow carries no per-thread permission choice.
export function dispatchProfileError(
  profile: DispatchProfileSnapshot,
  codexModels: readonly CodexModel[],
): string | undefined {
  if (profile.backend === "claude") {
    if (!CLAUDE_MODELS.some((option) => option.value === profile.model)) {
      return `Claude model ${profile.model} is no longer available`
    }
    if (!(EFFORTS as readonly string[]).includes(profile.effort)) {
      return `Reasoning level ${profile.effort} is not available for ${profile.model}`
    }
    return undefined
  }

  const model = codexModels.find((candidate) => candidate.slug === profile.model)
  if (!model) return `Codex model ${profile.model} is no longer available`
  if (!model.efforts.includes(profile.effort)) {
    return `Reasoning level ${profile.effort} is not available for ${profile.model}`
  }
  return undefined
}

export function buildGithubBatchInput(
  profile: DispatchProfileSnapshot,
  items: GithubBatchInput["items"],
): GithubBatchInput {
  return {
    items: items.map((item) => ({ ...item })),
    backend: profile.backend,
    model: profile.model,
    effort: profile.effort,
  }
}
