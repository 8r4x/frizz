import type { TranscriptMessage } from "@fray-ui/shared"

// Rendering-only text choice. The server keeps a generated prompt's full `text` for transcript logic
// and supplies `displayText` only when an exact presentation boundary was validated.
export function messagePresentationText(message: Pick<TranscriptMessage, "text" | "displayText">): string {
  return message.displayText ?? message.text
}

// The CURRENT ASK: the most recent user turn the HUMAN is actually waiting on an answer to. It pins to
// the pane top (ChatView's StickyUserBand) and supplies the retry text after a provider fault, so "who
// wrote it" decides it — not the `user` role, which the transcript also uses for machine-written turns.
//
// Excluded: a QUEUED/optimistic follow-up (it pins to the bottom until it lands), and a SUB-AGENT's
// upward report — `peerFrom` is the server's own tell that a CHILD wrote the turn, and a child
// reporting in is neither an ask nor anything to retry. Without that second guard an orchestrator
// running a dozen children re-pins the band to "Sub-agent «…» reported" on every report, burying the
// human's actual instruction, and a fault retry would resend the child's words as the human's.
// -1 when the transcript holds no human turn yet.
export function lastAskIndex(messages: readonly Pick<TranscriptMessage, "role" | "queued" | "peerFrom">[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.queued && !m.peerFrom) return i
  }
  return -1
}
