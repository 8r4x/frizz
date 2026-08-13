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
//   - A SCHEDULER WAKE (`wake: true` — a pr-watch delivery, a timer, a watcher). It names WHAT
//     RE-INVOKED THE AGENT, and NOTHING ELSE on the card represents it. Hiding it left a card that
//     showed a park on a PR watcher and then, with nothing in between, more work — reading as a watcher
//     wake that had never happened (maintainer 2026-08-12: "there's no indication of the PR Watcher
//     triggering and actually causing the additional follow-ups"). The Goal's own bump stays out, per
//     isGoalBump.
//
// A `boundary:"wake"` divider does NOT survive, and the asymmetry is the point. That one is a background
// task or sub-agent COMPLETION, and its LAUNCH card is already lifted out of this same span carrying the
// terminal state and the duration — so keeping it renders one event twice, and in the wrong order, since
// the completions flow in transcript order while the launches are one synthesized row emitted at the
// foot of the span (maintainer 2026-08-12, on exactly that card: "The ordering here just seems totally
// fucked … four background task completion notifications … then a bunch of bash calls show up right at
// the end"). The launch card is the better of the two: it says both what started and how it ended.
//
// The counting walk and the render loop BOTH go through this, so the divider can never promise the
// expansion a message it is already showing.
export function survivesQueueCollapse(m: CollapseMsgLike, index: number, superseded: ReadonlySet<number>): boolean {
  if (hasQuestionBlock(m.text)) return !superseded.has(index)
  return m.wake === true && !isGoalBump(m)
}

/** Does this message OPEN a new collapse segment — i.e. is it the scheduler wake that re-invoked a
 *  rested agent? An open ask survives the fold too (above) but does not start a segment: the agent asked
 *  and kept working, which is one continuous run of work, not a new one. */
export function opensQueueSegment(m: CollapseMsgLike): boolean {
  return m.wake === true && !isGoalBump(m)
}

// ---- SEGMENTS -------------------------------------------------------------------------------------
//
// ONE FOLD PER WAKE, not one fold per card.
//
// The card used to compute a single span — the agent's first prose after the human's ask through its
// last prose anywhere — and hang one divider off it. Wakes were lifted OUT of that span but did not
// SPLIT it, so a thread frizz had driven across five wakes rendered as: opening prose, five hairlines in
// a row, one fold, closing prose. Every hairline was detached from the work it explained, and the fold
// claimed a single run for five separate ones.
//
// A wake now CUTS. Each segment is [what re-invoked the agent → the prose it rested on], folds its own
// calls, and shows its own closing message, so the card reads down the page as the thread actually ran
// (maintainer 2026-08-12: "collapse everything starting at the point where the watcher was triggered up
// until it comes to rest… multiple messages in their complete form, with various collapsed tool call
// blocks between them, plus some hairline indicators showing why they were reawoken").
//
// THE SEGMENT SPANS THE WHOLE RUN, not just [open..close]. Calls made after the closing prose used to
// sit outside the fold and render as raw rows at the foot of the card — the tail of exactly the ordering
// the maintainer reported ("a bunch of bash calls show up right at the end"). They are the same run's
// work and they fold with it.

/** One message's shape, reduced to the six facts the segment walk needs. The caller evaluates them
 *  (they need the transcript schema and the card's own render predicates); this stays pure so the walk
 *  itself is unit-testable. */
export interface CollapseStep {
  /** Contributes nothing to the card at all — a queued send, or a message that renders nothing. */
  skip?: boolean
  /** Contributes visible PROSE, so it can anchor a segment's opening or closing row. */
  text?: boolean
  /** Tool calls this message would hand to a fold. Zero for a sub-agent completion marker, which renders
   *  as a divider rather than a card — counting it would promise a tool the expansion never shows. */
  tools?: number
  /** Would read as a hidden STEP if folded (it renders something a reader could have seen). */
  countable?: boolean
  /** Lifted out of the fold onto its own row — an open ask, or a wake. */
  survives?: boolean
  /** Starts a new segment (`opensQueueSegment`). The wake itself belongs to no segment. */
  opens?: boolean
}

export interface CollapseSegment {
  /** First index in the run — the message after the wake, or the first after the human's ask. */
  start: number
  /** Last index in the run — the message before the next wake, or the last message. */
  end: number
  /** First index contributing prose, rendered text-only above the fold; -1 when the run has none. */
  open: number
  /** Last index contributing prose, rendered text-only below the fold; -1 when the run has none. */
  close: number
  /** Messages hidden whole. */
  steps: number
  /** Tool calls the fold carries. */
  tools: number
  /** This run opened on a WAKE rather than on the human's ask. */
  woken: boolean
}

/** Split `[from .. end]` into one segment per wake. The wake messages themselves are excluded — they
 *  render as their own hairline at each boundary. */
export function queueCollapseSegments(steps: readonly CollapseStep[], from: number): CollapseSegment[] {
  const segments: CollapseSegment[] = []
  let current: CollapseSegment | undefined
  const close = () => {
    if (current && current.start <= current.end) segments.push(current)
    current = undefined
  }
  for (let i = Math.max(0, from); i < steps.length; i++) {
    const s = steps[i]
    if (s.skip === true) continue
    if (s.opens === true) {
      close()
      current = { start: i + 1, end: i, open: -1, close: -1, steps: 0, tools: 0, woken: true }
      continue
    }
    if (!current) current = { start: i, end: i, open: -1, close: -1, steps: 0, tools: 0, woken: false }
    current.end = i
    current.tools += s.tools ?? 0
    if (s.text === true) {
      if (current.open < 0) current.open = i
      current.close = i
    }
  }
  close()
  // The hidden-step count is a SECOND pass because it needs the run's own open/close, which is only
  // known once the run has ended.
  for (const seg of segments) {
    for (let i = seg.start; i <= seg.end; i++) {
      const s = steps[i]
      if (s.skip === true || s.survives === true) continue
      if (i === seg.open || i === seg.close) continue
      if (s.countable === true) seg.steps++
    }
  }
  return segments
}

/** Is this run worth folding?
 *
 *  A WOKEN run folds on the strength of anything hidden at all: its wake hairline is the anchor above it,
 *  and "the watcher fired and then twelve calls happened" is precisely the run the maintainer asked to
 *  see collapsed — even when the agent narrated it in a single message.
 *
 *  THE FIRST run, which opens on the human's ask, additionally needs DISTINCT opening and closing prose.
 *  That is today's rule kept deliberately: a lone agent turn has nothing intermediate, and hiding its own
 *  batched calls behind a divider that stands between the ask and the only answer reads as the card
 *  withholding the answer rather than summarizing the work. */
export function segmentFolds(seg: CollapseSegment): boolean {
  if (seg.open < 0) return false
  if (seg.tools < 1 && seg.steps < 1) return false
  return seg.woken || seg.open !== seg.close
}
