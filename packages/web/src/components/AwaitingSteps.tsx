// THE STEPS on a resting card whose ```awaiting fence hands the human `steps:` (2026-10-03) — things
// only they can perform: a sign-in, an approval, a merge the worker may not make. They ride the fence
// itself rather than a registered row (maintainer 2026-10-03: "I don't think this requires persistently
// registering it. Is there a way to do this just inside of the awaiting card?"), so this is a stratum
// of AwaitingBackgroundCard, not a card of its own.
//
// THE VERBS SEND AN ORDINARY REPLY. "Done" and "Couldn't do it" each send the human's own message — the
// outcome, then their note (stepsReply) — through the same eager follow-up the composer uses, so it
// lands as their bubble, wakes the worker exactly as anything they type would, and rolls back the same
// way if the send fails. Nothing is stored and nothing settles: the fence lives as long as the message
// carrying it, and the reply is what ends it.
import { useLayoutEffect, useRef, useState } from "react"
import { STEPS_DONE, STEPS_NOT_DONE, stepsReply } from "../lib/awaitingPresentation.ts"
import { draftKey, useDraft, useProjectDir } from "../lib/drafts.ts"
import { useEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CARD_PRIMARY_ACTION, CARD_SECONDARY_ACTION, CardActions, QUEUE_WRAP } from "./TranscriptCard.tsx"

/** The numbered steps — what the human reads before doing anything. */
export function StepsList({ steps }: { steps: readonly string[] }) {
  return (
    // One markdown block PER STEP inside a real list, rather than the steps joined into one markdown
    // string: a step carries its own code span or link, and joined steps would each need re-indenting
    // to stay inside their item. `md-body` supplies the list rhythm and the muted markers the
    // transcript's own lists wear. Full strength on a WRAPPER, because `.card-md .md-body` inherits
    // colour and outranks a utility on the element itself — the steps are the ask, never quieter text.
    <div data-awaiting-steps className="mt-2 text-fg first:mt-0">
      <div className={`md-body ${QUEUE_WRAP}`}>
        <ol>
          {steps.map((step, i) => <Step key={i} md={step} />)}
        </ol>
      </div>
    </div>
  )
}

function Step({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return (
    <li>
      <LinkedHtml className="md-body" html={html} />
    </li>
  )
}

/** The note box and the two verbs — drawn only while the thread is resting on THESE steps, which is
 *  the caller's test (AwaitingBackgroundCard `stepsLive`). */
export function StepsReply({ slug, sessionId, steps, onReplied, onReplyFailed }: {
  slug: string
  sessionId: string | undefined
  steps: readonly string[]
  /** The queue's optimistic card exit, as for its Snooze; absent off the queue. */
  onReplied?: () => void
  onReplyFailed?: () => void
}) {
  const projectDir = useProjectDir()
  // In the draft store, so a half-typed note survives a remount and reads the same on the queue card
  // and in the drawer.
  const [note, setNote, clearNote] = useDraft(draftKey.steps(projectDir, slug, sessionId, steps))
  const followUp = useEagerFollowUp(slug)
  // Latched on the click and released only by a rollback: between the send and the worker's reply the
  // card is still on screen, and a second click would send the outcome twice.
  const [sent, setSent] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // The same auto-growing box the question card's free-text row is: reset to `auto` so it can shrink,
  // then lock to the content height (borders included — box-sizing is border-box).
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`
  }, [note])
  const reply = (outcome: string) => {
    const written = note
    setSent(true)
    const started = followUp.submit(stepsReply(outcome, written), {
      onOptimistic: () => {
        clearNote()
        onReplied?.()
      },
      onRollback: () => {
        setSent(false)
        if (written) setNote(written)
        onReplyFailed?.()
      },
    })
    if (!started) setSent(false)
  }
  return (
    <>
      <textarea
        ref={taRef}
        data-1p-ignore
        data-surface="questionAnswer"
        data-steps-note
        rows={1}
        value={note}
        disabled={sent}
        onChange={(e) => setNote(e.target.value)}
        // ENTER IS A NEWLINE HERE, not a send — unlike the composer and the question card's text row,
        // because this card has TWO verbs and a key cannot know which one the human means. A note
        // reading "couldn't — the 2FA app is on my other phone" sent by Return as "Done" would tell the
        // worker the steps were performed; on a phone, whose Return key is the only way to start a new
        // line, that was one keystroke away. The reply is always a click.
        //
        // Every key still stops HERE, as in every box that owns its keys: Escape must not reach the app's
        // window handler, and the queue card's own Enter-to-send (TodosView) counts on boxes stopping it.
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Escape") {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
        placeholder="Add a note (optional)…"
        // The question card's free-text row, so the two boxes read as one family.
        className="mt-3 w-full resize-none overflow-hidden rounded-md border border-border bg-transparent px-3 py-1.5 text-[12px] leading-snug text-fg/90 outline-none transition-colors placeholder:text-muted-80 hover:bg-panel-2 focus:border-accent disabled:opacity-60"
      />
      <CardActions data-awaiting-steps-reply>
        <button
          type="button"
          data-steps-done
          disabled={sent}
          onClick={() => reply(STEPS_DONE)}
          onMouseDown={(e) => e.preventDefault()}
          className={`${CARD_PRIMARY_ACTION} disabled:opacity-60`}
        >
          {STEPS_DONE}
        </button>
        <button
          type="button"
          data-steps-not-done
          disabled={sent}
          onClick={() => reply(STEPS_NOT_DONE)}
          onMouseDown={(e) => e.preventDefault()}
          className={`${CARD_SECONDARY_ACTION} disabled:opacity-60`}
        >
          {STEPS_NOT_DONE}
        </button>
      </CardActions>
    </>
  )
}
