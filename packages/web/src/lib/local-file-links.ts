import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// One delegated listener covers every sanitized markdown surface (chat, scratchpad, plans, and
// drawers). It never follows file:// or an accidental same-origin pathname: only explicit data
// attributes emitted by markdown.ts reach the server's canonical-path allowlist gate.
export function installLocalFileLinkInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const source = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-local-path]") : null
    const path = source?.dataset.localPath
    if (!source || !path) return
    event.preventDefault()
    event.stopPropagation()
    void open(path, source.dataset.localImage === "true")
  }
  document.addEventListener("click", handler)
  const failed = imageFailureHandler()
  // `error` does NOT bubble, so the delegated listener has to run in the CAPTURE phase.
  document.addEventListener("error", failed, true)
  return () => {
    document.removeEventListener("click", handler)
    document.removeEventListener("error", failed, true)
  }
}

// A markdown screenshot whose file is gone — a /tmp shot that was cleaned up, a removed worktree,
// a path from another machine. `/local-image` 404s, and Chrome then paints its own broken-image glyph
// beside the alt text, which reads as a rendering fault in Fray rather than as a missing file. Swap the
// dead <img> for the plain path, exactly as BlockImage's onError fallback does for the React-rendered
// case — nothing is silently swallowed, and the replacement holds one stable line instead of the
// zero-height-then-glyph box that made the whole message reflow.
//
// One delegated listener for the same reason the click handler is delegated: prose is injected as raw
// sanitized HTML on several surfaces (chat, question cards, fence cards, scratchpad and plan drawers),
// so there is no React element to hang an onError on.
//
// SCOPED TO THOSE SURFACES ON PURPOSE. `data-local-image` is also carried by BlockImage's <img>, which
// React owns and which already has its own onError fallback; swapping that node out from under React
// would corrupt the tree it thinks it is reconciling. `.md-body`/`.md-inline` are set only by our own
// components around sanitized markdown, so they mark exactly the images React does NOT manage.
function imageFailureHandler(): (event: Event) => void {
  return (event) => {
    const img = event.target
    if (!(img instanceof HTMLImageElement) || img.dataset.localImage !== "true") return
    if (!img.closest(".md-body, .md-inline")) return
    const path = img.dataset.localPath ?? img.getAttribute("src") ?? ""
    const missing = document.createElement("span")
    missing.className = "md-image-missing font-mono-keep"
    missing.textContent = path
    // The author's alt text is the only description of what the picture showed; keep it reachable.
    if (img.alt && img.alt !== path) missing.title = img.alt
    img.replaceWith(missing)
  }
}

async function open(path: string, image: boolean) {
  try {
    const result = await rpc.openLocalFile({ path, ...(image ? { image: true } : {}) })
    if (result.action === "copy") {
      await navigator.clipboard.writeText(result.path)
      showToast("Copied local path")
    }
  } catch (error) {
    showToast(`Could not open local file: ${(error as Error).message.slice(0, 100)}`)
  }
}
