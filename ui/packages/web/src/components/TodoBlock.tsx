import { useId, useState, type ReactNode } from "react"
import { ChevronRight, Square, SquareCheckBig, SquareDot } from "lucide-react"
import type { TranscriptTodo, TranscriptToolCall } from "@fray-ui/shared"

// THE TO-DO LIST CARD — every provider's built-in checklist, one rendering.
//
// The call itself is a poor thing to draw: Claude Code's TaskUpdate is `{taskId:"3", status:"completed"}`
// and its TaskCreate's real content is a paragraph-long `description`. The generic tool card picked that
// description as its title, so three consecutive updates read as three walls of maintainer prose with no
// hint of what had actually changed (maintainer 2026-07-29). The server now folds the whole list instead
// (transcript.ts, the TO-DO LIST section) and hands this card the state AFTER the call.
//
// COLLAPSED by default, deliberately: a 20-row checklist per update — and an agent updates its list
// constantly — is a bigger wall than the one this replaces. The header carries the whole reading:
//
//   TODOS  ☑ Fix the overrides false positive in verify_deps        4/12   done · 11ms  ▸
//
// the changed row's own status glyph + its text, so "what happened" needs no words, plus the progress
// counter. Expanding reveals the full list, and the model's own description/explanation below it — so
// nothing it wrote is lost, it just stops being the title.
const TODO_LABEL = "Todos"

// Pending / current / done, as a checkbox family. Exactly ONE of them takes colour — the current row, in
// the app's accent — because a tool card is a subordinate activity band: twenty green checks would shout
// louder than the prose they belong to, while one amber row is the single fact worth scanning for.
//
// Done stays monochrome but is the BRIGHTEST of the two neutrals, and it is `SquareCheckBig` (whose check
// breaks the box edge) rather than `SquareCheck`. At /45 with the tucked-in check, a done row was
// distinguishable from a to-do row only by its dimmed text — reviewing the screenshot, "what is done" was
// not scannable from the glyphs at 12px, which is the one thing a checklist owes the reader.
const TODO_GLYPH = {
  pending: { Icon: Square, className: "text-muted/50" },
  in_progress: { Icon: SquareDot, className: "text-accent" },
  completed: { Icon: SquareCheckBig, className: "text-muted/75" },
} as const

const TODO_ROW_TEXT = {
  pending: "text-fg/75",
  in_progress: "text-fg",
  completed: "text-muted/70",
} as const

// Sized in `1em`, NOT in px, and that is what makes the vertical corrections in diff.css legitimate.
// An SVG's ink lands wherever its path falls in the viewBox, so each context's correction has to be
// measured — and it is written in `em` so it tracks the font size. A px-pinned glyph breaks that promise
// silently: with `size={12}` the glyph stayed 12px while doubling the card's type doubled everything
// around it, so the geometry the correction was derived from no longer held (caught by this change's own
// scale gate, which read a 6px residual at 2x). At 1em the glyph and its text scale together and the
// rows' residual stays 0px at 12px, 24px and 48px.
function TodoMark({ status }: { status: TranscriptTodo["status"] }) {
  const { Icon, className } = TODO_GLYPH[status]
  return <Icon aria-hidden="true" size="1em" strokeWidth={2} className={`fray-todo-mark shrink-0 ${className}`} />
}

const STATUS_WORD = { pending: "to do", in_progress: "in progress", completed: "done" } as const

export function TodoBlock({
  todos,
  change,
  detail,
  note,
  meta,
}: {
  todos: readonly TranscriptTodo[]
  change?: TranscriptToolCall["todoChange"]
  detail?: string
  // The model's own commentary on the call — a Claude task `description`, a codex plan `explanation`.
  note?: string
  meta?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const done = todos.filter((t) => t.status === "completed").length
  // The row this call touched. A DELETED row is gone from the snapshot, so its status can't be shown —
  // the headline strikes the text through instead, which is the one place a strikethrough earns its keep.
  const changed = todos.find((t) => t.changed)
  const headline = detail?.trim() || undefined
  const expandable = todos.length > 0 || Boolean(note)
  const counter = todos.length > 0 ? `${done}/${todos.length}` : undefined
  const label = [TODO_LABEL, headline ?? (todos.length ? `${todos.length} item${todos.length === 1 ? "" : "s"}` : "empty")]
    .filter(Boolean)
    .join(": ")
  return (
    <div className="fray-bash" data-todo-card>
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={expandable ? bodyId : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${expandable ? `${open ? "Collapse" : "Expand"} ` : ""}${label}${counter ? ` — ${done} of ${todos.length} done` : ""}`}
        className="fray-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps fray-bash-label shrink-0">{TODO_LABEL}</span>
          {/* The 11.5px lives on the WRAPPER, not on the text span, so the 1em glyph and the text it sits
              beside derive from ONE font size. With it on the span the glyph silently inherited the card's
              12.5px instead — a 1px size mismatch, and an alignment correction tied to that accident
              rather than to the pair. */}
          {headline && (
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]" title={headline} data-todo-headline>
              {change !== "deleted" && <TodoMark status={changed?.status ?? "pending"} />}
              <span className={`min-w-0 truncate ${change === "deleted" ? "text-muted/60 line-through" : "text-muted"}`}>{headline}</span>
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {counter && (
            <span className="fray-tool-header-caps tabular-nums text-[11px] text-muted/55" title={`${done} of ${todos.length} done`}>
              {counter}
            </span>
          )}
          {meta}
          {expandable && <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
        </span>
      </button>
      {expandable && (
        <div id={bodyId} hidden={!open}>
          {open && todos.length > 0 && (
            <ul className="fray-todo-list">
              {todos.map((todo, i) => (
                <li key={i} className="fray-todo-row" data-changed={todo.changed ? "true" : undefined}>
                  <TodoMark status={todo.status} />
                  <span className={`min-w-0 ${TODO_ROW_TEXT[todo.status]}`}>{todo.text}</span>
                  <span className="sr-only">{` — ${STATUS_WORD[todo.status]}`}</span>
                </li>
              ))}
            </ul>
          )}
          {open && note && (
            <>
              <div className="fray-bash-output-label petite-caps">note</div>
              <pre className="fray-bash-body fray-bash-output-body">{note}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
