// THE MACHINE'S HOME PAGE: every project Frizz knows about, one card each, and a way to add another.
//
// It renders at `/` and nothing else; a project's own board lives at `/project/<slug>`, which is what
// freed the root. The RAIL and the tooltip provider are NOT here — they belong to the layout route
// that stays mounted across a navigation (routes.tsx), which is what stops the rail rebuilding itself
// every time you use it.
//
// It draws entirely from the registry index — one file read, no databases opened. Answering a list
// request by opening forty projects is exactly the cost lazy activation exists to avoid, so a card
// deliberately shows only what the index holds. (The server does open them all in the background about
// a second after boot — server/tenant-prime.ts — but on its own clock, never on a request's.)
import * as RadixDialog from "@radix-ui/react-dialog"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ImagePlus } from "lucide-react"
import { Link, useNavigate } from "react-router"
import type { ProjectCard } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { relativeAge } from "../lib/activityTime.ts"
import { projectHref } from "../lib/base-path.ts"
import { showToast } from "../store.ts"
import { ProjectIconMenu, ProjectSquare } from "./ProjectRail.tsx"

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

// On a phone the same rows go FULL WIDTH: no card border, no radius, no grid gutter — a hairline
// between rows instead, and the whole row is the target. The grid above the breakpoint is untouched.
const MOBILE_ROW = "max-[700px]:rounded-none max-[700px]:border-x-0 max-[700px]:border-t-0 max-[700px]:border-b-border/70 max-[700px]:bg-transparent max-[700px]:py-3.5"

/** The card's icon is the rail's square at card size, and the one place to change it. */
const CARD_ICON = 38

function Card({ project, home }: { project: ProjectCard; home: string | undefined }) {
  const opened = relativeAge(project.lastOpenedAt)
  return (
    // A relatively-positioned WRAPPER, not a bordered card of its own: the icon menu's trigger has to
    // sit OUTSIDE the <a> (a button nested in a link is invalid, and clicking it would navigate), so
    // the link fills the wrapper and the trigger is laid over the square from outside it.
    // `group/card`: the hover lift is keyed to the WRAPPER so the card still lights when the pointer is
    // on the icon trigger, which covers the square from outside the link — otherwise the row would go
    // flat the moment you reached its own picture.
    <div className="group/card relative">
      <Link
        to={projectHref(project.slug)}
        className={`${CARD_BASE} ${MOBILE_ROW} flex-row items-center gap-3 border-border bg-panel group-hover/card:border-border-strong group-hover/card:bg-panel-2 ${
          project.stale ? "opacity-60" : ""
        }`}
      >
        <span className={`shrink-0 ${project.stale ? "grayscale" : ""}`}>
          <ProjectSquare project={project} size={CARD_ICON} />
        </span>
        {/* min-w-0 is what makes truncate real: a flex item will not shrink below its content
            without it, so a long name would push its slug straight through the card border. */}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-fg">{project.name}</span>
            {/* Shown only when it is not simply the name: a directory called "app" under "pullfrog"
                lives at /pullfrog-app and that is worth saying, while "nub" would just repeat itself. */}
            {project.slug !== project.name ? (
              <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted/70">
                /{project.slug}
              </span>
            ) : null}
          </span>
          <span className="truncate text-[11px] text-muted" title={project.path}>
            {shortPath(project.path, home)}
          </span>
          <span className="truncate text-[11px] text-muted/70">
            {project.stale ? "Directory is missing" : opened ? `Opened ${opened}` : "Never opened"}
          </span>
        </span>
      </Link>
      {/* THE ICON IS THE CONTROL. The trigger is the square's own footprint — same size, same corner
          radius, laid exactly over it. The offsets are the link's frame, which this sits outside of:
          17 is its 1px border plus `px-4`, and the square is centred in the link, so `top-1/2` plus the
          translate centres this on it. The phone row (MOBILE_ROW) drops the side and top borders and
          keeps the bottom one, so there it is 16, and the centre moves up half the missing top border
          — measured 2026-08-24: 1px left and 0.5px low without these. It draws nothing until the
          pointer is over the square, when a scrim and an image glyph say "this changes the picture" —
          the scrim at 75%, because at 60% a monogram's letters and a logo's strokes still showed
          through and tangled with the glyph (measured at dsf 6, 2026-08-24). It stays lit while its
          menu is open (Radix stamps `data-state` on the trigger) and for a keyboard user once focused.
          It sat in the card's bottom-right corner until 2026-08-24, where nothing tied it to the
          picture it changed (maintainer: hover the logo, or lack thereof, and the button should appear
          there). Hovering the square now hits this, not the link, so the square is no longer part of
          the click target — the rest of the row still is. */}
      <ProjectIconMenu project={project}>
        <button
          type="button"
          aria-label={`Change the icon for ${project.name}`}
          style={{ width: CARD_ICON, height: CARD_ICON }}
          className="absolute left-[17px] top-1/2 flex -translate-y-1/2 items-center justify-center rounded-[30%] bg-black/75 text-fg opacity-0 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-fg/60 data-[state=open]:opacity-100 max-[700px]:left-4 max-[700px]:top-[calc(50%-0.5px)]"
        >
          <ImagePlus size={16} strokeWidth={1.75} />
        </button>
      </ProjectIconMenu>
    </div>
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
      className={`${CARD_BASE} items-center justify-center gap-1.5 border-dashed border-border-strong bg-transparent text-muted hover:border-accent hover:text-fg max-[700px]:mx-4 max-[700px]:mt-4 ${
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

function AddProjectDialog({
  reason,
  proposed,
  onClose,
}: {
  reason?: string
  /** A directory `frizz` was just run in. Pre-filled, never pre-registered. */
  proposed?: string
  onClose: () => void
}) {
  const [path, setPath] = useState(proposed ?? "")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const add = useMutation({
    mutationFn: (input: string) => rpc.projectAdd({ path: input }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      // Adding a project is only ever a step towards opening it. `navigate`, not location.assign:
      // the rail is already showing and must not be torn down to open what was just added.
      navigate(projectHref(project.slug))
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
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">
            {proposed ? "Add this folder as a project?" : "Add a project"}
          </RadixDialog.Title>
          <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted">
            {proposed
              ? "You ran Frizz here and it is not a project yet. Nothing has been written — adding it is what creates its board."
              : reason
                ? `${reason}. Paste the folder instead — Frizz walks up to the repository root, the same way it does when you run it in a terminal.`
                : "Paste the folder you want a board for. Frizz walks up to the repository root, the same way it does when you run it in a terminal."}
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
                {proposed ? "Not now" : "Cancel"}
              </button>
              <button
                type="submit"
                disabled={add.isPending || path.trim().length === 0}
                className="rounded-md border border-accent bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-50"
              >
                {add.isPending ? "Adding…" : proposed ? "Add it" : "Add project"}
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
  // `?add=<dir>` is the LAUNCHER asking, not a registration: running `frizz` in an unknown folder
  // no longer adopts it, it sends you here to say yes. Read once — the answer belongs to this visit,
  // and leaving it in the URL would re-ask on every reload.
  const [proposed] = useState(() => {
    const value = new URLSearchParams(location.search).get("add") ?? undefined
    if (value) history.replaceState(null, "", location.pathname)
    return value
  })
  const [fallback, setFallback] = useState<{ reason?: string } | null>(proposed ? {} : null)
  // `?unknown=<slug>` is the SERVER saying it sent a page here rather than let it hang: `/project/<x>`
  // for a project nobody has used to render the app anyway, where every call came back 404, the board
  // never arrived, and the page sat on "connecting…" forever (index.ts `unknownProjectPage`). A URL
  // that silently turns into the picker reads as Frizz having swallowed it, so say what happened. Read
  // once and stripped, exactly like `?add=` above — it belongs to this arrival, not to the address.
  useEffect(() => {
    const slug = new URLSearchParams(location.search).get("unknown")
    if (!slug) return
    history.replaceState(null, "", location.pathname)
    showToast(`No project named ${slug} — showing all projects instead`, { duration: 7000 })
  }, [])
  const navigate = useNavigate()
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
      navigate(projectHref(result.project.slug))
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
    <div className="flex min-h-dvh w-full flex-col px-6 py-14 max-[700px]:px-0 max-[700px]:py-10">
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
            className={`grid w-full gap-2.5 max-[700px]:gap-0 ${
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
        <AddProjectDialog reason={fallback.reason} proposed={proposed} onClose={() => setFallback(null)} />
      ) : null}
    </div>
  )
}
