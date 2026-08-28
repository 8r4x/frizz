import { useState, type ReactElement } from "react"
import { useSnapshot } from "valtio"
import { MessageSquare, X } from "lucide-react"
import { removeContextItem, setContextComment, store } from "../store.ts"
import { contextDisplayPath } from "../lib/composerContext.ts"
import { useProjectDir } from "../lib/drafts.ts"

// The staged SELECTED-CONTEXT items for a thread, as chips INSIDE its prompt box along the top edge
// (the ⌘I flow — see FileViewerPanel and lib/composerContext.ts; Composer renders this through its
// `context` slot). One chip per selection: the file's basename plus its line range. Clicking a chip
// opens it — the quoted text plus a comment box — so each item can carry a note the way a review
// comment does. The set serializes into the next send and clears with it.
export function ComposerContextChips({ slug }: { slug: string }): ReactElement | null {
  const snap = useSnapshot(store)
  const projectDir = useProjectDir()
  const items = snap.composerContext[slug]
  const [openId, setOpenId] = useState<number | null>(null)
  if (!items?.length) return null
  const open = openId !== null ? items.find((item) => item.id === openId) : undefined
  return (
    // px-3.5 = the textarea's own text inset, so the first chip's border sits on the text column
    // (at px-3 it stood 2px proud of the first letter). pt-2.5 mirrors the textarea's top inset; the
    // -mb-1 pulls the text up under the chips so chip→text reads ~10px like border→chip, instead of
    // the 16px the two stacked insets produced.
    <div data-composer-context className="px-3.5 pt-2.5 -mb-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((item) => {
          const base = item.path.split("/").filter(Boolean).pop() || item.path
          const lines = item.startLine !== undefined && item.endLine !== undefined
            ? item.startLine === item.endLine ? `:${item.startLine}` : `:${item.startLine}-${item.endLine}`
            : ""
          return (
            <span
              key={item.id}
              className={`group/ctx flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors ${
                openId === item.id ? "border-accent/60 bg-panel-2 text-fg" : "border-border bg-panel-2/50 text-fg/80 hover:bg-panel-2"
              }`}
            >
              <button
                type="button"
                onClick={() => setOpenId(openId === item.id ? null : item.id)}
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
                  if (openId === item.id) setOpenId(null)
                }}
                aria-label={`Remove context ${base}`}
                className="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-fg"
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            </span>
          )
        })}
      </div>
      {open && (
        <div className="mt-1.5 rounded-md border border-border bg-panel-2/40 px-2.5 py-2">
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono-keep text-[11px] leading-4 text-fg/70">{open.text}</pre>
          <CommentInput key={open.id} slug={slug} id={open.id} initial={open.comment ?? ""} />
        </div>
      )}
    </div>
  )
}

// The comment box holds its text LOCALLY and writes every keystroke through to the store. Rendering
// it straight off the valtio snapshot ate characters: the batched notification lands a render behind
// the keystroke, so React reverts the DOM value to the stale prop in between (a 20-character comment
// survived as its last letter). valtio's own remedy — a `sync: true` snapshot — suppressed the chip
// row's re-render on item ADD in valtio 2.3.2, so the input buffers locally instead; keyed on the
// item id, so switching chips reseeds it.
function CommentInput({ slug, id, initial }: { slug: string; id: number; initial: string }): ReactElement {
  const [value, setValue] = useState(initial)
  return (
    <input
      type="text"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
        setContextComment(slug, id, event.target.value)
      }}
      placeholder="Add a comment on this selection…"
      autoFocus
      className="mt-2 block w-full rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-muted focus:border-accent"
    />
  )
}
