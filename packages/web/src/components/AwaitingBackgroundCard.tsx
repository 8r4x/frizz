// THE resting card — one card, three surfaces. A thread whose top-level turn has come to rest while
// its OWN dispatched work (sub-agents / launched background shells) is still live is not stalled and is
// not waiting on the human: it is waiting on results it kicked off. Server-derived
// (board.deriveAwaitingBackground); this module only renders it.
//
// It renders on the DRAWER and the FULL-SCREEN page, because the rest is a fact about the thread. On the
// QUEUE it renders too — but only for the shape that queues, and the event-Snooze is passed in as
// `actions` there (parking a card is a queue verb, and the queue is where a card you don't want to look
// at costs you something). The drawer and standalone page pass none, since you opened the thread
// deliberately and have nothing to dismiss (maintainer 2026-07-25: "in the drawer or in the full screen
// view, it should not").
//
// WHICH SHAPE QUEUES has flipped twice, and the current split is the point of this card's two voices:
//   • rest on a live SUB-AGENT — excused from the queue (board.deriveNeedsYou, 2026-07-30). The child
//     returns and re-invokes the parent within seconds, so the thread is mid-flight in substance and
//     there is nothing for the human to do. The drawer and the full-screen page are then the ONLY places
//     this state is stated in words, which raises the stakes on the card rather than lowering them.
//   • rest on a background SHELL alone — QUEUED (maintainer 2026-08-04: "if a thread has rested and the
//     only thing remaining is background shells, we should put it into the queue"). A shell is detached;
//     the thread has finished its turn in every sense that matters to the operator, so it is a handoff.
//     Shells were briefly excused too (2026-08-01) and that is what this reverses.
//
// Without it those surfaces showed NOTHING at rest: the shimmer stops and the transcript just ends,
// which reads as "the agent died" for exactly the threads that are healthiest. (The shimmer coming back
// on afterwards is CORRECT, not a bug — a child's <task-notification> lands as a re-invoking user record
// and the parent genuinely resumes; measured 15/15 times on a live worker thread, with idle windows as
// short as 0.13s. This card is what makes that alternation legible.)
import type { ReactNode } from "react"
import { Github, Hourglass, TerminalSquare } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { isDirectSubAgent } from "@frizz/shared"
import { CARD_BODY, CardActions, TranscriptCard } from "./TranscriptCard.tsx"

// Name what the thread is ACTUALLY waiting on. Three real cases, and the sentence has to be true in all
// of them: "sub-agents" is wrong for a shell-only thread (a launched dev server is not a child whose
// result you await), so shells get their own noun; and a thread with BOTH kinds live must name both
// rather than silently dropping the shells behind the agent count.
//
// The noun is "background shell", which is what the maintainer calls them and what the card's own title
// now says (it was the vaguer "background task" while the two shapes shared one title).
//
// The count is DIRECT children only. The sentence below says "it dispatched", and a descendant — a
// sub-agent's own sub-agent, which `subAgents` also carries now so the rows can nest — was dispatched by
// the child, not by this thread's worker. Counting them would make the sentence false.
// PR WATCHERS ARE THE THIRD KIND (2026-08-13), and they are listed exactly like the other two rather
// than getting a card of their own: the awaiting fence no longer offers a park action for `pr-watch`
// (lib/awaitingPresentation), so this card and its event-snooze are the one place a parked watcher is
// stated in words and the one control for hiding it.
export function prWatcherCount(thread: Pick<ThreadView, "watches">): number {
  return (thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed").length
}

// `watchers: false` is for the sentence that ends "…it dispatched": a PR watcher is not dispatched, it
// is PARKED ON, and naming it there makes the sentence false. That branch names it in its own clause.
export function awaitingBackgroundSubject(
  thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">,
  opts: { watchers?: boolean } = {},
): string {
  const agents = (thread.subAgents ?? []).filter((a) => isDirectSubAgent(a) && a.state === "running").length
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  const watchers = opts.watchers === false ? 0 : prWatcherCount(thread)
  // Each kind names itself and the list is comma-joined with a trailing "and" — a thread can genuinely
  // have all three out, and silently dropping one behind another's count is what this replaced.
  const parts = [
    agents > 0 ? `${agents} sub-agent${agents === 1 ? "" : "s"}` : null,
    shells > 0 ? `${shells} background shell${shells === 1 ? "" : "s"}` : null,
    watchers > 0 ? `${watchers} PR watcher${watchers === 1 ? "" : "s"}` : null,
  ].filter((p): p is string => p !== null)
  if (parts.length === 0) return "0 background shells" // unreachable via the card's own gate; never an empty sentence
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

// Whether the thread is genuinely WAITING or merely still has something running — the distinction the
// rail now draws with two different marks (groups.sessionIndicatorKind: a live sub-agent spins, a
// shell-only rest pulses), and the card has to agree with it. A dispatched sub-agent returns and
// re-invokes its parent, so "awaiting the results" is exactly right. A launched dev server never returns
// anything; saying the thread awaits its results describes a wait that is not happening.
function awaitsResults(thread: Pick<ThreadView, "subAgents">): boolean {
  return (thread.subAgents ?? []).some((a) => isDirectSubAgent(a) && a.state === "running")
}

// "when one of them finishes" is false of a single thing, and a thread with exactly one is the common
// case — so the pronoun agrees with the count rather than assuming the plural. Counts BOTH non-agent
// kinds, since either can be the single thing the sentence is about.
function liveShellCount(thread: Pick<ThreadView, "bgShells" | "watches">): number {
  return (thread.bgShells ?? []).filter((s) => s.state === "running").length + prWatcherCount(thread)
}

/** Does the non-waiting sentence's verb have to cover a WATCHER? A shell "finishes"; a watcher never
 *  does — it fires when somebody else acts on the PR — so a thread holding one needs the wider verb. */
function hasWatcher(thread: Pick<ThreadView, "watches">): boolean {
  return prWatcherCount(thread) > 0
}

// The title, and it is CONDITIONAL for the same reason the body sentence is. "Background shells running"
// is the maintainer's own name for the shell-only rest (2026-08-04) and it is the shape that now carries
// a queue card, so that is the title the human meets in the queue. A rest on a live SUB-AGENT is a
// different state on a different surface — it is genuinely awaiting a result, and calling it "background
// shells" would name work it never launched — so it keeps the older title.
//
// The GLYPH follows the title. An hourglass is a WAIT, which is true of the sub-agent rest and false of
// the shell one: a queued handoff behind a detached shell is not waiting on anything, and stamping the
// wait mark on it would contradict the whole reason it is in the queue.
// A WATCHER-ONLY rest gets its own title, because "Background shells running" would name work the
// thread never launched — the same objection that keeps the sub-agent rest on the older title. It also
// has to be a title the human recognises as the park their worker declared, since the awaiting fence no
// longer carries "PR watcher armed" (2026-08-13). A thread holding BOTH reads as shells: those are the
// thing that is actually executing, and the watcher is named in the sentence beneath.
export function awaitingBackgroundLabel(thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">): string {
  if (awaitsResults(thread)) return "Awaiting background work"
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  if (shells === 0 && prWatcherCount(thread) > 0) {
    return prWatcherCount(thread) === 1 ? "PR watcher armed" : "PR watchers armed"
  }
  return "Background shells running"
}

export function AwaitingBackgroundCard({ thread, actions }: {
  thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">
  // The queue card's event-Snooze. Only the QUEUE passes one, and the shapes that reach the queue are
  // the shell-only rest and — since 2026-08-13 — the pr-watch park, whose own fence card no longer
  // offers one. So this is the control for both.
  actions?: ReactNode
}) {
  const waiting = awaitsResults(thread)
  const watcherOnly = !waiting && hasWatcher(thread) && (thread.bgShells ?? []).every((sh) => sh.state !== "running")
  return (
    // The SAME shell as every transcript card (TranscriptCard). This card stacks directly under an
    // awaiting fence card on a queue card, and it used to be a visibly different object there —
    // smaller radius, a washed-out fill, its own padding, no kind header — for the same job.
    <TranscriptCard
      data-awaiting-background
      // THE GLYPH FOLLOWS THE TITLE, which is the rule this card already had for the hourglass: an
      // hourglass is a WAIT, true of the sub-agent rest and false of a detached shell. A watcher-only
      // rest is a third case — a terminal square on a card headed "PR watcher armed" names the wrong
      // runtime entirely — so it takes the same GitHub mark its row in the ops strip and its wake
      // hairline wear.
      icon={waiting ? Hourglass : watcherOnly ? Github : TerminalSquare}
      label={awaitingBackgroundLabel(thread)}
    >
      {/* Both sentences are BODY text (maintainer 2026-07-24): the self-return is a fact about the
          thread, not a caption for the button, so it reads as prose rather than as a label the Snooze
          control drags around with it — and it therefore stays on the surfaces that have no button. */}
      <p className={CARD_BODY}>
        {waiting ? (
          <>
            This agent has come to rest, but it’s awaiting the results from{" "}
            {awaitingBackgroundSubject(thread, { watchers: false })} it dispatched. It returns to the queue on its own
            when the work comes back.
            {/* Its own clause, because a watcher is PARKED ON rather than dispatched — folding it into
                the subject above made the sentence claim the thread had dispatched a PR. */}
            {hasWatcher(thread) && (
              <>
                {" "}It is also watching {prWatcherCount(thread)} pull request{prWatcherCount(thread) === 1 ? "" : "s"}.
              </>
            )}
          </>
        ) : (
          // NOT "it returns to the queue" — this card IS the queue card now, and telling the human it
          // will arrive somewhere they are already looking is the one sentence that cannot be true here.
          // What is true is the resumption: a finished shell notifies its worker, which picks the thread
          // back up on its own. Kept SHORT because the Snooze beside it says the longer version — the
          // body and its action's caption are two surfaces, not one sentence written twice.
          <>
            This agent has come to rest, but it left {awaitingBackgroundSubject(thread)} {hasWatcher(thread) ? "out" : "running"}. It
            resumes on its own when {liveShellCount(thread) === 1 ? "it" : "one of them"}{" "}
            {/* A shell FINISHES; a watcher never does — it fires when somebody else acts on the PR. One
                verb has to cover both when a thread holds both, and "reports" is the honest one: a
                finished shell notifies its worker and a fired watcher hands it the new activity. */}
            {hasWatcher(thread) ? "reports" : "finishes"}.
          </>
        )}
      </p>
      {actions ? <CardActions>{actions}</CardActions> : null}
    </TranscriptCard>
  )
}
