import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"

// WHICH PROJECT THIS PAGE IS SHOWING, taken from its own URL.
//
// One Frizz per machine serves every project from one origin, so the first path segment names the
// project: `/nub/thread/fix-auth`. That works precisely because Frizz's own routes were moved under
// `/_frizz/` — the top-level namespace is otherwise free, so a first segment is either the SPA's own
// route or a project slug, and nothing else.
//
// AN EMPTY BASE IS A SUPPORTED STATE, not a bug. The launching project is still served unprefixed at
// `/`, which is what lets the server land slug routing without a lockstep rewrite of this file.

/**
 * The SPA's own top-level route names.
 *
 * Anything else in first position is a project slug. This is the single definition of that set —
 * `isFrizzRoute` in markdownTargets.ts used to keep its own copy, and under a project prefix a stale
 * copy is not a small bug: every in-app link starts looking like a FILESYSTEM path to the markdown
 * sanitizer, and renders as a disabled local-file chip.
 */
export const APP_ROUTE_SEGMENTS = new Set(["thread", "status"])

/**
 * This page’s path, or `/` where there is no page.
 *
 * These helpers are imported by modules that also run under node — the markdown sanitizer and the
 * socket transport both have unit tests with no DOM — so reading `location` unguarded turns a pure
 * function into one that throws depending on who imported it. A STUBBED location counts too: the
 * socket tests install one carrying only `origin`, so a present `location` is not a promise of a
 * present `pathname`.
 */
function here(pathname?: string): string {
  if (typeof pathname === "string") return pathname
  const current = typeof location === "undefined" ? undefined : location.pathname
  return typeof current === "string" ? current : "/"
}

/** `/nub`, or `""` when this page is the unprefixed launching project. */
export function basePath(pathname?: string): string {
  const first = here(pathname).split("/")[1] ?? ""
  if (!first || APP_ROUTE_SEGMENTS.has(first)) return ""
  return `/${first}`
}

/** The path with the project prefix removed — what the router reasons about. */
export function innerPath(pathname?: string): string {
  const path = here(pathname)
  const base = basePath(path)
  if (!base) return path || "/"
  return path.slice(base.length) || "/"
}

/** An inner path put back in terms the address bar uses. */
export function outerPath(inner: string, pathname?: string): string {
  const base = basePath(here(pathname))
  return base ? `${base}${inner === "/" ? "" : inner}` || "/" : inner
}

/**
 * Where THIS page's API lives: `/_frizz/nub`, or `/_frizz` unprefixed.
 *
 * Every client URL builder goes through here, so a page always addresses the project it is showing
 * rather than whichever one happens to have launched the server.
 */
export function apiBase(pathname?: string): string {
  return `${FRIZZ_ROUTE_PREFIX}${basePath(here(pathname))}`
}
