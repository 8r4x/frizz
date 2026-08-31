import { test } from "node:test"
import assert from "node:assert/strict"
import { editedFilesOf } from "./edited-files.ts"

const msg = (at: string, ...tools: { name: string; detail?: string; edit?: { file: string; added?: number; removed?: number } }[]) => ({ at, tools } as never)

test("distinct files, newest edit first, counted per write call, diffstat summed", () => {
  const out = editedFilesOf([
    msg("2026-08-28T10:00:00Z", { name: "Edit", edit: { file: "/r/a.ts", added: 5, removed: 2 } }, { name: "Write", edit: { file: "/r/b.ts", added: 40, removed: 0 } }),
    msg("2026-08-28T10:05:00Z", { name: "Edit", edit: { file: "/r/a.ts", added: 1, removed: 1 } }, { name: "Read", detail: "/r/c.ts" }),
  ])
  assert.deepEqual(out, [
    { path: "/r/a.ts", edits: 2, lastEditedAt: "2026-08-28T10:05:00Z", added: 6, removed: 3 },
    { path: "/r/b.ts", edits: 1, lastEditedAt: "2026-08-28T10:00:00Z", added: 40, removed: 0 },
  ])
})

test("an unreconstructed apply_patch counts by name + detail; a Bash call never does", () => {
  const out = editedFilesOf([msg("t", { name: "apply_patch", detail: "/r/d.ts" }, { name: "Bash", detail: "rm /r/e.ts" })])
  assert.deepEqual(out.map((f) => f.path), ["/r/d.ts"])
})
