const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"])

function splitEffort(value: string, separator: "/" | "-"): { model: string; effort?: string } {
  const at = value.lastIndexOf(separator)
  if (at <= 0) return { model: value }
  const effort = value.slice(at + 1)
  if (!EFFORTS.has(effort)) return { model: value }
  return { model: value.slice(0, at), effort }
}

// The provider records one opaque dispatch cell, not separate profile fields:
//   Claude: fray:opus-high / fray:fray-opus-high
//   Codex:  explorer gpt-5.6-terra/high
// Preserve an agent role when one exists, but present the model/effort with the same separators the
// normal prompt-box selector uses. Unknown/custom cells remain verbatim rather than being guessed.
export function subAgentProfileLabel(subagentType?: string): string {
  const raw = subagentType?.trim()
  if (!raw) return "Profile unknown"

  if (raw.startsWith("fray:")) {
    const routed = raw.slice("fray:".length).replace(/^fray-/, "")
    const { model, effort } = splitEffort(routed, "-")
    return effort ? `${model} › ${effort}` : model
  }

  const words = raw.split(/\s+/)
  const cell = words.at(-1) ?? raw
  const { model, effort } = splitEffort(cell, "/")
  if (!effort) return raw
  const role = words.slice(0, -1).join(" ")
  return `${role ? `${role} · ` : ""}${model} › ${effort}`
}
