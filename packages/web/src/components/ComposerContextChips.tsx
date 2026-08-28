import { useEffect, useRef, useState, type ReactElement } from "react"
import { useSnapshot } from "valtio"
import { MessageSquare, X } from "lucide-react"
import { removeContextItem, setContextComment, store } from "../store.ts"
import { contextDisplayPath } from "../lib/composerContext.ts"
import { useProjectDir } from "../lib/drafts.ts"
import { CONTEXT_CHIP_HEIGHT } from "./Composer.tsx"

// The staged SELECTED-CONTEXT items for a thread, as chips INLINE in its prompt box: the pills open the
// first line of the message and the typed prose runs on after them (the ⌘I flow — see FileViewerPanel
// and lib/composerContext.ts). Composer owns the row — this renders one `[data-context-chip]` pill per
// selection, `CONTEXT_CHIP_HEIGHT` tall, and Composer lays them on the text's first line and indents
// the prose past the last one; see its `context` prop for why a row of pills above the text was
// rejected. Each chip is the file's basename plus its line range. Clicking a chip pops a card above it
// — the quoted text plus a comment box — so each item can carry a note the way a review comment does.
// The set serializes into the next send and clears with it.
export function ComposerContextChips({ slug }: { slug: string }): ReactElement | null {
  const snap = useSnapshot(store)
  const projectDir = useProjectDir()
  const items = snap.composerContext[slug]
  const [openId, setOpenId] = useState<number | null>(null)
  if (!items?.length) return null
  return (
    <>
      {items.map((item) => {
        const base = item.path.split("/").filter(Boolean).pop() || item.path
        const lines = item.startLine !== undefined && item.endLine !== undefined
          ? item.startLine === item.endLine ? `:${item.startLine}` : `:${item.startLine}-${item.endLine}`
          : ""
        const isOpen = openId === item.id
        return (
          <span
            key={item.id}
            data-context-chip
            style={{ height: CONTEXT_CHIP_HEIGHT }}
            className={`group/ctx pointer-events-auto relative flex items-center gap-1 rounded-md border px-1.5 text-[11px] leading-none transition-colors ${
              isOpen ? "border-accent/60 bg-panel-2 text-fg" : "border-border bg-panel-2/50 text-fg/80 hover:bg-panel-2"
            }`}
          >
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : item.id)}
              title={contextDisplayPath(item.path, projectDir)}
              className="flex min-w-0 items-center gap-1 outline-none"
            >
              <span className="max-w-48 truncate font-mono-keep">{base}{lines}</span>
              {/* The comment marker: only once a note exists, so a bare quote stays a bare chip. */}
              {item.comment?.trim() && <MessageSquare size={10} aria-hidden="true" className="shrink-0 text-muted" />}
            </button>
            <button
              type="button"
              // Like every control beside a live input here: never blur the textarea on the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                removeContextItem(slug, item.id)
                if (isOpen) setOpenId(null)
              }}
              aria-label={`Remove context ${base}`}
              // -mr-[3px] folds the button's own 2px of padding AND most of the X's dead space (lucide's
              // X paints the middle 12 of its 24 units, ~2px of box per side at size 10) into the
              // pill's, so the ✕ ink sits as far from the right border as the label ink does from the
              // left. Read off a dsf-8 scan of the pill's middle band, 2026-08-28: label→left border
              // 6.5px; ✕→right border 7.5px at -mr-0.5, 5.5px at -mr-1, 6.5px at -mr-[3px].
              className="shrink-0 rounded p-0.5 -mr-[3px] text-muted transition-colors hover:text-fg"
            >
              <X size={10} strokeWidth={2.5} />
            </button>
            {isOpen && (
              <ContextCard
                key={item.id}
                text={item.text}
                initial={item.comment ?? ""}
                onComment={(value) => setContextComment(slug, item.id, value)}
                onClose={() => setOpenId(null)}
              />
            )}
          </span>
        )
      })}
    </>
  )
}

// The quote-plus-comment card, popped ABOVE its chip like the slash-suggestion menu pops above the box
// (same border/shadow/z), because the chip lives on the text's first line and nothing may push that
// line around while a note is being typed. Escape or a click anywhere outside closes it and hands the
// caret back to the textarea beside the chip.
function ContextCard({ text, initial, onComment, onClose }: {
  text: string
  initial: string
  onComment: (value: string) => void
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const card = ref.current
      if (!card || card.contains(event.target as Node) || card.parentElement?.contains(event.target as Node)) return
      onClose()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [onClose])
  return (
    <div
      ref={ref}
      data-context-card
      className="absolute bottom-full left-0 z-20 mb-2 w-[min(28rem,calc(100vw-2rem))] cursor-auto rounded-lg border border-border bg-bg px-2.5 py-2 text-left shadow-lg"
    >
      <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono-keep text-[11px] leading-4 text-fg/70">{text}</pre>
      <CommentInput initial={initial} onChange={onComment} onClose={onClose} />
    </div>
  )
}

// The comment box holds its text LOCALLY and writes every keystroke through to the store. Rendering
// it straight off the valtio snapshot ate characters: the batched notification lands a render behind
// the keystroke, so React reverts the DOM value to the stale prop in between (a 20-character comment
// survived as its last letter). valtio's own remedy — a `sync: true` snapshot — suppressed the chip
// row's re-render on item ADD in valtio 2.3.2, so the input buffers locally instead; keyed on the
// item id (the card is), so switching chips reseeds it.
function CommentInput({ initial, onChange, onClose }: { initial: string; onChange: (value: string) => void; onClose: () => void }): ReactElement {
  const [value, setValue] = useState(initial)
  return (
    <input
      type="text"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
        onChange(event.target.value)
      }}
      onKeyDown={(event) => {
        // Escape closes the card only — never the file panel or a drawer behind it (the DrawerStack
        // chain listens on the window). Enter is the same: the note is already saved, so it just
        // returns to the message.
        if (event.key !== "Escape" && event.key !== "Enter") return
        event.preventDefault()
        event.stopPropagation()
        onClose()
        event.currentTarget.closest("[data-context-chip]")?.parentElement?.parentElement?.querySelector("textarea")?.focus()
      }}
      placeholder="Add a comment on this selection…"
      autoFocus
      className="mt-2 block w-full rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-muted focus:border-accent"
    />
  )
}
