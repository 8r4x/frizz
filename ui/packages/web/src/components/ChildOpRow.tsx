import type { ReactElement, ReactNode } from "react"
import { X } from "lucide-react"
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
  childProgressLabel,
} from "../lib/childOps.ts"

export type ChildOpKind = "AGENT" | "SHELL"

// The ONE surface knob, and the only thing any caller may vary. It encodes REAL information-density
// differences between the three places a child row appears — not styling preference:
//   rail  — the sidebar's indented child rows. The [ ]/[/] checkbox motif (BoxSpinner) that the whole
//           rail speaks, at 12px, indented to clear the parent row's indicator column. NEVER swap this
//           for the pulsing dot: matching the parent rows is the point. The rail keeps carrying the raw
//           subagent type in its tooltip, which is now the only place it appears at all.
//   card  — a queue card's live child lines. The pulsing live dot and the child's CURRENT STEP, no kind
//           tag and no counters: a handoff card names the work still running beneath it and what that
//           work is doing, it does not become a second ops toolbar.
//   sheet — the drawer's background-ops strip. The full row: dot + petite-caps kind tag + label + the
//           dismiss × + the current step + the "how far it has got" counters, because this IS the
//           operations surface.
// All three carry the light-gray "last active" reading when the child reports one — the recency the
// running/stale mark alone can't give ("stale" only means quiet ≥15 min, not HOW long) — RIGHT-JUSTIFIED
// at the end of the row (maintainer 2026-07-27), so a column of rows reads its recencies down one edge
// instead of at whatever ragged offset each label happens to end.
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
  lastActivityAt,
  activityDetail,
  toolUses,
  tokens,
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
  // WHAT THE CHILD IS DOING RIGHT NOW, in the provider's own words ("Running sleep for 20 seconds") —
  // rewritten per tool call off the Claude Agent SDK's typed task stream. This is the answer to "there's
  // not really any indication of what they're up to aside from starts and stops", so it is the row's
  // headline reading after the label. Prefer it over the bare tool name (`activity`, e.g. "Bash"),
  // which says almost nothing, and over `summary`, which measured EMPTY on every progress event and
  // only arrives with the terminal notification — by which point the row has already been retired.
  // Absent for a tmux thread, a codex child, or an older CLI ⇒ the row simply reads as it did before,
  // never with a gap where the step would have gone.
  activityDetail?: string
  // How far the child has got. `toolUses` rides the board signature so it pushes promptly; `tokens`
  // deliberately does not (it would churn), so it reads as a slow secondary number and never animates.
  // Ops-strip only — a queue card names the work, it does not keep a meter on it.
  toolUses?: number
  tokens?: number
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

  // `ml-auto` is what right-justifies it: the reading is the LAST item in the row's flex line, so it
  // takes every pixel the (truncating) label leaves behind and sits flush at the right edge.
  const reading: ReactNode = ago ? (
    <span className="ml-auto shrink-0 pl-1.5 text-muted/40" title={`Last active ${ago}`}>{ago}</span>
  ) : null
  // The current step, and (ops strip only) how far the child has got. The step TRUNCATES rather than
  // pushing the recency off the row: at a narrow width the first few words still say what kind of work
  // is in flight, and the full sentence rides the tooltip.
  const step = !rail && activityDetail?.trim() ? activityDetail.trim() : undefined
  const progress = sheet ? childProgressLabel(toolUses, tokens) : undefined

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
  // The two prompt-box densities. The label (drill-in) and the × are SIBLINGS inside one row line — a
  // button can't nest inside a button — with the × sitting DIRECTLY AFTER the title (maintainer
  // 2026-07-27: at the far right it read as too subtle to find) and the recency pushed to the right
  // edge behind it. The × is always visible, quietly: a control you have to discover by hovering is
  // exactly the complaint.
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-op-row={onDismiss ? "" : undefined}>
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
      {/* `flex-1` here is `flex: 1 1 0%` — a ZERO base size, so the step only ever consumes space the
          label did not need. It never pushes the identity out; it just fills what is left and clips.
          The 4rem floor is not cosmetic: with a pure zero basis a long label squeezed the step to
          nothing and left its separator dot stranded against the next reading. Below that floor the
          label yields instead, which is the right trade — a step clipped to two words still says what
          KIND of work is in flight. */}
      {step && (
        <span className="flex min-w-[4rem] flex-1 items-center gap-1.5 text-muted/45" title={step} data-child-activity>
          <span aria-hidden className="shrink-0 text-muted/25">·</span>
          <span className="min-w-0 truncate">{step}</span>
        </span>
      )}
      {/* The counters are the row's LOWEST-value reading, so they are the first thing a narrow viewport
          gives up — below `sm` they would cost the label and the step the room they need to say which
          child this is and what it is doing. Both of those matter more than "how many tools so far". */}
      {progress && <span className="hidden shrink-0 tabular-nums text-muted/35 sm:block" data-child-progress>{progress}</span>}
      {reading}
    </div>
  )
}
