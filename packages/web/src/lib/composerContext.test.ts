import assert from "node:assert/strict"
import { test } from "node:test"
import { buildMessageWithContext, contextDisplayPath, locateInSource, serializeContextItems, type ComposerContextItem } from "./composerContext.ts"

const item = (over: Partial<ComposerContextItem>): ComposerContextItem => ({ id: 1, path: "/repo/docs/guide.md", text: "some text", ...over })

test("a unique selection maps to its 1-based line range, whitespace-insensitively", () => {
  const source = "# Title\n\nFirst paragraph line one\ncontinues on line four.\n\nAnother paragraph.\n"
  // The rendered view joins the soft-wrapped paragraph into one line; the match must still land.
  assert.deepEqual(locateInSource(source, "line one continues on"), { startLine: 3, endLine: 4 })
  assert.deepEqual(locateInSource(source, "Another paragraph."), { startLine: 6, endLine: 6 })
})

test("an ambiguous or absent selection yields no line range", () => {
  const source = "alpha beta\ngamma\nalpha beta\n"
  assert.equal(locateInSource(source, "alpha beta"), null)
  assert.equal(locateInSource(source, "not present"), null)
  assert.equal(locateInSource(source, "   "), null)
})

test("paths under the project display relative; others stay absolute", () => {
  assert.equal(contextDisplayPath("/repo/docs/guide.md", "/repo"), "docs/guide.md")
  assert.equal(contextDisplayPath("/repo/docs/guide.md", "/repo/"), "docs/guide.md")
  assert.equal(contextDisplayPath("/elsewhere/guide.md", "/repo"), "/elsewhere/guide.md")
  assert.equal(contextDisplayPath("/repo/docs/guide.md", null), "/repo/docs/guide.md")
})

test("serialization quotes every line, labels the range, and carries the comment", () => {
  const out = serializeContextItems([item({ text: "line a\nline b", startLine: 3, endLine: 4, comment: "why is this here?" })], "/repo")
  assert.equal(out, "Selected context:\n\n" + "docs/guide.md (lines 3-4):\n> line a\n> line b\n\nComment: why is this here?")
})

test("multiple items are numbered; a single line reads as one line; no comment, no Comment line", () => {
  const out = serializeContextItems(
    [item({ text: "a", startLine: 2, endLine: 2 }), item({ id: 2, text: "b" })],
    "/repo",
  )
  assert.equal(out, "Selected context:\n\n[1] docs/guide.md (line 2):\n> a\n\n[2] docs/guide.md:\n> b")
})

test("context is spliced after the prose but before trailing attachment paths", () => {
  const value = "Look at this\n/tmp/shot.png"
  const out = buildMessageWithContext(value, [item({ text: "quoted" })], "/repo")
  assert.equal(out, "Look at this\n\nSelected context:\n\ndocs/guide.md:\n> quoted\n/tmp/shot.png")
})

test("with no staged items the value passes through untouched", () => {
  assert.equal(buildMessageWithContext("hello", [], "/repo"), "hello")
})

test("context alone (no prose) still forms a message body", () => {
  assert.equal(buildMessageWithContext("", [item({ text: "quoted" })], "/repo"), "Selected context:\n\ndocs/guide.md:\n> quoted")
})
