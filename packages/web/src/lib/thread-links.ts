import { openThread } from "../store.ts"
import { innerPath, projectSlug } from "./base-path.ts"

// A worker can emit a markdown link to another frizz thread — `[label](/thread/<slug>)` — e.g. after
// spawning one via the mcp__frizz__spawn_thread tool. `/thread/<slug>` is a RESERVED SPA route
// (markdownTargets.ts isFrizzRoute), so markdown.ts leaves it a normal anchor rather than a local-file
// button. This one delegated listener intercepts a plain left-click on any such anchor and opens the
// thread IN THE DRAWER (openThread — dedupes/raises if already open) instead of letting the browser
// navigate a new tab. A modified click (⌘/ctrl/shift/alt) is left alone so the same href still works
// as a real deep-link opened in a new tab. Covers every sanitized markdown surface (chat, the doc
// drawer, drawers) since it delegates from document.
//
// Matched against the INNER path, because markdown.ts now stamps this page's project prefix onto an
// unprefixed in-app link (see prefixedAppRoute — the raw href had to become navigable in its own
// right, for the modified clicks this handler deliberately does not take). Opening in the drawer is
// only right for a thread of the project already on screen, so a link naming a DIFFERENT project is
// left to the browser.
const THREAD_HREF = /^\/thread\/([a-z0-9][a-z0-9-]*)\/?$/

export function installThreadLinkInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href*="/thread/"]') : null
    const href = anchor?.getAttribute("href")
    if (!anchor || !href || !href.startsWith("/")) return
    const linked = projectSlug(href)
    if (linked && linked !== projectSlug()) return // another project's board — let the browser go there
    const match = THREAD_HREF.exec(innerPath(href))
    if (!match) return
    event.preventDefault()
    event.stopPropagation()
    openThread(match[1])
  }
  document.addEventListener("click", handler)
  return () => document.removeEventListener("click", handler)
}
