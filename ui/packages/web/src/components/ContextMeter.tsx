import type { ThreadView } from "@fray-ui/shared"
import { Tooltip } from "./Tooltip.tsx"

// HOW FULL THE SESSION'S CONTEXT IS — a dial and its percentage in the bottom-left of every thread
// footer (queue card, drawer, full-screen), rendered once here because all three share
// ThreadLifecycleFooter.
//
// It is a READING, never an estimate. Both halves of the fraction are measured by the provider and
// travel together on ThreadView.context; the server omits the field entirely unless it has both, so
// this component's only job is to render nothing when it is absent. There is deliberately no 0% dial,
// no empty ring, no "—" placeholder: an absent reading must occupy no space at all, the same rule the
// child row's working-duration follows. (Which threads have one, and why, is documented on
// FoldState.contextWindow — the short version is that codex always does and a Claude thread does from
// the end of its first turn.)
//
// SIZE IS INHERITED, NOT SET. The svg is sized in `em` and the arc colors come from `currentColor`, so
// the footer's own text scale decides how big this is and what tone it takes — exactly the discipline
// ChildOpRow's duration reading landed on. Do not put a px size on it.
//
// THE PERCENT IS ON THE SURFACE; the FRACTION stays in the tooltip. A bare 12.6px dial at 60% muted was
// unfindable in practice — on the `/thread/<slug>/full` page it sits alone at the left end of a ~900px
// strip, 746px from the nearest ink, and reads as no indicator at all rather than as a quiet one. (That
// is what "why is there no context indicator in the full UI?" turned out to mean: it was rendering, and
// invisible.) So the readout now says its number, mirroring this app's OWN usage readout — QuotaChip is
// a provider mark plus a `tabular-nums` percentage, and this is the same reading in the same shape. The
// original note stands for the part that was actually right: "348,950 / 1,000,000" IS a line of
// telemetry and would compete with the lifecycle buttons, so it stays in the tooltip. Three characters
// do not. `tabular-nums` so a live reading ticking 8% → 87% cannot jitter the dial beside it.

// Geometry for a 16-unit viewBox donut. r + half the stroke is the OUTER edge, held at 7.5 so the ring
// sits fully inside the box — thinning the stroke therefore RAISES r rather than shrinking the glyph.
const R = 6.5
const STROKE = 2
const CIRCUMFERENCE = 2 * Math.PI * R
// NO ink nudge, and that is a MEASURED result rather than an omission. A dial beside digits is the exact
// icon-beside-text trap the visual-review skill exists for — `items-center` centers the svg's BOX while
// the eye reads its INK — so it was measured: the ring's ink is a circle centered in its own viewBox, and
// against the digits at the footer's 12px/17.14px scale it lands 0.21px high (0.40px at 24px, i.e.
// ~0.0175em, so the error is proportional, not a fixed pixel debt). That is under the
// device grid and well below the ~0.3px floor where a transform starts costing more sharpness than it
// buys. The two things that make it come out this small are the 1.43 line-height's generous half-leading
// and the `%`'s own slight descender, which together put the digits' ink centre within a fifth of a pixel
// of the line box centre — so if either the label or the footer's leading changes, RE-MEASURE.

/** Percent for display: floored, so the readout only says 100% when the context genuinely is full. */
function displayPercent(tokens: number, window: number): number {
  return Math.max(0, Math.min(100, Math.floor((tokens / window) * 100)))
}

export function ContextMeter({ thread }: { thread: ThreadView }) {
  const context = thread.context
  // Absent ⇒ nothing. Also guards a window of 0, which would make the fraction meaningless rather
  // than merely unknown.
  if (!context || context.window <= 0) return null
  const percent = displayPercent(context.tokens, context.window)
  // The arc's own fraction is NOT the floored percent: a 0.4%-full context should still show a hairline
  // of arc rather than a bare ring, and clamping keeps a reading that overshoots its window (a provider
  // counting a request fray has not seen the window change for) from wrapping past 12 o'clock.
  const fraction = Math.max(0, Math.min(1, context.tokens / context.window))
  const label = `Context ${percent}% full\n${context.tokens.toLocaleString()} of ${context.window.toLocaleString()} tokens`
  return (
    <Tooltip label={label} side="top" multiline>
      <span
        data-context-meter
        data-context-percent={percent}
        aria-label={label}
        className="flex shrink-0 items-center gap-1 text-muted/60"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-[1.05em] w-[1.05em] shrink-0"
          aria-hidden
          // Start the arc at 12 o'clock and fill clockwise — the direction every dial is read in.
          style={{ transform: "rotate(-90deg)" }}
        >
          {/* The track: the same ink at low opacity, so the empty part of the dial reads as unfilled
              rather than as a border of some other element. */}
          <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={STROKE} />
          <circle
            cx="8"
            cy="8"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
          />
        </svg>
        <span className="tabular-nums">{percent}%</span>
      </span>
    </Tooltip>
  )
}
