// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the rest it was asked at, and nowhere else.
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
// So: the question belongs to the REST that ended the turn it was asked in — the last message before the
// next human turn. Everything that happened afterwards reads below it, in the order it happened.

export interface AnchorMessage {
  role: string
  kind?: string
  at?: string
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
    // FRIZZ'S OWN DELIVERIES COUNT, and deliberately: a wake is recorded as a user turn, and a question
    // asked before one still belongs above it — the thread moved on, whoever moved it. What is excluded
    // is punctuation with a nominal role (an event line, a reasoning summary), which is not a turn.
    if (m.role !== "user" || m.kind === "event" || m.kind === "reasoning") continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (!Number.isFinite(at) || at <= asked) continue
    return i - 1
  }
  return tail
}

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Questions asked in ONE `ask` call share an instant and therefore a
 *  group, which is what keeps a batch rendering as one stack. */
export function questionsByAnchor<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const byAnchor = new Map<number, Q[]>()
  for (const q of questions) {
    const anchor = questionAnchorIndex(messages, q.askedAt)
    const group = byAnchor.get(anchor)
    if (group) group.push(q)
    else byAnchor.set(anchor, [q])
  }
  return byAnchor
}
