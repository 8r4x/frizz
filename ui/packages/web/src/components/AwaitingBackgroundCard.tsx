// THE resting card — one card, three surfaces. A thread whose top-level turn has come to rest while
// its OWN dispatched work (sub-agents / launched background shells) is still live is not stalled and is
// not waiting on the human: it is waiting on results it kicked off. Server-derived
// (board.deriveAwaitingBackground); this module only renders it.
//
// It renders on EVERY surface that shows the thread — the queue card, the drawer, and the full-screen
// page — because the rest is a fact about the thread, not a queue-only annotation. What differs is the
// AFFORDANCE: the queue card passes the event-Snooze as `actions` (parking a card is a queue verb, and
// the queue is where a card you don't want to look at costs you something), while the drawer and the
// standalone page pass none — you opened the thread deliberately, so there is nothing to dismiss
// (maintainer 2026-07-25: "in the drawer or in the full screen view, it should not").
//
// Without it those two surfaces showed NOTHING at rest: the shimmer stops and the transcript just ends,
// which reads as "the agent died" for exactly the threads that are healthiest. (The shimmer coming back
// on afterwards is CORRECT, not a bug — a child's <task-notification> lands as a re-invoking user record
// and the parent genuinely resumes; measured 15/15 times on a live worker thread, with idle windows as
// short as 0.13s. This card is what makes that alternation legible.)
import type { ReactNode } from "react"
import { Hourglass } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { CARD_BODY, CardActions, TranscriptCard } from "./TranscriptCard.tsx"

// Name what the thread is ACTUALLY waiting on. Three real cases, and the sentence has to be true in all
// of them: "sub-agents" is wrong for a shell-only thread (a launched dev server is not a child whose
// result you await), so shells fall back to a neutral noun; and a thread with BOTH kinds live must name
// both rather than silently dropping the shells behind the agent count.
export function awaitingBackgroundSubject(thread: Pick<ThreadView, "subAgents" | "bgShells">): string {
  const agents = (thread.subAgents ?? []).filter((a) => a.state === "running").length
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  const agentPart = `${agents} sub-agent${agents === 1 ? "" : "s"}`
  const shellPart = `${shells} background task${shells === 1 ? "" : "s"}`
  if (agents > 0 && shells > 0) return `${agentPart} and ${shellPart}`
  return agents > 0 ? agentPart : shellPart
}

export function AwaitingBackgroundCard({ thread, actions }: {
  thread: Pick<ThreadView, "subAgents" | "bgShells">
  // The queue card's event-Snooze. Omitted on the drawer and the full-screen page.
  actions?: ReactNode
}) {
  return (
    // The SAME shell as every transcript card (TranscriptCard). This card stacks directly under an
    // awaiting fence card on a queue card, and it used to be a visibly different object there —
    // smaller radius, a washed-out fill, its own padding, no kind header — for the same job.
    <TranscriptCard data-awaiting-background icon={Hourglass} label="Awaiting background work">
      {/* Both sentences are BODY text (maintainer 2026-07-24): the self-return is a fact about the
          thread, not a caption for the button, so it reads as prose rather than as a label the Snooze
          control drags around with it — and it therefore stays on the surfaces that have no button. */}
      <p className={CARD_BODY}>
        This agent has come to rest, but it’s awaiting the results from {awaitingBackgroundSubject(thread)} it
        dispatched. It returns to the queue on its own when the work comes back.
      </p>
      {actions ? <CardActions>{actions}</CardActions> : null}
    </TranscriptCard>
  )
}
