// What the QUEUE CARD's intermediate collapse is allowed to swallow.
//
// The card hides the run between the agent's opening narration and its final message behind one summary
// divider, so a triage card reads "what I asked" → "where it landed" without the wall of tool calls in
// between. Two things must survive that elision, for the same reason the background-task and sub-agent
// dispatch CALLS are lifted out of it (maintainer 2026-08-01: "It's important that those show up in the
// chat") — they are LIFECYCLE, not disposable chatter.
//
// Pure string/shape logic, no DOM and no schema import: the predicates take the structural minimum so
// they stay unit-testable, mirroring answering.ts's AskMsgLike.

import { parseRecurringPrompt } from "@frizz/shared"
import { messagePresentationText } from "./messagePresentation.ts"
import { hasQuestionBlock, splitQuestionBlocks } from "./questionBlocks.ts"

// The minimal message shape these walks need. `displayText` is what the reader actually sees — the
// server strips its own wake-delivery token out of `text` into that field — and it is what the Goal
// trailer must be matched against (see isGoalBump).
export interface CollapseMsgLike {
  text: string
  displayText?: string
  wake?: boolean
  boundary?: "wake" | "compaction" | "rest"
  sourceId?: string
}

// The GOAL firing, which the queue card deliberately does not narrate: on a thread being driven by one,
// rest → bump is the normal cycle, not news (maintainer 2026-08-12: "do not include 'Agent rested' above
// it or the stop hook firing"). Frizz's SIGN-OFF reminder is exempt — that one explains why a fence
// appeared in a message that had already been written, so removing it makes the agent look like it
// answered a question nobody asked.
//
// Matched on the PRESENTATION text, never the raw `text`: the trailer this parses is `$`-anchored, and
// the raw field still carries the server's delivery token after it, so matching `text` silently never
// fires.
export function isGoalBump(m: CollapseMsgLike): boolean {
  if (!m.wake) return false
  const bump = parseRecurringPrompt(messagePresentationText(m))
  return bump !== undefined && bump.kind !== "signoff"
}

// A message's ```question fences, normalized — its identity as an ASK. The surrounding prose is
// deliberately excluded: an agent restating its open questions rewords the lead paragraph every time,
// and the lead is not what the human is being asked to answer.
function askSignature(text: string): string | undefined {
  const blocks = splitQuestionBlocks(text).filter((s) => s.kind === "question")
  if (blocks.length === 0) return undefined
  return JSON.stringify(blocks.map((b) => (b.kind === "question" ? [b.questionKind, b.danger === true, b.text.trim()] : null)))
}

// Indices of asks a LATER message repeats verbatim. An agent woken mid-park — a sub-agent returning, a
// watcher firing — commonly restates its open questions under a fresh lead, and both copies then render
// as live answer cards, so one queue card offered the same pair of decisions twice (maintainer
// 2026-08-12: "The pair of questions it asked at the end was also asked twice"; measured on that thread,
// the two fences were byte-identical and only the lead paragraph differed). The NEWEST copy renders; the
// superseded one collapses with the rest of the run.
//
// PRESENTATION ONLY. selectOpenAsks still makes every ask answerable wherever it sits (maintainer
// 2026-08-03), and answering the surviving copy sends exactly what answering the older one would.
export function supersededAskIndices(messages: readonly CollapseMsgLike[]): Set<number> {
  const lastAt = new Map<string, number>()
  const signatures: (string | undefined)[] = []
  for (let i = 0; i < messages.length; i++) {
    const sig = askSignature(messages[i].text)
    signatures.push(sig)
    if (sig !== undefined) lastAt.set(sig, i)
  }
  const superseded = new Set<number>()
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i]
    if (sig !== undefined && lastAt.get(sig) !== i) superseded.add(i)
  }
  return superseded
}

// Whether a message sitting mid-span keeps its own row instead of collapsing into the summary divider.
//
//   - A ```question. An ask the agent kept working past is a decision the human still owes; collapsing it
//     left the card offering "Send answers" with no question in sight, and the same ask answerable one
//     click away in the drawer. A SUPERSEDED copy is the exception — the newer one carries the decision.
//   - A WAKE: a scheduler delivery, or the `boundary:"wake"` divider a sub-agent or background-shell
//     completion draws. It names WHAT RE-INVOKED THE AGENT, which is the one thing a reader cannot
//     reconstruct from the messages around it. Hiding it left a card that showed a park on a PR watcher
//     and then, with nothing in between, more work — reading as a watcher wake that had never happened
//     (maintainer 2026-08-12: "there's no indication of the PR Watcher triggering and actually causing
//     the additional follow-ups"). The Goal's own bump stays out, per isGoalBump.
//
// The counting walk and the render loop BOTH go through this, so the divider can never promise the
// expansion a message it is already showing.
export function survivesQueueCollapse(m: CollapseMsgLike, index: number, superseded: ReadonlySet<number>): boolean {
  if (hasQuestionBlock(m.text)) return !superseded.has(index)
  return (m.wake === true || m.boundary === "wake") && !isGoalBump(m)
}
