import type { EditedFile, TranscriptMessage } from "@frizz/shared"

// THE FILES A THREAD'S WORKER HAS WRITTEN, derived from its projected transcript — the fullscreen
// page's rail lists them (maintainer 2026-08-28: "the edited files, if that's even possible"). It is:
// every Edit/Write/MultiEdit call carries a structured `edit.file`, and a codex apply_patch the
// projection could not reconstruct still arrives named Edit with the file as its `detail` — the same
// two readings the web's toolActivity uses for the "edited N files" digest, kept in step by
// construction (the same name set, the same fallback order).
//
// It runs over the FULL projection, never the latest window: the window is the last ~300 messages,
// and a worker's edits sit in the middle of an effort with verification and the handoff after them.
// Distinct by path, newest edit first, each with how many write calls touched it and when the last
// one was issued (the emitting message's own stamp). A Bash `rm`/`mv` is deliberately not inspected.

const FILE_WRITING_TOOL_NAMES = new Set(["edit", "multiedit", "write", "apply patch"])

type ToolLike = { name: string; detail?: string; edit?: { file: string; added?: number; removed?: number } }
type MessageLike = Pick<TranscriptMessage, "tools"> & { at?: string }

function normalizedToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ")
}

export function editedFilePath(tool: ToolLike): string | null {
  const structured = tool.edit?.file.trim()
  if (structured) return structured
  const detail = tool.detail?.trim()
  return detail && FILE_WRITING_TOOL_NAMES.has(normalizedToolName(tool.name)) ? detail : null
}

export function editedFilesOf(messages: readonly MessageLike[]): EditedFile[] {
  const byPath = new Map<string, EditedFile>()
  for (const message of messages) {
    for (const tool of message.tools ?? []) {
      const path = editedFilePath(tool)
      if (!path) continue
      const existing = byPath.get(path)
      if (existing) {
        existing.edits++
        if (message.at) existing.lastEditedAt = message.at
        if (tool.edit?.added !== undefined) existing.added = (existing.added ?? 0) + tool.edit.added
        if (tool.edit?.removed !== undefined) existing.removed = (existing.removed ?? 0) + tool.edit.removed
        // Re-insert so Map order tracks recency.
        byPath.delete(path)
        byPath.set(path, existing)
      } else {
        byPath.set(path, {
          path,
          edits: 1,
          ...(message.at ? { lastEditedAt: message.at } : {}),
          ...(tool.edit?.added !== undefined ? { added: tool.edit.added } : {}),
          ...(tool.edit?.removed !== undefined ? { removed: tool.edit.removed } : {}),
        })
      }
    }
  }
  return [...byPath.values()].reverse()
}
