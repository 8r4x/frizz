// SELECTED CONTEXT for a thread's composer — the ⌘I flow. A selection made in the /full file viewer
// becomes a staged item (file, quoted text, best-effort line range, optional comment) ANCHORED BY A
// FOOTNOTE MARKER `[^N]` spliced into the draft prose at the caret, and on send the items serialize
// as footnote definitions under the prose. Markers-in-the-text is the load-bearing part (maintainer
// 2026-09-02): the human interleaves chip, comment, chip, comment — so the agent can only know which
// comment refers to which selection if the reference sits at its original position in the prose.
// Text, not a side-channel: the worker reads the same transcript the human does, an inline `[^1]`
// reads as the footnote it is, and a quoted block with a file name is something every harness
// already understands.

import { joinComposerValue, splitComposerValue } from "./imagePaths.ts"

export interface ComposerContextItem {
  id: number
  /** The footnote number anchoring this item: the `[^N]` token spliced into the draft prose. */
  marker: number
  /** Absolute path of the file the selection came from (the panel's canonical path). */
  path: string
  /** The selected text, verbatim. */
  text: string
  /** 1-based line range in the file, when the selection could be located unambiguously. */
  startLine?: number
  endLine?: number
  /** The human's note on this selection, typed on the chip. */
  comment?: string
}

/** The literal token a marker renders as in the prose. */
export function markerToken(marker: number): string {
  return `[^${marker}]`
}

const MARKER_RE = /\[\^(\d+)\]/g

/**
 * The next free footnote number: one past the highest `[^N]` visible in the prose OR staged on the
 * thread. The prose scan matters — after a failed-send restore or a hand-typed marker, reusing a
 * number would fuse two references into one.
 */
export function nextMarker(prose: string, staged: readonly { marker: number }[]): number {
  let max = 0
  for (const item of staged) max = Math.max(max, item.marker)
  for (const match of prose.matchAll(MARKER_RE)) max = Math.max(max, Number(match[1]))
  return max + 1
}

/**
 * Splice `[^N]` into the prose at the caret, padding with a space on either side it would otherwise
 * glue to a word. Returns the new prose and the caret to restore — after the marker but before any
 * trailing pad, so typing straight on reads `[^1] comment` without a double space.
 */
export function insertMarkerIntoProse(prose: string, caret: number, marker: number): { prose: string; caret: number } {
  const at = Math.max(0, Math.min(caret, prose.length))
  const before = prose.slice(0, at)
  const after = prose.slice(at)
  const lead = before && !/\s$/.test(before) ? " " : ""
  const trail = after && !/^\s/.test(after) ? " " : ""
  const token = markerToken(marker)
  return { prose: `${before}${lead}${token}${trail}${after}`, caret: at + lead.length + token.length }
}

/**
 * Delete a marker's token from the prose (every occurrence, defensively), folding the spacing the
 * insert added so `a [^1] b` comes back as `a b`.
 */
export function stripMarkerFromProse(prose: string, marker: number): string {
  const token = markerToken(marker).replace(/[[\]^]/g, "\\$&")
  return prose.replace(new RegExp(`( ?)${token}( ?)`, "g"), (_, lead: string, trail: string) => (lead && trail ? " " : ""))
}

/**
 * Best-effort line range for a selection: find the selection's whitespace-normalized text in the
 * file's source. The rendered view hands us text the markdown pipeline has re-wrapped (soft breaks
 * joined, emphasis markers stripped), so an exact match is hopeless — but a whitespace-insensitive
 * match lands for the common case of selecting plain prose or code. Ambiguous (2+ occurrences) and
 * absent selections return null: a wrong line number is worse than none.
 */
export function locateInSource(source: string, selected: string): { startLine: number; endLine: number } | null {
  // Normalize both sides to single-space word runs, keeping a map from each normalized character back
  // to the source line it came from.
  const lineOf: number[] = []
  let normalized = ""
  let line = 1
  let pendingSpace = false
  for (const ch of source) {
    if (ch === "\n") {
      line++
      pendingSpace = true
      continue
    }
    if (/\s/.test(ch)) {
      pendingSpace = true
      continue
    }
    if (pendingSpace && normalized.length > 0) {
      normalized += " "
      lineOf.push(line)
    }
    pendingSpace = false
    normalized += ch
    lineOf.push(line)
  }
  const needle = selected.replace(/\s+/g, " ").trim()
  if (!needle) return null
  const first = normalized.indexOf(needle)
  if (first === -1) return null
  if (normalized.indexOf(needle, first + 1) !== -1) return null
  // A space between words carries the FOLLOWING word's line (see the push above), which is exactly
  // right for a match that starts mid-map; the ends index real characters either way.
  return { startLine: lineOf[first], endLine: lineOf[first + needle.length - 1] }
}

/** `packages/web/src/App.tsx` for a file under the project; the absolute path for anything else. */
export function contextDisplayPath(path: string, projectDir?: string | null): string {
  if (projectDir && path.startsWith(`${projectDir.replace(/\/+$/, "")}/`)) {
    return path.slice(projectDir.replace(/\/+$/, "").length + 1)
  }
  return path
}

function lineLabel(item: { startLine?: number; endLine?: number }): string {
  if (item.startLine === undefined || item.endLine === undefined) return ""
  return item.startLine === item.endLine ? ` (line ${item.startLine})` : ` (lines ${item.startLine}-${item.endLine})`
}

/**
 * The agent-facing serialization: one footnote DEFINITION per item — `[^N]: path (line L):` then the
 * selection as a blockquote, comments as plain lines after each quote. The `[^N]` references stay in
 * the prose where the human put them, so the definitions carry the marker rather than a positional
 * index. Blockquotes rather than a fence because the quoted text may itself contain any fence, and
 * because the transcript renders the sent message as markdown — quoted context reads as quotation.
 */
export function serializeContextItems(items: ComposerContextItem[], projectDir?: string | null): string {
  if (!items.length) return ""
  const blocks = items.map((item) => {
    const quoted = item.text.replace(/\s+$/, "").split("\n").map((line) => `> ${line}`).join("\n")
    const comment = item.comment?.trim()
    return `${markerToken(item.marker)}: ${contextDisplayPath(item.path, projectDir)}${lineLabel(item)}:\n${quoted}${comment ? `\n\nComment: ${comment}` : ""}`
  })
  return `Selected context:\n\n${blocks.join("\n\n")}`
}

/**
 * Splice the serialized context into an outgoing composer value. Only items whose `[^N]` reference
 * still appears in the prose serialize — deleting the marker text IS the removal gesture. The value's
 * TRAILING lines may be attachment paths (see imagePaths.ts) which several surfaces detect by their
 * trailing position — context goes after the prose but BEFORE those lines so they stay trailing.
 * Definitions follow the order the references appear in the prose, not staging order.
 */
export function buildMessageWithContext(value: string, items: ComposerContextItem[], projectDir?: string | null): string {
  const { prose, attachments } = splitComposerValue(value)
  const present = items
    .filter((item) => prose.includes(markerToken(item.marker)))
    .sort((a, b) => prose.indexOf(markerToken(a.marker)) - prose.indexOf(markerToken(b.marker)))
  const context = serializeContextItems(present, projectDir)
  if (!context) return value
  const body = prose.trimEnd() ? `${prose.trimEnd()}\n\n${context}` : context
  return joinComposerValue(body, attachments.map((attachment) => attachment.path))
}

// ── the receiving side: a SENT message parsed back into prose + items ────────────────────────────

/** One context item recovered from a sent message's serialized footnote definitions. */
export interface SentContextItem {
  marker: number
  /** The path exactly as serialized (project-relative or absolute). */
  display: string
  startLine?: number
  endLine?: number
  /** The quoted selection, blockquote prefixes stripped. */
  text: string
  comment?: string
}

const HEADER = "Selected context:\n\n"

/**
 * Recognize the serialization `buildMessageWithContext` produced inside a SENT message, so the
 * transcript can render the `[^N]` references as chips instead of showing the raw footnote dump.
 * Strict by design: anything that does not parse back exactly — including every pre-marker-era
 * message, whose definitions read `[1] path` — returns null and renders as the plain text it is.
 */
export function parseSentContext(prose: string): { body: string; items: SentContextItem[] } | null {
  const at = prose.lastIndexOf(HEADER)
  if (at === -1) return null
  if (at !== 0 && prose.slice(at - 2, at) !== "\n\n") return null
  const body = prose.slice(0, Math.max(0, at - 2))
  // Definition blocks are separated by a blank line followed by the next `[^N]: ` head — a comment
  // paragraph inside a block also follows a blank line, so split on the lookahead, not on `\n\n`.
  const blocks = prose.slice(at + HEADER.length).split(/\n\n(?=\[\^\d+\]: )/)
  const items: SentContextItem[] = []
  for (const block of blocks) {
    const lines = block.split("\n")
    const head = lines[0]?.match(/^\[\^(\d+)\]: (.+):$/)
    if (!head) return null
    let display = head[2]
    let startLine: number | undefined
    let endLine: number | undefined
    const range = display.match(/ \((?:line (\d+)|lines (\d+)-(\d+))\)$/)
    if (range) {
      display = display.slice(0, -range[0].length)
      startLine = Number(range[1] ?? range[2])
      endLine = Number(range[1] ?? range[3])
    }
    let i = 1
    const quote: string[] = []
    for (; i < lines.length && lines[i].startsWith(">"); i++) quote.push(lines[i].replace(/^> ?/, ""))
    if (!quote.length) return null
    let comment: string | undefined
    if (i < lines.length) {
      if (lines[i] !== "" || !lines[i + 1]?.startsWith("Comment: ")) return null
      comment = lines.slice(i + 1).join("\n").slice("Comment: ".length)
    }
    items.push({ marker: Number(head[1]), display, startLine, endLine, text: quote.join("\n"), comment })
  }
  if (!items.length) return null
  // The references must actually be in the body — a message that merely QUOTES a serialization (an
  // agent echoing one back, a human pasting one) keeps its honest plain-text rendering.
  if (!items.every((item) => body.includes(markerToken(item.marker)))) return null
  return { body, items }
}

/** The chip label a context item wears everywhere: `basename:12` / `basename:3-9` / `basename`. */
export function contextChipLabel(item: { display?: string; path?: string; startLine?: number; endLine?: number }): string {
  const source = item.display ?? item.path ?? ""
  const base = source.split("/").filter(Boolean).pop() || source
  if (item.startLine === undefined || item.endLine === undefined) return base
  return item.startLine === item.endLine ? `${base}:${item.startLine}` : `${base}:${item.startLine}-${item.endLine}`
}
