export interface ProviderMarkDefinition {
  /** Backend value carried on a known, owned thread. */
  backend: "claude" | "codex" | "acp"
  /** Exposed to assistive technology because the mark is the provider cue. */
  label: "Claude Code" | "OpenAI Codex" | "ACP agent"
}

/**
 * Provider-specific optical sizing is intentionally part of the component contract. The OpenAI
 * knot fills its viewBox more densely than the Claude Code asterisk, so matching nominal boxes
 * makes Codex read too large. The Codex knot also needs no downward baseline correction: at this
 * compact size that correction left it reading one pixel low beside title text.
 */
export const PROVIDER_MARK_GEOMETRY: Record<ProviderMarkDefinition["backend"], string> = {
  claude: "size-[11px] translate-y-px",
  codex: "size-[10px]",
  // A stroked lucide glyph, not a filled brand mark: its ink is the stroke, so it gets the larger box
  // and no baseline nudge. Re-measure (scripts/ink-gaps.mjs) if the glyph or its stroke width changes.
  acp: "size-[11px]",
}

const PROVIDER_MARKS: Record<ProviderMarkDefinition["backend"], ProviderMarkDefinition> = {
  claude: { backend: "claude", label: "Claude Code" },
  codex: { backend: "codex", label: "OpenAI Codex" },
  // One generic mark for every ACP agent: the protocol is the identity Frizz can vouch for, the agent
  // behind it is named in the thread's profile readout.
  acp: { backend: "acp", label: "ACP agent" },
}

// Board snapshots from an older server, legacy rows, and future backends intentionally have
// no identity mark. Do not infer one from the current dispatch preference or model name.
export function providerMarkForBackend(backend: string | null | undefined): ProviderMarkDefinition | undefined {
  return backend === "claude" || backend === "codex" || backend === "acp" ? PROVIDER_MARKS[backend] : undefined
}
