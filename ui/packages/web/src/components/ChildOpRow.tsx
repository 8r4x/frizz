import type { ReactElement } from "react"
import { ArrowUpRight, X } from "lucide-react"
import { BoxSpinner } from "./BoxSpinner.tsx"
import { isRunningOperation } from "../lib/operationIndicators.ts"
import { formatAgo } from "../lib/durationLabels.ts"
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
//           for the pulsing dot: matching the parent rows is the point.
//   card  — a queue card's live child lines. The pulsing live dot, no kind tag: a handoff card names
//           the work still running beneath it, it does not become a second ops toolbar.
//   sheet — the drawer's background-ops strip. The full row: dot + petite-caps kind tag + label + a
//           hover drill-in arrow, because this IS the operations surface.
// All three carry the light-gray "last active" reading when the child reports one — the recency the
// running/stale mark alone can't give ("stale" only means quiet ≥15 min, not HOW long).
export type ChildOpDensity = "rail" | "card" | "sheet"

// ONE row for "a thing running underneath this thread", rendered identically everywhere it appears.
// Before this component existed the same row was written four times and the copies drifted — two arrow
// alphas six pixels apart on one queue card, two stale-dot alphas, and three different answers for a
// child with no id. Every token it draws comes from lib/childOps.ts.
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
  lastActivityAt,
  parentSlug,
  onOpen,
  onDismiss,
  title,
}: {
  kind: ChildOpKind
  label: string
  state: "running" | "stale"
  density: ChildOpDensity
  // ISO of the child's last transcript append (its output-file mtime). Rendered as a light-gray
  // "6 min ago" reading, live-ticking; absent ⇒ no reading (never a fabricated one).
  lastActivityAt?: string
  // Drill-in marker: keeps an open ThreadSheet for this slug from self-dismissing on the pointer-down,
  // so the child transcript STACKS over its parent instead of replacing it (see ThreadSheet).
  parentSlug?: string
  // Absent ⇒ a non-interactive row (never a dropped one).
  onOpen?: () => void
  // Absent ⇒ no × . Retiring a finished-but-unsignalled op is an ops-strip affordance; a rail row and a
  // queue card line deliberately have no dismiss.
  onDismiss?: () => void
  // Tooltip override. The rail passes "[subagent-type] label" — the type tag it has no room to render.
  title?: string
}): ReactElement {
  const running = isRunningOperation(state)
  const clickable = !!onOpen
  const rail = density === "rail"
  const sheet = density === "sheet"
  // Live-ticking recency, on every density. useNowMs re-renders this row ~every 30s so the reading
  // keeps counting up even while the board sends nothing (a steadily-quiet child pushes no delta).
  const now = useNowMs()
  const ago = formatAgo(lastActivityAt, now)
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

  const content = (
    <>
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      {indicator}
      {sheet && <span className="petite-caps shrink-0 text-[9.5px] text-muted/45">{kind}</span>}
      <span className={`min-w-0 truncate text-muted/70 ${rail ? "leading-[16px]" : clickable ? "group-hover:text-fg/80 group-hover:underline" : ""}`}>{label}</span>
      {ago && <span className="shrink-0 text-muted/40" title={`Last active ${ago}`}>{ago}</span>}
      {sheet && clickable && <ArrowUpRight size={11} className="shrink-0 text-transparent transition-colors group-hover:text-muted/50" />}
    </>
  )

  // `flex-1` only when a × sits beside the row: in the card/rail column layouts a flex-1 child would
  // grow VERTICALLY instead.
  const rowClass = rail
    ? "group flex min-w-0 items-center gap-2 rounded-md py-0.5 pl-[26px] pr-1.5 text-left text-[11.5px] outline-none transition-colors hover:bg-white/[0.04]"
    : `group flex min-w-0 items-center gap-1.5 text-left text-[11.5px] ${onDismiss ? "flex-1 " : ""}${clickable ? "cursor-pointer rounded-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60" : ""}`

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
      {content}
    </button>
  ) : (
    <div data-subagent-parent={parentSlug} title={rowTitle} className={rowClass}>
      {content}
    </div>
  )

  if (!onDismiss) return row
  // The label (drill-in) and the × are SIBLINGS inside one row group — a button can't nest inside a
  // button. The × reveals on row hover/focus so it never competes with the label at rest.
  return (
    <div className="group/op flex min-w-0 items-center gap-1" data-op-row>
      {row}
      <button
        type="button"
        onClick={onDismiss}
        onMouseDown={(e) => e.stopPropagation()}
        title={CHILD_DISMISS_TITLE}
        aria-label={`Dismiss ${CHILD_DISMISS_NOUN[kind]}: ${label}`}
        className="shrink-0 rounded-sm p-0.5 text-muted/30 opacity-0 outline-none transition-opacity hover:text-fg/70 focus-visible:opacity-100 group-hover/op:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  )
}
