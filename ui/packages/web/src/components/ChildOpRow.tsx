import type { ReactElement, ReactNode } from "react"
import { X } from "lucide-react"
import { BoxSpinner } from "./BoxSpinner.tsx"
import { isRunningOperation } from "../lib/operationIndicators.ts"
import { compactElapsedSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import {
  CHILD_ARROW,
  CHILD_ARROW_CLASS,
  CHILD_DISMISS_NOUN,
  CHILD_DISMISS_TITLE,
  CHILD_OPEN_TITLE,
  CHILD_QUIET_SHELL_TITLE,
  CHILD_STALE_DOT_CLASS,
  CHILD_STALE_TITLE,
} from "../lib/childOps.ts"

export type ChildOpKind = "AGENT" | "SHELL"

// The ONE surface knob, and the only thing any caller may vary. It encodes REAL information-density
// differences between the three places a child row appears — not styling preference:
//   rail  — the sidebar's indented child rows. The [ ]/[/] checkbox motif (BoxSpinner) that the whole
//           rail speaks, at 12px, indented to clear the parent row's indicator column. NEVER swap this
//           for the pulsing dot: matching the parent rows is the point. The rail keeps carrying the raw
//           subagent type in its tooltip, which is now the only place it appears at all.
//   card  — a queue card's live child lines: the pulsing live dot and the label, no kind tag.
//   sheet — the drawer's background-ops strip: dot + petite-caps kind tag + label + the dismiss ×.
// All three carry the light-gray DURATION the child has been working — right-justified at the end of the
// row (maintainer 2026-07-27), so a column of rows reads its numbers down one edge instead of at
// whatever ragged offset each label happens to end. It reads at the SAME size as the title and every
// other reading on the row; the size lives on the container for exactly that reason.
export type ChildOpDensity = "rail" | "card" | "sheet"

// ONE row for "a thing running underneath this thread", rendered identically everywhere it appears.
// Before this component existed the same row was written four times and the copies drifted — two arrow
// alphas six pixels apart on one queue card, two stale-dot alphas, and three different answers for a
// child with no id. Every token it draws comes from lib/childOps.ts.
//
// WHAT THE ROW DELIBERATELY NO LONGER CARRIES (maintainer 2026-07-27, on the rows under the prompt box):
//   • the ↗ hover glyph — the drill-in affordance is the TITLE itself (it underlines on hover and is
//     the button), so a second, quieter icon saying the same thing was noise;
//   • the bracketed model+effort tag — the profile belongs to the prompt box's own control one line up,
//     not repeated on every child line.
//
// POLICY for a child with no `id` (nothing to drill into): a NON-INTERACTIVE row — a plain <div> with
// the same layout, no hover, no focus stop. Never a `disabled` button (which announces an affordance
// that isn't there) and never a dropped row (which silently hides live work). Same rule on all three
// densities: `onOpen` absent ⇒ non-interactive, present ⇒ a real button.
export function ChildOpRow({
  kind,
  label,
  state,
  density,
  startedAt,
  parentSlug,
  onOpen,
  onDismiss,
  title,
}: {
  kind: ChildOpKind
  label: string
  state: "running" | "stale"
  density: ChildOpDensity
  // ISO of the child's DISPATCH. Rendered as a light-gray compact duration ("38s", "12m", "1hr 5m"),
  // live-ticking; absent ⇒ no
  // reading (never a fabricated one). Deliberately not a "last active" recency: anything still listed
  // here is running or stale-but-tracked, so "recently active" is already implied and the recency read
  // as near-zero information (maintainer 2026-07-28). How long it has been WORKING is the number that
  // tells you whether to go look at it.
  startedAt?: string
  // Drill-in marker: keeps an open ThreadSheet for this slug from self-dismissing on the pointer-down,
  // so the child transcript STACKS over its parent instead of replacing it (see ThreadSheet).
  parentSlug?: string
  // Absent ⇒ a non-interactive row (never a dropped one).
  onOpen?: () => void
  // Absent ⇒ no × . Retiring a finished-but-unsignalled op is an ops-strip affordance; a rail row and a
  // queue card line deliberately have no dismiss.
  onDismiss?: () => void
  // Tooltip override. The rail passes "[subagent-type] label" — the type reading it has no room to render.
  title?: string
}): ReactElement {
  const running = isRunningOperation(state)
  const clickable = !!onOpen
  const rail = density === "rail"
  const sheet = density === "sheet"
  // Live-ticking recency, on every density. useNowMs re-renders this row ~every 30s so the reading
  // keeps counting up even while the board sends nothing (a steadily-quiet child pushes no delta).
  const now = useNowMs()
  const elapsed = compactElapsedSince(startedAt, now)
  const openTitle = CHILD_OPEN_TITLE[kind]
  const rowTitle = title ?? (clickable ? openTitle : undefined)

  // The liveness mark. The rail speaks the rail's checkbox language; the card and the drawer share the
  // pulsing-dot language, in a fixed-width column so their labels line up across both surfaces.
  const indicator = rail ? (
    <span className="flex w-3.5 shrink-0 items-center justify-center">
      {running ? <BoxSpinner size={12} /> : <span className={CHILD_STALE_DOT_CLASS} title={CHILD_STALE_TITLE} />}
    </span>
  ) : (
    <span className="flex w-[9px] shrink-0 justify-center">
      {running ? (
        // A running SHELL pulses blue, a running sub-AGENT pulses the accent-yellow.
        <span
          aria-hidden
          className={`fray-live-dot ${kind === "SHELL" ? "fray-live-dot--shell" : "fray-live-dot--agent"}`}
          data-running-indicator={density === "card" ? "queue-subagent" : "operation"}
        />
      ) : kind === "SHELL" ? (
        <span aria-hidden className="fray-live-dot-quiet fray-live-dot-quiet--shell" data-running-indicator="operation-quiet" title={CHILD_QUIET_SHELL_TITLE} />
      ) : (
        <span className={CHILD_STALE_DOT_CLASS} title={CHILD_STALE_TITLE} />
      )}
    </span>
  )

  // `ml-auto` is what right-justifies it: the reading is the LAST item in the row's flex line, so it
  // takes every pixel the (truncating) label leaves behind and sits flush at the right edge.
  const reading: ReactNode = elapsed ? (
    <span className="ml-auto shrink-0 pl-1.5 text-muted/40" title={`Working for ${elapsed}`}>{elapsed}</span>
  ) : null

  const identity = (
    <>
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      {indicator}
      {sheet && <span className="petite-caps shrink-0 text-[9.5px] text-muted/45">{kind}</span>}
      <span className={`min-w-0 truncate text-muted/70 ${rail ? "leading-[16px]" : clickable ? "group-hover:text-fg/80 group-hover:underline" : ""}`}>{label}</span>
      {/* The RAIL's reading rides INSIDE the row so the full-width hover highlight (and the whole
          click target) still spans the row; the two prompt-box densities put it outside, past the ×. */}
      {rail && reading}
    </>
  )

  // SHRINK PRIORITY on the two prompt-box densities: the label is the child's IDENTITY (and the
  // drill-in target), so it keeps its natural width up to 60% of the row and the current step absorbs
  // whatever is left. Letting both shrink proportionally crushed the label to "Inspe…" the moment a
  // step arrived, which inverted the reading — you could see what some child was doing but not which.
  const rowClass = rail
    ? "group flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 pl-[26px] pr-1.5 text-left text-[11.5px] outline-none transition-colors hover:bg-white/[0.04]"
    // `overflow-hidden` is load-bearing at a narrow width: the arrow/dot/kind tag inside are shrink-0,
    // so once the row runs out of room the button's own content used to SPILL and the × landed on top
    // of the "AGENT" tag. Clipping keeps the collapse graceful. The ring goes inset to survive it.
    : `group flex min-w-0 max-w-[60%] items-center gap-1.5 overflow-hidden text-left text-[11.5px] ${clickable ? "cursor-pointer rounded-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60" : ""}`

  const row = clickable ? (
    <button
      type="button"
      data-subagent-parent={parentSlug}
      onClick={onOpen}
      // Only the ops strip swallows the press: it can sit inside a card/drawer whose own mousedown
      // handler would otherwise act on it. The rail and card rows must let the pointer-down through —
      // ThreadSheet reads it (via data-subagent-parent) to decide to STACK rather than dismiss.
      onMouseDown={sheet ? (e) => e.stopPropagation() : undefined}
      title={rowTitle}
      aria-label={`${openTitle}: ${label}`}
      className={rowClass}
    >
      {identity}
    </button>
  ) : (
    <div data-subagent-parent={parentSlug} title={rowTitle} className={rowClass}>
      {identity}
    </div>
  )

  if (rail) return row
  // text-[11.5px] sits on the CONTAINER, not only on the label button: the ×, the step, the counters
  // and the reading are all SIBLINGS of that button, so a size set only on it leaves them inheriting
  // the parent's larger one. That is exactly what happened when the reading moved to the right edge
  // (maintainer 2026-07-28: "why did you make the 5 min ago labels bigger… it should be the same font
  // size as the title"). One size here keeps every reading on the row in step.
  // The two prompt-box densities. The label (drill-in) and the × are SIBLINGS inside one row line — a
  // button can't nest inside a button — with the × sitting DIRECTLY AFTER the title (maintainer
  // 2026-07-27: at the far right it read as too subtle to find) and the recency pushed to the right
  // edge behind it. The × is always visible, quietly: a control you have to discover by hovering is
  // exactly the complaint.
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11.5px]" data-op-row={onDismiss ? "" : undefined}>
      {row}
      {/* The × sits between the identity and the live step, which is exactly "after the title". */}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          onMouseDown={(e) => e.stopPropagation()}
          title={CHILD_DISMISS_TITLE}
          aria-label={`Dismiss ${CHILD_DISMISS_NOUN[kind]}: ${label}`}
          className="shrink-0 rounded-sm p-0.5 text-muted/45 outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
        >
          <X size={11} />
        </button>
      )}
      {reading}
    </div>
  )
}
