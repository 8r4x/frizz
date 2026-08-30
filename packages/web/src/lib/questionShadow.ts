// ONE QUESTION, ONE CARD — folding a ```question fence into the registered question it restates, and
// taking its POSITION while doing it (see PLACEMENT at the foot of this file: the fence's slot is where
// the registered card renders, so a worker can write the ask into the middle of its own handoff).
//
// A worker can ask the same question twice at one rest: register it with `ask` (a row, the durable
// form) and then, at sign-off, write it again as a ```question fence because the contract says the
// fence is the handback. Both producers reach QuestionBlockCard, so the transcript drew the question
// twice, back to back, on the thread page and the queue card (maintainer 2026-08-28: "Same question
// showing up twice in a row" — a release go/no-go registered at 10:11 and re-fenced at 10:11 with
// "(also on the board as a card)" appended, after two PR-watcher wakes had buried the first fence).
//
// The REGISTERED card is the one that survives, and it is not a coin toss: answering it settles the
// row, which is what un-gates `done` and dequeues the thread; answering the fence sends a plain
// follow-up and leaves the row open behind it, so the worker wakes to an answer it cannot `done` past.
// (lib/registeredDone.ts folds the other way — a fenced done beside a registered one keeps the message's
// card — because there the two are the same bytes and nothing is settled by which one is drawn.)
//
// A fence is folded only when it demonstrably RESTATES a registration standing at the SAME REST. A
// different question fenced beside a registered one still renders — the fold never hides a question
// the human has not seen elsewhere on the page. The text rule is deliberately loose about markup (the
// fence wraps `code` and [links](…) that the registration's plain string cannot carry) and about
// trailing prose (the worker appends a parenthetical), and strict about the question itself.
import type { RegisteredQuestionView } from "@frizz/shared"
import { type AnchorMessage, questionsByAnchor } from "./questionAnchor.ts"
import { type MessageSegment, parseQuestionBlock, splitQuestionBlocks } from "./questionBlocks.ts"

/** The rest a question's anchor closes: the index of its first message — the one after the previous
 *  human turn — or 0 for an anchor above the loaded window, whose rest is off the page entirely. */
function restStart(messages: readonly AnchorMessage[], anchor: number): number {
  for (let i = anchor; i >= 0; i--) {
    if (isTurn(messages[i])) return i + 1
  }
  return 0
}

/** Same turn test as questionAnchorIndex: a human turn closes a rest; punctuation does not. */
function isTurn(m: AnchorMessage): boolean {
  return m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
}

/** The registered questions STANDING at each message, keyed by message index: every message of the
 *  rest a question was asked at AND of every rest after it, so a fence anywhere from the ask onward can
 *  be checked against it. A question stands until it is answered or withdrawn, and the human can reply
 *  past one without answering it (the composer is right there) — the worker's NEXT handoff then names
 *  it again, and that fence must fold and place exactly as one at the asking rest does. Until
 *  2026-08-28 only the asking rest saw it, so a placement marker in a later handoff drew nothing and the
 *  card fell back to its anchor — a rest above the queue card's window, which pinned it at the very top
 *  of the card while the handoff below spoke of it as if it sat right there (maintainer: "why is the
 *  question showing up above my last message?"). A group anchored above the loaded window (-1) stands at
 *  every loaded message: its rest is off the page, and everything on the page is later. Human turns map
 *  to nothing — a wake carries no fence of the worker's. */
export function registeredStandingAt<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const byMessage = new Map<number, Q[]>()
  for (const [anchor, group] of questionsByAnchor(messages, questions)) {
    for (let i = restStart(messages, anchor); i < messages.length; i++) {
      if (isTurn(messages[i])) continue
      const at = byMessage.get(i)
      if (at) at.push(...group)
      else byMessage.set(i, [...group])
    }
  }
  return byMessage
}

// Shorter than this and a match says nothing — "Proceed?" restates every go/no-go ever asked.
const MIN_MATCH = 12

/** Markup-blind, whitespace-blind, case-blind text: what the two producers have in common once the
 *  fence's markdown is gone. */
function normalize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** The question proper: everything up to and including the first `?`, or nothing when there is none. */
function head(text: string): string | undefined {
  const at = text.indexOf("?")
  return at === -1 ? undefined : text.slice(0, at + 1)
}

/** Does this ```question fence body restate one of `registered`? The fence's context (its prose above
 *  the option run) either contains the registered question, is a prefix of it, or asks the same thing —
 *  carries its `?`-terminated head, or opens with one the registration carries — with different context
 *  around it. */
export function fenceRestatesRegistered(
  body: string,
  registered: readonly Pick<RegisteredQuestionView, "spec">[],
): boolean {
  if (registered.length === 0) return false
  const context = normalize(parseQuestionBlock(body, "question").contextMd)
  if (context.length < MIN_MATCH) return false
  const contextHead = head(context)
  return registered.some(({ spec }) => {
    const asked = normalize(spec.question)
    if (asked.length < MIN_MATCH) return false
    if (context.includes(asked) || asked.startsWith(context)) return true
    const askedHead = head(asked)
    if (askedHead !== undefined && askedHead.length >= MIN_MATCH && context.includes(askedHead)) return true
    return contextHead !== undefined && contextHead.length >= MIN_MATCH && asked.includes(contextHead)
  })
}

/** Does every ```question fence in this message text restate a registration? False for a text with no
 *  fence at all — there is nothing to fold — so a caller gating chrome on the fenced ask can drop it
 *  exactly when the fold leaves that ask with no card of its own. */
export function allFencesShadowed(
  text: string,
  registered: readonly Pick<RegisteredQuestionView, "id" | "spec">[],
): boolean {
  if (registered.length === 0 || !text.includes("```question")) return false
  const fences = splitQuestionBlocks(text).filter((seg) => seg.kind === "question")
  return fences.length > 0 && fences.every((seg) => seg.kind === "question" && fenceStandsFor(seg, registered) !== undefined)
}

// ---- PLACEMENT IS RETIRED (2026-08-30) ----
//
// The fence used to say WHERE the registered card renders: an empty ```question qst_… marker took the
// rest's whole group into its own slot (`placeQuestions`), so a worker could couch the ask inside its
// handoff. Measured before retiring it: across the 3,005 transcripts on this machine, 15 of 17 real
// markers sat at the TAIL of their message — where the card lands with no marker at all — and 2 were
// genuinely couched mid-prose (maintainer 2026-08-30, choosing "Retire mid-prose placement"). Questions
// now always render at the tail of their rest; one asked above the loaded window renders at the window
// head, as the no-marker fallback always did. The FOLD above survives the retirement — a fence that
// names or restates a registration still draws nothing — so a legacy marker is inert rather than a
// second card, and fenceStandsFor below is the fold's matcher.

/** The registration a ```question fence STANDS FOR, if any: the one its info-string id names, else the
 *  one its prose restates. The id is exact and the prose is not, so a worker that writes
 *  ```question qst_ab12cd34 never depends on the text rule below. */
export function fenceStandsFor<Q extends Pick<RegisteredQuestionView, "id" | "spec">>(
  seg: Extract<MessageSegment, { kind: "question" }>,
  registered: readonly Q[],
): Q | undefined {
  if (seg.registeredId) return registered.find((q) => q.id.toLowerCase() === seg.registeredId)
  return registered.find((q) => fenceRestatesRegistered(seg.text, [q]))
}

