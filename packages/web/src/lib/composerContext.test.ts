import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildMessageWithContext,
  contextChipLabel,
  contextDisplayPath,
  insertMarkerIntoProse,
  locateInSource,
  nextMarker,
  parseSentContext,
  serializeContextItems,
  stripMarkerFromProse,
  type ComposerContextItem,
} from "./composerContext.ts"

const item = (over: Partial<ComposerContextItem>): ComposerContextItem => ({ id: 1, marker: 1, path: "/repo/docs/guide.md", text: "some text", ...over })

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

test("the next marker climbs past both the staged set and any token already in the prose", () => {
  assert.equal(nextMarker("", []), 1)
  assert.equal(nextMarker("plain prose", [{ marker: 2 }]), 3)
  // A restored or hand-typed [^5] must never be reissued, or two references fuse.
  assert.equal(nextMarker("see [^5] here", [{ marker: 2 }]), 6)
})

test("a marker splices at the caret, padding only the sides that would glue to a word", () => {
  assert.deepEqual(insertMarkerIntoProse("", 0, 1), { prose: "[^1]", caret: 4 })
  assert.deepEqual(insertMarkerIntoProse("note.", 5, 1), { prose: "note. [^1]", caret: 10 })
  // Mid-word: padded on both sides, caret before the trailing pad so typing on reads `[^1] x`.
  assert.deepEqual(insertMarkerIntoProse("ab", 1, 2), { prose: "a [^2] b", caret: 6 })
  // Already-spaced neighbourhood takes no extra padding on the spaced side.
  assert.deepEqual(insertMarkerIntoProse("a b", 2, 1), { prose: "a [^1] b", caret: 6 })
  // An out-of-range caret clamps to the end.
  assert.deepEqual(insertMarkerIntoProse("hi", 99, 1), { prose: "hi [^1]", caret: 7 })
})

test("stripping a marker folds the spacing its insert added", () => {
  assert.equal(stripMarkerFromProse("a [^1] b", 1), "a b")
  assert.equal(stripMarkerFromProse("[^1] lead", 1), "lead")
  assert.equal(stripMarkerFromProse("tail [^1]", 1), "tail")
  assert.equal(stripMarkerFromProse("a [^12] b", 1), "a [^12] b")
})

test("serialization defines each footnote, quotes every line, and carries the comment", () => {
  const out = serializeContextItems([item({ text: "line a\nline b", startLine: 3, endLine: 4, comment: "why is this here?" })], "/repo")
  assert.equal(out, "Selected context:\n\n" + "[^1]: docs/guide.md (lines 3-4):\n> line a\n> line b\n\nComment: why is this here?")
})

test("multiple items keep their own markers; a single line reads as one line; no comment, no Comment line", () => {
  const out = serializeContextItems(
    [item({ text: "a", startLine: 2, endLine: 2 }), item({ id: 2, marker: 2, text: "b" })],
    "/repo",
  )
  assert.equal(out, "Selected context:\n\n[^1]: docs/guide.md (line 2):\n> a\n\n[^2]: docs/guide.md:\n> b")
})

test("context is spliced after the prose but before trailing attachment paths", () => {
  const value = "Look at this [^1]\n/tmp/shot.png"
  const out = buildMessageWithContext(value, [item({ text: "quoted" })], "/repo")
  assert.equal(out, "Look at this [^1]\n\nSelected context:\n\n[^1]: docs/guide.md:\n> quoted\n/tmp/shot.png")
})

test("an item whose reference was deleted from the prose is dropped, and definitions follow prose order", () => {
  const out = buildMessageWithContext("second [^2] then first [^1]", [item({}), item({ id: 2, marker: 2, text: "other" })], "/repo")
  assert.equal(out, "second [^2] then first [^1]\n\nSelected context:\n\n[^2]: docs/guide.md:\n> other\n\n[^1]: docs/guide.md:\n> some text")
  assert.equal(buildMessageWithContext("no references here", [item({})], "/repo"), "no references here")
})

test("with no staged items the value passes through untouched", () => {
  assert.equal(buildMessageWithContext("hello", [], "/repo"), "hello")
})

test("a sent message parses back into its body and items", () => {
  const sent = buildMessageWithContext(
    "Fix this [^1] and mind the note [^2] please",
    [item({ text: "line a\nline b", startLine: 3, endLine: 4 }), item({ id: 2, marker: 2, text: "quoted", startLine: 9, endLine: 9, comment: "careful" })],
    "/repo",
  )
  const parsed = parseSentContext(sent)
  assert.ok(parsed)
  assert.equal(parsed.body, "Fix this [^1] and mind the note [^2] please")
  assert.deepEqual(parsed.items, [
    { marker: 1, display: "docs/guide.md", startLine: 3, endLine: 4, text: "line a\nline b", comment: undefined },
    { marker: 2, display: "docs/guide.md", startLine: 9, endLine: 9, text: "quoted", comment: "careful" },
  ])
})

test("what is not the serialization renders as the plain text it is", () => {
  // The pre-marker era's format ([1], no definitions) must not half-parse.
  assert.equal(parseSentContext("notes\n\nSelected context:\n\n[1] docs/guide.md:\n> old style"), null)
  // A definition whose reference is missing from the body is someone quoting the format, not sending it.
  assert.equal(parseSentContext("no reference\n\nSelected context:\n\n[^1]: docs/guide.md:\n> quoted"), null)
  // The header mid-sentence is prose.
  assert.equal(parseSentContext("about Selected context:\n\n[^1]: docs/guide.md:\n> q"), null)
  assert.equal(parseSentContext("plain message"), null)
})

test("the chip label is basename plus a compact line range", () => {
  assert.equal(contextChipLabel({ display: "docs/guide.md", startLine: 3, endLine: 4 }), "guide.md:3-4")
  assert.equal(contextChipLabel({ path: "/repo/docs/guide.md", startLine: 2, endLine: 2 }), "guide.md:2")
  assert.equal(contextChipLabel({ display: "docs/guide.md" }), "guide.md")
})
