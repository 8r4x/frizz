// The one icon-action treatment used by every button in the top-left status bar (settings, reload).
// It lives here rather than in StatusBar.tsx because RestartFrayButton also needs it, and importing it
// from StatusBar — which itself renders RestartFrayButton — would be an import cycle.
//
// 24px square: the WCAG 2.2 minimum pointer target, and the largest size that still reads as part of a
// 12px text strip rather than as chrome parked next to it. The old corner button was 32px, which
// out-weighed the owner/repo label once the two became neighbours.
export const STATUS_BAR_ACTION =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/75 outline-none transition-colors hover:bg-panel hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong disabled:opacity-55"

/** Icon size for every glyph in the bar. Matched to the 24px target so no button reads heavier. */
export const STATUS_BAR_ICON = 14
