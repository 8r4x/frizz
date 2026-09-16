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
  // lucide's plug, cropped to its ink (ProviderMark's AcpMark sets the viewBox), so the box IS the ink
  // and the caller's `ml-1` is 4px of ink gap like the two marks above (uncropped, the 24-unit box
  // carried 2.75px of dead space per side and drew 6.75px). MEASURED on the rail title (13px
  // system-ui, visual-review cap-band probe, dsf 6): ink 9.17px tall against a 9.16px cap height,
  // riding 0.92px HIGH of the cap band before `translate-y-px` — the same 1px drop the Claude
  // asterisk needs. Re-measure rather than re-guess if the glyph, its stroke or the type scale moves.
  acp: "h-[11px] w-[6.65px] translate-y-px",
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
