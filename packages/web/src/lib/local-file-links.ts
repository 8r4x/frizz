import { rpc } from "../api/rpc.ts"
import { openFilePanel, openLightbox, pushMarkdownDrawer, showToast, store } from "../store.ts"
import { copyTextToClipboard } from "./clipboard.ts"
import { lightboxImageFor } from "./lightbox.ts"
import { isLocalMarkdownFile, localImageUrl } from "./markdownTargets.ts"
import { isMobileViewport } from "./mobile.ts"

// One delegated listener covers every sanitized markdown surface (chat, the doc drawer, and
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
    if (source.dataset.localImage === "true") openPicture(source, path)
    else openLocalPath(path)
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
// beside the alt text, which reads as a rendering fault in Frizz rather than as a missing file. Swap the
// dead <img> for the plain path, exactly as BlockImage's onError fallback does for the React-rendered
// case — nothing is silently swallowed, and the replacement holds one stable line instead of the
// zero-height-then-glyph box that made the whole message reflow.
//
// One delegated listener for the same reason the click handler is delegated: prose is injected as raw
// sanitized HTML on several surfaces (chat, question cards, fence cards, doc and plan drawers),
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
    // Take the FRAME with it when there is one (markdown.ts frames block images). Replacing only the
    // `<img>` would leave a bordered, matted box standing around a line of muted path text — a frame
    // advertising a picture that isn't there. BlockImage drops its frame on the same failure.
    ;(img.closest(".md-image-frame") ?? img).replaceWith(missing)
  }
}

// A picture opens in Frizz's own viewer (components/Lightbox.tsx) — a screenshot a worker drew as a
// bare path line (BlockImage) or as Markdown, on any surface — with every other picture of the same
// message beside it, so a turn's screenshots page like a ```lightbox gallery's. The message is the
// transcript's `data-frizz-msg` root; a card or a reader, which hold one message, is its `.md-body`. A
// LINK to a picture names one picture, so it opens alone.
function openPicture(source: HTMLElement, path: string): void {
  if (!(source instanceof HTMLImageElement)) {
    openLightbox([lightboxImageFor(path, source.textContent)], 0)
    return
  }
  const scope = source.closest("[data-frizz-msg]") ?? source.closest(".md-body, .md-inline")
  const pictures = scope ? [...scope.querySelectorAll<HTMLImageElement>('img[data-local-image="true"][data-local-path]')] : [source]
  openLightbox(pictures.map((img) => lightboxImageFor(img.dataset.localPath!, img.alt)), Math.max(pictures.indexOf(source), 0))
}

// Act on a vetted local path: a `.md` file is prose Frizz can render itself, so it opens in the built-in
// reader instead of launching an editor; everything else goes to the server, which realpath-gates it and
// hands it to the opener the `localFileOpener` setting names — except on a phone, where nothing leaves
// the browser (below). The decision lives HERE, in the one place
// every local-path activation passes through, rather than in each producer — markdown links, resolved
// inline-code paths, attachment chips, the Codex file rows and the tool-header path links all get the
// same routing from this single branch. A picture never arrives here from a click — it opens in the
// lightbox (openPicture, above) — so `image` is the lightbox's own way OUT, its "Open in default
// viewer": the file goes to the desktop's image viewer rather than to the reader or an editor.
//
// Components that own their own click (PathLink, whose row swallows the event before it can reach the
// delegated listener below) call this directly; everything that only tags itself `data-local-path`
// arrives through the interceptor.
export function openLocalPath(path: string, image = false): void {
  if (!image && isLocalMarkdownFile(path)) {
    pushMarkdownDrawer(path)
    return
  }
  // On the fullscreen page every non-image file opens in the split viewer too (source view; the
  // server admits project files only), because a reader beside the transcript beats being thrown out
  // to an editor for a look. Outside it — the board — the desktop opener remains the answer for code.
  if (!image && store.splitFileViewer) {
    openFilePanel(path)
    return
  }
  // ON A PHONE the desktop opener is the wrong machine: it launches an editor on the computer Frizz runs
  // on, which from a phone is somewhere else entirely, and the tap appears to do nothing. So every file
  // opens in Frizz's own reader instead — the same drawer a `.md` gets, showing the file as highlighted
  // source (MarkdownDrawer) — and the lightbox's "Open in default viewer" opens the picture in the
  // browser, the phone's own image viewer, through the route that already serves it to the transcript.
  if (isMobileViewport()) {
    if (image) window.open(localImageUrl(path), "_blank", "noopener")
    else pushMarkdownDrawer(path)
    return
  }
  void open(path, image)
}

async function open(path: string, image: boolean) {
  try {
    const result = await rpc.openLocalFile({ path, ...(image ? { image: true } : {}) })
    if (result.action === "copy") {
      await copyTextToClipboard(result.path)
      showToast("Copied local path")
    }
  } catch (error) {
    showToast(`Could not open local file: ${(error as Error).message.slice(0, 100)}`)
  }
}
