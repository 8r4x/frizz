import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Plus } from "lucide-react"
import type { ProjectCard } from "@frizz/shared"
import { PROJECT_ICON_EXTENSIONS } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { projectHref, projectSlug } from "../lib/base-path.ts"
import { Tooltip } from "./Tooltip.tsx"

// THE PROJECT RAIL — every project on this machine as one icon square, always on screen.
//
// Slack's and Discord's rail, and for their reason: once a person is working across a dozen
// workspaces, "which one am I in" and "take me to another" are constant questions, and a home page
// answers neither without a round trip. Frizz reached the same point when one server started serving
// every project — the grid at `/` is a fine front door and a poor switcher.
//
// It is FIXED to the viewport's left edge, outside App's centered sidebar+workpane pair, so it holds
// still while the page scrolls and never enters the measure of anything else. App reserves its width
// with a padding-left on the container rather than a margin on the pair, so the pair still centers in
// whatever space is left.
//
// HIDDEN BELOW 800px, where the sidebar already stacks above the workpane and a permanent 56px column
// would be a tenth of the viewport spent on navigation. The grid at `/` is the switcher there.

/**
 * The column's total painted width, and the inset every surface beside it reserves.
 *
 * 57 and not 56 because the rail is border-box and carries a 1px right border: at 56 the CONTENT box
 * is 55, and a 40px square centred in 55 sits half a pixel left of centre — measured at 7.5px on the
 * left against 8.5px on the right. 57 gives it a 56px content box and a true 8/8.
 *
 * Exported as a pair so the reserved space and the painted width cannot drift apart.
 */
export const RAIL_WIDTH_CLASS = "w-[57px]"
export const RAIL_INSET_CLASS = "max-[800px]:pl-0 pl-[57px]"
/** What a fixed-position surface must clear to sit beside the rail rather than under it. */
export const RAIL_WIDTH_PX = 57

/**
 * A stable hue per project, from its id.
 *
 * A monogram is what a project with no icon gets, and forty grey squares would defeat the point of a
 * rail entirely — colour is doing the identifying. The id is a UUID and never changes, so a project's
 * colour is stable across machines, renames and moves; hashing the NAME would reshuffle the rail
 * whenever someone renamed something.
 */
function monogramHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360
  return hash
}

/**
 * One or two letters, from word boundaries rather than the first two characters.
 *
 * `standard-schema` reads as SS and `fray` as F. Two letters is the ceiling: three stops being a
 * monogram and starts being unreadable text at 40px.
 */
export function monogram(name: string): string {
  const words = name.split(/[\s\-_./]+/u).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

/** The icon URL for a project, versioned so a replaced icon is a different URL. See ProjectCard. */
export function projectIconSrc(project: ProjectCard): string {
  const version = project.iconVersion ? `&v=${encodeURIComponent(project.iconVersion)}` : ""
  return `/_frizz/project-icon?id=${encodeURIComponent(project.id)}${version}`
}

/**
 * The square itself: the project's icon, or its monogram until we know there isn't one.
 *
 * The monogram is what renders while the icon loads AND if it never does, with the `<img>` laid over
 * it and revealed only on load. That ordering is deliberate — a rail of forty squares fetches forty
 * icons, and the alternative (blank until loaded) is a rail that assembles itself in front of you.
 */
export function ProjectSquare({ project, size }: { project: ProjectCard; size: number }) {
  const [loaded, setLoaded] = useState(false)
  const hue = monogramHue(project.id)
  return (
    <span
      className="relative block overflow-hidden rounded-[30%] bg-elevated"
      style={{
        width: size,
        height: size,
        // Low saturation and lightness: these sit against a near-black rail and must read as a
        // surface with a letter on it, not as a colour chip. The letter carries the same hue at full
        // brightness so the pairing stays legible at any hue.
        background: loaded ? undefined : `hsl(${hue} 32% 24%)`,
      }}
    >
      {!loaded && (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center font-semibold leading-none"
          // 0.4em of the square: the same proportion Slack's initials use, and small enough that two
          // letters still clear the rounded corners.
          style={{ fontSize: size * 0.4, color: `hsl(${hue} 55% 78%)` }}
        >
          {/*
            `items-center` centres the LINE BOX, and a line box is half-leading plus a descender the
            monogram never uses — so where the ink lands depends entirely on the font's metrics. THIS
            APP RENDERS IN TWO (html[data-font]), and measured on this tile the same two letters sat
            0.50px BELOW centre in the sans stack and 1.02px ABOVE it in mono: a 1.5px spread, and no
            single constant is right in both.

            `text-box: trim-both cap alphabetic` makes the box the CAP BAND itself — baseline to cap
            height, which for A-Z is exactly the ink — so the browser recomputes it per font and the
            centring is correct in both with nothing to re-measure. Where it is unsupported the line
            box is used as before, which is the ≤1px placement this replaced rather than a broken one.
          */}
          <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>
            {monogram(project.name)}
          </span>
        </span>
      )}
      <img
        src={projectIconSrc(project)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
        // object-contain, never cover: a logo cropped to fill its square is a mangled logo, and the
        // scan admits some non-square marks (a 300×331 `.github/logo.webp` is a real case). The
        // padding keeps a full-bleed icon off the rounded corners without shrinking a letterboxed one
        // into a stamp.
        className={`relative h-full w-full object-contain p-[6%] transition-opacity ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </span>
  )
}

const SQUARE = 40

/**
 * The current project's square grows a pill on the rail's left edge.
 *
 * Discord's indicator, because the alternative — marking the square itself — competes with the icon
 * it is drawn on top of. The pill lives in the gutter, where nothing else does.
 */
function RailLink({ project, current }: { project: ProjectCard; current: boolean }) {
  return (
    <Tooltip side="right" label={project.stale ? `${project.name} — directory is missing` : project.name}>
      <a
        href={projectHref(project.slug)}
        aria-current={current ? "page" : undefined}
        className="group relative flex h-10 w-full items-center justify-center outline-none"
      >
        {/* 28 of the square's 40px — 70%. Discord runs 40 of 48 (83%) and 24 of 40 read as a stub
            against the square beside it; 28 is the same confident mark at this size. The hover stub
            is deliberately short: it says "this one" without pretending to be the current page. */}
        <span
          aria-hidden
          className={`absolute left-0 w-[3px] rounded-r-full bg-fg transition-all duration-150 ${
            current ? "h-7 opacity-100" : "h-2.5 opacity-0 group-hover:opacity-60"
          }`}
        />
        <span
          className={`transition-[transform,opacity] duration-150 group-hover:scale-[1.06] group-focus-visible:ring-1 group-focus-visible:ring-fg/60 rounded-[30%] ${
            current ? "" : "opacity-75 group-hover:opacity-100"
          } ${project.stale ? "grayscale" : ""}`}
        >
          <ProjectSquare project={project} size={SQUARE} />
        </span>
      </a>
    </Tooltip>
  )
}

/**
 * Choose, or stop choosing, this project's picture.
 *
 * A browser file input rather than the server's native picker: the picker exists because a PROJECT is
 * an absolute path the browser withholds, and an icon is bytes — which the browser hands over
 * happily. One fewer round trip and it works over a forwarded port.
 */
export function ProjectIconMenu({
  project,
  children,
}: {
  project: ProjectCard
  children: ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["projectsList"] })
  const set = useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Chunked: `String.fromCharCode(...bytes)` on a 4 MB icon blows the argument limit and throws
      // a RangeError that reads like a network failure.
      let binary = ""
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      }
      return rpc.projectIconSet({ id: project.id, name: file.name, data: btoa(binary) })
    },
    onSuccess: () => { setError(null); void invalidate() },
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
  })
  const clear = useMutation({
    mutationFn: () => rpc.projectIconClear({ id: project.id }),
    onSuccess: () => { setError(null); void invalidate() },
  })

  const item = "cursor-default rounded px-2 py-1.5 text-[12.5px] text-fg outline-none data-[highlighted]:bg-panel-2"
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={PROJECT_ICON_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Reset first: picking the same file twice in a row fires no change event otherwise, so a
          // failed upload could not be retried with the same file.
          event.target.value = ""
          if (file) set.mutate(file)
        }}
      />
      <RadixDropdown.Root>
        <RadixDropdown.Trigger asChild>{children}</RadixDropdown.Trigger>
        <RadixDropdown.Portal>
          <RadixDropdown.Content
            align="start"
            sideOffset={6}
            className="z-[220] min-w-[190px] rounded-lg border border-border bg-panel p-1 shadow-xl shadow-black/40"
          >
            <RadixDropdown.Item className={item} onSelect={() => input.current?.click()}>
              {set.isPending ? "Uploading…" : "Choose an icon…"}
            </RadixDropdown.Item>
            <RadixDropdown.Item className={item} onSelect={() => clear.mutate()}>
              {project.iconIsCustom ? "Use the detected icon" : "Look for an icon again"}
            </RadixDropdown.Item>
          </RadixDropdown.Content>
        </RadixDropdown.Portal>
      </RadixDropdown.Root>
      {error ? <p className="mt-1 text-[11px] text-red-400">{error}</p> : null}
    </>
  )
}

export function ProjectRail() {
  const { data } = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  const current = projectSlug()
  const [adding, setAdding] = useState(false)
  const pick = useMutation({
    mutationFn: () => rpc.projectPick({}),
    onSuccess: (result) => {
      if (result.kind === "picked") location.assign(projectHref(result.project.slug))
      // No picker on this machine, or it failed: the grid owns the typed-path fallback dialog, and
      // sending someone there is better than growing a second copy of it in a 56px column.
      else if (result.kind === "unavailable") location.assign("/")
    },
    onSettled: () => setAdding(false),
  })

  const projects = data ?? []

  return (
    <nav
      aria-label="Projects"
      className={`fixed inset-y-0 left-0 z-[60] flex flex-col items-center border-r border-border bg-panel/60 py-3 max-[800px]:hidden ${RAIL_WIDTH_CLASS}`}
    >
      <Tooltip side="right" label="All projects">
        <a href="/" aria-current={current ? undefined : "page"} className="shrink-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-fg/60">
          <img src="/favicon.svg" width={26} height={26} alt="All projects" className="opacity-80 transition-opacity hover:opacity-100" />
        </a>
      </Tooltip>
      <hr className="my-3 w-6 shrink-0 border-0 border-t border-border" />

      {/* The scrolling band. `min-h-0` is what lets it actually scroll inside a flex column, and the
          hidden scrollbar keeps a 56px column from spending 8px of itself on a track. */}
      <div // The fade mask is the only thing that says "there is more": with 29 projects the band scrolls
        // 1328px inside 773px, and a hard clip at the divider reads as the end of the list. 8px between
        // squares mirrors what Discord runs at 48px and Slack at 36px; 6 read tight at 40.
        className="frizz-rail-scroll flex w-full min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
        {projects.map((project) => (
          <RailLink key={project.id} project={project} current={project.slug === current} />
        ))}
      </div>

      <Tooltip side="right" label="Add a project">
        <button
          type="button"
          disabled={adding}
          onClick={() => { setAdding(true); pick.mutate() }}
          aria-label="Add a project"
          className="mt-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-[30%] border border-dashed border-border-strong text-muted outline-none transition-colors hover:border-accent hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-50"
        >
          <Plus size={16} />
        </button>
      </Tooltip>
    </nav>
  )
}
