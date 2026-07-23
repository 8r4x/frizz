import { useState, type ComponentType } from "react"
import { ArrowUpRight, ChevronsDownUp, ChevronsUpDown, FileText, Loader2, RotateCcw } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { Tooltip } from "./Tooltip.tsx"
import { MarkAsButton } from "./MarkAsButton.tsx"
import { canRetry } from "../lib/status.ts"
import { retrySession } from "../lib/retrySession.ts"

// The retry message + follow-up now live in lib/retrySession so the sidebar's hover-revealed Retry
// shares this exact recovery path. Re-exported for existing importers.
export { STALLED_RETRY_MESSAGE } from "../lib/retrySession.ts"

// THE shared whole-thread action icons, rendered IDENTICALLY by the queue card header and the thread
// header so the two can never drift. Order left→right runs least→most important, so the primary verb
// sits at the far RIGHT. The verbs SPLIT on kind:
//   • SESSION (non-foreign): doc/open navigation; the full thread additionally exposes Retry for any
//     exited session (crashed or ordinarily rested — both resume through the same follow-up path).
//     Queue headers suppress it so their whole-thread verbs have one persistent home in
//     ThreadLifecycleFooter. Rename lives next to the title in ThreadHeader.
//   • SESSION (foreign): read-only. Only the doc/open NAVIGATION affordances — no kill/archive.
//   • LEGACY (kind !== "session"): the vestigial Mark-as split button, exactly as before.
export function HeaderActions({
  thread,
  onOpen,
  onDoc,
  onDone,
  onCollapse,
  collapsed,
  doneBusy,
  onStatusMutate,
  onStatusApplied,
  onStatusFailed,
  showExitAction = true,
}: {
  thread: ThreadView
  onOpen?: () => void // present only on queue cards → shows the Open-thread (drawer) icon
  onDoc?: () => void // present only on the thread header → shows the fray-document icon
  onDone: () => void // legacy Mark-as "done" path (parent-owned mutation)
  onCollapse?: () => void // queue cards → collapse/expand the card body to just its header
  collapsed?: boolean
  doneBusy?: boolean
  // Mutation pass-through for the LEGACY MarkAsButton choreography. Archive/Snooze callbacks belong
  // to ThreadLifecycleFooter.
  onStatusMutate?: () => void
  onStatusApplied?: () => void
  onStatusFailed?: () => void
  // Queue cards keep every lifecycle verb in their footer. Full thread surfaces expose Retry for an
  // exited session.
  showExitAction?: boolean
}) {
  const isSession = thread.kind === "session"
  const isForeign = thread.foreign === true

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onCollapse && (
        <IconBtn
          label={collapsed ? "Expand" : "Collapse"}
          icon={collapsed ? ChevronsUpDown : ChevronsDownUp}
          size={13}
          onClick={onCollapse}
        />
      )}
      {onDoc && <IconBtn label="Fray document" icon={FileText} size={14} onClick={onDoc} />}
      {onOpen && <IconBtn label="Open thread" icon={ArrowUpRight} size={14} onClick={onOpen} />}
      {isSession ? (
        // Foreign sessions are read-only. An exited session leads with recovery — Retry is the only
        // exit-state verb here; clearing a finished row is the footer's job (Mark as done / Snooze).
        showExitAction && !isForeign && canRetry(thread)
          ? <RetryButton slug={thread.id} />
          : null
      ) : (
        <div className="ml-1">
          <MarkAsButton
            slug={thread.id}
            onDone={onDone}
            doneBusy={doneBusy}
            onMutateStart={onStatusMutate}
            onApplied={onStatusApplied}
            onFailed={onStatusFailed}
          />
        </div>
      )}
    </div>
  )
}

// Retry uses the same authoritative recovery path as any other follow-up (see lib/retrySession).
function RetryButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false)
  const apply = () => {
    setBusy(true)
    // retrySession now resolves the session id from the board and passes it to the guarded followUp.
    retrySession(slug).finally(() => setBusy(false))
  }
  return (
    <Tooltip label="Retry — resume this session where it left off">
      <button
        onClick={apply}
        disabled={busy}
        aria-label="Retry exited session"
        onMouseDown={(e) => e.preventDefault()}
        className="ml-1 flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/10 px-2.5 py-1 text-[12px] font-medium text-accent outline-none transition-colors hover:border-accent/70 hover:bg-accent/15 disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        Retry
      </button>
    </Tooltip>
  )
}

// A quiet icon button with an immediate dark tooltip. onMouseDown-preventDefault keeps DOM focus off the
// button so a click never steals the keyboard from a card's composer. `busy` swaps in a spinner.
function IconBtn({
  label,
  icon: Icon,
  size,
  busy,
  ...rest
}: { label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; size: number; busy?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip label={label}>
      <button
        {...rest}
        aria-label={label}
        onMouseDown={(e) => e.preventDefault()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-muted disabled:opacity-40"
      >
        {busy ? <Loader2 size={size} strokeWidth={2} className="animate-spin" /> : <Icon size={size} strokeWidth={2} />}
      </button>
    </Tooltip>
  )
}
