import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react"
import { rpc } from "../api/rpc.ts"

// Clickable inline-code file paths. Agent prose often mentions files in backticks (`~/.claude/CLAUDE.md`,
// `packages/web/src/App.tsx`). When the text of an inline `<code>` resolves to a real file on disk under
// the server's openable roots, we tag it so the app-wide local-file click interceptor opens it in the
// user's editor/default app — same mechanism as a Markdown file link, just discovered from bare code.
//
// The existence check is a server round-trip (the browser can't stat), so this runs as a POST-render
// decoration: classify candidates locally to avoid statting every backtick, batch the unknowns to the
// server, and tag the ones that come back real. Resolutions are cached for the session.

// A bare filename: a stem, then ONE extension that opens with a letter (`cloudflare-ask.md`,
// `package.json`, `App.tsx`). The letter rule is what keeps a version (`1.2`, `v1.2`) and an
// abbreviation (`e.g.`, which ends on its dot) out. A member access (`Promise.resolve`) still matches;
// the server says no and it stays plain code, at the cost of one batched, cached round-trip.
const BARE_FILENAME = /^[\w.@+-]+\.[a-z][a-z0-9]{0,7}$/i

// A path-like candidate: no whitespace, not a URL, and either home-anchored (`~`), slash-bearing
// (absolute or repo-relative), or a bare filename with an extension — the form a worker's question
// names a file it wrote at the project root in (`it's in \`cloudflare-ask.md\``), which reads as a
// link and, until 2026-08-25, was the one file reference in prose that never became one. Bare words
// and shell commands are excluded so we never stat `git status` or `useState`. Length-capped to match
// the server input bound.
export function isPathCandidate(raw: string): boolean {
  const v = raw.trim()
  if (!v || v.length > 1024 || /\s/.test(v)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false // http(s)://, file://, cursor://, mailto:, …
  if (v === "~" || v.startsWith("~/") || v.startsWith("/") || v.includes("/")) return true
  return BARE_FILENAME.test(v)
}

// Session cache: candidate text → canonical openable path, or null when it doesn't resolve to a real
// file under the gate. `undefined` = not yet asked. Module-scoped so every prose surface shares it and a
// given path is resolved once. Files rarely appear/vanish mid-session, so stale-none is acceptable.
const cache = new Map<string, string | null>()

// Candidates a batch is out for right now. A second surface that finds the same path while the first
// surface's batch is in flight must not send it again — a question card's context, its options and its
// footnote each decorate their own element, and one path routinely appears in two of them.
const inflight = new Set<string>()

// The re-tag signal every mounted hook subscribes to: bumped whenever a batch lands with new answers,
// so EVERY surface re-runs its decoration — not only the one whose batch it was. A hook that waited
// on a path another hook had in flight is what this exists for; it never sent a request of its own,
// so nothing else would ever tell it the answer arrived.
let version = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const readVersion = () => version

// Matches the server's `resolveLocalPaths` input cap (router.ts). Candidates are chunked to this size so
// a path-heavy message (a big file listing in one prose block) can't blow the cap and lose EVERY link;
// each chunk resolves — or fails — independently.
const RESOLVE_BATCH = 128

// Resolve the not-yet-known candidates via batched queries; bumps `version` if any new answer landed. A
// chunk that fails its round-trip (e.g. an older server without the route) caches its own candidates as
// unresolved so they stay plain code until the next reload — without dropping the chunks that succeeded.
async function resolveUnknown(paths: string[]): Promise<void> {
  const wanted = [...new Set(paths)].filter((p) => !cache.has(p) && !inflight.has(p))
  if (!wanted.length) return
  for (const p of wanted) inflight.add(p)
  const chunks: string[][] = []
  for (let i = 0; i < wanted.length; i += RESOLVE_BATCH) chunks.push(wanted.slice(i, i + RESOLVE_BATCH))
  const batches = await Promise.all(chunks.map(async (chunk) => {
    try {
      return (await rpc.resolveLocalPaths({ paths: chunk })).resolved
    } catch {
      return chunk.map((input) => ({ input, path: null }))
    }
  }))
  let changed = false
  for (const resolved of batches) {
    for (const r of resolved) if (!cache.has(r.input)) { cache.set(r.input, r.path); changed = true }
  }
  for (const p of wanted) inflight.delete(p)
  if (!changed) return
  version += 1
  for (const listener of listeners) listener()
}

function decorate(code: Element, openPath: string): void {
  code.setAttribute("data-local-path", openPath)
  code.setAttribute("title", `Open ${openPath}`)
  code.classList.add("local-file-code")
}

// Post-render decoration hook: after `html` is committed into `ref`, tag inline-code file references that
// resolve to real files. Runs in a LAYOUT effect so cached hits re-tag before paint (no flicker) when
// `html` changes — React replaced the innerHTML, wiping prior tags. Also re-runs after any batch
// resolves (via the shared `version`). Block code (inside `<pre>`) is left alone.
export function useLocalFileCodeLinks(ref: RefObject<HTMLElement | null>, html: string): void {
  const seen = useSyncExternalStore(subscribe, readVersion, readVersion)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const unknown: string[] = []
    for (const code of root.querySelectorAll("code")) {
      if (code.closest("pre")) continue // block code, not an inline reference
      // Code that is already the LABEL of a reference — [`draft.md`](/some/where/draft.md), or the
      // local-file button the sanitizer minted from it — is spoken for: the author chose its
      // destination. Tagging it would nest a second `data-local-path` inside the first, and the click
      // interceptor's `closest()` would find the inner one and open whatever a `draft.md` at the
      // project root happens to be, instead of the file the link names.
      if (code.closest("a, [data-local-path]")) continue
      const raw = (code.textContent ?? "").trim()
      if (!isPathCandidate(raw)) continue
      const resolved = cache.get(raw)
      if (resolved === undefined) unknown.push(raw)
      else if (resolved) decorate(code, resolved)
    }
    if (unknown.length) void resolveUnknown(unknown)
  }, [ref, html, seen])
}
