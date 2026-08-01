import { subscribe } from "valtio"
import { store, topThreadSlug, closeDrawersById } from "../store.ts"

// URL ⇄ state sync, SPA-style. Paths: `/` (the unified queue — the only page), `/thread/<slug>`
// (the queue with that thread open in the drawer STACK's topmost thread layer — there is no
// standalone thread page), `/status/<status>` (URL-only lists).
//
// History contract (standard SPA): opening a thread layer PUSHES an entry so the browser Back
// button unwinds it; other transitions REPLACE so transient state never buries the back stack.
//
// (The focus machine this used to route through was deleted — the router writes store.view directly.)

function currentPath(): string {
  const top = topThreadSlug()
  if (top) return `/thread/${encodeURIComponent(top)}`
  // A parked route still IS that thread's URL. Without this the address bar would flip to "/" for the
  // frame or two before the board settles the destination, and settling it into a drawer would then
  // push a redundant history entry for a URL the user never left.
  if (store.routeThreadSlug) return `/thread/${encodeURIComponent(store.routeThreadSlug)}`
  if (store.view.startsWith("status:")) return `/status/${encodeURIComponent(store.view.slice(7))}`
  return "/"
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    // A hand-edited/truncated percent escape must not throw during primeRoute() and abort the entire
    // app before React mounts. Treat malformed routes like any other unknown path: return to Queue.
    return null
  }
}

function applyPath(path: string): void {
  const thread = path.match(/^\/thread\/([^/]+)$/)
  if (thread) {
    const slug = decodeSegment(thread[1])
    if (slug === null) {
      store.routeThreadSlug = null
      closeDrawersById(store.drawers.map((d) => d.id))
      store.view = "todos"
      return
    }
    store.view = "todos"
    // Back/forward landed on a thread path: if that thread is somewhere in the stack, unwind ABOVE
    // it and we're done — the surface it asks for is already up.
    const idx = store.drawers.findIndex((d) => d.kind === "thread" && d.slug === slug && !d.closing)
    // Unwind the layers ABOVE the matched thread through their animated closers (slide-out), not an
    // instant splice — Back/forward must play the same exit animation as backdrop/Esc.
    if (idx !== -1) {
      store.routeThreadSlug = null
      closeDrawersById(store.drawers.slice(idx + 1).map((d) => d.id))
      return
    }
    // Otherwise PARK the slug: the destination depends on whether the thread is queued, which the
    // board alone can say, and on a cold deep link no board has arrived yet. App settles it the first
    // render the board is authoritative (store.resolveRoutedThread). Deciding here instead — the old
    // unconditional pushDrawer — is what rendered a queued thread's panel twice on `/thread/<slug>`:
    // its full card in the main column, plus the identical panel in a drawer half-covering it.
    store.routeThreadSlug = slug
    return
  }
  const status = path.match(/^\/status\/([^/]+)$/)
  if (status) {
    store.routeThreadSlug = null
    closeDrawersById(store.drawers.map((d) => d.id))
    const statusName = decodeSegment(status[1])
    store.view = statusName === null ? "todos" : `status:${statusName}`
    return
  }
  // Everything else is the queue; Back past the last thread layer unwinds the stack (animated).
  store.routeThreadSlug = null
  closeDrawersById(store.drawers.map((d) => d.id))
  store.view = "todos"
}

// Cold-load adoption is initial application state, so establish it BEFORE React's first render.
// main.tsx primes synchronously; startRouter repeats this safely (both paths are idempotent) so
// tests/non-main entry points retain the old self-contained contract.
//
// A thread path only PARKS its slug here — the destination needs the board (see applyPath). That is
// not a regression of the old opacity-0-phantom bug: the layer that bug produced was one animated in
// AFTER mount, whereas resolveRoutedThread still pushes `routed: true` (painted open, no animation),
// and it fires on the very render the board lands — the same render that replaces App's boot spinner
// with the queue, so the sheet and the page behind it appear together.
export function primeRoute(path = location.pathname): void {
  applyPath(path)
}

export function startRouter(): () => void {
  // Boot: adopt whatever the address bar says (deep link / reload restores the state).
  primeRoute()

  const unsub = subscribe(store, () => {
    const path = currentPath()
    if (path === location.pathname) return
    // A NEW topmost thread pushes history; unwinding or non-thread transitions replace.
    const openingThread = path.startsWith("/thread/")
    if (openingThread) history.pushState(null, "", path)
    else history.replaceState(null, "", path)
  })

  // URL → state (back/forward, hand-edited paths).
  const onPop = () => applyPath(location.pathname)
  window.addEventListener("popstate", onPop)
  return () => {
    unsub()
    window.removeEventListener("popstate", onPop)
  }
}
