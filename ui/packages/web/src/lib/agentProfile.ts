// ── THE SUB-AGENT MODEL+EFFORT TAG ───────────────────────────────────────────────────────────────
//
// A dispatch's `subagent_type` is captured VERBATIM (SubAgentView.subagentType) because it is the
// provider's own string and the transcript's AgentBlock renders it raw. But the live child rows under
// a prompt box need the fact inside it — WHICH model, at WHAT effort — and "fray:opus-xhigh" is a slug,
// not a reading. This is the one place that turns the slug into the pair.
//
// Only the two shapes fray itself produces are recognized. Everything else (a named Claude agent type
// like "general-purpose" / "Explore", a bare custom agent) yields NO pair rather than a guess: a child
// row that invents a model is worse than one that stays quiet, and an unrecognized string is exactly
// the case where a guess would be wrong.
//
//   1. "fray:<model>[-<effort>]"        — the fray worker profiles (FRAY.md's dispatch cells). The older
//      "fray:fray-<model>-<effort>" doubling is still present in live transcripts, so it is absorbed.
//      A profile with no effort axis ("fray:haiku") yields the model alone.
//   2. "[<agent-type> ]<model>/<effort>" — the codex cell, built by describeCell() in the server's
//      codex-subagents.ts from spawn_agent's own `model` + `reasoning_effort`. The slash is the marker;
//      any leading agent-type word ("worker gpt-5.6-terra/high") is dropped.

export interface AgentProfile {
  model?: string
  effort?: string
}

// The efforts fray dispatches across (profileGrid's EFFORT_ORDER). Used ONLY to decide whether the
// trailing segment of a "fray:" cell is an effort or part of the model name — never to validate one, so
// a newly-added effort degrades to "model only", never to a mis-split model.
const KNOWN_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"])

export function parseAgentProfile(subagentType: string | undefined): AgentProfile {
  const raw = subagentType?.trim()
  if (!raw) return {}

  // Codex cell first: the slash is unambiguous, and a codex model slug ("gpt-5.6-terra") carries the
  // hyphens that would otherwise confuse the fray-namespace split below.
  const slash = raw.lastIndexOf("/")
  if (slash > 0) {
    const model = raw.slice(0, slash).trim().split(/\s+/).pop()
    const effort = raw.slice(slash + 1).trim()
    return { model: model || undefined, effort: effort || undefined }
  }

  // Claude worker profile. The "fray:" namespace is what makes the hyphen split safe — an arbitrary
  // agent type ("claude-code-guide") must never be read as a model+effort pair.
  if (!raw.startsWith("fray:")) return {}
  const cell = raw.slice("fray:".length).replace(/^fray-/, "").trim()
  if (!cell) return {}
  const cut = cell.lastIndexOf("-")
  if (cut <= 0) return { model: cell }
  const effort = cell.slice(cut + 1)
  return KNOWN_EFFORTS.has(effort) ? { model: cell.slice(0, cut), effort } : { model: cell }
}

// The rendered reading. "opus › high" — the SAME `model › effort` form the prompt box's own profile
// selector uses one line above these rows (profileGrid.ts profileGridDisplayLabel), so a child's
// profile and its parent's are read the same way. Undefined when there is no model to name.
export function agentProfileLabel(subagentType: string | undefined): string | undefined {
  const { model, effort } = parseAgentProfile(subagentType)
  if (!model) return undefined
  return effort ? `${model} › ${effort}` : model
}
