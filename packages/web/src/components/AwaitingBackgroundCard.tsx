// THE resting card — one card, three surfaces. A thread whose top-level turn has come to rest while
// its OWN dispatched work (sub-agents / launched background shells) is still live is not stalled and is
// not waiting on the human: it is waiting on results it kicked off. Server-derived
// (board.deriveAwaitingBackground); this module only renders it.
//
// It renders on the DRAWER and the FULL-SCREEN page, because the rest is a fact about the thread. It
// used to render on the queue card too, with the event-Snooze passed as `actions` (parking a card is a
// queue verb, and the queue is where a card you don't want to look at costs you something) — the drawer
// and standalone page passed none, since you opened the thread deliberately and have nothing to dismiss
// (maintainer 2026-07-25: "in the drawer or in the full screen view, it should not").
//
// SINCE 2026-08-01 there is no queue surface at all: a thread resting on live own work is excused from
// the queue outright, so the running rail and the queue can never both claim it. The `actions` prop and
// the Snooze it carries are therefore vestigial — no caller passes one — and these two surfaces are the
// ONLY place this state is stated in words. That raises the stakes on the card rather than lowering
// them: without it, opening such a row shows a transcript that simply ends at rest.
//
// Without it those two surfaces showed NOTHING at rest: the shimmer stops and the transcript just ends,
// which reads as "the agent died" for exactly the threads that are healthiest. (The shimmer coming back
// on afterwards is CORRECT, not a bug — a child's <task-notification> lands as a re-invoking user record
// and the parent genuinely resumes; measured 15/15 times on a live worker thread, with idle windows as
// short as 0.13s. This card is what makes that alternation legible.)
import type { ReactNode } from "react"
import { Hourglass } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { isDirectSubAgent } from "@fray-ui/shared"
import { CARD_BODY, CardActions, TranscriptCard } from "./TranscriptCard.tsx"

// Name what the thread is ACTUALLY waiting on. Three real cases, and the sentence has to be true in all
// of them: "sub-agents" is wrong for a shell-only thread (a launched dev server is not a child whose
// result you await), so shells fall back to a neutral noun; and a thread with BOTH kinds live must name
// both rather than silently dropping the shells behind the agent count.
//
// The count is DIRECT children only. The sentence below says "it dispatched", and a descendant — a
// sub-agent's own sub-agent, which `subAgents` also carries now so the rows can nest — was dispatched by
// the child, not by this thread's worker. Counting them would make the sentence false.
export function awaitingBackgroundSubject(thread: Pick<ThreadView, "subAgents" | "bgShells">): string {
  const agents = (thread.subAgents ?? []).filter((a) => isDirectSubAgent(a) && a.state === "running").length
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  const agentPart = `${agents} sub-agent${agents === 1 ? "" : "s"}`
  const shellPart = `${shells} background task${shells === 1 ? "" : "s"}`
  if (agents > 0 && shells > 0) return `${agentPart} and ${shellPart}`
  return agents > 0 ? agentPart : shellPart
}

// Whether the thread is genuinely WAITING or merely still has something running — the distinction the
// rail now draws with two different marks (groups.sessionIndicatorKind: a live sub-agent spins, a
// shell-only rest pulses), and the card has to agree with it. A dispatched sub-agent returns and
// re-invokes its parent, so "awaiting the results" is exactly right. A launched dev server never returns
// anything; saying the thread awaits its results describes a wait that is not happening.
function awaitsResults(thread: Pick<ThreadView, "subAgents">): boolean {
  return (thread.subAgents ?? []).some((a) => isDirectSubAgent(a) && a.state === "running")
}

export function AwaitingBackgroundCard({ thread, actions }: {
  thread: Pick<ThreadView, "subAgents" | "bgShells">
  // The queue card's event-Snooze — vestigial since the queue surface went away; no caller passes one.
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
        {awaitsResults(thread) ? (
          <>
            This agent has come to rest, but it’s awaiting the results from {awaitingBackgroundSubject(thread)} it
            dispatched. It returns to the queue on its own when the work comes back.
          </>
        ) : (
          <>
            This agent has come to rest, but it left {awaitingBackgroundSubject(thread)} running. It returns to the
            queue on its own when the work finishes.
          </>
        )}
      </p>
      {actions ? <CardActions>{actions}</CardActions> : null}
    </TranscriptCard>
  )
}
