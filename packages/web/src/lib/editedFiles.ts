import type { TranscriptMessage } from "@frizz/shared"

// THE FILES A THREAD'S WORKER HAS WRITTEN, derived from its transcript — the fullscreen page's rail
// lists them (maintainer 2026-08-28: "the edited files, if that's even possible"). It is: every
// Edit/Write/MultiEdit call carries a structured `edit.file`, and a codex apply_patch the server could
// not reconstruct still arrives named Edit with the file as its `detail` — the same two readings
// lib/toolActivity's editedFileCount uses for the digest, kept in step here by construction (the same
// name set, the same fallback order).
//
// Distinct by path, newest edit first, each with how many write calls touched it and when the last one
// was issued (the emitting message's own stamp). A Bash `rm`/`mv` is deliberately not inspected.

const FILE_WRITING_TOOL_NAMES = new Set(["edit", "multiedit", "write", "apply patch"])

export interface EditedFile {
  path: string
  edits: number
  lastEditedAt?: string
}

type ToolLike = { name: string; detail?: string; edit?: { file: string } }
type MessageLike = Pick<TranscriptMessage, "tools"> & { at?: string; timestamp?: string }

function normalizedToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ")
}

export function editedFilePath(tool: ToolLike): string | null {
  const structured = tool.edit?.file.trim()
  if (structured) return structured
  const detail = tool.detail?.trim()
  return detail && FILE_WRITING_TOOL_NAMES.has(normalizedToolName(tool.name)) ? detail : null
}

export function editedFiles(messages: readonly MessageLike[]): EditedFile[] {
  const byPath = new Map<string, EditedFile>()
  for (const message of messages) {
    const at = message.at ?? message.timestamp
    for (const tool of message.tools ?? []) {
      const path = editedFilePath(tool)
      if (!path) continue
      const existing = byPath.get(path)
      if (existing) {
        existing.edits++
        if (at) existing.lastEditedAt = at
        // Re-insert so Map order tracks recency.
        byPath.delete(path)
        byPath.set(path, existing)
      } else {
        byPath.set(path, { path, edits: 1, lastEditedAt: at })
      }
    }
  }
  return [...byPath.values()].reverse()
}
