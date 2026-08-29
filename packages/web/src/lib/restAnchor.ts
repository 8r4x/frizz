// WHICH MESSAGE THE THREAD LAST RESTED ON — the anchor the awaiting card belongs to.
//
// An awaiting card states a REST: "the worker stopped here, on these waits". Until 2026-08-28 every
// transcript surface keyed it on the last assistant MESSAGE instead (ChatView.lastAssistantIndex), and
// the two come apart the moment the human bumps the thread: the reply starts streaming, the last
// assistant message is now the reply, and the fence the worker rested on reads as settled — card gone,
// while the "Agent rested" hairline under it stays. A rest with no fence at all (a worker parked on
// registered rows alone) had it worse: the resting card at the tail is gated on turn-idle, so the bump
// left NOTHING at the rest. Maintainer, with three screenshots: "it renders the third image, which
// doesn't show the card at all, but it does continue rendering the agent's hairline. This is nuts."
//
// The rest itself is in the transcript — the server emits a `boundary:"rest"` event at every one
// (transcript.ts restMessage), and the client only hides the ones whose surroundings already say it. So
// the anchor is the last assistant utterance before the LAST rest event: the message the worker
// actually stopped on, which stays put while the reply streams and moves only when the worker rests
// again. That is the cut a fence goes stale at, and the slot a fenceless rest draws its card in.

export interface RestAnchorMessage {
  role: string
  kind?: string
  boundary?: string
  at?: string
}

/** The last rest in the window: the index of the message the worker rested on and the rest's own
 *  instant. `undefined` when the window holds no rest event — a long turn the human steered mid-flight,
 *  or a window loaded above every rest — in which case a caller falls back to the last assistant
 *  message, which is what every surface keyed on before. `index` is -1 when the rest event is the first
 *  thing in the window: the message it closed is above what is loaded. */
export function lastRest(messages: readonly RestAnchorMessage[]): { index: number; at?: string } | undefined {
  for (let r = messages.length - 1; r >= 0; r--) {
    const m = messages[r]
    if (m.kind !== "event" || m.boundary !== "rest") continue
    for (let i = r - 1; i >= 0; i--) {
      const prev = messages[i]
      // SAID, not a row: an event line (a wake, a compaction, a child returning) carries role:"assistant"
      // and no utterance, and a reasoning summary is punctuation. Same test as lastAssistantIndex.
      if (prev.role === "assistant" && prev.kind !== "event" && prev.kind !== "reasoning") return { index: i, at: m.at }
    }
    return { index: -1, at: m.at }
  }
  return undefined
}
