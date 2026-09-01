import type { TranscriptMessage } from "@frizz/shared"
import { isAnswersMessage } from "./answersMessage.ts"

// Rendering-only text choice. The server keeps a generated prompt's full `text` for transcript logic
// and supplies `displayText` only when an exact presentation boundary was validated.
export function messagePresentationText(message: Pick<TranscriptMessage, "text" | "displayText">): string {
  return message.displayText ?? message.text
}

// The CURRENT ASK: the most recent user turn the HUMAN is actually waiting on an answer to. It
// supplies the retry text after a provider fault, so "who wrote it" decides it — not the `user` role,
// which the transcript also uses for machine-written turns.
//
// Excluded: a QUEUED/optimistic follow-up (it has not landed yet), and a SUB-AGENT's upward report —
// `peerFrom` is the server's own tell that a CHILD wrote the turn, and a child reporting in is neither
// an ask nor anything to retry; a fault retry would resend the child's words as the human's.
// -1 when the transcript holds no human turn yet.
export function lastAskIndex(messages: readonly Pick<TranscriptMessage, "role" | "queued" | "peerFrom">[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user" && !m.queued && !m.peerFrom) return i
  }
  return -1
}

export type HumanTurnLike = Pick<TranscriptMessage, "role" | "text"> &
  Partial<Pick<TranscriptMessage, "displayText" | "kind" | "queued" | "wake" | "peerFrom">>

// THE MOST RECENT INTERACTION — the last turn the human themself put into the thread. The QUEUE CARD
// opens here, so it is stricter than the ask above: the card does not merely quote this message, it
// starts at it, and everything before it is history the drawer holds.
//
// Anything frizz composed is therefore out, not just anything frizz delivered. A `wake` user record is
// frizz writing as the user — the Goal delivery, the sign-off reminder, a watcher wake — and cutting
// there opened the card on frizz's own boilerplate with the human's task hidden above it (maintainer
// 2026-08-12: "queue cards STILL need to go all the way back to the last user message. that's important
// context that needs to be surfaced"). A `peerFrom` record is a SUB-AGENT reporting up, which is the
// same defect with a different writer. A QUEUED send has not been delivered, so nothing after it is a
// reply to it.
//
// …EXCEPT THE ONE TURN FRIZZ DELIVERS THAT THE HUMAN WROTE: the answer to a REGISTERED question
// (`mcp__frizz__ask`). It rides in as a scheduler wake because the human may have answered while the
// worker's process was down — so `wake` alone cannot decide the writer, and isAnswersMessage is the
// same tell the chat already draws it by. Answering is a steer like any other; walking past it back to
// the ask before it made the card repaint the whole already-answered iteration under the human's
// original message, twice over (maintainer 2026-08-31: "the cue card should only go back to the most
// recent user interaction").
//
// 0 — the whole loaded transcript — when the human has written nothing in it yet.
export function lastHumanTurnIndex(messages: readonly HumanTurnLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user" || m.queued || m.peerFrom) continue
    if (m.wake && !isAnswersMessage(m)) continue
    return i
  }
  return 0
}
