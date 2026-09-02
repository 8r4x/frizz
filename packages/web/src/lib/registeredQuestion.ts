// PRODUCER 3 of the shared question model. A ```question fence is parsed into a `ParsedQuestion` by
// questionBlocks.ts; an `agent-question` INTERACTION is converted into one by interactionQuestion.ts;
// and a REGISTERED question — a row a worker created with the `ask` tool — is converted here. All
// three reach QuestionBlockCard as the same thing, which is the whole reason there is one card.
//
// What a registration adds over the other two producers is a STATIC TREE: an option may carry
// `followUps`, questions that become live only once the human picks that option. So a registration is
// not one card but a walk — the root is always live, and a follow-up is live exactly while its parent
// option is chosen. `liveQuestionNodes` performs that walk against the answers staged so far, and
// `registeredAnswer` folds the same walk back into the `QuestionAnswer` payload the worker receives.
//
// A BRANCH NOT TAKEN CONTRIBUTES NOTHING. Deselecting an option does not blank its follow-ups' staged
// answers (the human may come back), but they stop being live, so they never reach the payload: an
// absent follow-up means "not asked", never "asked and skipped".
import type { AskedOption, AskedQuestion, RegisteredQuestionView, QuestionAnswer } from "@frizz/shared"
import type { BlockAnswer, ParsedQuestion } from "./questionBlocks.ts"

/** `A.`, `B.`, … then `AA.` past 26 — the same identifiers every other producer letters options with.
 *  Not decoration: the card derives its free-text row's own identifier from the last option's prefix,
 *  and an operator answering in the composer refers to options by letter. */
function optionLetter(index: number): string {
  let n = index, out = ""
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return `${out}.`
}

/** How one option renders: the chip's LABEL LINE, and optionally a block-markdown BODY inside the chip.
 *  A one-line `description` is the fence convention's trade-off, joined with the em dash the fence
 *  itself uses, so an option written either way renders identically. A MULTI-LINE description is the
 *  option's rich body instead — a list, a code block, a diff — always visible, because it is what the
 *  human is choosing between. A legacy `preview` (reveal-on-select, retired 2026-09-01) folds into the
 *  same body so stored questions keep rendering, just no longer behind a click. */
function optionParts(index: number, opt: AskedOption): { line: string; body?: string } {
  const trade = opt.description?.trim()
  const inline = trade && !trade.includes("\n") ? trade : undefined
  const body = [inline ? undefined : trade, opt.preview?.trim()].filter(Boolean).join("\n\n") || undefined
  return { line: `${optionLetter(index)} ${opt.label}${inline ? ` — ${inline}` : ""}`, ...(body ? { body } : {}) }
}

/** One question of a registration that is CURRENTLY live — the root, or a follow-up whose parent option
 *  is chosen. The path is its address in the staged-answer map; see `childPath`. */
export interface LiveQuestionNode {
  /** `"root"`, then `"root/1.0"` for follow-up 0 under option 1, and so on. Stable across renders and
   *  independent of which branch is taken, so staged text survives a deselect-and-reselect. */
  path: string
  spec: AskedQuestion
  question: ParsedQuestion
  /** The RAW option labels, parallel to `question.options`. The display string carries a letter and a
   *  trade-off; the answer must carry the worker's own label, or it reads its answer back as prose. */
  optionLabels: string[]
  /** 1 for the root. Only for indenting — the limit is enforced at registration. */
  depth: number
}

export const ROOT_PATH = "root"
export function childPath(parent: string, optionIndex: number, followUpIndex: number): string {
  return `${parent}/${optionIndex}.${followUpIndex}`
}

/** Convert one question node into the neutral model the card renders. */
export function toParsedQuestion(spec: AskedQuestion): { question: ParsedQuestion; optionLabels: string[] } {
  const options = spec.options ?? []
  const recommendedIdx = options.findIndex((o) => o.recommended)
  const parts = options.map((o, i) => optionParts(i, o))
  return {
    question: {
      kind: spec.kind,
      danger: spec.danger === true,
      contextMd: spec.question,
      options: parts.map((p) => p.line),
      recommendedIdx: recommendedIdx === -1 ? null : recommendedIdx,
      ...(parts.some((p) => p.body) ? { optionBodies: parts.map((p) => p.body) } : {}),
    },
    optionLabels: options.map((o) => o.label),
  }
}

/** Which option a staged answer has taken, for the purpose of opening a branch. Only a SINGLE-select
 *  question can open one (a `multi` option cannot carry follow-ups — several picked options would open
 *  several branches at once, refused at registration), and typing free text OVERRIDES a chip exactly as
 *  it does everywhere else, so an override closes the branch too. */
function takenOption(spec: AskedQuestion, answer: BlockAnswer | undefined): number | null {
  if (!answer || spec.kind === "multi") return null
  if (answer.text.trim()) return null
  return answer.chosen
}

/** Every question of this registration that is live given what is staged so far, in render order:
 *  the root, then the follow-ups under the option it took, depth-first. */
export function liveQuestionNodes(
  spec: AskedQuestion,
  answers: ReadonlyMap<string, BlockAnswer>,
): LiveQuestionNode[] {
  const out: LiveQuestionNode[] = []
  const walk = (node: AskedQuestion, path: string, depth: number) => {
    const { question, optionLabels } = toParsedQuestion(node)
    out.push({ path, spec: node, question, optionLabels, depth })
    const taken = takenOption(node, answers.get(path))
    if (taken === null) return
    const followUps = node.options?.[taken]?.followUps ?? []
    followUps.forEach((child, i) => walk(child, childPath(path, taken, i), depth + 1))
  }
  walk(spec, ROOT_PATH, 1)
  return out
}

/** Has this node been answered at all? A pick, a toggle, or typed text — any one is an answer. */
export function nodeAnswered(spec: AskedQuestion, answer: BlockAnswer | undefined): boolean {
  if (!answer) return false
  if (answer.text.trim()) return true
  if (spec.kind === "multi") return (answer.chosenSet ?? []).length > 0
  return answer.chosen !== null
}

/** Fold the staged answers back into the payload the worker receives, or undefined when the ROOT is
 *  unanswered — a registration whose root is blank has said nothing, whatever was typed further down a
 *  branch that is no longer live.
 *
 *  Note the asymmetry with `liveQuestionNodes`: a live-but-unanswered FOLLOW-UP is included with an
 *  empty `chosen`, because the human seeing a question and leaving it blank is itself information the
 *  worker should have. Only a branch that was never opened is absent. */
export function registeredAnswer(
  view: Pick<RegisteredQuestionView, "id" | "spec">,
  answers: ReadonlyMap<string, BlockAnswer>,
): QuestionAnswer | undefined {
  if (!nodeAnswered(view.spec, answers.get(ROOT_PATH))) return undefined
  const build = (node: AskedQuestion, path: string): QuestionAnswer => {
    const answer = answers.get(path)
    const labels = (node.options ?? []).map((o) => o.label)
    const chosen = node.kind === "multi"
      ? (answer?.chosenSet ?? []).slice().sort((a, b) => a - b).flatMap((i) => (labels[i] === undefined ? [] : [labels[i]]))
      : takenOption(node, answer) !== null ? [labels[answer!.chosen!]].filter((l) => l !== undefined) : []
    const text = answer?.text.trim()
    const taken = takenOption(node, answer)
    const followUps = taken === null
      ? []
      : (node.options?.[taken]?.followUps ?? []).map((child, i) => build(child, childPath(path, taken, i)))
    return {
      questionId: view.id,
      question: node.question,
      chosen,
      ...(text ? { text } : {}),
      ...(followUps.length > 0 ? { followUps } : {}),
    }
  }
  return build(view.spec, ROOT_PATH)
}
