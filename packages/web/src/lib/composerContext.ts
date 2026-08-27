// SELECTED CONTEXT for a thread's composer — the ⌘I flow. A selection made in the /full file viewer
// becomes a staged item (file, quoted text, best-effort line range, optional comment) rendered as a
// chip above the composer, and on send the whole set is serialized INTO the outgoing message text.
// Text, not a side-channel: the worker reads the same transcript the human does, and a quoted block
// with a file name is something every harness already understands.

import { joinComposerValue, splitComposerValue } from "./imagePaths.ts"

export interface ComposerContextItem {
  id: number
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

function lineLabel(item: ComposerContextItem): string {
  if (item.startLine === undefined || item.endLine === undefined) return ""
  return item.startLine === item.endLine ? ` (line ${item.startLine})` : ` (lines ${item.startLine}-${item.endLine})`
}

/**
 * The agent-facing serialization: a labeled blockquote per item, comments as plain lines after each
 * quote. Blockquotes rather than a fence because the quoted text may itself contain any fence, and
 * because the transcript renders the sent message as markdown — quoted context reads as quotation.
 */
export function serializeContextItems(items: ComposerContextItem[], projectDir?: string | null): string {
  if (!items.length) return ""
  const blocks = items.map((item, i) => {
    const label = items.length > 1 ? `[${i + 1}] ` : ""
    const quoted = item.text.replace(/\s+$/, "").split("\n").map((line) => `> ${line}`).join("\n")
    const comment = item.comment?.trim()
    return `${label}${contextDisplayPath(item.path, projectDir)}${lineLabel(item)}:\n${quoted}${comment ? `\n\nComment: ${comment}` : ""}`
  })
  return `Selected context:\n\n${blocks.join("\n\n")}`
}

/**
 * Splice the serialized context into an outgoing composer value. The value's TRAILING lines may be
 * attachment paths (see imagePaths.ts) which several surfaces detect by their trailing position —
 * context goes after the prose but BEFORE those lines so they stay trailing.
 */
export function buildMessageWithContext(value: string, items: ComposerContextItem[], projectDir?: string | null): string {
  const context = serializeContextItems(items, projectDir)
  if (!context) return value
  const { prose, attachments } = splitComposerValue(value)
  const body = prose.trimEnd() ? `${prose.trimEnd()}\n\n${context}` : context
  return joinComposerValue(body, attachments.map((attachment) => attachment.path))
}
