// PRODUCER 2 of the shared question model. A ```question fence is parsed into a `ParsedQuestion` by
// questionBlocks.ts; an `agent-question` INTERACTION — a native Claude AskUserQuestion tool call, or
// Codex's item/tool/requestUserInput — is converted into the same `ParsedQuestion` here, so both reach
// QuestionBlockCard as the same thing and cannot drift into two looks.
//
// The two shapes line up one-for-one, which is why one component can serve both:
//     AskUserQuestion   { question, header, options:[{label, description}], multiSelect }  + free text
//     ```question fence   a question line, lettered options with one-line trade-offs, an optional
//                         `multi` tag, and a free-text box at the bottom
// `multiSelect` IS `multi`; `options[].label — description` IS an option line.
//
// It also carries the mapping BACK: an interaction answer is submitted as typed field values, so each
// question keeps the field ids and the exact option values its choices must be submitted as. The
// display label and the submitted value are deliberately separate — the label may be clipped or
// scrubbed for the card, while the value must be the provider's exact bytes or the agent reads the
// answer as freeform prose instead of a pick.
import type { InteractionField, InteractionRecord, InteractionValue, InteractionValues } from "@fray-ui/shared"
import type { BlockAnswer, ParsedQuestion } from "./questionBlocks.ts"

/** The field-id suffix the Claude broker uses to pair a question's free-text field with its options.
 *  Mirrors NOTES_FIELD_SUFFIX in server/src/backend/claude-permission-interactions.ts. */
const NOTES_SUFFIX = "_notes"

export interface InteractionQuestion {
  /** The neutral model the shared card renders. */
  question: ParsedQuestion
  /** The field carrying the chosen option(s), if this question offers any. */
  optionFieldId?: string
  /** The exact value to submit for each option, parallel to `question.options`. */
  optionValues: InteractionValue[]
  /** The field carrying free text, if this producer offers a free-text box. */
  notesFieldId?: string
}

/** `A.`, `B.`, … then `AA.` past 26 — the fence convention's option identifiers. */
function optionLetter(index: number): string {
  let n = index, out = ""
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return `${out}.`
}

function questionFor(optionField: InteractionField | undefined, notesField: InteractionField | undefined): InteractionQuestion | null {
  const anchor = optionField ?? notesField
  if (!anchor) return null
  const options = optionField && (optionField.input === "select" || optionField.input === "multi-select")
    ? optionField.options
    : []
  return {
    question: {
      kind: optionField?.input === "multi-select" ? "multi" : "question",
      danger: false,
      // The question itself is the field's description (the provider's full question text); the label
      // is the short header chip, used only when a producer supplied no description.
      contextMd: anchor.description ?? anchor.label,
      // Lettered exactly as a fence's option lines are (`- A. …`). This is not decoration: the card
      // derives the free-text row's own identifier from the last option's prefix, and an operator
      // answering in the composer refers to options by letter. Without it a native question read as
      // a fence question with its letters missing — the one visible difference left between them.
      options: options.map((option, index) => `${optionLetter(index)} ${option.label}`),
      // A tool call has no notion of a recommended option — that is a fray fence convention — so the
      // badge simply does not appear rather than being faked.
      recommendedIdx: null,
    },
    ...(optionField ? { optionFieldId: optionField.id } : {}),
    optionValues: options.map((option) => option.value),
    ...(notesField ? { notesFieldId: notesField.id } : {}),
  }
}

/** Convert an `agent-question` interaction's fields into questions the shared card can render, or null
 *  when some field cannot be expressed as one (a number or boolean prompt) — in which case the caller
 *  keeps the generic typed form rather than silently dropping an input the operator has to fill. */
export function interactionQuestions(record: Pick<InteractionRecord, "payload">): InteractionQuestion[] | null {
  if (record.payload.kind !== "agent-question") return null
  const fields = record.payload.fields
  const out: InteractionQuestion[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    // A secret field must never be rendered as an ordinary answer box; the generic card has the
    // secure-fallback affordance for that, so hand the whole record back to it.
    if (field.secret) return null
    if (field.id.endsWith(NOTES_SUFFIX)) continue // consumed by its option field below
    const next = fields[index + 1]
    const notesField = next && next.id === `${field.id}${NOTES_SUFFIX}` ? next : undefined
    if (field.input === "select" || field.input === "multi-select") {
      const built = questionFor(field, notesField)
      if (!built) return null
      out.push(built)
    } else if (field.input === "text" || field.input === "multiline") {
      // A free-form question (Codex's "other" mode): no options, just the free-text box.
      const built = questionFor(undefined, field)
      if (!built) return null
      out.push(built)
    } else {
      return null // number / integer / boolean — not a question, keep the generic form
    }
  }
  return out.length > 0 ? out : null
}

/** Map the card's staged answers back to typed interaction field values, using EXACTLY the fence
 *  card's own semantics so the two behave identically: for a single-select, free text OVERRIDES a
 *  chosen chip (which is why the chip visibly deselects as you type); for `multi`, free text COEXISTS
 *  with the toggled set and appends colour. Returns undefined when nothing was answered at all. */
export function interactionQuestionValues(
  questions: readonly InteractionQuestion[],
  answers: readonly BlockAnswer[],
): InteractionValues | undefined {
  const values: Record<string, InteractionValue> = {}
  questions.forEach((entry, index) => {
    const answer = answers[index]
    if (!answer) return
    const text = answer.text.trim()
    if (entry.question.kind === "multi") {
      const picked = (answer.chosenSet ?? [])
        .slice()
        .sort((a, b) => a - b)
        .flatMap((optionIndex) => {
          const value = entry.optionValues[optionIndex]
          return value === undefined ? [] : [value as string]
        })
      if (entry.optionFieldId && picked.length > 0) values[entry.optionFieldId] = picked
      if (entry.notesFieldId && text) values[entry.notesFieldId] = text
      return
    }
    if (text) {
      if (entry.notesFieldId) values[entry.notesFieldId] = text
      return
    }
    const chosen = answer.chosen
    if (entry.optionFieldId && chosen !== null && entry.optionValues[chosen] !== undefined) {
      values[entry.optionFieldId] = entry.optionValues[chosen]
    }
  })
  return Object.keys(values).length > 0 ? (values as InteractionValues) : undefined
}
