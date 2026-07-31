import { type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"
import { ThreadComposerBox } from "./ThreadComposerBox.tsx"

// The bar under the chat/terminal is now JUST the follow-up composer — the Done button and the
// ⋯ menu live in the workpane header (ThreadHeaderActions) next to the tabs. `ops` (the live
// background-operations strip) renders INSIDE the padded box rather than beside it, so those rows
// hang tight off the prompt and the box's own pb becomes their gap to the lifecycle footer.
//
// This is now a THIN wrapper: the foreign-terminal read-only check, plus <ThreadComposerBox> — the same
// block the queue card renders. Everything the two surfaces must agree on (the draft key, the
// `/login`/`/logout` intercept, the model/effort footer, the status line) lives in that component.
export function ThreadActionBar({ slug, ops }: { slug: string; onTerminal?: () => void; ops?: ReactNode }) {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((t) => t.id === slug)

  if (!thread) return null
  // A FOREIGN session (a maintainer terminal — no registry row) is a read-only transcript view: no
  // composer, no verbs. Say so plainly instead of the follow-up box (there's no tmux stdin to steer).
  if (thread.foreign) {
    return (
      <div className="shrink-0 border-t border-border bg-panel px-4 py-3 text-[11.5px] text-muted/70">
        Read-only — running in an external terminal.
      </div>
    )
  }

  return (
    <ThreadComposerBox
      slug={slug}
      surface="chatComposer"
      id="followup-input"
      placeholder="Follow up…"
      className="shrink-0 border-t border-border bg-panel px-3 py-3"
      ops={ops}
    />
  )
}

// The old ⋯ overflow menu is gone: the fray-document, retry, and done actions all live as direct
// icons in the shared <HeaderActions> (Kill and Dismiss were dropped entirely — an exited session
// is retried from the header, or cleared through the lifecycle footer).
