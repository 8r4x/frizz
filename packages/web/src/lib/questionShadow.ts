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

/** The registered questions standing at the same rest as each message, keyed by message index — every
 *  message of a rest maps to that rest's group, so a fence anywhere in the rest can be checked against
 *  it. A rest is what lib/questionAnchor anchors a question to: the run of messages up to the next
 *  human turn. A group anchored above the loaded window (-1) maps to nothing; its rest is not on the page. */
export function registeredAtRest<Q extends { askedAt: string }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
): Map<number, Q[]> {
  const byMessage = new Map<number, Q[]>()
  for (const [anchor, group] of questionsByAnchor(messages, questions)) {
    if (anchor < 0) continue
    // Same turn test as questionAnchorIndex: a human turn closes the rest; punctuation does not.
    for (let i = anchor; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "user" && m.kind !== "event" && m.kind !== "reasoning") break
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

// ---- PLACEMENT: the fence says WHERE the registered card renders ----
//
// The fold above deletes a shadowing fence and lets the registered card land at the end of the rest.
// That is right about which card survives and wrong about where it goes: a worker writes the question
// INTO its handoff — a paragraph of setup, the ask, then what happens either way — and a card that
// jumps to the bottom leaves the setup pointing at nothing (maintainer 2026-08-28: "it's kind of nice
// that they can couch a registered question within some copy"). So the fence's POSITION is the
// placement, and the registered card renders in its slot instead of being dropped.
//
// PLACEMENT IS PER REST, NOT PER QUESTION, and that is a constraint rather than a simplification: the
// stack submits every answer in ONE call (RegisteredQuestionStack — a per-question send half-wakes the
// turn, and the memo settled it as policy 7B), so one rest's questions cannot be scattered across the
// prose behind separate Send buttons. The FIRST fence of the rest that stands for any of them places
// the whole group.
//
// NOTHING IS EVER LOST BY OMISSION. A rest whose message names none of its registrations still renders
// them at the anchor, exactly as before — the worker chooses the position, never whether the human sees
// it. That is the difference between this and gating the render on the worker remembering to write
// something, which would put an unanswerable question behind a `done` nobody can reach.

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

export interface QuestionPlacement<Q> {
  /** The rest's whole registered group, keyed by the index of the message that PLACES it. */
  placed: Map<number, Q[]>
  /** The anchors those groups would otherwise have rendered at, so the anchor path skips them. */
  placedAnchors: Set<number>
}

/** Where each rest's registered questions render, given what its messages actually wrote. */
export function placeQuestions<Q extends Pick<RegisteredQuestionView, "id" | "spec"> & { askedAt: string }>(
  messages: readonly (AnchorMessage & { text?: string })[],
  questions: readonly Q[],
): QuestionPlacement<Q> {
  const placed = new Map<number, Q[]>()
  const placedAnchors = new Set<number>()
  const isTurn = (m: AnchorMessage) => m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
  for (const [anchor, group] of questionsByAnchor(messages, questions)) {
    // A rest above the loaded window has no message on the page to place anything in.
    if (anchor < 0) continue
    let start = 0
    for (let i = anchor; i >= 0; i--) {
      if (isTurn(messages[i])) { start = i + 1; break }
    }
    // Forward, so the FIRST fence of the rest wins — the worker's own reading order.
    for (let i = start; i <= anchor; i++) {
      const m = messages[i]
      if (isTurn(m) || !m.text) continue
      const stands = splitQuestionBlocks(m.text).some((seg) => seg.kind === "question" && fenceStandsFor(seg, group) !== undefined)
      if (!stands) continue
      placed.set(i, [...group])
      placedAnchors.add(anchor)
      break
    }
  }
  return { placed, placedAnchors }
}
