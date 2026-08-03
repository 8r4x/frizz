import { Repeat, Timer } from "lucide-react"
import type { RecurringPrompt } from "@fray-ui/shared"
import { WakeDivider } from "./WakeDivider.tsx"

// A DELIVERED stop hook or heartbeat, in the transcript: a HAIRLINE NOTIFICATION, the same one every
// other child event in this app wears.
//
// It arrives as an ordinary user turn (fray pastes it into the worker's composer), so left alone it
// rendered as the human's own off-white bubble — claiming the operator had typed a paragraph the
// scheduler composed, and repeating that paragraph in full every few minutes on any thread actually
// being driven by one.
//
// It briefly rendered instead as a bespoke collapsible row, which was worse for a reason worth
// recording: it was BUILT to look like a tool call rather than BEING one, so it matched nothing —
// "that is not what the rest of our tool calls look like… our tool calls have a consistent UI"
// (maintainer 2026-08-03). Inventing a third idiom to sit between two existing ones is how a transcript
// stops reading as one surface.
//
// WakeDivider is the right home and needed no argument: a beat or a bump is exactly the class it
// already serves — something outside the turn reached a notable state and re-invoked the agent — beside
// a background shell resting, a Monitor timing out, a sub-agent finishing or reporting up, and a
// pr-watch wake. It also gets the family's centred rule, petite-caps label, icon sizing and measured
// optical nudge for free, which is the whole reason that component exists.
//
// The label is the WHOLE notification: no disclosure, no prompt body. The delivered text is the armed
// text, and the armed text is already legible and editable in the footer panel — so repeating it inline
// on every delivery adds nothing a reader cannot already get, which is the failure both earlier
// renderings shared.
export function RecurringPromptLine({ bump, sourceId }: { bump: RecurringPrompt; sourceId?: string }) {
  const heartbeat = bump.kind === "heartbeat"
  // The cadence rides in the label because it is the one fact the panel cannot tell you about THIS
  // delivery: which schedule was in force when it fired.
  const label = heartbeat
    ? `Heartbeat${bump.every ? ` · every ${bump.every}` : ""}`
    : "Stop hook"
  return (
    <WakeDivider
      // TWO glyphs here, one per feature, because a divider marks ONE delivery and the two deliveries
      // answer different questions: a clock for the heartbeat, a loop for the stop hook (which has no
      // clock — it fires because the thread stopped, again). The footer's trigger is deliberately a
      // THIRD mark, a pulse, because it stands for both at once (see StopHookControl).
      //
      // The stop hook's was `CircleStop`, and in a wake line that is backwards: this divider exists to
      // say the agent was RE-INVOKED, and a stop button in the transcript reads as the run ending here.
      // Same square-in-a-circle the footer shed on 2026-08-03, for a related reason.
      icon={heartbeat ? Timer : Repeat}
      sourceId={sourceId}
      marker={heartbeat ? "heartbeat" : "stop-hook"}
      ariaLabel={label}
    >
      {label}
    </WakeDivider>
  )
}
