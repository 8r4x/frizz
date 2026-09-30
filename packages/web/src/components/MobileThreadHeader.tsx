import { useMemo, useState } from "react"
import { ArrowLeft, MoreHorizontal } from "lucide-react"
import { useBoard, useTranscript } from "../hooks.ts"
import { threadBySlug } from "../store.ts"
import { displayTitle } from "../groups.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { MOBILE_STATE_WORD, mobileThreadAge, mobileThreadState, turnStartedAt } from "../lib/mobileThread.ts"
import { ThreadActionsSheet, useModelEffortLabel } from "./MobileThreadActionsSheet.tsx"

// THE PHONE THREAD HEADER (mockup v2 §2). The desktop drawer's header is two rows — title and "Last
// active", then an icon strip and a bordered × — and at 390pt it spent 91.5px on controls a phone either
// cannot use (copy a terminal command, open fullscreen) or reaches more easily from a list. This is one
// 56px row: ← back, the title, a subtitle that says where the thread stands, and ⋯ for everything else.
//
// ← IS TODAY'S ×. Same `onClose` the drawer passes — the animated close, the same URL unwind — only the
// glyph and the corner changed. It does NOT take the drawer's initial focus the way × did
// (`data-dialog-initial-focus`): a programmatically focused button matches :focus-visible, so the page
// opened with a lit circle around ←. Focus falls back to the sheet itself, which draws nothing. The browser's own Back does the same thing through the history entry
// opening the thread pushed (lib/router).
//
// The subtitle leads with the STATE because that is what a phone reader opens a thread to learn:
// "Needs you" in the accent (the one thing the accent is for), "Working" in the live green while a turn
// runs, otherwise "Rested" — then the age, then the model and effort. See lib/mobileThread.ts.
//
// Everything the icon strip and the lifecycle footer held — Snooze, Goal, the registered files, Rename,
// Copy link, and Retry / Restart worker / Reload plugins where the header offers them — is in the ⋯
// sheet (ThreadActionsSheet).
export function MobileThreadHeader({ slug, onClose, onStatusApplied }: { slug: string; onClose: () => void; onStatusApplied?: () => void }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const [sheetOpen, setSheetOpen] = useState(false)
  const now = useNowMs()
  const running = thread?.runtime === "running" || thread?.runtime === "spawning"
  // The same transcript query the conversation below already holds (one observer more, no extra read):
  // a running turn's age counts from the message that started it.
  const transcript = useTranscript(slug, { poll: running })
  const turnStart = useMemo(() => turnStartedAt(transcript.data?.messages ?? []), [transcript.data])
  const modelEffort = useModelEffortLabel(thread)
  if (!thread) return null
  const state = mobileThreadState(thread)
  const age = mobileThreadAge(thread, state, turnStart, now)
  const stateClass = state === "needs-you" ? "font-semibold text-accent" : state === "working" ? "font-semibold text-live" : ""
  const title = displayTitle(thread)
  return (
    <header
      data-thread-header
      data-mobile-thread-header
      className="flex min-h-14 shrink-0 items-center gap-0.5 border-b border-border bg-panel py-1 pl-1 pr-1.5"
    >
      <button
        type="button"
        aria-label="Back"
        data-mobile-thread-back
        onClick={onClose}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg/90 outline-none active:bg-hover focus-visible:bg-hover"
      >
        <ArrowLeft size={21} strokeWidth={2.1} />
      </button>
      <div className="min-w-0 flex-1 pl-0.5 leading-[1.25]">
        <div data-mobile-thread-title className="truncate text-[16.5px] font-semibold tracking-[-0.01em]" title={title}>{title}</div>
        <div data-mobile-thread-subtitle data-state={state} className="truncate text-[13px] text-muted">
          <span className={stateClass}>{MOBILE_STATE_WORD[state]}</span>
          {age && <> · {age}</>}
          {modelEffort && <> · {modelEffort}</>}
        </div>
      </div>
      <button
        type="button"
        aria-label="Thread actions"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        data-mobile-thread-more
        onClick={() => setSheetOpen(true)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg/90 outline-none active:bg-hover focus-visible:bg-hover"
      >
        <MoreHorizontal size={21} strokeWidth={2.1} />
      </button>
      {sheetOpen && <ThreadActionsSheet slug={slug} onClose={() => setSheetOpen(false)} onArchived={onStatusApplied} />}
    </header>
  )
}
