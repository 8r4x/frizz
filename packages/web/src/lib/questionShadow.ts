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

// ---- PLACEMENT: the marker says WHERE the registered card renders ----
//
// An empty ```question qst_… fence is a PLACEMENT MARKER: the registered card whose id it names renders
// in its slot, so a worker can couch a question inside its own handoff — the setup above it, the card,
// then what happens either way — instead of every card landing at the tail of the rest.
//
// It has been in and out once. Built 2026-08-28 (maintainer: "it's kind of nice that they can couch a
// registered question within some copy"), it placed the rest's WHOLE group at the first standing fence,
// with a text-match fallback for a worker that re-fenced the question in prose. Retired 2026-08-30 on
// usage data (15 of 17 real markers sat at the tail, where the card lands with no marker at all). Back
// on 2026-09-11 for a different reason than couching: the free-form ```question fence — a question
// written INTO a fence body — is retired from the contract outright (shared QUESTION_FENCE_RETIRED_AT),
// because a fence's answer is bytes in a later message that nothing tracks, and settling one means
// guessing (PR #33, declined). The marker is the ONE fence a worker still writes, and it is safe
// precisely because it names a ROW: the row is open or answered, and nothing about the fence is ever
// inferred (maintainer 2026-09-11: "a version of the question fence that just contains a reference to
// a specific registered question. Any question identifier that doesn't show up inside one of these
// question reference fences can just show up at the end").
//
// PLACEMENT IS PER QUESTION, BY ID, AND NOTHING ELSE. One marker places exactly the question it names;
// a rest's other questions render at the anchor as they always did; a marker naming an id that is not
// standing at its message draws nothing (the fold below). The 2026-08-28 text-match placement is NOT
// back: prose that restates a registration still FOLDS (draws nothing, so an old-contract worker's
// re-fenced question is never a second card) but never places, because a fuzzy match is exactly the
// guess the marker exists to remove.
//
// THE ANSWERS STILL SEND AS ONE UNIT. The `answerQuestions` RPC takes every staged answer in one call
// (a per-question send would half-wake the worker), so scattering the cards through the prose cannot
// scatter the Send: the cards share ONE answering state (RegisteredQuestionCards' provider) and the
// rest's stack at the anchor carries the one "Send answers" for all of them, placed or not.
//
// NOTHING IS EVER LOST BY OMISSION. A rest whose message names none of its registrations renders them
// at the anchor exactly as before — the worker chooses the position, never whether the human sees it.
// And the placement is NOT confined to the asking rest: a worker that rests again after the human
// replied past the question writes its marker into THAT handoff, and the marker takes there.
//
// BUT A MARKER ONLY PLACES WITHIN THE REST THAT WROTE IT, and that is what `atRest` buys (2026-09-13).
// The scan used to run from the question's own anchor to the end of the loaded window, so a marker from
// an OLD rest kept the card pinned there forever — and the anchor path's at-rest re-anchor (see
// questionAnchor: at rest, every open question belongs to the CURRENT rest) could never reach it,
// because a placed question is subtracted from that path before it runs. The thread then rested again
// with the question still open, the card stayed thousands of pixels up at the rest that asked it, and
// the tail drew the group's bare disabled "Send answers" with nothing above it to answer. Which is the
// 2026-08-31 report — "Why was this able to come to rest without a proper handoff?" — arriving again
// through the marker, reported 2026-09-13 as "How did this thread pause without a sign-off?". At rest
// the scan therefore starts at the CURRENT rest: a worker that wants its card in the handoff writes the
// marker into the handoff, and one that says nothing gets the card at the tail where the rest is.

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
  /** The questions placed INTO each message, keyed by the index of the message whose marker places
   *  them, in registration order. */
  placed: Map<number, Q[]>
  /** Every placed question's id — what the anchor path subtracts, so a placed card is drawn once. */
  placedIds: Set<string>
}

/** The ids a message's markers name, lowercased, in order — the empty-bodied ```question qst_… fences
 *  only. A fence WITH a body is a legacy question (or, under the new contract, prose), never a marker. */
export function markerIdsIn(text: string): string[] {
  if (!text.includes("```question")) return []
  return splitQuestionBlocks(text).flatMap((seg) => seg.kind === "question" && seg.registeredId && seg.text.trim() === "" ? [seg.registeredId] : [])
}

/** Where each registered question renders, given what the messages from its ask onward actually wrote:
 *  the LAST message (the newest handoff — the one the human is reading; an older placement is history)
 *  from the question's rest onward whose empty marker names its id. A question no loaded message names
 *  is absent from `placed` and renders at its anchor. Human turns never place anything — a wake carries
 *  no marker of the worker's.
 *
 *  `atRest` is the same caller knowledge questionsByAnchor takes, and it narrows the scan to the rest
 *  the human is reading: at rest an open question belongs to the CURRENT rest, so only a marker in that
 *  rest places it and a stale one from an older rest lets it fall back to the tail. Mid-flight the
 *  question still belongs to the rest it was asked at, and so does its marker. */
export function placeQuestions<Q extends Pick<RegisteredQuestionView, "id"> & { askedAt: string }>(
  messages: readonly (AnchorMessage & { text?: string })[],
  questions: readonly Q[],
  opts: { atRest?: boolean } = {},
): QuestionPlacement<Q> {
  const placed = new Map<number, Q[]>()
  const placedIds = new Set<string>()
  if (questions.length === 0) return { placed, placedIds }
  // One parse per marker-bearing message, however many questions are open.
  const markersAt = new Map<number, string[]>()
  const markersOf = (i: number): string[] => {
    let ids = markersAt.get(i)
    if (ids === undefined) {
      const m = messages[i]
      ids = m.role === "assistant" && m.text ? markerIdsIn(m.text) : []
      markersAt.set(i, ids)
    }
    return ids
  }
  for (const [anchor, group] of questionsByAnchor(messages, questions, opts)) {
    for (const q of group) {
      const id = q.id.toLowerCase()
      let placedAt = -1
      for (let i = restStart(messages, anchor); i < messages.length; i++) {
        if (isTurn(messages[i])) continue
        if (markersOf(i).includes(id)) placedAt = i
      }
      if (placedAt < 0) continue
      const at = placed.get(placedAt)
      if (at) at.push(q)
      else placed.set(placedAt, [q])
      placedIds.add(q.id)
    }
  }
  return { placed, placedIds }
}

