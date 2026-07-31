import { useState } from "react"
import { Check, Hash } from "lucide-react"
import { showToast } from "../store.ts"

// A per-message DEBUG HANDLE. Every projected message already carries a `sourceId` — the server's
// stable identity, `<backend>:<sessionId>:<byteOffset>`, where the offset points at the record that
// OPENED the message in the raw session log (see server/src/transcript.ts createTranscriptFold).
// It was previously invisible: reporting "the tool card under my third message renders wrong" meant
// describing the message in prose and hoping the reader found the same bubble.
//
// This chip surfaces it. Copy it, paste it, and `nub ui/scripts/debug-message.mjs <id>` prints BOTH
// sides of the projection seam — the raw record(s) AND the projected TranscriptMessage — which is what
// separates a projector bug (transcript.ts) from a renderer bug (ChatView.tsx) in one read.

// The `<sessionId>` is constant across a thread, so the offset (plus a codex event ordinal) is the
// only part that distinguishes two messages — the compact thing to SHOW. The full id is what copies.
export function shortDebugId(sourceId: string): string {
  const parts = sourceId.split(":")
  return parts.length >= 3 ? parts.slice(2).join(":") : sourceId
}

// ABSOLUTELY positioned, and that is load-bearing rather than cosmetic: an in-flow chip would add
// height to every message, and the standalone transcript's virtualizer re-measures each row via
// measureElement — so a hover-revealed in-flow element would reflow the whole list on mouse move.
// Zero layout participation ⇒ zero measurement churn.
//
// `side` follows the message's own alignment, and both variants are placed to CLEAR the content
// rather than float over it (measured in a real browser — an earlier `left-0` overlapped the user
// bubble's own first line by 27px):
//   right — assistant prose runs full width, so the chip rides UP into the inter-message gap
//           (STEP is 14px) instead of covering the end of the first line.
//   left  — a user bubble is right-aligned with an empty gutter beside it, so `right-full` parks the
//           chip entirely OUTSIDE the bubble; it never touches the human's own words.
// -top-4 is 16px — the chip's measured height — so its bottom edge lands exactly on its content's top
// edge: fully clear of the prose, and all but 2px of it inside STEP (the 14px inter-message gap).
const SIDE_POSITION = {
  right: "-top-4 right-0",
  left: "top-0 right-full mr-1.5",
} as const

export function MessageDebugId({ sourceId, side = "right" }: { sourceId?: string; side?: "left" | "right" }) {
  const [copied, setCopied] = useState(false)
  if (!sourceId) return null
  const copy = () => {
    if (!navigator.clipboard?.writeText) {
      showToast("Clipboard unavailable — copy from a secure Fray page")
      return
    }
    void navigator.clipboard.writeText(sourceId).then(
      () => {
        setCopied(true)
        showToast("Message debug id copied")
        setTimeout(() => setCopied(false), 1200)
      },
      () => showToast("Clipboard unavailable — copy from a secure Fray page"),
    )
  }
  return (
    <button
      type="button"
      data-message-debug-id={sourceId}
      title={`Copy debug id — ${sourceId}`}
      aria-label={`Copy debug id for this message, ${sourceId}`}
      onClick={copy}
      // Keep the transcript's text selection / focus where it was: the chip is a side-channel, not
      // a participant in the reading flow.
      onMouseDown={(e) => e.preventDefault()}
      className={`absolute ${SIDE_POSITION[side]} z-[8] flex items-center gap-0.5 whitespace-nowrap rounded-md border border-border bg-panel/90 px-1 py-px font-mono text-[9.5px] leading-tight text-muted opacity-0 backdrop-blur-sm transition-opacity hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg/60 group-hover/msg:opacity-100`}
    >
      {copied ? <Check aria-hidden size={9} /> : <Hash aria-hidden size={9} />}
      <span>{copied ? "copied" : shortDebugId(sourceId)}</span>
    </button>
  )
}
