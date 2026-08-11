// THE APP'S PILL SWITCH — shadcn's shape (a track, a thumb, one slide) in frizz's tokens.
//
// It replaced a segmented `Off | On` pair wherever a single boolean is being set. That control was two
// buttons and a border, so an off state still drew a box the eye had to read before finding which half
// was lit; a switch says the same thing with position alone and needs no label to be scanned. Maintainer
// 2026-08-11: "use regular pill toggles, shadcn style."
//
// HAND-ROLLED rather than `@radix-ui/react-switch`, which is not a dependency here. A switch is a
// `role="switch"` button and a translated span — the package would buy keyboard handling the button
// element already gives us, and every Radix primitive this app does pull in earns it with a portal or a
// focus trap. There is nothing to trap here.
//
// SIZED IN PIXELS, not in the Tailwind scale, because the two sizes must stay in exact arithmetic: the
// thumb's travel is (track width − 2 × inset − thumb). Round those independently and the thumb stops
// short of the track's right edge by a hair that reads as a rendering bug rather than a design.
const SIZES = {
  // The 11px-prose size, for a switch sharing a row with small copy (the recurring-prompt panel).
  sm: { track: "h-[16px] w-[28px]", thumb: "size-[12px]", travel: "translate-x-[12px]" },
  // The form size, for a switch beside a normal label.
  md: { track: "h-[20px] w-[34px]", thumb: "size-[16px]", travel: "translate-x-[14px]" },
} as const

export function Switch({ checked, onChange, disabled, label, size = "sm", testId }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Accessible name. The visible text beside a switch is usually a `<span>`, not a `<label for>`, so
   *  this is what a screen reader actually reads — never omit it. */
  label: string
  size?: keyof typeof SIZES
  testId?: string
}) {
  const s = SIZES[size]
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-switch={testId}
      data-state={checked ? "checked" : "unchecked"}
      // `onMouseDown` preventDefault: a switch in a popover beside a textarea would otherwise steal
      // focus on press, firing the textarea's blur-persist a beat before this one's own write and
      // sending two round-trips for one click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!checked)}
      className={`inline-flex shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-default disabled:opacity-45 ${s.track} ${
        checked ? "bg-fg" : "bg-border hover:bg-border-strong"
      }`}
    >
      <span
        className={`pointer-events-none block rounded-full transition-transform duration-150 ease-out ${s.thumb} ${
          checked ? `bg-bg ${s.travel}` : "translate-x-0 bg-muted/70"
        }`}
      />
    </button>
  )
}
