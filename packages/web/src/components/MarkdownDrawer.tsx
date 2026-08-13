import { useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { localFileDir } from "../lib/markdownTargets.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// The BUILT-IN MARKDOWN READER: a right side sheet (the same slide/backdrop family as the plan and
// frizz-document drawers) rendering a `.md` file that lives on disk. Every link to one lands here
// instead of launching the desktop opener — a worker citing `AGENTS.md`, a backticked path that
// resolved to a doc, an attached `.md` — because throwing the user out of Frizz into an editor to read
// two paragraphs is the wrong answer to "what does that file say?".
//
// The file's own directory is passed as the render base, so its RELATIVE links (`./ARCHITECTURE.md`,
// `docs/x.md`, an image beside it) resolve to real paths — a doc that cross-references its neighbours
// is browsable, each link stacking another reader over this one. Content is a file on disk written by
// whoever wrote it, so it goes through the same allowlist sanitizer as every other prose surface.

const FOOTER_STYLE = { paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }

// The desktop-opener escape hatch. Reading is the default now, but a file you want to EDIT still
// belongs in the editor, and this is the only affordance left that gets it there. It honours the
// `localFileOpener` setting, exactly as a click on the link used to.
function OpenAction({ path }: { path: string }) {
  const open = () => {
    rpc
      .openLocalFile({ path })
      .then(async (result) => {
        if (result.action !== "copy") return
        await navigator.clipboard.writeText(result.path)
        showToast("Copied local path")
      })
      .catch((error) => showToast(`Could not open local file: ${(error as Error).message.slice(0, 100)}`))
  }
  return (
    <button
      type="button"
      onClick={open}
      onMouseDown={(e) => e.preventDefault()}
      className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
      title={`Open ${path} outside Frizz`}
      aria-label="Open"
    >
      <ExternalLink size={12} aria-hidden="true" /> Open
    </button>
  )
}

export function MarkdownDrawer({ id, path, title, depth, widthDepth }: { id: number; path: string; title: string; depth: number; widthDepth: number }) {
  const body = useQuery({ queryKey: ["localMarkdown", path], queryFn: () => rpc.localMarkdown({ path }) })
  // Base the relative links on the CANONICAL path the server resolved, not the one that was clicked:
  // a link through a symlinked directory would otherwise rebase its neighbours onto a directory the
  // gate never admitted, and every one of them would 404.
  const resolved = body.data?.path ?? path
  const html = useMarkdownHtml(body.data?.markdown ?? "", { baseDir: localFileDir(resolved), asDocument: true })
  const inner = useInnerHtml(html)
  const ref = useRef<HTMLDivElement>(null)
  useLocalFileCodeLinks(ref, html)

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* No leading icon, like every other SUBTITLED sheet here (plan, frizz-doc). SheetHeader centers
              an icon on the whole title+subtitle block, so beside a two-line header a 14px glyph measured
              7.00px below the title's cap band and read as floating between the lines. The basename is the
              title and the path is the subtitle; neither needs a glyph to say "file". */}
          <SheetHeader title={title} subtitle={resolved} onClose={close} />
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            {body.isLoading ? (
              <div className="text-[13px] text-muted">Loading…</div>
            ) : body.error ? (
              // The gate's own words — "outside Frizz's trusted roots", "was not found" — say more than
              // a generic failure would, and the footer still offers the desktop opener.
              <div className="text-[13px] text-red-400/90">Couldn’t read this file: {(body.error as Error).message}</div>
            ) : html ? (
              <>
                <div ref={ref} className="md-body" dangerouslySetInnerHTML={inner} />
                {body.data?.truncated && (
                  <p className="mt-4 border-t border-border/60 pt-3 text-[12px] text-muted">
                    This file is too long to render in full — everything above the cut is shown. Open it to read the rest.
                  </p>
                )}
              </>
            ) : (
              <div className="text-[13px] text-muted">This file is empty.</div>
            )}
          </div>
          <div
            className="shrink-0 flex items-center justify-end gap-1.5 border-t border-border/60 bg-panel px-5 pt-3"
            style={FOOTER_STYLE}
          >
            <OpenAction path={resolved} />
          </div>
        </>
      )}
    </Sheet>
  )
}
