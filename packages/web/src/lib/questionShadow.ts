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
//
// AND THE PLACEMENT IS NOT CONFINED TO THE ASKING REST. The worker contract says the card is drawn "at
// the rest you stopped at", and a worker that rests again after the human replied past the question
// writes its empty ```question qst_… marker into THAT handoff. The marker has to take: the card belongs
// where the prose that sets it up is, not nine hours up the transcript at the rest the row was minted.

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

/** Where each group of registered questions renders, given what the messages from its ask onward
 *  actually wrote. Within one rest the FIRST standing fence takes the group (see above); across rests the
 *  LAST rest with one wins — the newest handoff is the one the human is reading, and a placement in an
 *  older sign-off is history. Two groups placed into the same message share the slot (they send as one
 *  batch there regardless). */
export function placeQuestions<Q extends Pick<RegisteredQuestionView, "id" | "spec"> & { askedAt: string }>(
  messages: readonly (AnchorMessage & { text?: string })[],
  questions: readonly Q[],
): QuestionPlacement<Q> {
  const placed = new Map<number, Q[]>()
  const placedAnchors = new Set<number>()
  for (const [anchor, group] of questionsByAnchor(messages, questions)) {
    let placedAt = -1
    // Whether the rest being walked already holds the group's slot; a human turn opens the next rest.
    let restTaken = false
    for (let i = restStart(messages, anchor); i < messages.length; i++) {
      const m = messages[i]
      if (isTurn(m)) { restTaken = false; continue }
      if (restTaken || !m.text) continue
      const stands = splitQuestionBlocks(m.text).some((seg) => seg.kind === "question" && fenceStandsFor(seg, group) !== undefined)
      if (!stands) continue
      placedAt = i
      restTaken = true
    }
    if (placedAt < 0) continue
    const at = placed.get(placedAt)
    if (at) at.push(...group)
    else placed.set(placedAt, [...group])
    placedAnchors.add(anchor)
  }
  return { placed, placedAnchors }
}
