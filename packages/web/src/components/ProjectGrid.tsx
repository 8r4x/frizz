// THE MACHINE'S HOME PAGE: every project Frizz knows about, one card each, and a way to add another.
//
// This is the third root shell beside <App/> and <StandaloneThreadPage/> (main.tsx). It renders at
// `/` and nothing else; a project's own board lives at `/<slug>`, which is what freed the root.
//
// It draws entirely from the registry index — one file read, no databases opened. Opening forty
// projects to draw forty cards is exactly the cost lazy activation exists to avoid, so a card
// deliberately shows only what the index holds. Visiting a card is what opens that project.
import * as RadixDialog from "@radix-ui/react-dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { ProjectCard } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { relativeAge } from "../lib/activityTime.ts"
import { projectHref } from "../lib/base-path.ts"

/**
 * The mark, at the size where it is legible AS a mark.
 *
 * Measured against the shipped favicon at 40 / 56 / 76 / 96: it is five fibers pulling loose from a
 * wrapped bundle, and below ~70px the strands collapse into a silhouette that reads as a HAND. 76 is
 * the first size where the bundle's wrap and the gaps between strands both survive.
 */
const MARK_PX = 76

/** `/Users/me/code/nub` → `~/code/nub`. The home prefix is noise on every row. */
function shortPath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const CARD_BASE =
  "flex flex-col gap-1 rounded-lg border px-4 py-3 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60"

function Card({ project, home }: { project: ProjectCard; home: string | undefined }) {
  const opened = relativeAge(project.lastOpenedAt)
  return (
    <a
      href={projectHref(project.slug)}
      className={`${CARD_BASE} border-border bg-panel hover:border-border-strong hover:bg-panel-2 ${
        project.stale ? "opacity-60" : ""
      }`}
    >
      {/* min-w-0 is what makes truncate real: a flex item will not shrink below its content
          without it, so a long name would push its slug straight through the card border. */}
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium text-fg">{project.name}</span>
        {/* Shown only when it is not simply the name: a directory called "app" under "pullfrog"
            lives at /pullfrog-app and that is worth saying, while "nub" would just repeat itself. */}
        {project.slug !== project.name ? (
          <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted/70">
            /{project.slug}
          </span>
        ) : null}
      </div>
      <span className="truncate text-[11px] text-muted" title={project.path}>
        {shortPath(project.path, home)}
      </span>
      <span className="text-[11px] text-muted/70">
        {project.stale ? "Directory is missing" : opened ? `Opened ${opened}` : "Never opened"}
      </span>
    </a>
  )
}

/**
 * The phantom card.
 *
 * Dashed and never filled: it is an affordance, not a project, and on a grid whose whole job is
 * "pick one of these" a solid card that is not one of these is a small lie. On an empty machine it
 * is the only thing on the page, so it grows a line of explanation instead of being a footnote.
 */
function PhantomCard({
  hero,
  pending,
  onClick,
}: {
  hero?: boolean
  pending?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={`${CARD_BASE} items-center justify-center gap-1.5 border-dashed border-border-strong bg-transparent text-muted hover:border-accent hover:text-fg ${
        hero ? "min-h-[118px]" : "min-h-[74px]"
      }`}
    >
      <span className="text-[17px] leading-none text-muted/70">+</span>
      <span className="text-[12.5px]">{pending ? "Choosing a folder…" : "Add a project"}</span>
      {hero ? (
        <span className="text-[11px] text-muted/70">Point Frizz at a folder on this machine</span>
      ) : null}
    </button>
  )
}

function AddProjectDialog({ reason, onClose }: { reason?: string; onClose: () => void }) {
  const [path, setPath] = useState("")
  const queryClient = useQueryClient()
  const add = useMutation({
    mutationFn: (input: string) => rpc.projectAdd({ path: input }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      // Adding a project is only ever a step towards opening it.
      location.assign(projectHref(project.slug))
    },
  })
  const error = add.error instanceof Error ? add.error.message : add.error ? String(add.error) : null

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open && !add.isPending) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[210] bg-black/30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[210] w-[460px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-black/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">Add a project</RadixDialog.Title>
          <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted">
            {reason ? `${reason}. Paste the folder instead — ` : "Paste the folder you want a board for. "}
            Frizz walks up to the repository root, the same way it does when you run it in a terminal.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!add.isPending) add.mutate(path)
            }}
          >
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="~/code/my-project"
              spellCheck={false}
              className={`w-full rounded-md border bg-bg px-2.5 py-2 font-mono text-[12px] text-fg outline-none placeholder:text-muted/50 focus-visible:ring-1 focus-visible:ring-fg/60 ${
                error ? "border-red-500/60" : "border-border-strong"
              }`}
            />
            {error ? <p className="mt-1.5 text-[11.5px] text-red-400">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={add.isPending}
                className="rounded-md border border-border-strong bg-elevated px-3 py-1.5 text-[12.5px] text-fg outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={add.isPending || path.trim().length === 0}
                className="rounded-md border border-accent bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-50"
              >
                {add.isPending ? "Adding…" : "Add project"}
              </button>
            </div>
          </form>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function ProjectGrid() {
  // The typed-path dialog is the FALLBACK, not the front door: it opens only when the machine has no
  // picker, or the picker failed to open and said why.
  const [fallback, setFallback] = useState<{ reason?: string } | null>(null)
  const queryClient = useQueryClient()
  const pick = useMutation({
    mutationFn: () => rpc.projectPick({}),
    onSuccess: (result) => {
      if (result.kind === "cancelled") return
      if (result.kind === "unavailable") {
        setFallback({ reason: result.reason })
        return
      }
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      location.assign(projectHref(result.project.slug))
    },
    // A picker that throws is still a machine without a working picker.
    onError: (error) => setFallback({ reason: error instanceof Error ? error.message : String(error) }),
  })
  const { data, isPending, error } = useQuery({
    queryKey: ["projectsList"],
    queryFn: () => rpc.projectsList(),
  })
  // The home directory is only ever used to shorten a path for display, so a miss costs a longer row.
  const home = data?.[0]?.path.match(/^(\/(?:Users|home)\/[^/]+)\//u)?.[1]
  const empty = data !== undefined && data.length === 0

  return (
    // m-auto rather than justify-center: a centred flex column CLIPS its overflow at the top once
    // the content is taller than the viewport, and forty projects will be. Auto margins centre while
    // still letting the page scroll from its real top.
    <div className="flex min-h-dvh w-full flex-col px-6 py-14">
      <div className="m-auto flex w-full flex-col items-center">
      <div className="mb-8 flex flex-col items-center gap-2.5 text-center">
        <img src="/favicon.svg" width={MARK_PX} height={MARK_PX} alt="" className="rounded-[17px]" />
        <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-fg">
          {empty ? "Welcome to Frizz" : "Select a project"}
        </h1>
        {empty ? (
          <p className="max-w-[420px] text-[13px] leading-relaxed text-muted">
            A project is a folder on this machine. Frizz keeps one board of threads per project, and
            serves them all from here.
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="text-[13px] text-muted">Could not read the project registry: {String(error)}</p>
      ) : isPending ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : (
        <>
          <div
            className={`grid w-full gap-2.5 ${
              empty ? "max-w-[360px] grid-cols-1" : "max-w-[720px] grid-cols-1 sm:grid-cols-2"
            }`}
          >
            {data.map((project) => (
              <Card key={project.id} project={project} home={home} />
            ))}
            <PhantomCard hero={empty} pending={pick.isPending} onClick={() => pick.mutate()} />
          </div>
          {empty ? (
            <p className="mt-6 text-[11.5px] text-muted/70">
              Or run{" "}
              <code className="rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-muted">
                frizz
              </code>{" "}
              inside any folder — it registers itself and opens.
            </p>
          ) : null}
        </>
      )}

      </div>
      {fallback ? (
        <AddProjectDialog reason={fallback.reason} onClose={() => setFallback(null)} />
      ) : null}
    </div>
  )
}
