import { useCallback, useEffect, useRef, useState } from "react"
import { seedBoard } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle } from "../groups.ts"
import { resolveThreadRoute } from "../lib/threadRouteState.ts"
import { ThreadView } from "./ChatView.tsx"
import { DrawerStack } from "./DrawerStack.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { Toaster } from "./Toaster.tsx"
import { useQuery } from "@tanstack/react-query"

export function StandaloneThreadPage({ slug }: { slug: string }) {
  const board = useBoard()
  const route = resolveThreadRoute(board, slug)
  const thread = route.kind === "found" ? route.thread : undefined
  const projectDir = board?.projectDir

  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
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
      <div className="h-dvh min-h-0 bg-bg px-0 text-sm text-fg sm:px-5">
        <main
          data-standalone-thread
          className="mx-auto flex h-full w-full max-w-[900px] min-w-0 flex-col overflow-hidden border-border bg-panel sm:border-x"
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
    if (data?.length === 1) location.replace(`/project/${data[0].projectSlug}/thread/${encodeURIComponent(slug)}/full`)
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
              href={`/project/${hit.projectSlug}/thread/${encodeURIComponent(slug)}/full`}
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
