import { splitQuestionBlocks, parseQuestionBlock, type MessageSegment } from "./questionBlocks.ts"

// Detect + parse OUR OWN composed-answer format, so a user message that is a multi-block answer renders
// as a structured card (echoing the question component) instead of a flat run-on bubble. The format is
// produced by useLiveAnswering.sendAnswers for a message with >1 question block:
//
//   Answers:
//   1. <answer one>
//   2. <answer two>
//   …
//
// — for EVERY live-ask send, a one-block ask included (see composeAnswerWire). Detection is deliberately
// strict: the FIRST non-empty line must be exactly "Answers:", and the body must be numbered "N. …"
// lines. Anything else returns null and the caller falls back to the plain bubble — degrade safely,
// never lose text.
//
// composeAnswerWire has a SECOND form for a batch that answers a BURIED ask (see parseBuriedAnswersMessage):
//
//   Answers to earlier questions:
//   1. “<question>” → <answer>
//
// which carries its own questions inline and so needs no lookback pairing at all. `parseAnswersCard`
// is the entry point that accepts either.

export interface ParsedAnswer {
  n: number
  answer: string
}

// A ParsedAnswer PAIRED with the question it answers — `question` is the originating ```question
// block's context prose (options/recommendation stripped), or undefined when pairing wasn't possible
// (no question message found / count mismatch), in which case the card falls back to numbered rows.
export interface PairedAnswer extends ParsedAnswer {
  question?: string
}

const MARKER = /^(\d+)\.\s+(.*)$/

export function parseAnswersMessage(text: string): ParsedAnswer[] | null {
  if (!text) return null
  // CR/CRLF → LF first: a terminal-injected follow-up arrives carriage-return-separated, which would
  // otherwise leave the whole message on one "line" and defeat detection (see the server's normalizer).
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  // First NON-empty line must be exactly the "Answers:" header.
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length || lines[i].trim() !== "Answers:") return null
  i++

  const out: ParsedAnswer[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(MARKER)
    if (m) {
      out.push({ n: Number(m[1]), answer: m[2] })
    } else if (out.length > 0) {
      // A continuation line of the current answer (an answer that itself spans lines) — keep the break.
      const last = out[out.length - 1]
      last.answer = last.answer ? `${last.answer}\n${line}` : line
    } else if (line.trim()) {
      // Non-empty, non-numbered content before ANY numbered answer → not our clean format; bail.
      return null
    }
  }

  if (out.length === 0) return null
  for (const a of out) a.answer = a.answer.replace(/\s+$/, "") // trim trailing blank continuation lines
  return out
}

const BURIED_HEADER = "Answers to earlier questions:"
const BURIED_ROW = /^(\d+)\.\s+[“"](.*?)[”"]\s+→\s+(.*)$/

// Parse composeAnswerWire's SELF-DESCRIBING form — the one it emits when any answer in the batch targets
// a BURIED ask (a question the agent scrolled past by continuing to work), where a bare "N." would be
// ambiguous about WHICH turn's question it answers:
//
//   Answers to earlier questions:
//   1. “Should the settings store use SQLite?” → A. SQLite
//
// This form is self-contained: each row quotes its own question, so — unlike the "Answers:" form — it
// needs NO lookback and no block-number correlation. That matters, because a buried batch can answer
// questions from SEVERAL different messages at once, which the numbered lookback (pairAnswersMessage)
// could only ever mislabel. Parsing here rather than there is what lets these rows render as the same
// structured card instead of a raw run-on bubble. Same strict/degrade-safely discipline as above: the
// first non-empty line must be the header verbatim, every row must quote-then-arrow, and anything else
// returns null so the caller keeps the plain bubble.
export function parseBuriedAnswersMessage(text: string): PairedAnswer[] | null {
  if (!text) return null
  const lines = text.replace(/\r\n?/g, "\n").split("\n") // CR/CRLF → LF (terminal-injected follow-ups)
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length || lines[i].trim() !== BURIED_HEADER) return null
  i++

  const out: PairedAnswer[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(BURIED_ROW)
    if (m) {
      const question = m[2].trim()
      out.push(question ? { n: Number(m[1]), answer: m[3], question } : { n: Number(m[1]), answer: m[3] })
    } else if (out.length > 0) {
      const last = out[out.length - 1] // a multi-line answer's continuation — keep the break
      last.answer = last.answer ? `${last.answer}\n${line}` : line
    } else if (line.trim()) {
      return null // non-empty, non-row content before ANY row → not our format
    }
  }

  if (out.length === 0) return null
  for (const a of out) a.answer = a.answer.replace(/\s+$/, "")
  return out
}

// Either composed-answer form → card rows. The lookback-free entry point, for a caller that renders one
// message without the surrounding list (the sub-agent sheet); list call sites go through pairAllAnswers.
export function parseAnswersCard(text: string): PairedAnswer[] | null {
  return parseBuriedAnswersMessage(text) ?? parseAnswersMessage(text)
}

// The minimal structural slice of a transcript message the pairing needs — role/kind/text plus the
// server's display projection — so the function stays pure and testable without the shared schema
// (TranscriptMessage satisfies it).
export interface MsgLike {
  role: string
  kind?: string
  text: string
  displayText?: string
}

// THE HUMAN'S TURN IS READ THROUGH ITS DISPLAY PROJECTION, never the raw record. The raw `text` of an
// answers turn is not only what the human typed: frizz appends its own machine-facing tail to the copy
// the worker receives — the clock note (`⏱ Frizz: the message above arrived 4h9m after your last one…`)
// on any reply landing after a long gap — and the transcript is read from the WORKER's record, so that
// tail is part of `text`. The server strips it into `displayText` (see transcript.ts userDisplayText),
// and the plain bubble renders that. This pairing used to read `text` instead, so the numbered parser
// took the note as a continuation line of the LAST answer and the Answers card printed it under the
// human's chosen option, in their own card (reported 2026-08-25: "the freaking time stamps are still
// showing up in my question answers"). The ask blocks of the ASSISTANT turn keep reading `text` — an
// assistant record never carries a projection, and that is the text the human answered.
const answersText = (m: MsgLike): string => m.displayText ?? m.text

// The ```question blocks of the NEAREST EARLIER ask, looking backward from `index` with the same skip
// discipline as useLiveAnswering: kind:"event"/"reasoning" punctuation and text-less (tool-only) turns
// are scanned past, and so is a prose-only assistant message WITHOUT blocks (a worker often follows its
// ask with a note before the human answers). Null when a text-bearing USER message intervenes (an
// earlier human turn claims anything before it — those questions were already answered) or the list
// starts. The `includes` guard keeps the walk cheap: it now runs for every user message, not just the
// ones already known to carry an "Answers:" header.
function nearestAskBlocks(messages: readonly MsgLike[], index: number): MessageSegment[] | null {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "event" || m.kind === "reasoning") continue // punctuation, not a conversation turn
    if (!m.text.trim()) continue // tool-only turn — no narrative to pair with
    if (m.role === "user") return null // an earlier human turn — don't pair across it
    if (!m.text.includes("```question")) continue // interstitial assistant prose — keep looking for the ask
    const blocks = splitQuestionBlocks(m.text).filter((s) => s.kind === "question")
    if (blocks.length > 0) return blocks
  }
  return null
}

const questionOf = (b: MessageSegment): string =>
  b.kind === "question" ? parseQuestionBlock(b.text, b.questionKind, b.danger).contextMd.trim() : ""

// LEGACY single-answer bubbles. Before composeAnswerWire numbered every live send, a ONE-block ask's
// answer went out as bare text with no header at all — so those messages carry no marker to parse and
// there are transcripts full of them. Recover exactly the unambiguous ones: a single-block ask whose
// bare reply is BYTE-IDENTICAL to one of its own option labels, i.e. the human clicked that chip. A
// freeform reply (the "Or skip the questions and reply…" path, or a typed override) matches no option
// and correctly keeps its plain bubble — this must never box an ordinary steer into an Answers card.
function pairBareChipAnswer(text: string, blocks: MessageSegment[]): PairedAnswer[] | null {
  if (blocks.length !== 1) return null // a multi-block ask always numbered its answers — nothing to recover
  const answer = text.trim()
  if (!answer) return null
  const b = blocks[0]
  if (b.kind !== "question") return null
  const parsed = parseQuestionBlock(b.text, b.questionKind, b.danger)
  if (!parsed.options.some((o) => o.trim() === answer)) return null
  const question = parsed.contextMd.trim()
  return [question ? { n: 1, answer, question } : { n: 1, answer }]
}

// Pair an answers-message with the questions it answers. The composed reply targets the ```question
// blocks of the nearest earlier ask (see nearestAskBlocks), so each answer pairs by ITS OWN NUMBER:
// answer `n` ↔ block n (sendAnswers numbers by ORIGINAL block position and filters unanswered blocks,
// so a PARTIAL answer set — "Answers:\n1. A" against a five-block ask — still maps faithfully). An
// out-of-range or non-increasing number means the correlation is unreliable → unpaired rows (never
// mislabel an answer with the wrong question). Returns null when messages[index] isn't an
// answers-message at all — callers fall back to the plain bubble. Unpaired rows keep question undefined
// → the numbered fallback.
export function pairAnswersMessage(messages: readonly MsgLike[], index: number): PairedAnswer[] | null {
  const msg = messages[index]
  if (!msg || msg.role !== "user" || msg.kind === "event") return null
  // The buried form already quotes each question — take it verbatim and skip the lookback entirely
  // (its rows can answer several different messages, which the numbered correlation below can't model).
  const text = answersText(msg)
  const buried = parseBuriedAnswersMessage(text)
  if (buried) return buried
  const answers = parseAnswersMessage(text)
  const blocks = nearestAskBlocks(messages, index)
  if (!answers) return blocks ? pairBareChipAnswer(text, blocks) : null
  if (!blocks) return answers
  // Sanity: numbers must be strictly increasing and within the block range (sendAnswers guarantees
  // both; hand-typed text that violates them gets the safe numbered fallback).
  const sane = answers.every((a, j) => Number.isInteger(a.n) && a.n >= 1 && a.n <= blocks.length && (j === 0 || a.n > answers[j - 1].n))
  if (!sane) return answers
  return answers.map((a) => {
    const q = questionOf(blocks[a.n - 1])
    return q ? { ...a, question: q } : { ...a }
  })
}

// Convenience for the list-map call sites: the pairing for EVERY index in one pass, null at non-answers
// positions. Precomputed where the message list is mapped (a useMemo on the messages identity) so the
// memoized Message's `paired` prop is null — a stable primitive — for every ordinary message, and only
// the (few) answers-messages get a fresh array when the list changes.
export function pairAllAnswers(messages: readonly MsgLike[]): (PairedAnswer[] | null)[] {
  return messages.map((_, i) => pairAnswersMessage(messages, i))
}
