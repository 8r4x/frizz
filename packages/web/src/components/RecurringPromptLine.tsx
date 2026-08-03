import { useId, useState } from "react"
import { ChevronRight } from "lucide-react"
import type { RecurringPrompt } from "@fray-ui/shared"
import { TRANSCRIPT_META_LABEL_CLASS } from "../lib/transcriptMetaLabels.ts"

// A DELIVERED stop hook or heartbeat, in the transcript.
//
// It arrives as an ordinary user turn (fray pastes it into the worker's composer), and it used to
// render as a wake DIVIDER with the whole prompt inline. That was wrong for the same reason a wall of
// tool output would be: a recurring prompt repeats — that is its whole nature — so on a thread being
// driven by one, the same paragraph appears every few minutes and buries the work between the copies.
//
// So it renders as a TOOL CALL does (maintainer 2026-08-02: "it should render like a tool call, not a
// call-out card"): one collapsed line you can scan past, opening to the actual prompt when you want it.
// It borrows MinimalToolActivity's exact disclosure idiom — same meta label scale, same chevron and
// rotation — because a reader should not have to learn a second way to open a thing in one transcript.
//
// The one mark it does not share is the PINK dot, which is the colour this feature has carried since it
// was an interval heartbeat on the sidebar rail. It is the only thing on the line that says "fray spoke
// here, not the human", and it has to do that at a glance in a column of grey.
export function RecurringPromptLine({ bump, sourceId }: { bump: RecurringPrompt; sourceId?: string }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  // "Stop hook" / "Heartbeat · every 10 min" — the cadence belongs in the collapsed line because it is
  // the one fact you cannot recover by opening it: the prompt is inside, the schedule is not.
  const label = bump.kind === "heartbeat"
    ? `Heartbeat${bump.every ? ` · every ${bump.every}` : ""}`
    : "Stop hook"

  return (
    <div data-fray-msg={sourceId} data-recurring-prompt={bump.kind} className="flex min-w-0 flex-col">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={bodyId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label} prompt`}
        className={`group flex w-full min-w-0 items-center gap-1.5 rounded py-0.5 text-left outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 ${TRANSCRIPT_META_LABEL_CLASS}`}
      >
        {/* Sized and positioned in `em` so it tracks the label rather than pinning to today's 14px. A
            round dot has vertically symmetric ink, so centring its BOX centres its ink — the correction
            an asymmetric glyph would need does not arise, and adding one would only move it off. */}
        <span
          aria-hidden
          data-recurring-prompt-dot
          className="size-[0.42em] shrink-0 rounded-full bg-pink-400"
        />
        <span data-recurring-prompt-label className="min-w-0 truncate text-muted">{label}</span>
        <ChevronRight
          aria-hidden="true"
          size={13}
          // Same nudge and rotation the tool-activity disclosure uses — copied deliberately rather than
          // re-derived, so the two rows open identically in one column.
          className={`relative top-[calc(0.032em+1px)] size-[1em] shrink-0 text-muted/70 transition-transform group-hover:text-current ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        // The operator's words only — the trailer that taught the protocol is parsed off, because it is
        // identical on every delivery and is the bulk of what made these unreadable in bulk.
        <div
          id={bodyId}
          data-recurring-prompt-body
          className="mt-1 whitespace-pre-wrap break-words border-l border-border pl-3 text-[13px] leading-relaxed text-muted"
        >
          {bump.prompt}
        </div>
      )}
      {!expanded && <div id={bodyId} hidden />}
    </div>
  )
}
