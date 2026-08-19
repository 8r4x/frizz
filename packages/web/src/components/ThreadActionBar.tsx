import { useState, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { openThread, showToast, store } from "../store.ts"
import { rpc } from "../api/rpc.ts"
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
  // A FOREIGN session (one of the human's own terminals — no registry row) has no channel frizz can
  // send into, so it gets no composer. It gets the ONE verb that changes that: adopting it binds a
  // registry row to the conversation, after which it is an ordinary thread with an ordinary composer.
  if (thread.foreign) return <AdoptForeignSession slug={slug} />

  return (
    <ThreadComposerBox
      slug={slug}
      surface="chatComposer"
      id="followup-input"
      placeholder="Follow up…"
      // PADDING ONLY — no border, no background. The separator + panel fill belong to the
      // [data-thread-chat-footer] wrapper in ChatView that hosts this bar; carrying them here too
      // stacked a second hairline directly under the first, so the line above the prompt box read
      // as a 2px rule instead of the queue card's single hairline. Same shape as the queue card's
      // own call site (TodosView: `shrink-0 px-5 pb-3 pt-0`) and as drawer-composer-footer-fixture.
      className="shrink-0 px-3 py-3"
      ops={ops}
    />
  )
}

// The old ⋯ overflow menu is gone: the frizz-document, retry, and done actions all live as direct
// icons in the shared <HeaderActions> (Kill and Dismiss were dropped entirely — an exited session
// is retried from the header, or cleared through the lifecycle footer).

// The Non-Frizz band's one verb. Adoption creates the ROW and nothing else — the session is at rest
// (the band lists nothing else), so the human's first message resumes it through the ordinary
// follow-up path, which is also why this bar is replaced by a real composer the moment it lands.
//
// The row leaves the Non-Frizz band on its own: the id now belongs to a registry row, so the tailer's
// foreign scan stops returning it on the next tick. Nothing here has to un-list it.
function AdoptForeignSession({ slug }: { slug: string }) {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((t) => t.id === slug)
  const [adopting, setAdopting] = useState(false)
  if (!thread) return null

  const adopt = async () => {
    if (adopting) return
    setAdopting(true)
    try {
      const res = await rpc.adoptSession({
        sessionId: slug,
        backend: thread.backend === "codex" ? "codex" : "claude",
        // The name the human is looking at right now, so the adopted thread keeps it rather than
        // having the server re-derive one from a transcript it would have to re-open.
        ...(thread.title ? { title: thread.title.slice(0, 200) } : {}),
      })
      // Straight into the adopted thread: the point of adopting is to say something to it, and the
      // foreign drawer this replaces is keyed by the OLD id, which no longer names a foreign row.
      openThread(res.slug)
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That session could not be adopted")
      setAdopting(false)
    }
  }

  return (
    // gap-3 MEASURED, not assumed (scripts/ink-gaps.mjs, dsf 4, on the real bar): 12px of box reads as
    // 12.91px of ink. A bordered button's border IS its ink (deadLeft 0), and the sentence's ink stops
    // ~0.9px inside its box on the full stop — so nothing here needs a negative-margin trim, which is
    // exactly the case a glyph-in-a-hover-square would NOT be. The verb is the brighter of the two on
    // purpose: a readout is quieter than the thing you can do.
    <div className="shrink-0 flex items-center gap-3 px-4 py-3 text-[11.5px] text-muted/70">
      <span>Read-only — running in an external terminal.</span>
      <button
        type="button"
        onClick={adopt}
        disabled={adopting}
        className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-fg/80 transition-colors hover:border-border hover:text-fg disabled:opacity-50"
        title="Bind a Frizz thread to this conversation so you can send it messages"
      >
        {adopting ? "Adopting…" : "Adopt into Frizz"}
      </button>
    </div>
  )
}
