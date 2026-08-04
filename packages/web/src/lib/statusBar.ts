// The one icon-action treatment used by every button in the top-left status bar (settings, reload).
// It lives here rather than in StatusBar.tsx because RestartFrizzButton also needs it, and importing it
// from StatusBar — which itself renders RestartFrizzButton — would be an import cycle.
//
// 24px square: the WCAG 2.2 minimum pointer target, and the largest size that still reads as part of a
// 12px text strip rather than as chrome parked next to it. The old corner button was 32px, which
// out-weighed the owner/repo label once the two became neighbours.
//
// The hover fill is bg-elevated, one step ABOVE the bar's own bg-panel surface. It was bg-panel back
// when the bar had no background of its own; once the bar became an opaque panel chip, a bg-panel
// hover was the same colour as the thing behind it and the hover simply stopped reading.
export const STATUS_BAR_ACTION =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/75 outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong disabled:opacity-55"

/** Icon size for every glyph in the bar. Matched to the 24px target so no button reads heavier. */
export const STATUS_BAR_ICON = 14
