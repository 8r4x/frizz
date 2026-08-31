// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the thread's CURRENT rest while it is at rest,
// and at the rest it was asked at while the thread has moved past it mid-flight.
//
// A ```question fence needs none of this — it IS a message, so it renders where it was written. A
// REGISTERED question is a row in `thread_question` with no message to live in, so its position is a
// decision, and it was the wrong one until 2026-08-27: the card was pinned above the composer with the
// pending-interaction stack, on the reasoning that neither may scroll out of reach. That holds only
// while the question is the newest thing on the thread. The moment the human replies past it without
// answering — which they may, the composer is right there — the card sits UNDER their own newest
// message and under everything the worker has done since, claiming to be the current ask (maintainer
// 2026-08-27: "Questions are still showing up for me between my most recent message and the agent
// outputs that have happened since that message. That doesn't make any sense. The questions should show
// up in the chat wherever the session came to rest").
//
// The 2026-08-27 fix froze the card at the rest that ended the turn it was asked in — and that reading
// broke on the OTHER half of the same scenario. The human replies past the card, the worker answers the
// follow-up and rests AGAIN with the question still open: the new rest is now the handoff the human
// reads, and it shows no ask at all. The card sits stranded above their own reply, the tail reads as a
// bare stop, and the sign-off nudge rightly stands down because the open row IS the thread's sign-off
// (maintainer 2026-08-31, on exactly that transcript: "Why was this able to come to rest without a
// proper handoff?"). "Wherever the session came to rest" means the CURRENT rest, not the historical one.
//
// So, both halves: while the thread is AT REST with the worker having spoken last, every open question
// anchors to the tail — the rest the human is reading is the rest that owes them the ask. While the
// thread is mid-flight (or the human spoke last and the worker has not picked it up), the question
// belongs to the rest that ended the turn it was asked in — the last message before the next human
// turn — so it never claims currency amid live output or under the human's own newest message.

export interface AnchorMessage {
  role: string
  kind?: string
  at?: string
}

/** A real human turn — a typed reply or one of frizz's own deliveries, which land as user records and
 *  count deliberately (the thread moved on, whoever moved it). Punctuation with a nominal role (an event
 *  line, a reasoning summary) is not a turn. */
function isTurn(m: AnchorMessage): boolean {
  return m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
}

/** Did the WORKER end the loaded exchange — is there assistant output after the last human turn? False
 *  while the human's newest message sits unanswered at the tail, which is the window where an open
 *  question must stay above it rather than jump below it. */
export function agentSpokeLast(messages: readonly AnchorMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return true
    if (isTurn(messages[i])) return false
  }
  return false
}

/** The index of the message this question renders AFTER. `messages.length - 1` when nothing has happened
 *  since (the common case — the worker asked and rested, and the card is still the tail), and `-1` when
 *  the rest it belongs to is older than the loaded window, which puts it at the top of what is loaded
 *  rather than back at the bottom where it would lie about being current. */
export function questionAnchorIndex(messages: readonly AnchorMessage[], askedAt: string): number {
  const asked = Date.parse(askedAt)
  const tail = messages.length - 1
  if (!Number.isFinite(asked)) return tail
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isTurn(m)) continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (!Number.isFinite(at) || at <= asked) continue
    return i - 1
  }
  return tail
}

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Questions asked in ONE `ask` call share an instant and therefore a
 *  group, which is what keeps a batch rendering as one stack.
 *
 *  `atRest` is the caller's live-state knowledge, which the messages alone cannot carry: true when the
 *  thread is neither running nor spawning. At rest with the worker last to speak, every open question is
 *  the CURRENT ask of the CURRENT rest, so the whole set anchors to the tail — questions asked at
 *  different rests collapse into one stack there, in asked order. Without it (or with the human's reply
 *  waiting at the tail) each question keeps the rest that ended the turn it was asked in. */
export function questionsByAnchor<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
  opts: { atRest?: boolean } = {},
): Map<number, Q[]> {
  if (opts.atRest && questions.length > 0 && agentSpokeLast(messages)) {
    return new Map([[messages.length - 1, [...questions]]])
  }
  const byAnchor = new Map<number, Q[]>()
  for (const q of questions) {
    const anchor = questionAnchorIndex(messages, q.askedAt)
    const group = byAnchor.get(anchor)
    if (group) group.push(q)
    else byAnchor.set(anchor, [q])
  }
  return byAnchor
}
