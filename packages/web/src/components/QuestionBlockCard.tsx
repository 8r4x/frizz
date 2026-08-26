// THE question card — the single component every question in frizz renders through, whatever produced
// it. There are two producers and one look:
//
//   1. a ```question fence in an assistant message (lib/questionBlocks.ts parses the markdown), and
//   2. a NATIVE AskUserQuestion tool call from the Claude session broker, whose interaction record is
//      converted to the same model by lib/interactionQuestion.ts.
//
// They share a data model, which is why they can share a component: a question, lettered options each
// with a one-line trade-off, an optional "select several" mode, and a free-text box at the bottom. The
// tool call's `multiSelect` IS the fence's `multi` tag; its `options[].label/description` ARE the
// fence's option lines. Anything that reads as a difference between them is a bug in a producer, not a
// reason for a second card (maintainer 2026-07-27: "Ideally, they could share a component").
//
// It lives in its own module rather than in ChatView so BOTH producers can reach it: the interaction
// surface (InteractionCards.tsx) is imported BY ChatView, so a question card defined inside ChatView
// could only have been shared through a module cycle.
import { Fragment, useId, useLayoutEffect, useMemo, useRef } from "react"
import { AlertTriangle, Check, HelpCircle, ListChecks } from "lucide-react"
import { useInlineMarkdownHtml, useMarkdownHtml } from "../lib/useMarkdown.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { parseQuestionBlock, type BlockAnswer, type ParsedQuestion, type QuestionKind } from "../lib/questionBlocks.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"

export interface BlockInteractive {
  answer: BlockAnswer
  onChip: (optIdx: number, optText: string) => void
  onText: (text: string) => void
  onSubmit: () => void
}

// A ```question block, set off from the surrounding prose: rounded neutral border + slightly elevated
// bg + a muted label (NOT yellow — that's the focus motif). The label + icon track the kind: a plain
// question shows a help glyph, a `multi` block shows a checklist. A `danger` block (the destructive
// gate — force-merge, deletion, rollback) layers the app's red risk language (the same text-red-400
// family the bypass permission mode uses) with a warning glyph.
// The context renders as markdown; the convention-parsed trailing options render as choice chips (radio
// feel for single-select, toggleable checkboxes for `multi`) and the "Recommendation:" line as a muted
// note. When `interactive` is present (the live message), chips are clickable and a freetext textarea
// appears; otherwise everything is read-only. EVERY kind stages its answer the same way — pick a chip
// and/or type, then Send answers. Nothing in a question card sends on a single click (maintainer
// 2026-07-26: the old approval gate's one-click Approve was the lone exception and it is gone).
//
// THE MODEL IT RENDERS is `ParsedQuestion` (lib/questionBlocks.ts) — the neutral shape, not a
// fence-shaped one. A caller supplies EITHER the raw fence body (producer 1, parsed here) or an
// already-built `question` (producer 2, the native tool call). Everything below this line reads only
// from `parsed`, so neither producer can drift into its own styling.
export function QuestionBlockCard({
  raw,
  question,
  questionKind,
  danger,
  interactive,
  wrap,
}: {
  /** Producer 1: the raw body of a ```question fence, parsed here. */
  raw?: string
  /** Producer 2: an already-built question (a native AskUserQuestion tool call). */
  question?: ParsedQuestion
  questionKind?: QuestionKind
  danger?: boolean
  interactive?: BlockInteractive
  wrap?: boolean
}) {
  const parsed = useMemo(
    () => question ?? parseQuestionBlock(raw ?? "", questionKind ?? "question", danger),
    [question, raw, questionKind, danger],
  )
  const html = useMarkdownHtml(parsed.contextMd)
  const trailingHtml = useMarkdownHtml(parsed.trailingMd ?? "")
  const recIdx = parsed.recommendedIdx
  const recHtml = useInlineMarkdownHtml(parsed.recommendation ?? "")
  const isMulti = parsed.kind === "multi"
  const isDanger = parsed.danger
  const chosen = interactive?.answer.chosen ?? null
  const chosenSet = interactive?.answer.chosenSet ?? []
  const freetext = interactive?.answer.text ?? ""
  // The free-text answer is an AUTO-EXPANDING textarea (not a fixed one-line input): reset to `auto`
  // so it can SHRINK when text is deleted, then lock to the content height so the box grows line-by-line
  // as the answer is typed. Runs on every freetext change (incl. an external clear via a chip-click).
  const taRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    // box-sizing is border-box (Tailwind preflight), so the style height must INCLUDE the borders —
    // else clientHeight lands a couple px short of scrollHeight and the last line clips (overflow is
    // hidden). `offsetHeight - clientHeight` is the vertical border delta measured at height:auto.
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`
  }, [freetext])
  const KindIcon = isDanger ? AlertTriangle : isMulti ? ListChecks : HelpCircle
  // Sentence case, because the shared chrome renders this as a real TITLE now rather than as an
  // uppercased eyebrow — a lowercase "question" beside the card's glyph reads as a typo.
  const kindLabel = isMulti ? "Select multiple" : "Question"
  return (
    <TranscriptCard tone={isDanger ? "danger" : "neutral"} icon={KindIcon} label={kindLabel}>
      {/* FULL-strength, against the card's stepped-down description colour: this card's body is not a
          description of the title, it IS the ask, and the question must never read dimmer than the
          word "Question" above it. The colour rides a WRAPPER because `.card-md .md-body` inherits
          colour by design (and outranks a utility class on the element itself). */}
      {html && (
        <div className="text-fg">
          <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={html} />
        </div>
      )}
      {(parsed.options.length > 0 || interactive) && (
        // Options stack in a SINGLE full-width column (maintainer 2026-07-10: a 2-col grid read as
        // ragged, uneven columns with dead whitespace once option text got long). One chip per row;
        // the free-text row keeps col-span-full so the "something else…" answer gets the whole line.
        <div className="mt-2 grid grid-cols-1 gap-1.5">
          {parsed.options.map((opt, i) => (
            <Fragment key={i}>
              {/* A group heading the worker wrote between choices ("Melee family:" over D–F). It rides
                  WITH its option rather than being stranded below the chips as unanswerable prose, and
                  wears the SAME body treatment as the context above — the FIRST group's heading is just
                  the tail of that context, so a muted caption here would make two identical things
                  render differently in one card. */}
              {parsed.optionHeadings?.[i] && <OptionHeading md={parsed.optionHeadings[i]!} wrap={wrap} />}
            <Chip
              label={opt}
              multi={isMulti}
              // The recommendation renders INSIDE its option as a badge (not as a caption below);
              // the inline `(recommended: why)` rationale (or a legacy rec line) rides the chip's title.
              recommended={recIdx === i}
              recTitle={recIdx === i ? parsed.recommendedNote : undefined}
              // MULTI: selected == toggled in the set (coexists with freetext). SINGLE: selected only
              // while it's the effective answer — a freetext override clears it.
              selected={isMulti ? chosenSet.includes(i) : chosen === i && !freetext.trim()}
              disabled={!interactive}
              onClick={() => {
                interactive?.onChip(i, opt)
                // SINGLE only: choosing a chip takes the selection WITH the focus — if the free-text
                // input still holds DOM focus (its mousedown is prevented, so clicking won't blur it),
                // its accent focus border would sit next to the chip's, so blur it. MULTI keeps both
                // live at once (chips + a color note coexist), so leave the input focused there.
                // Scoped to THIS block's own answer box by ref, not by a data- tag: the queue card now
                // also renders a free-form composer alongside an open ask, and a tag match would blur
                // the caret out of that unrelated box whenever a chip is clicked.
                if (isMulti) return
                if (taRef.current && document.activeElement === taRef.current) taRef.current.blur()
              }}
            />
            </Fragment>
          ))}
          {/* The free-text answer IS the final option — but it SPANS THE FULL WIDTH (col-span-full)
              below the multi-column options, and is an auto-growing textarea (see taRef effect above)
              rather than a one-line input, so a long "something else…" answer stays fully visible. */}
          {interactive && (
            <textarea
              ref={taRef}
              rows={1}
              // Its own surface tag — deliberately NOT the queue card's `queueComposer`, which is the
              // separate free-form prompt box at the bottom of the card. Escape BLURS (climb out, same
              // semantics as the shared Composer) and stops here rather than reaching App's window
              // handler. NOTE (verified in the real app 2026-07-26): stopping it does NOT keep an
              // enclosing thread drawer open — Radix's DismissableLayer takes Escape on the document
              // in the CAPTURE phase, so it has already dismissed the sheet before this bubble-phase
              // handler runs. The typed answer survives that (it lives in the draft store), but the
              // "Escape climbs out of the box first" intent only holds on the queue card.
              data-surface="questionAnswer"
              value={freetext}
              onChange={(e) => interactive.onText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Escape") {
                  e.preventDefault()
                  e.currentTarget.blur()
                  return
                }
                // Enter writes a NEWLINE here (the browser default — this box is a staged form field,
                // not a composer); ⌘/Ctrl-Enter is the send. See shouldSubmitStagedEnter.
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
                  interactive.onSubmit()
                }
              }}
              // SINGLE: clicking into the input MOVES the selection here — any chosen chip deselects (its
              // accent border must not linger once the user commits to typing). MULTI keeps its toggled
              // set (the freetext only appends color), so don't disturb it on focus. Keeps typed text.
              onFocus={() => {
                if (!isMulti && chosen !== null) interactive.onText(freetext)
              }}
              placeholder={
                isMulti ? "Add a note…" : parsed.options.length ? `${nextOptionId(parsed.options)} Something else…` : "Type your answer…"
              }
              // Styled as the FINAL option row (same shape as a chip) that SPANS both grid columns.
              // resize-none + overflow-hidden hand height control to the auto-grow effect (no manual
              // drag handle, no inner scrollbar). Focus or content = the accent border (the selection
              // lives HERE now); the tinted bg marks an actual answer.
              className={`col-span-full w-full resize-none overflow-hidden rounded-md border px-3 py-1.5 text-[12px] leading-snug text-fg/90 outline-none placeholder:text-muted/80 transition-colors ${
                freetext.trim() ? "border-accent bg-accent/10" : "border-border bg-transparent hover:bg-panel-2 focus:border-accent"
              }`}
            />
          )}
        </div>
      )}
      {/* A "Note: …" footnote the worker wrote AFTER the options — rendered below the chips (muted) so
          the choices stay answerable instead of swallowing them (the old parser dropped the chips). */}
      {parsed.trailingMd && (
        <LinkedHtml className={`mt-2 md-body text-[12px] text-muted/70${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={trailingHtml} />
      )}
      {/* The caption fallback survives ONLY when the recommendation didn't match an option. */}
      {parsed.recommendation && recIdx === null && (
        <LinkedHtml className="md-inline mt-1.5 text-[11px] text-muted/70" html={recHtml} />
      )}
    </TranscriptCard>
  )
}


// A group heading between options. Its own component only so the markdown parse and the
// dangerouslySetInnerHTML prop can be memoized per heading — a hook can't be called inside the
// options .map(), and an inline `{ __html }` literal there would rebuild the DOM on every render
// (see useInnerHtml).
function OptionHeading({ md, wrap }: { md: string; wrap?: boolean }) {
  const html = useInlineMarkdownHtml(md.split("\n").join(" "))
  return (
    <div className="mt-1 text-fg">
      <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={html} />
    </div>
  )
}

// The free-text row's identifier: one past the last option ("A. B. C." → "D.", "1. 2." → "3.").
function nextOptionId(options: string[]): string {
  const last = options[options.length - 1]?.match(/^\s*([A-Za-z]|\d+)([.)])\s/)
  if (!last) return `${String.fromCharCode(65 + options.length)}.`
  const [, id, punct] = last
  return /\d/.test(id) ? `${Number(id) + 1}${punct}` : `${String.fromCharCode(id.toUpperCase().charCodeAt(0) + 1)}${punct}`
}

// recommendedIndex (rec-line → option index) now lives in ../lib/questionBlocks.ts alongside the rest
// of the question parsing, so it's covered by the pure-logic unit tests.

// A single answer choice: a left-aligned neutral row; when selected it takes the subtle accent
// border (focus-adjacent selection). A `multi` chip additionally carries a checkbox square (empty →
// checked) so the "toggle several" affordance reads unmistakably as multi-select vs the single-select
// chips' bare border highlight. Read-only (no interactive controller) → muted and non-clickable.
//
// THE HIT AREA IS A STRETCHED, EMPTY BUTTON LAID OVER THE ROW — not a button wrapped around the text.
// The option text is worker-authored markdown, and it carries the same live things a paragraph does: a
// link, a `#123` reference, a bare URL, a file path (maintainer 2026-08-25: "the link to that Markdown
// file should be clickable … as well as URLs and PR/issue links inside questions — the usual set of
// augmentations"). None of those may sit INSIDE a `<button>`: interactive-in-interactive is invalid
// HTML, and Gecko retargets a click inside a button to the button, so the link would never open. So
// the row is a plain `<div>`; the button is `absolute inset-0` beside the text, named by the text
// through `aria-labelledby`; and styles.css positions each live element in the text ABOVE the button.
// A click on a link follows it and selects nothing; a click on any other pixel of the row picks the
// option. Tab reaches the button first and each link after it. Until this the chip asked the sanitizer
// to flatten links to spans (`inertInteractive`), which is why a file named in an option never opened.
function Chip({
  label,
  selected,
  disabled,
  multi,
  recommended,
  recTitle,
  onClick,
}: {
  label: string
  selected: boolean
  disabled: boolean
  multi?: boolean
  recommended?: boolean
  recTitle?: string
  onClick: () => void
}) {
  // Inline-only: a chip is one line, so no `<p>`/list block chrome. Raw `label` used to leak
  // `**bold**`/backticks.
  const labelHtml = useInlineMarkdownHtml(label)
  const labelId = useId()
  return (
    <div
      data-question-option
      title={recTitle}
      className={`relative flex items-start gap-2 rounded-md border px-3 py-1.5 text-[12px] leading-snug transition-colors ${
        selected
          ? "border-accent bg-accent/10 text-fg"
          : disabled
            ? "border-border text-muted/80"
            // hover lands on `elevated`, one step above the card's own panel-2 fill — hovering to
            // panel-2 was invisible once every card standardized on that fill.
            : "border-border text-fg/90 hover:bg-elevated hover:border-border-strong"
      }`}
    >
      <button
        type="button"
        disabled={disabled}
        aria-labelledby={labelId}
        onClick={onClick}
        onMouseDown={(e) => e.preventDefault()}
        className="absolute inset-0 rounded-md outline-none"
      />
      {multi && (
        <span
          aria-hidden
          className={`mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
            selected ? "border-accent bg-accent text-bg" : "border-border-strong"
          }`}
        >
          {selected && <Check size={10} strokeWidth={3} />}
        </span>
      )}
      {/* The "Recommended" badge FLOATS to the top-right so the option text flows around it and reclaims
          the full width on the lines below — instead of a flex sibling that permanently narrows the text
          column. The badge must precede the label in source order for the float to take effect. */}
      <span id={labelId} className="min-w-0 flex-1">
        {recommended && (
          // Optically centred on the option text's CAP BLOCK, not on its line box. Measured on the
          // rendered page: the pill's ink centre sat 1.88px (sans) / 1.80px (mono) BELOW the label's,
          // because a 9.5px pill inside a 12px line resolves a shorter line box and lands its baseline
          // 1px low. Unlike the icon nudge this is font-INDEPENDENT — both sides scale with the same
          // font — so it is a constant, and 2px lands on a whole device pixel at 2× DPR. `translate`
          // (not a margin) so the float's exclusion area, and therefore the text wrap, is untouched.
          // `pointer-events-none`: the transform makes the badge a stacking context that paints above
          // the stretched button, and a click on the badge must still pick the option.
          <span className="pointer-events-none float-right ml-2 mt-px -translate-y-[2px] rounded-full border border-border-strong px-1.5 py-px text-[9.5px] uppercase tracking-wide text-muted">
            Recommended
          </span>
        )}
        <LinkedHtml as="span" className="md-inline" html={labelHtml} />
      </span>
    </div>
  )
}
