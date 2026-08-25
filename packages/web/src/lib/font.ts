import type { QueryClient } from "@tanstack/react-query"
import type { Settings } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"

// Literal font stacks — mirror styles.css @theme --font-mono / --font-sans. Duplicated here ON
// PURPOSE (not referenced via var(--font-*)): the inline style set in apply() must survive a Vite
// HMR swap of styles.css, during which BOTH the html[data-font] rule AND the @theme custom
// properties briefly vanish. A var()-based inline family would go invalid in that gap and flash; a
// literal stack has no dependency on the swapped sheet. Keep these in sync with styles.css.
const MONO_STACK =
  'ui-monospace, "JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Mono", Consolas, Menlo, "DejaVu Sans Mono", monospace'
const SANS_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

// Reflects Settings.font onto <html data-font> so styles.css can swap the type family app-wide.
// Applying it at the document root (not from a React component) keeps it live even while the
// Settings drawer that changed it is closed/unmounted. Anything other than "mono" is sans — the same
// reading index.html's pre-paint guard takes of the localStorage mirror, and the server's default
// (settings.ts). The two used to disagree: this side read "anything other than sans is mono", and
// initFont applied it to an EMPTY cache before React mounted, so every load painted its first frames
// in mono and flipped to sans when settingsGet answered — a document-wide reflow, on top of the guard
// that existed to prevent exactly that (measured 2026-08-25: sans at 4ms, mono at 72ms, sans at 158ms).
function apply(font: Settings["font"] | undefined) {
  const v = font === "mono" ? "mono" : "sans"
  document.documentElement.dataset.font = v
  // Pin the family as an INLINE style on <body> so it survives Vite HMR stylesheet swaps. When
  // styles.css is replaced, its data-font rule vanishes for a frame → the body would flash mono↔sans
  // on EVERY css edit. An inline style lives on the element, not the swapped sheet, so it persists.
  // The data-font CSS rule remains the first-paint/default path; this just makes it flash-proof.
  if (document.body) document.body.style.fontFamily = v === "sans" ? SANS_STACK : MONO_STACK
  // Mirror for index.html's pre-paint FOUC guard (settings arrive an RPC after first paint).
  try {
    localStorage.setItem("frizz-font", v)
  } catch {
    // storage unavailable — the guard just defaults to mono next load
  }
}

// Wire from main.tsx (uncontended) so the attribute tracks the settings query for the whole session:
// seed from an initial fetch, then re-apply whenever the ["settingsGet"] cache entry changes (e.g.
// the drawer saves a new font). App.tsx runs the same query, so the cache is the shared source.
export function initFont(qc: QueryClient) {
  // Only a KNOWN font is applied. Before settings arrive the document keeps what index.html set from
  // the mirror; applying a fallback here would override that guard with a guess for one round trip.
  const cached = qc.getQueryData<Settings>(["settingsGet"])
  if (cached) apply(cached.font)
  rpc.settingsGet().then((s) => apply(s.font)).catch(() => {})
  qc.getQueryCache().subscribe(() => {
    const s = qc.getQueryData<Settings>(["settingsGet"])
    if (s) apply(s.font)
  })
}
