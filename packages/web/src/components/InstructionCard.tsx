// The card for a REGISTERED INSTRUCTION — steps a worker handed the human with `mcp__frizz__instruct`
// (2026-10-03), because only the human can perform them: a sign-in, an approval, a merge, a button the
// worker may not press. It is a row in the question registry, so it renders where a registered question
// does (RegisteredQuestionCard branches here) and holds the thread in the queue the same way — but it
// is not a question, and it does not answer like one.
//
// THERE IS NOTHING TO STAGE. A question collects picks across a whole rest and sends them in one batch,
// because a partial batch would half-wake the worker. An instruction's reply is the act itself, already
// finished by the time the human clicks: "Done" or "Couldn't do it", each sent the moment it is clicked
// and each a wake. So the card carries its own two verbs in the card footer every other card's verb
// lives in, and the rest's "Send answers" never counts it.
//
// NO ×. A dismissed question is the worker's to decide; an instruction the human will not perform is
// still news the worker has to act on, and a silent dismissal would leave it waiting on a reply that
// never comes. "Couldn't do it" is the decline, it wakes the worker, and the note says why. The server
// refuses to dismiss an instruction either way (router `survivesDismissal`).
import { useLayoutEffect, useRef } from "react"
import { ListTodo } from "lucide-react"
import { INSTRUCTIONS_DONE, INSTRUCTIONS_NOT_DONE, type AskedInstructions, type QuestionAnswer } from "@frizz/shared"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { useInlineMarkdownHtml, useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CARD_ACTION_RADIUS, CARD_PRIMARY_ACTION, CardActions, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"

/** The card's kind title, open and settled alike. */
export const INSTRUCTION_LABEL = "For you to do"

export function InstructionCard({
  spec,
  note,
  onNote,
  onComplete,
  sending,
  wrap,
}: {
  spec: AskedInstructions
  /** The note box's content. It lives in the draft store (keyed like a question's free text), so a
   *  half-typed note survives a remount and a worker restart. */
  note: string
  onNote: (text: string) => void
  /** Send the reply: `INSTRUCTIONS_DONE` or `INSTRUCTIONS_NOT_DONE`, with the note beside it. */
  onComplete: (outcome: string) => void
  sending: boolean
  wrap?: boolean
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  // The same auto-growing box the question card's free-text row is: reset to `auto` so it can shrink,
  // then lock to the content height (borders included — box-sizing is border-box).
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`
  }, [note])
  return (
    <TranscriptCard data-instruction surface="question" icon={ListTodo} label={INSTRUCTION_LABEL}>
      <InstructionBody spec={spec} wrap={wrap} />
      <textarea
        ref={taRef}
        data-1p-ignore
        data-surface="questionAnswer"
        rows={1}
        value={note}
        disabled={sending}
        onChange={(e) => onNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Escape") {
            e.preventDefault()
            e.currentTarget.blur()
            return
          }
          // Enter sends the card's PRIMARY verb, as Enter sends the staged answers in a question's box
          // (the three Enter keys every box shares — see shouldSubmitStagedEnter). Shift/Option-Enter
          // still write a newline, and "Couldn't do it" is always a click.
          if (shouldSubmitStagedEnter({
            key: e.key,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
            keyCode: e.nativeEvent.keyCode,
          })) {
            e.preventDefault()
            if (!sending) onComplete(INSTRUCTIONS_DONE)
          }
        }}
        placeholder="Add a note (optional)…"
        // The question card's free-text row, so the two boxes in one stack read as one family.
        className="mt-3 w-full resize-none overflow-hidden rounded-md border border-border bg-transparent px-3 py-1.5 text-[12px] leading-snug text-fg/90 outline-none transition-colors placeholder:text-muted-80 hover:bg-panel-2 focus:border-accent disabled:opacity-60"
      />
      <CardActions>
        <button
          type="button"
          data-instruction-done
          disabled={sending}
          onClick={() => onComplete(INSTRUCTIONS_DONE)}
          onMouseDown={(e) => e.preventDefault()}
          className={`${CARD_PRIMARY_ACTION} disabled:opacity-60`}
        >
          {INSTRUCTIONS_DONE}
        </button>
        {/* The secondary sibling departs from the primary on FILL only, as the provider-fault card's
            Retry does beside its Sign in. */}
        <button
          type="button"
          data-instruction-not-done
          disabled={sending}
          onClick={() => onComplete(INSTRUCTIONS_NOT_DONE)}
          onMouseDown={(e) => e.preventDefault()}
          className={`shrink-0 ${CARD_ACTION_RADIUS} border border-border px-2.5 py-1 text-[11px] font-medium text-fg/90 outline-none transition-colors hover:border-border-strong hover:bg-panel focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-60`}
        >
          {INSTRUCTIONS_NOT_DONE}
        </button>
      </CardActions>
    </TranscriptCard>
  )
}

/** An instruction the human has reported on, in the slot its open card filled: greyed, its title, and
 *  the reply. The steps and context are dropped, as a settled question drops the options nobody picked —
 *  the card is a record of what came back now, not a to-do still waiting. */
export function SettledInstructionCard({ id, spec, answer, wrap }: { id: string; spec: AskedInstructions; answer: QuestionAnswer; wrap?: boolean }) {
  const titleHtml = useInlineMarkdownHtml(spec.question)
  const reply = [answer.chosen.join(", "), answer.text?.trim()].filter(Boolean).join(" — ")
  return (
    <article data-question-id={id} data-settled-question data-instruction aria-label="Reported instruction" className="flex min-w-0 flex-col opacity-60">
      <TranscriptCard surface="question" icon={ListTodo} label={INSTRUCTION_LABEL}>
        <div className="text-fg">
          <LinkedHtml as="span" className={`md-inline font-medium${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={titleHtml} />
        </div>
        {/* The settled question's answer chip: a past reply, never the awaiting-you accent. */}
        <div className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border-strong border-l-2 border-l-accent/40 bg-bg/50 py-1.5 pl-[11px] pr-3 text-[12px] leading-snug text-fg">
          {reply}
        </div>
      </TranscriptCard>
    </article>
  )
}

/** The title, the context and the numbered steps — what the human reads before doing anything. */
function InstructionBody({ spec, wrap }: { spec: AskedInstructions; wrap?: boolean }) {
  const titleHtml = useInlineMarkdownHtml(spec.question)
  const contextHtml = useMarkdownHtml(spec.context ?? "")
  const wrapClass = wrap ? ` ${QUEUE_WRAP}` : ""
  return (
    <>
      {/* FULL strength, as the question card's ask is: the title IS the thing being asked of the human,
          and must never read dimmer than the kind word above it. */}
      <div className="text-fg">
        <LinkedHtml as="span" className={`md-inline font-medium${wrapClass}`} html={titleHtml} />
      </div>
      {contextHtml && <LinkedHtml className={`md-body mt-2${wrapClass}`} html={contextHtml} />}
      {/* One markdown block PER STEP, inside a real list, rather than the steps joined into one markdown
          string: a step may carry its own code block or paragraphs, and a list item's continuation
          lines would have to be re-indented to stay inside it. `md-body` supplies the list rhythm and
          the muted markers the transcript's own lists wear. The steps are the ask, so they are full
          strength — on a WRAPPER, because `.card-md .md-body` inherits colour and outranks a utility on
          the element itself. */}
      <div className="mt-2 text-fg">
        <div className={`md-body${wrapClass}`}>
          <ol data-instruction-steps>
            {spec.steps.map((step, i) => <InstructionStep key={i} md={step} />)}
          </ol>
        </div>
      </div>
    </>
  )
}

function InstructionStep({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return (
    <li>
      <LinkedHtml className="md-body" html={html} />
    </li>
  )
}
