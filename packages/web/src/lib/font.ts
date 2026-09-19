// The interface renders in ONE type family: sans. It was a machine setting with a mono alternative
// until 2026-09-19 (maintainer: "let's drop monospace as an option"); styles.css still keys the sans
// rules on `html[data-font="sans"]`, which index.html pins on the <html> tag itself, so the first paint
// is sans with nothing to wait for and no localStorage mirror to read.
//
// Literal font stack — mirrors styles.css @theme --font-sans. Duplicated here ON PURPOSE (not
// referenced via var(--font-*)): the inline style set below must survive a Vite HMR swap of styles.css,
// during which BOTH the html[data-font] rule AND the @theme custom properties briefly vanish. A
// var()-based inline family would go invalid in that gap and flash; a literal stack has no dependency
// on the swapped sheet. Keep it in sync with styles.css.
const SANS_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

// Wire from main.tsx. Re-asserts the attribute (a fixture page that forgot it would otherwise render
// the sheet's mono default) and pins the family as an INLINE style on <body> so it survives Vite HMR
// stylesheet swaps: when styles.css is replaced its data-font rule vanishes for a frame, and an inline
// style lives on the element, not the swapped sheet.
export function initFont() {
  document.documentElement.dataset.font = "sans"
  if (document.body) document.body.style.fontFamily = SANS_STACK
}
