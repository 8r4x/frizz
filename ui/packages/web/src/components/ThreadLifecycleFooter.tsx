import { useState } from "react"
import { Check, Hourglass, Loader2 } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { threadLifecycleAvailability, completionArchivesImmediately } from "../lib/threadLifecycle.ts"
import { futureSnoozedUntil } from "../groups.ts"
import { formatSnoozeWake, formatUserSnooze, snoozePromptPreview } from "../lib/snooze.ts"
import { SnoozeButton } from "./SnoozeButton.tsx"
import { Dialog } from "./ui/Dialog.tsx"

// The sole home for whole-thread lifecycle controls. Queue cards render it at their natural bottom;
// full thread surfaces make it sticky below every tab. Keeping this separate from HeaderActions and
// message/fence rendering prevents the completion action from jumping or duplicating after transcript hydration.
export function ThreadLifecycleFooter({
  thread,
  sticky = false,
  safeArea = false,
  onArchived,
  onDismissCancel,
  onSnoozed,
}: {
  thread: ThreadView
  sticky?: boolean
  // The full thread view places this footer at the physical bottom of a drawer. Keep the device
  // inset here, after the lifecycle controls, rather than padding the chat footer below the prompt.
  safeArea?: boolean
  onArchived?: () => void
  // Undo an OPTIMISTIC dismissal (see StateButton): the queue passes this so a card that faded on click
  // can be un-hidden the instant the server declines to complete (needs confirmation, or errors). Absent
  // ⇒ the button stays non-optimistic (the drawer footer, where there is no queue card to reinstate).
  onDismissCancel?: () => void
  onSnoozed?: () => void
}) {
  const available = threadLifecycleAvailability(thread)
  if (!available.footer) return null
  return (
    <footer
      aria-label="Thread lifecycle actions"
      data-thread-lifecycle-footer
      className={`${sticky ? "z-20" : "rounded-b-[7px]"} flex min-h-10 shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border/70 bg-panel/95 px-3 pt-2 ${safeArea ? "pb-[max(0.5rem,env(safe-area-inset-bottom))]" : "pb-2"} backdrop-blur-sm`}
    >
      <PendingSnooze thread={thread} />
      {available.snooze && <SnoozeButton thread={thread} onSnoozed={onSnoozed} />}
      <StateButton thread={thread} onArchived={onArchived} onDismissCancel={onDismissCancel} />
    </footer>
  )
}

// The park is otherwise invisible from inside the thread: the sidebar carries the only snooze
// affordance-at-rest (an hourglass whose tooltip you have to hover), and a follow-up no longer clears
// the snooze — so without this you could type into a thread, watch it answer, and never learn it was
// still going to drop back out of your queue. States it in the one place both surfaces share.
// `mr-auto` pins it left while the lifecycle buttons stay right-aligned; it wraps under them when the
// card is too narrow to hold both.
function PendingSnooze({ thread }: { thread: ThreadView }) {
  const until = futureSnoozedUntil(thread)
  if (!until) return null
  const prompt = thread.snoozePrompt?.trim()
  return (
    <span
      data-pending-snooze
      title={formatUserSnooze(until, thread.snoozePrompt) ?? undefined}
      className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted/75"
    >
      <Hourglass size={11} className="shrink-0 text-muted/60" />
      <span className="shrink-0">
        {prompt ? "Bumps" : "Snoozed until"} {formatSnoozeWake(until)}
      </span>
      {/* The prompt is the difference between "the card comes back" and "the agent gets sent this",
          so it earns space when there is any — truncated, with the full text in the title above. */}
      {prompt && <span className="truncate text-muted/50">· {snoozePromptPreview(prompt)}</span>}
    </span>
  )
}

// Also rendered — deliberately redundant — as a white primary button at the bottom of the in-chat
// ```done card (see FenceCard). Same completion mutation and live-session confirmation flow; only the
// chrome differs, via `className`. There is deliberately NO Reopen state: reopening a thread is done by
// sending it another message, so the button is always "Mark as done".
export function StateButton({
  thread,
  onArchived,
  onDismissCancel,
  className = "border border-border-strong bg-panel-2/60 px-2.5 py-1 text-fg/80 hover:bg-panel-2 hover:text-fg",
}: {
  thread: ThreadView
  onArchived?: () => void
  // Undo an optimistic dismissal (queue only). Present ⇒ the click may dismiss the card BEFORE the RPC
  // returns and reinstate it if the server declines; absent ⇒ the button waits for the round-trip.
  onDismissCancel?: () => void
  className?: string
}) {
  // Disables the instant it's clicked. On success we DON'T reset it: the card is dissolving, so the
  // button stays disabled (still reading "Mark as done", no spinner) for the whole fade-out rather
  // than flickering back to enabled under the animation. Only a live-session confirmation prompt
  // (re-enables under the dialog) or a failure (re-enables in place) clears it.
  const [pending, setPending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // `optimistic`: fade the card NOW (before the RPC) rather than after the round-trip. Only when a
  // reinstate path exists AND the completion is predicted to archive immediately — so the common resting
  // "done" card feels instantaneous, while an executing turn still waits and shows the confirm dialog.
  const complete = (terminateLive: boolean, optimistic: boolean) => {
    setPending(true)
    if (optimistic) onArchived?.() // start the exit animation immediately
    rpc
      .completeThread({ slug: thread.id, terminateLive })
      .then((result) => {
        if (result.needsConfirmation) {
          // The server wants confirmation after all (an executing/ambiguous turn, or a rare mispredict).
          // Reinstate the optimistically-dismissed card (onDismissCancel cancels its pending unmount too),
          // then open the dialog over it. The server returns needsConfirmation from a cheap liveness/telemetry
          // check BEFORE any tmux kill, so this reply normally lands before the card's exit and the button is
          // still mounted → the dialog opens. If it arrives after the card already unmounted (a slow reply
          // under event-loop contention), the card still reinstates but this setConfirmOpen no-ops on the
          // gone instance — the user simply sees the card return and can click again. Safe either way.
          if (optimistic) onDismissCancel?.()
          setConfirmOpen(true)
          setPending(false)
          return
        }
        setConfirmOpen(false)
        showToast("Done")
        if (!optimistic) onArchived?.() // non-optimistic path dismisses now; optimistic already did
      })
      .catch((error) => {
        if (optimistic) onDismissCancel?.() // roll the card back into the queue on failure
        showToast(`Couldn’t finish: ${(error as Error).message.slice(0, 80)}`)
        setPending(false)
      })
  }
  const canOptimistic = !!onArchived && !!onDismissCancel && completionArchivesImmediately(thread)
  return (
    <>
      <button
        type="button"
        // The server owns the execution verdict. A live tmux shell can be resting at its provider
        // prompt, in which case Done should immediately stop it and archive the thread.
        onClick={() => complete(false, canOptimistic)}
        disabled={pending}
        aria-label="Mark as done"
        title="Mark as done"
        onMouseDown={(event) => event.preventDefault()}
        className={`flex items-center gap-1.5 rounded-md text-[12px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-45 ${className}`}
      >
        <Check size={12} />
        Mark as done
      </button>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open)
        }}
        title="End this session?"
        className="w-[390px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmOpen(false)}
              className="rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => complete(true, false)}
              className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {pending && <Loader2 size={12} className="animate-spin" />}
              End session &amp; mark done
            </button>
          </>
        }
      >
        <p className="p-4 text-[12px] leading-relaxed text-muted">
          This thread is still running. Marking it done will stop its agent session, then move it to Done.
        </p>
      </Dialog>
    </>
  )
}
