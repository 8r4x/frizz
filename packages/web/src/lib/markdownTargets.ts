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
  // Strip this page's project prefix first. Under `/nub/thread/x` the in-app link IS `/nub/thread/x`,
  // and without this it reads as a filesystem path and renders as a disabled local-file chip.
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
