import { useCallback, useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { seedBoard, store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import { projectHref } from "../lib/base-path.ts"
import { standaloneThreadHref } from "../lib/standaloneThreadRoute.ts"
import { ThreadView } from "./ChatView.tsx"
import { DrawerStack } from "./DrawerStack.tsx"
import { FileViewerPanel } from "./FileViewerPanel.tsx"
import { FocusRail } from "./FocusRail.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { Toaster } from "./Toaster.tsx"
import { useQuery } from "@tanstack/react-query"

/**
 * The `/full` page for a thread in ANOTHER project — the two places that must name a project other
 * than this page's. Composed from the two helpers that own the shapes rather than spelled by hand:
 * these were the only call sites bypassing `projectHref`, and a hand-spelled prefix is exactly how the
 * ↗ button came to mint an unprefixed URL in the first place.
 */
function standaloneHrefIn(projectSlug: string, slug: string): string {
  // `"/"` forces the UNPREFIXED inner form: this page may itself be prefixed (a `/project/a/…/full`
  // link to a thread that turns out to live in project b), and `standaloneThreadHref` would otherwise
  // stamp THIS page's prefix on before we prepend the other project's.
  return `${projectHref(projectSlug)}${standaloneThreadHref(slug, "/")}`
}

export function StandaloneThreadPage({ slug }: { slug: string }) {
  const board = useBoard()
  const route = resolveThreadRoute(board, slug)
  const thread = route.kind === "found" ? route.thread : undefined
  const projectDir = board?.projectDir

  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
  }, [])

  // SPLIT MODE for the file reader: while this page is mounted (and the window is wide enough for two
  // real columns), a click on a local file renders beside the thread instead of as a sheet over it —
  // Markdown through pushMarkdownDrawer, any other text file through openLocalPath (a project file in
  // the rail's Edited files list, say). Tracked live so shrinking the window falls back to the drawer for later
  // clicks; a panel already open stays (its layout degrades gracefully, and yanking it on resize
  // would lose the reader's place).
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1000px)")
    const apply = () => { store.splitFileViewer = wide.matches }
    apply()
    wide.addEventListener("change", apply)
    return () => {
      wide.removeEventListener("change", apply)
      store.splitFileViewer = false
      store.filePanel = null
    }
  }, [])


  const atRest = thread?.runtime === "turn-idle" || thread?.runtime === "exited" || thread?.runtime === "none"
  useEffect(() => {
    if (!thread || !atRest) return
    rpc.threadSeen({ slug }).catch(() => {})
  }, [atRest, slug, thread?.lastActivityAt])

  // "<thread> · owner/repo — Frizz". The thread title LEADS because a tab truncates from the end and
  // several of these are usually open on the same repo at once — the thread is what tells them apart.
  // The workspace identity trails as "owner/repo — Frizz", the same mark the installed app window uses.
  useEffect(() => {
    const projectLabel = board?.projectLabel ?? board?.projectName
    const threadLabel = thread ? displayTitle(thread) : slug
    document.title = projectLabel ? `${threadLabel} · ${projectLabel} — Frizz` : `${threadLabel} · Frizz`
  }, [board?.projectLabel, board?.projectName, slug, thread])

  return (
    <TooltipProvider>
      <div className="h-dvh min-h-0 bg-bg text-sm text-fg">
        {/* THE FULLSCREEN LAYOUT (maintainer 2026-08-28: "truly fullscreen"): the thread column sits
            LEFT-ALIGNED against the viewport edge, the operational rail floats beside it, and the file
            viewer takes whatever is left when a file is open — no centering, no outer gutters. The
            column keeps a reading-width ceiling; the page background beyond the rail is the same
            gutter the board draws beside its own centered pair. A phone-width window still gets the
            old single column: the rail and the viewer need the width they hide under. */}
        <div className="flex h-full w-full">
          <main
            data-standalone-thread
            className="flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden border-border bg-panel sm:max-w-[960px] sm:border-r"
          >
            {route.kind === "loading" ? (
              <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading thread">
                <span className="block h-5 w-5 animate-spin rounded-full border-2 border-muted/50 border-t-transparent" />
              </div>
            ) : route.kind === "missing" ? (
              <MissingThread slug={slug} />
            ) : (
              <ThreadView slug={slug} virtualized showReturnToQueue />
            )}
          </main>
          {thread && <div className="hidden h-full min-h-0 md:block"><FocusRail thread={thread} /></div>}
          <FileViewerSlot slug={slug} />
        </div>
        {/* The SAME drawer stack the queue mounts. Without it every drill-in this page renders — a
            sub-agent row, a background-shell row, the frizz-doc button, a `[…](/thread/<slug>)` link —
            pushed a layer onto the store that nothing displayed, so the click was simply dead. Mounted
            OUTSIDE <main> (which is overflow-hidden); the sheets are `fixed inset-0` and no ancestor
            here creates a containing block, so they cover the viewport exactly as they do in App. */}
        <DrawerStack />
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

// The panel's width, shared by the animated slot and its fixed-width inner content. The inner stays
// at FULL width for the whole slide so the panel's content never reflows mid-animation — the slot's
// overflow-hidden clip is what reveals it.
const FILE_PANEL_WIDTH = "min(52rem, 45vw)"

// The width-animated slot the split file viewer lives in. Width 0 ⇄ panel width is the slide: the
// flex pair recenters as it animates, which moves the thread column left exactly as the panel comes
// in. The panel's CONTENT outlives the store entry by the ~200ms slide-out (`current`), so closing
// animates the same edge instead of blanking the column and collapsing an empty gutter.
function FileViewerSlot({ slug }: { slug: string }) {
  const snap = useSnapshot(store)
  const panel = snap.filePanel
  const [current, setCurrent] = useState<string | null>(null)
  useEffect(() => {
    if (panel) {
      setCurrent(panel.path)
      return
    }
    const timer = window.setTimeout(() => setCurrent(null), 220)
    return () => window.clearTimeout(timer)
  }, [panel?.path, panel?.openedAt, panel])
  return (
    <aside
      data-file-viewer-slot
      aria-hidden={!panel}
      className="h-full min-h-0 shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
      style={{ width: panel ? FILE_PANEL_WIDTH : 0 }}
    >
      {current && (
        <div className="flex h-full min-h-0 flex-col" style={{ width: FILE_PANEL_WIDTH }}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden border-border bg-panel sm:border-l">
            {/* Keyed on the path so following a link inside the viewer resets the view toggle and
                scroll to the new document's top. */}
            <FileViewerPanel key={current} slug={slug} path={current} />
          </div>
        </div>
      )}
    </aside>
  )
}

/**
 * A thread this project does not have — which, since one server started serving every project, is
 * usually a thread ANOTHER project has.
 *
 * Every URL from the per-project era is unprefixed: `localhost:4917/thread/fix-auth/full` was
 * unambiguous because the PORT named the project. The same path now resolves against whichever
 * project launched the server, so a bookmark that worked yesterday lands here. It is not lost, it is
 * one directory over — so look, and say where it went rather than blaming the operator.
 */
function MissingThread({ slug }: { slug: string }) {
  const { data, isPending } = useQuery({
    queryKey: ["threadLocate", slug],
    queryFn: () => rpc.threadLocate({ slug }),
  })
  // Exactly one owner is the overwhelmingly common case, and there is nothing to choose between.
  useEffect(() => {
    if (data?.length === 1) location.replace(standaloneHrefIn(data[0].projectSlug, slug))
  }, [data, slug])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div>
        <h1 className="font-medium text-fg">Thread unavailable</h1>
        {isPending ? (
          <p className="mt-1 text-muted">Looking for “{slug}” in your other projects…</p>
        ) : data && data.length > 0 ? (
          <p className="mt-1 text-muted">
            “{slug}” lives in {data.length === 1 ? "another project" : "these projects"} — opening it there.
          </p>
        ) : (
          <p className="mt-1 text-muted">Thread “{slug}” was not found in any project on this machine.</p>
        )}
      </div>
      {data && data.length > 1 ? (
        <div className="flex flex-wrap justify-center gap-2">
          {data.map((hit) => (
            <a
              key={hit.projectSlug}
              href={standaloneHrefIn(hit.projectSlug, slug)}
              className="rounded-md border border-border px-3 py-1.5 text-[12px] text-fg/90 hover:bg-panel-2"
            >
              {hit.projectName}
            </a>
          ))}
        </div>
      ) : (
        <a href="/" className="rounded-md border border-border px-3 py-1.5 text-[12px] text-fg/90 hover:bg-panel-2">
          All projects
        </a>
      )}
    </div>
  )
}
