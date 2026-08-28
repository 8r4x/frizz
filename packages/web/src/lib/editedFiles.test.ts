import assert from "node:assert/strict"
import { test } from "node:test"
import { editedFiles } from "./editedFiles.ts"

const msg = (at: string, ...tools: { name: string; detail?: string; edit?: { file: string } }[]) => ({ at, tools } as never)

test("distinct files, newest edit first, counted per write call", () => {
  const out = editedFiles([
    msg("2026-08-28T10:00:00Z", { name: "Edit", edit: { file: "/r/a.ts" } }, { name: "Write", edit: { file: "/r/b.ts" } }),
    msg("2026-08-28T10:05:00Z", { name: "Edit", edit: { file: "/r/a.ts" } }, { name: "Read", detail: "/r/c.ts" }),
  ])
  assert.deepEqual(out, [
    { path: "/r/a.ts", edits: 2, lastEditedAt: "2026-08-28T10:05:00Z" },
    { path: "/r/b.ts", edits: 1, lastEditedAt: "2026-08-28T10:00:00Z" },
  ])
})

test("an unreconstructed apply_patch counts by name + detail; a Bash call never does", () => {
  const out = editedFiles([msg("t", { name: "apply_patch", detail: "/r/d.ts" }, { name: "Bash", detail: "rm /r/e.ts" })])
  assert.deepEqual(out.map((f) => f.path), ["/r/d.ts"])
})
