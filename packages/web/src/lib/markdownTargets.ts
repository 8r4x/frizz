import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"
import { apiBase, innerPath, projectSlug, APP_ROUTE_SEGMENTS } from "./base-path.ts"
// Markdown is often written by tools that report local artifacts as links. A browser interprets a
// POSIX absolute path as a same-origin URL path, which both navigates away from Frizz and produces a
// deceptive localhost URL. Identify those targets before DOM sanitization so they can never become
// navigable anchors. This module deliberately does not decide filesystem authorization: the server's
// `/local-image` route realpath-checks the requested image against its narrow trusted-root allowlist.

export interface LocalMarkdownTarget {
  // Metadata for a local-looking destination. The renderer keeps this out of normal prose unless
  // it needs to expose it as an accessible title for a disabled local link.
  display: string
  // Present only for a local POSIX path that can be passed to the server's gated image endpoint.
  posixPath?: string
}

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/

// Editor deep-link schemes that all share VS Code's URL grammar: `<scheme>://file/<path>[:line[:col]]`.
// Agents under user-level "link every file" instructions write these (`[plan.md](cursor://file/<abs>)`)
// because in a terminal that is the only clickable form. Left as an anchor, the OS resolves the scheme
// and the named editor opens no matter what the "Local file links" setting says — and a `.md` file
// never reaches Frizz's own reader. Classify the path the link names instead, so it routes exactly
// like a plain path link. The path may carry its own leading slash (`cursor://file//Users/…`) or lean
// on the route's (`cursor://file/Users/…`); both forms occur in the wild and both editors accept both.
const EDITOR_FILE_URL = /^(?:cursor|vscode|vscode-insiders|windsurf):\/\/file\/(.*)$/i

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // An invalid escape is still a local-looking value, but must never make sanitization throw.
    return value
  }
}

// The SPA's intentionally supported root-relative routes. All other single-slash absolute targets
// are treated as filesystem paths; ordinary relative links (`docs/foo`), fragments, mailto, and
// http(s) never reach this classifier.
function isFrizzRoute(href: string): boolean {
  if (href === "/" || href.startsWith("/?") || href.startsWith("/#")) return true
  // Strip this page's project prefix first. Under `/project/nub/thread/x` the in-app link IS
  // `/project/nub/thread/x`, and without this it reads as a filesystem path and renders as a
  // disabled local-file chip.
  const bare = href.replace(/[?#].*$/u, "")
  // A link straight to another project's board — `/project/nub` — is in-app even though it has no
  // route segment of its own once the prefix is stripped.
  if (projectSlug(bare)) return true
  const inner = innerPath(bare)
  const first = inner.split("/")[1] ?? ""
  return APP_ROUTE_SEGMENTS.has(first)
}

/**
 * Classify an anchor/image destination that denotes a filesystem path. `file:` values with a remote
 * host and Windows paths are retained as local text but deliberately have no `posixPath`: they cannot
 * be proxied by a POSIX server endpoint. Protocol-relative URLs (`//cdn.example/...`) remain web URLs.
 */
export function localMarkdownTarget(raw: string | null | undefined): LocalMarkdownTarget | null {
  const href = raw?.trim()
  if (!href) return null
  // marked HTML-escapes backslashes in a Windows Markdown destination (`C:%5CUsers…`), so classify
  // the decoded value before checking its drive-prefix form.
  const decodedHref = decodePath(href)

  if (WINDOWS_ABSOLUTE_PATH.test(decodedHref)) return { display: decodedHref }

  if (decodedHref.startsWith("/") && !decodedHref.startsWith("//") && !isFrizzRoute(decodedHref)) {
    const path = decodedHref
    return { display: path, posixPath: path }
  }

  const editor = EDITOR_FILE_URL.exec(href)
  if (editor) {
    // Strip a query/fragment tail (`?windowId=_blank`) before decoding, as resolveRelativeLocalPath
    // does — a filesystem path has neither. The editor cursor suffix (`:12:3`) stays: the reader and
    // the server's opener both strip it themselves, the same as for a bare `README.md:12` path.
    const rest = decodePath(editor[1].replace(/[?#].*$/u, "")).replace(/^\/+/, "")
    if (!rest) return null
    if (WINDOWS_ABSOLUTE_PATH.test(rest)) return { display: rest }
    const path = `/${rest}`
    return { display: path, posixPath: path }
  }

  if (!/^file:/i.test(href)) return null
  try {
    const url = new URL(href)
    if (url.protocol !== "file:") return null
    // A UNC/remote file URL is not a local POSIX file the server can safely proxy. It remains a
    // non-navigating chip, while an empty or localhost authority can use the existing gated route.
    if (url.hostname && url.hostname !== "localhost") return { display: href }
    const path = decodePath(url.pathname)
    return { display: path, posixPath: path }
  } catch {
    return { display: href }
  }
}

export function localImageUrl(path: string): string {
  return `${apiBase()}/local-image?path=${encodeURIComponent(path)}`
}

// Must match the server's image-content-type allowlist. The server still decides whether a path is
// actually eligible by resolving it and confining it to the active workspace's trusted roots.
const PROXIED_IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i

export function localImageUrlForTarget(target: LocalMarkdownTarget): string | null {
  return target.posixPath && PROXIED_IMAGE_PATH.test(target.posixPath)
    ? localImageUrl(target.posixPath)
    : null
}

// Must match the server's `MARKDOWN_FILE_EXT`. A local path with this extension is rendered by Frizz's
// own reader drawer instead of being handed to the desktop opener — the one local file kind the app
// knows how to show. The strip mirrors an editor cursor suffix (`README.md:12`) the way
// resolveOpenableFile does, so a line-anchored reference still reads as Markdown.
const MARKDOWN_FILE_PATH = /\.(?:md|markdown)$/i

export function isLocalMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_PATH.test(path.trim().replace(/:\d+(?::\d+)?$/, ""))
}

// Resolve a RELATIVE Markdown destination against the directory the prose belongs to. Repo docs link
// to each other relatively on purpose (`./ARCHITECTURE.md`, `../scripts/shot.mjs`) and so does chat
// prose — a worker writing up its own scratch file names it `.frizz/threads/<id>/HANDOFF.md`, exactly
// as it typed it into the shell. With no base, none of those is a local path OR a working URL: the
// anchor stayed relative and the browser resolved it against the PAGE, so clicking a handoff link
// navigated to `/project/nub/thread/<slug>/.frizz/threads/<id>/HANDOFF.md` and out of Frizz entirely.
//
// The base is the rendering document's own directory for the file reader, and the PROJECT DIRECTORY
// for every other surface — the same root the server resolves a bare inline-code path against
// (local-file.ts `resolveOpenableFile`), so a path written in backticks and the same path written as a
// link now land on the same file. `~`/`~/` expands against `home` when the board supplied one, which
// is the other half of that parity. Returns null for anything already absolute, a fragment, a query,
// or a scheme; the query/fragment tail of a resolved path is dropped, since a filesystem path has
// neither.
export function resolveRelativeLocalPath(
  raw: string | null | undefined,
  baseDir: string,
  home?: string,
): string | null {
  const href = raw?.trim()
  if (!href) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null // http(s):, file:, mailto:, cursor:, …
  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return null
  const relative = decodePath(href.replace(/[?#].*$/u, ""))
  if (!relative) return null
  // A home-anchored path carries its own root, so it needs no base at all — and must never be glued
  // onto one, which is what turned `~/.claude/CLAUDE.md` into `<baseDir>/~/.claude/CLAUDE.md`.
  const homeAnchored = relative === "~" || relative.startsWith("~/")
  if (homeAnchored && !home?.startsWith("/")) return null
  const root = homeAnchored ? home! : baseDir
  if (!root.startsWith("/")) return null
  const segments = `${root}/${homeAnchored ? relative.slice(1) : relative}`.split("/")
  const stack: string[] = []
  for (const segment of segments) {
    if (!segment || segment === ".") continue
    if (segment === "..") stack.pop()
    else stack.push(segment)
  }
  // `..` may climb above the base; the server's openable-root gate is what actually confines the
  // result, exactly as it does for an absolute path an author wrote by hand.
  return `/${stack.join("/")}`
}

/** The directory a document at `path` lives in — the base for its relative links. */
export function localFileDir(path: string): string {
  const cut = path.lastIndexOf("/")
  return cut > 0 ? path.slice(0, cut) : "/"
}
