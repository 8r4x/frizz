import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { closeFilePanel, addContextItem } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { splitFrontmatter } from "../lib/frontmatter.ts"
import { localFileDir } from "../lib/markdownTargets.ts"
import { locateInSource } from "../lib/composerContext.ts"
import { Frontmatter, FOOTER_STYLE, OpenAction } from "./MarkdownDrawer.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"

// The /full page's SPLIT file viewer: the same built-in markdown reader as MarkdownDrawer, framed as
// a PANEL BESIDE the thread instead of a sheet over it — on /full the transcript is the whole point,
// and covering it to read a file defeated the page. Two additions over the drawer reader:
//
//   · a Rendered ⇄ Source toggle (the source view shows the file verbatim, frontmatter included);
//   · ⌘I over a selection in EITHER view stages that selection as a context item on the thread's
//     composer (chips above the box, each with an optional comment — see lib/composerContext.ts).
//
// Line numbers for a source-view selection are exact (character offsets against the raw text); for a
// rendered-view selection they are best-effort (whitespace-insensitive unique match), because the
// markdown pipeline re-wraps and re-writes what the DOM shows.

// The character offset of (node, offsetInNode) within `root`, by summing every text node before it.
// The source <pre> renders one string child, but browsers MAY split large text on parse — walking is
// what keeps the offset right either way.
function charOffsetIn(root: Element, node: Node, offset: number): number | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node) return total + offset
    total += current.textContent?.length ?? 0
  }
  // An element-node boundary (triple-click selections end on one): count text fully before it.
  if (node instanceof Element && root.contains(node)) {
    const inner = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let sum = 0
    for (let current = inner.nextNode(); current; current = inner.nextNode()) {
      const pos = node.compareDocumentPosition(current)
      if (pos & Node.DOCUMENT_POSITION_PRECEDING || node.contains(current)) sum += current.textContent?.length ?? 0
    }
    return sum
  }
  return null
}

function lineOfOffset(raw: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, raw.length)
  for (let i = 0; i < end; i++) if (raw.charCodeAt(i) === 10) line++
  return line
}

export function FileViewerPanel({ slug, path }: { slug: string; path: string }) {
  const body = useQuery({ queryKey: ["localMarkdown", path], queryFn: () => rpc.localMarkdown({ path }) })
  // Canonical path from the server (symlinks resolved) — the base for relative links, the label, and
  // the path stamped on context items, exactly as in MarkdownDrawer.
  const resolved = body.data?.path ?? path
  const raw = body.data?.markdown ?? ""
  const { front, body: source } = splitFrontmatter(raw)
  const [view, setView] = useState<"rendered" | "source">("rendered")
  const html = useMarkdownHtml(source, { baseDir: localFileDir(resolved), asDocument: true })
  const inner = useInnerHtml(html)
  const renderedRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLPreElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useLocalFileCodeLinks(renderedRef, html)
  const title = resolved.split("/").filter(Boolean).pop() || resolved

  // ⌘I / Ctrl-I: stage the current selection (when it lives inside this panel) as a context item on
  // the thread's composer. Window-level, capture-phase: the selection owns no focusable element, so a
  // local key handler would never see the chord.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "i") return
      const root = rootRef.current
      const selection = window.getSelection()
      if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) return
      const text = selection.toString()
      if (!text.trim()) return
      e.preventDefault()
      e.stopPropagation()
      // Exact lines when the selection sits in the verbatim <pre>; best-effort otherwise.
      let lines: { startLine: number; endLine: number } | null = null
      const pre = sourceRef.current
      if (pre && pre.contains(range.commonAncestorContainer)) {
        const start = charOffsetIn(pre, range.startContainer, range.startOffset)
        const end = charOffsetIn(pre, range.endContainer, range.endOffset)
        if (start !== null && end !== null) {
          lines = { startLine: lineOfOffset(raw, Math.min(start, end)), endLine: lineOfOffset(raw, Math.max(0, Math.max(start, end) - 1)) }
        }
      } else {
        lines = locateInSource(raw, text)
      }
      addContextItem(slug, { path: resolved, text, ...(lines ?? {}) })
      // Collapsing the selection is the acknowledgment — the chip appearing on the composer is the
      // payload, and a still-highlighted range invites a second ⌘I that would stage a duplicate.
      selection.removeAllRanges()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [slug, resolved, raw])

  return (
    <div ref={rootRef} data-file-viewer-panel className="flex h-full min-h-0 flex-col">
      <SheetHeader
        title={title}
        subtitle={resolved}
        onClose={closeFilePanel}
        actions={
          // The active segment's fill must contrast the HEADER it sits on (bg-panel) — an earlier
          // bg-panel fill was invisible there and the state read only from text brightness.
          <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border-strong p-0.5 text-[11px] font-medium" role="group" aria-label="File view">
            {(["rendered", "source"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                aria-pressed={view === mode}
                className={`rounded px-2 py-0.5 transition-colors ${view === mode ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
              >
                {mode === "rendered" ? "Rendered" : "Source"}
              </button>
            ))}
          </div>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {body.isLoading ? (
          <div className="text-[13px] text-muted">Loading…</div>
        ) : body.error ? (
          <div className="text-[13px] text-red-400/90">Couldn’t read this file: {(body.error as Error).message}</div>
        ) : view === "source" ? (
          raw ? (
            <pre ref={sourceRef} className="whitespace-pre-wrap break-words font-mono-keep text-[12px] leading-5 text-fg/90">{raw}</pre>
          ) : (
            <div className="text-[13px] text-muted">This file is empty.</div>
          )
        ) : html ? (
          <>
            {front && <Frontmatter lines={front} />}
            <div ref={renderedRef} className="md-body" dangerouslySetInnerHTML={inner} />
          </>
        ) : (
          <div className="text-[13px] text-muted">This file is empty.</div>
        )}
        {!body.isLoading && !body.error && body.data?.truncated && (
          <p className="mt-4 border-t border-border/60 pt-3 text-[12px] text-muted">
            This file is too long to render in full — everything above the cut is shown. Open it to read the rest.
          </p>
        )}
      </div>
      <div
        className="shrink-0 flex items-center justify-between gap-3 border-t border-border/60 bg-panel px-5 pt-3"
        style={FOOTER_STYLE}
      >
        <span className="min-w-0 truncate text-[11px] text-muted/70">Select text and press ⌘I to add it to the chat</span>
        <OpenAction path={resolved} />
      </div>
    </div>
  )
}
