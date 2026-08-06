// THE MACHINE'S HOME PAGE: every project Frizz knows about, one card each.
//
// This is the third root shell beside <App/> and <StandaloneThreadPage/> (main.tsx). It renders at
// `/` and nothing else; a project's own board lives at `/<slug>`, which is what freed the root.
//
// It draws entirely from the registry index — one file read, no databases opened. Opening forty
// projects to draw forty cards is exactly the cost lazy activation exists to avoid, so a card
// deliberately shows only what the index holds. Visiting a card is what opens that project.
import { useQuery } from "@tanstack/react-query"
import type { ProjectCard } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { relativeAge } from "../lib/activityTime.ts"

/** `/Users/me/code/nub` → `~/code/nub`. The home prefix is noise on every row. */
function shortPath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function Card({ project, home }: { project: ProjectCard; home: string | undefined }) {
  const opened = relativeAge(project.lastOpenedAt)
  return (
    <a
      href={`/${project.slug}`}
      className={`group flex flex-col gap-1 rounded-lg border border-border bg-panel px-4 py-3 outline-none transition-colors hover:border-border-strong hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-fg/60 ${
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

export function ProjectGrid() {
  const { data, isPending, error } = useQuery({
    queryKey: ["projectsList"],
    queryFn: () => rpc.projectsList(),
  })
  // The home directory is only ever used to shorten a path for display, so a miss costs a longer row.
  const home = data?.[0]?.path.match(/^(\/(?:Users|home)\/[^/]+)\//u)?.[1]

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-4 px-6 py-10">
      {/* No icon beside it on purpose: ICON_LABEL_NUDGE is measured for a 12px glyph beside a
          10-12px label, and a 15px pairing would need its own measurement to sit right. Decoration
          is not worth an unmeasured optical offset. */}
      <h1 className="text-[15px] font-medium text-fg">Projects</h1>
      {error ? (
        <p className="text-[13px] text-muted">Could not read the project registry: {String(error)}</p>
      ) : isPending ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : data.length === 0 ? (
        // Not an error state: a fresh machine has an empty registry until the first `frizz`.
        <p className="text-[13px] text-muted">
          No projects yet. Run <code className="font-mono text-fg">frizz</code> inside one to add it.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {data.map((project) => (
            <Card key={project.id} project={project} home={home} />
          ))}
        </div>
      )}
    </div>
  )
}
