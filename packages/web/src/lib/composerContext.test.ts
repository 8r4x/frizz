import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildMessageWithContext,
  contextChipLabel,
  contextDisplayPath,
  hasToken,
  insertTokenIntoProse,
  locateInSource,
  parseSentContext,
  serializeContextItems,
  splitProseByTokens,
  stripTokenFromProse,
  tokenLabel,
  uniqueToken,
  type ComposerContextItem,
} from "./composerContext.ts"

const item = (over: Partial<ComposerContextItem>): ComposerContextItem => ({ id: 1, token: "@guide.md:3", path: "/repo/docs/guide.md", text: "some text", startLine: 3, endLine: 3, ...over })

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

test("the chip label is basename plus a compact line range, and the token is that label behind an @", () => {
  assert.equal(contextChipLabel({ display: "docs/guide.md", startLine: 3, endLine: 4 }), "guide.md:3-4")
  assert.equal(contextChipLabel({ path: "/repo/docs/guide.md", startLine: 2, endLine: 2 }), "guide.md:2")
  assert.equal(contextChipLabel({ display: "docs/guide.md" }), "guide.md")
  assert.equal(tokenLabel("@guide.md:3#2"), "guide.md:3#2")
})

test("a token is unique against the staged set and the prose, by a #n suffix", () => {
  assert.equal(uniqueToken("guide.md:3", [], ""), "@guide.md:3")
  assert.equal(uniqueToken("guide.md:3", [{ token: "@guide.md:3" }], ""), "@guide.md:3#2")
  // A hand-typed twin in the prose must not be mistaken for the staged reference.
  assert.equal(uniqueToken("guide.md:3", [{ token: "@guide.md:3" }], "see @guide.md:3#2 too"), "@guide.md:3#3")
})

test("a token is only found as a whole reference", () => {
  assert.equal(hasToken("see @guide.md:3.", "@guide.md:3"), true)
  assert.equal(hasToken("see @guide.md:30", "@guide.md:3"), false)
  assert.equal(hasToken("see @guide.md:3-4", "@guide.md:3"), false)
  assert.equal(hasToken("see @guide.md:3#2", "@guide.md:3"), false)
})

test("a token splices at the caret, padding only the sides that would glue to a word", () => {
  assert.deepEqual(insertTokenIntoProse("", 0, "@a.md:1"), { prose: "@a.md:1", caret: 7 })
  assert.deepEqual(insertTokenIntoProse("note.", 5, "@a.md:1"), { prose: "note. @a.md:1", caret: 13 })
  // Mid-word: padded on both sides, caret before the trailing pad so typing on reads `@a.md:1 x`.
  assert.deepEqual(insertTokenIntoProse("ab", 1, "@a.md:1"), { prose: "a @a.md:1 b", caret: 9 })
  // An already-spaced side takes no extra padding.
  assert.deepEqual(insertTokenIntoProse("a b", 2, "@a.md:1"), { prose: "a @a.md:1 b", caret: 9 })
  // An out-of-range caret clamps to the end.
  assert.deepEqual(insertTokenIntoProse("hi", 99, "@a.md:1"), { prose: "hi @a.md:1", caret: 10 })
})

test("stripping a token folds the spacing its insert added, and leaves longer tokens alone", () => {
  assert.equal(stripTokenFromProse("a @a.md:1 b", "@a.md:1"), "a b")
  assert.equal(stripTokenFromProse("@a.md:1 lead", "@a.md:1"), "lead")
  assert.equal(stripTokenFromProse("tail @a.md:1", "@a.md:1"), "tail")
  assert.equal(stripTokenFromProse("a @a.md:12 b", "@a.md:1"), "a @a.md:12 b")
})

test("the splitter cuts prose into plain runs and whole staged tokens, longest token first", () => {
  assert.deepEqual(splitProseByTokens("x @a.md:1 y @a.md:1#2.", ["@a.md:1", "@a.md:1#2"]), [
    { text: "x " },
    { text: "@a.md:1", token: "@a.md:1" },
    { text: " y " },
    { text: "@a.md:1#2", token: "@a.md:1#2" },
    { text: "." },
  ])
  // An unstaged twin and a longer sibling both stay plain.
  assert.deepEqual(splitProseByTokens("@a.md:10 and @b.md", ["@a.md:1"]), [{ text: "@a.md:10 and @b.md" }])
  assert.deepEqual(splitProseByTokens("plain", []), [{ text: "plain" }])
  assert.deepEqual(splitProseByTokens("", ["@a.md:1"]), [])
})

test("serialization defines each token, quotes every line, and carries the comment", () => {
  const out = serializeContextItems([item({ token: "@guide.md:3-4", text: "line a\nline b", startLine: 3, endLine: 4, comment: "why is this here?" })], "/repo")
  assert.equal(out, "Selected context:\n\n" + "@guide.md:3-4 (docs/guide.md, lines 3-4):\n> line a\n> line b\n\nComment: why is this here?")
})

test("a single line reads as one line, no lines reads as the bare path, and no comment means no Comment line", () => {
  const out = serializeContextItems(
    [item({ text: "a" }), item({ id: 2, token: "@guide.md", text: "b", startLine: undefined, endLine: undefined })],
    "/repo",
  )
  assert.equal(out, "Selected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> a\n\n@guide.md (docs/guide.md):\n> b")
})

test("context is spliced after the prose but before trailing attachment paths", () => {
  const value = "Look at this @guide.md:3\n/tmp/shot.png"
  const out = buildMessageWithContext(value, [item({ text: "quoted" })], "/repo")
  assert.equal(out, "Look at this @guide.md:3\n\nSelected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> quoted\n/tmp/shot.png")
})

test("an item whose reference was deleted from the prose is dropped, and definitions follow prose order", () => {
  const out = buildMessageWithContext("second @guide.md:9 then first @guide.md:3", [item({}), item({ id: 2, token: "@guide.md:9", text: "other", startLine: 9, endLine: 9 })], "/repo")
  assert.equal(out, "second @guide.md:9 then first @guide.md:3\n\nSelected context:\n\n@guide.md:9 (docs/guide.md, line 9):\n> other\n\n@guide.md:3 (docs/guide.md, line 3):\n> some text")
  assert.equal(buildMessageWithContext("no references here", [item({})], "/repo"), "no references here")
})

test("with no staged items the value passes through untouched", () => {
  assert.equal(buildMessageWithContext("hello", [], "/repo"), "hello")
})

test("a sent message parses back into its body and items", () => {
  const sent = buildMessageWithContext(
    "Fix this @guide.md:3-4 and mind the note @guide.md:9 please",
    [item({ token: "@guide.md:3-4", text: "line a\nline b", startLine: 3, endLine: 4 }), item({ id: 2, token: "@guide.md:9", text: "quoted", startLine: 9, endLine: 9, comment: "careful" })],
    "/repo",
  )
  const parsed = parseSentContext(sent)
  assert.ok(parsed)
  assert.equal(parsed.body, "Fix this @guide.md:3-4 and mind the note @guide.md:9 please")
  assert.deepEqual(parsed.items, [
    { token: "@guide.md:3-4", display: "docs/guide.md", startLine: 3, endLine: 4, text: "line a\nline b", comment: undefined },
    { token: "@guide.md:9", display: "docs/guide.md", startLine: 9, endLine: 9, text: "quoted", comment: "careful" },
  ])
  // A definition with no line range parses too.
  const bare = parseSentContext("see @guide.md\n\nSelected context:\n\n@guide.md (docs/guide.md):\n> q")
  assert.deepEqual(bare?.items, [{ token: "@guide.md", display: "docs/guide.md", startLine: undefined, endLine: undefined, text: "q", comment: undefined }])
})

test("what is not the serialization renders as the plain text it is", () => {
  // The two earlier formats must not half-parse.
  assert.equal(parseSentContext("notes\n\nSelected context:\n\n[1] docs/guide.md:\n> old style"), null)
  assert.equal(parseSentContext("notes [^1]\n\nSelected context:\n\n[^1]: docs/guide.md (line 3):\n> footnote era"), null)
  // A definition whose reference is missing from the body is someone quoting the format, not sending it.
  assert.equal(parseSentContext("no reference\n\nSelected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> quoted"), null)
  // The header mid-sentence is prose.
  assert.equal(parseSentContext("about Selected context:\n\n@guide.md:3 (docs/guide.md, line 3):\n> q"), null)
  assert.equal(parseSentContext("plain message"), null)
})
