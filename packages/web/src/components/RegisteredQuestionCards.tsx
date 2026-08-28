// The surface a REGISTERED question renders on — a question a worker created with the `ask` tool, which
// is a row in `thread_question` rather than a fence in a message. That is the whole difference, and it
// is the reason this file exists at all: a fenced question lives and dies with the message carrying it,
// so it vanishes from view the moment the transcript scrolls or the context is compacted, while a
// registration is still owed an answer tomorrow. So these cards do NOT ride the transcript. They sit
// where the pending-interaction stack sits — pinned above the composer, on the thread and on the board.
//
// The CARD is the shared one (QuestionBlockCard); only the plumbing is new. What a registration adds
// over the other two producers is the STATIC TREE: an option may carry follow-ups that become live only
// once that option is picked, so one registration renders as a stack of cards that grows as it is
// answered. lib/registeredQuestion.ts performs that walk; nothing here decides which nodes are live.
import { useMemo, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { X } from "lucide-react"
import type { QuestionAnswer, RegisteredQuestionView, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir } from "../lib/drafts.ts"
import type { BlockAnswer } from "../lib/questionBlocks.ts"
import { parseAnswersCard } from "../lib/answersMessage.ts"
import { ROOT_PATH, liveQuestionNodes, nodeAnswered, registeredAnswer } from "../lib/registeredQuestion.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The answer could not be sent."
  return message.length > 240 ? `${message.slice(0, 239)}…` : message
}

/** The chip/toggle half of a staged answer, keyed by `<question id>|<node path>`. The free-text half
 *  lives in the draft store instead, so a half-typed answer survives a remount and a worker restart. */
type Picks = Map<string, { chosen: number | null; chosenSet: number[] }>
const pickKey = (id: string, path: string) => `${id}|${path}`

export function RegisteredQuestionStack({
  thread,
  questions: only,
  showInFlight = true,
  className = "",
}: {
  thread: ThreadView | undefined
  // WHICH of the thread's open questions this mount draws. Every surface now places a question at the
  // REST IT WAS ASKED AT rather than at the transcript's tail (lib/questionAnchor), so one thread can
  // have several of these mounted at different depths — each handed its own group.
  questions?: readonly RegisteredQuestionView[]
  // The in-flight ANSWER belongs to the tail wherever the questions sit: it is the human's newest turn,
  // and the delivered copy of it lands at the tail a second later. Only the tail mount draws it.
  showInFlight?: boolean
  className?: string
}) {
  const slug = thread?.id
  const questions = only ?? thread?.questions ?? []
  const projectDir = useProjectDir()
  const [picks, setPicks] = useState<Picks>(() => new Map())
  const [error, setError] = useState<string>()

  // Every free-text box of every question, subscribed as one batch — the draft store's own hook takes a
  // key list, and the set only changes when a question is registered or settled.
  const textKeys = useMemo(
    () => (slug ? questions.flatMap((q) => allPaths(q).map((path) => draftKey.question(projectDir, slug, q.id, path))) : []),
    [projectDir, slug, questions],
  )
  const persistedText = useDraftValues(textKeys)
  const answerFor = (q: RegisteredQuestionView, path: string): BlockAnswer => {
    const pick = picks.get(pickKey(q.id, path))
    return {
      chosen: pick?.chosen ?? null,
      chosenSet: pick?.chosenSet ?? [],
      text: (slug ? persistedText.get(draftKey.question(projectDir, slug, q.id, path)) : undefined) ?? "",
    }
  }
  const answersOf = (q: RegisteredQuestionView): ReadonlyMap<string, BlockAnswer> =>
    new Map(allPaths(q).map((path) => [path, answerFor(q, path)]))

  // EVERY answered question goes in ONE call. A per-question send would half-wake the turn: the worker
  // would come back to a payload it cannot act on and would have to ask for the rest again.
  const staged: QuestionAnswer[] = questions.flatMap((q) => {
    const built = registeredAnswer(q, answersOf(q))
    return built ? [built] : []
  })

  const send = useMutation({
    mutationFn: async (answers: QuestionAnswer[]) => rpc.answerQuestions({ slug: slug!, answers }),
    onSuccess: (result) => {
      // The rows are gone from the board push that follows, so the staged state for them is dead weight;
      // dropping the drafts too keeps a re-asked question from opening pre-filled with a stale answer.
      for (const id of result.answered) {
        setPicks((prev) => {
          const next = new Map(prev)
          for (const key of [...next.keys()]) if (key.startsWith(`${id}|`)) next.delete(key)
          return next
        })
        const q = questions.find((entry) => entry.id === id)
        if (q && slug) for (const path of allPaths(q)) draftStore.set(draftKey.question(projectDir, slug, q.id, path), "")
      }
    },
    onError: (cause) => setError(errorText(cause)),
  })
  const dismiss = useMutation({
    mutationFn: async (id: string) => rpc.dismissQuestions({ slug: slug!, ids: [id] }),
    onError: (cause) => setError(errorText(cause)),
  })

  // THE ANSWER, ALREADY SENT AND NOT YET IN THE WORKER'S HANDS. Answering stores the row; a wake hands
  // it over a moment later (deliberately — an answer given while the worker's process is down has to
  // survive the gap). In between, the question card is gone and the delivered turn has not arrived, so
  // this slot went EMPTY and the thread — at rest, with nothing registered any more — drew the residual
  // "Rested without a sign-off" card in the hole (maintainer 2026-08-27: "a little card that, for like
  // 5+ seconds, just says that the thread rested without a sign-off before it shows up my answer").
  //
  // The board composes the bytes the delivery will carry, and this parses them with the reader the chat
  // uses on the landed turn — so the in-flight card and the real one are the SAME card and the swap is
  // invisible. Dimmed while it is in flight, exactly like an optimistic follow-up bubble.
  const inFlight = showInFlight && thread?.answersInFlight ? parseAnswersCard(thread.answersInFlight) : null
  if (!slug || questions.length === 0) {
    if (!slug || !inFlight) return null
    return (
      <section data-answers-in-flight aria-label="Your answer, on its way to the worker" className={`flex min-w-0 flex-col items-end ${className}`}>
        <AnswersCard answers={inFlight} queued />
      </section>
    )
  }
  const submit = () => {
    if (staged.length === 0 || send.isPending) return
    setError(undefined)
    send.mutate(staged)
  }

  return (
    <section
      data-registered-questions
      aria-label={`${questions.length} question${questions.length === 1 ? "" : "s"} waiting for an answer`}
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      {questions.map((q) => (
        <article key={q.id} data-question-id={q.id} className="flex min-w-0 flex-col gap-2">
          {(() => {
            const nodes = liveQuestionNodes(q.spec, answersOf(q))
            const card = (node: (typeof nodes)[number]) => (
              <QuestionBlockCard
                key={node.path}
                question={node.question}
                // Named for what it IS, so the relationship survives even where the rule is subtle.
                label={node.depth > 1 ? "Follow-up" : undefined}
                // The ×, on the ROOT card's title row only — one registration is one thing to dismiss,
                // and a follow-up cannot be declined separately from the answer that opened it. It is
                // NEVER offered on a `danger` question: a generic close icon is not consent for
                // something irreversible, and declining is a real option INSIDE that question. The
                // server refuses one too, so this is the affordance and not the rule.
                aside={node.depth === 1 && !q.spec.danger ? (
                  <button
                    type="button"
                    data-dismiss-question
                    aria-label="Dismiss this question"
                    title="Dismiss — the worker decides it itself"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(q.id)}
                    // PLACED BY CONSTRUCTION, not by a fitted constant. `p-1 -m-1` cancels exactly, so
                    // the button's layout box is the bare 16px svg while its hit area stays 24px; at
                    // 16px lucide's X paints 8px of ink centred in its box, exactly as HelpCircle
                    // paints 13.33px centred in its own — so sharing `card-icon-offset` puts the two
                    // ink centres on one line in BOTH fonts, with nothing to re-measure when the
                    // setting flips. Hand-placed at `-my-1` with a 13px glyph first: the x rode 2.40px
                    // ABOVE the card glyph and drew a 16.58px ink gap where `gap-2` claimed 8.
                    //
                    // `flex` is load-bearing: a button is inline-block by default, so inside the head's
                    // `leading-6` aside span it sits on that span's BASELINE — which moves with the font
                    // and put the x 1.00px high under sans while reading 0.00 under mono. A block-level
                    // box has no baseline to sit on, and both settings then measure 0.00.
                    //
                    // HORIZONTALLY the trim is DEEPER than the padding, because lucide's X paints only
                    // 8 of its 16 box px: `-mx-2` collapses the padding AND that inset, so the layout
                    // box IS the ink box and `gap-2` means 8px of ink. That lands 9.33px of ink to the
                    // kind glyph — the same distance the card family's only other aside, a plain text
                    // link, already draws — rather than the 13.33px a padding-only trim left.
                    className="card-icon-offset -mx-2 -my-1 flex rounded-md p-1 text-muted/70 outline-none transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40"
                  >
                    <X size={16} />
                  </button>
                ) : undefined}
                interactive={{
                  answer: answerFor(q, node.path),
                  onChip: (optIdx) => {
                    // SINGLE: picking a chip clears any typed override, mirroring both other producers.
                    // OUTSIDE the updater: the store write wakes this component's own draft
                    // subscription, and React runs a queued updater during render — so from inside it
                    // that write was a setState-in-render warning on every chip click after a keystroke.
                    if (node.spec.kind !== "multi") draftStore.set(draftKey.question(projectDir, slug, q.id, node.path), "")
                    setPicks((prev) => {
                      const next = new Map(prev)
                      const key = pickKey(q.id, node.path)
                      const pick = next.get(key) ?? { chosen: null, chosenSet: [] }
                      if (node.spec.kind === "multi") {
                        const set = pick.chosenSet.includes(optIdx)
                          ? pick.chosenSet.filter((v) => v !== optIdx)
                          : [...pick.chosenSet, optIdx]
                        next.set(key, { ...pick, chosenSet: set })
                      } else {
                        next.set(key, { ...pick, chosen: optIdx })
                      }
                      return next
                    })
                  },
                  onText: (text) => {
                    draftStore.set(draftKey.question(projectDir, slug, q.id, node.path), text)
                    // SINGLE: the free-text box taking over — a keystroke OR just focusing it — drops the
                    // chosen chip, as the fence producer does. The card's onFocus calls this with the
                    // text unchanged for exactly that reason, so writing the draft alone left the chip
                    // lit beside a focused box (maintainer 2026-08-28).
                    if (node.spec.kind !== "multi") setPicks((prev) => {
                      const key = pickKey(q.id, node.path)
                      const pick = prev.get(key)
                      if (!pick || pick.chosen === null) return prev
                      return new Map(prev).set(key, { ...pick, chosen: null })
                    })
                  },
                  onSubmit: submit,
                }}
              />
            )
            // THE WHOLE BRANCH SITS BEHIND ONE CONTINUOUS RULE, opened by the first follow-up and closed
            // by the last — everything below the root belongs to the single option that was taken. A
            // rule per card (the first cut) drew that one branch as a stack of unrelated indents,
            // because the article's own gap broke the line between every pair. Depth 3 nests its own
            // rule inside this one, which is where the tree stops (ASK_MAX_DEPTH).
            const branch = nodes.slice(1)
            return (
              <>
                {card(nodes[0])}
                {branch.length > 0 && (
                  <div className="ml-3 flex flex-col gap-2 border-l border-border pl-3">
                    {branch.map((node) => (
                      <div key={node.path} className={node.depth > 2 ? "ml-3 border-l border-border pl-3" : undefined}>
                        {card(node)}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )
          })()}
        </article>
      ))}
      {error && <div role="alert" className="break-words text-[11px] leading-snug text-red-300">{error}</div>}
      {send.isPending && (
        <div role="status" aria-live="polite" className="text-[11px] leading-snug text-muted">Sending…</div>
      )}
      <div className="flex justify-start">
        <button
          type="button"
          data-send-answers
          disabled={staged.length === 0 || send.isPending}
          onClick={submit}
          onMouseDown={(e) => e.preventDefault()}
          className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
        >
          Send answers
        </button>
      </div>
    </section>
  )
}

/** EVERY node path in a question's tree — live or not. The draft subscription and the clear-on-send both
 *  need the whole tree, not just what is currently on screen: text typed into a branch, abandoned, and
 *  returned to must still be there, and a settled question must leave nothing behind anywhere. */
function allPaths(q: RegisteredQuestionView): string[] {
  const out: string[] = []
  const walk = (node: RegisteredQuestionView["spec"], path: string) => {
    out.push(path)
    node.options?.forEach((option, optIdx) => {
      option.followUps?.forEach((child, fuIdx) => walk(child, `${path}/${optIdx}.${fuIdx}`))
    })
  }
  walk(q.spec, ROOT_PATH)
  return out
}

/** Is this question answered enough to send? Exported for the board card, which shows a count. */
export function questionIsStaged(q: RegisteredQuestionView, answers: ReadonlyMap<string, BlockAnswer>): boolean {
  return nodeAnswered(q.spec, answers.get(ROOT_PATH))
}
