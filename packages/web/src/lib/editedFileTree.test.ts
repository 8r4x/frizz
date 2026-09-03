import assert from "node:assert/strict"
import test from "node:test"
import type { EditedFile } from "@frizz/shared"
import { editedFileSegments, editedFileTree, flattenEditedFileTree } from "./editedFileTree.ts"

const file = (path: string): EditedFile => ({ path, edits: 1 })

// The rows as the rail draws them: `depth·kind·name`, so a test reads like the rail looks.
function rows(files: EditedFile[], projectDir?: string): string[] {
  return flattenEditedFileTree(editedFileTree(files, projectDir)).map((n) => `${n.depth}${n.kind === "dir" ? "d" : "f"} ${n.name}`)
}

test("a chain of single-child directories collapses into one row, like GitHub", () => {
  assert.deepEqual(
    rows([file("/repo/packages/web/src/components/ChatView.tsx"), file("/repo/packages/web/src/components/Sidebar.tsx")], "/repo"),
    ["0d packages/web/src/components", "1f ChatView.tsx", "1f Sidebar.tsx"],
  )
})

test("a directory that branches keeps its own row, and the chains below it collapse", () => {
  assert.deepEqual(
    rows([
      file("/repo/packages/web/src/components/ChatView.tsx"),
      file("/repo/packages/server/src/router.ts"),
      file("/repo/packages/server/src/router.test.ts"),
    ], "/repo"),
    ["0d packages", "1d server/src", "2f router.test.ts", "2f router.ts", "1d web/src/components", "2f ChatView.tsx"],
  )
})

test("a file beside a subdirectory is a branch: the directory keeps its row and the file sits under it", () => {
  assert.deepEqual(
    rows([file("/repo/src/index.ts"), file("/repo/src/lib/util.ts")], "/repo"),
    ["0d src", "1d lib", "2f util.ts", "1f index.ts"],
  )
})

test("directories come before files, each alphabetical and case-insensitive, at every level", () => {
  assert.deepEqual(
    rows([file("/repo/zeta.ts"), file("/repo/Alpha.ts"), file("/repo/b/x.ts"), file("/repo/README.md"), file("/repo/a/y.ts")], "/repo"),
    ["0d a", "1f y.ts", "0d b", "1f x.ts", "0f Alpha.ts", "0f README.md", "0f zeta.ts"],
  )
})

test("a file at the project root is a depth-0 file row", () => {
  assert.deepEqual(rows([file("/repo/package.json")], "/repo"), ["0f package.json"])
})

test("a file outside the project keeps its absolute path, rooted at / and collapsed the same way", () => {
  assert.deepEqual(
    rows([file("/Users/me/.claude/CLAUDE.md"), file("/repo/src/a.ts")], "/repo"),
    ["0d /Users/me/.claude", "1f CLAUDE.md", "0d src", "1f a.ts"],
  )
})

test("without a project directory every path is absolute", () => {
  assert.deepEqual(rows([file("/repo/src/a.ts")]), ["0d /repo/src", "1f a.ts"])
})

test("segments: a trailing slash on either side is not a segment, and the project dir itself is not under itself", () => {
  assert.deepEqual(editedFileSegments("/repo/src/a.ts/", "/repo/"), ["src", "a.ts"])
  assert.deepEqual(editedFileSegments("/repo", "/repo"), ["/", "repo"])
  assert.deepEqual(editedFileSegments("/repo-other/a.ts", "/repo"), ["/", "repo-other", "a.ts"])
})

test("the file node carries the edited file, diffstat and all", () => {
  const edited: EditedFile = { path: "/repo/a.ts", edits: 3, added: 10, removed: 2 }
  const [node] = editedFileTree([edited], "/repo")
  assert.equal(node.kind, "file")
  if (node.kind === "file") assert.deepEqual(node.file, edited)
})
