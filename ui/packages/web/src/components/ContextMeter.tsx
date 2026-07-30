import type { ThreadView } from "@fray-ui/shared"
import { Tooltip } from "./Tooltip.tsx"

// HOW FULL THE SESSION'S CONTEXT IS — a glanceable donut in the bottom-left of every thread footer
// (queue card, drawer, full-screen), rendered once here because all three share ThreadLifecycleFooter.
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
// THE NUMBERS LIVE IN THE TOOLTIP, NOT ON THE SURFACE. A footer is a control strip; spending a line of
// it on "348,950 / 1,000,000" would make a background reading compete with the lifecycle buttons. A
// compact "87%" beside the dial was tried and deliberately dropped too — the dial alone is the intended
// weight for this reading.
//
// So if you are here because a thread appears to have NO indicator: the surface is almost certainly not
// the reason. All three surfaces render this same component, and the usual answer is that the thread has
// no reading yet — a Claude row carries no denominator until its first turn ENDS, because the SDK names
// the context window only on its `result` event. It is per-THREAD, never per-surface.

// Geometry for a 16-unit viewBox donut. r + half the stroke is the OUTER edge, held at 7.5 so the ring
// sits fully inside the box — thinning the stroke therefore RAISES r rather than shrinking the glyph.
const R = 6.5
const STROKE = 2
const CIRCUMFERENCE = 2 * Math.PI * R

/** Percent for the tooltip: floored, so it only reads 100% when the context genuinely is full. */
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
        className="flex shrink-0 items-center text-muted/60"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-[1.05em] w-[1.05em]"
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
      </span>
    </Tooltip>
  )
}
