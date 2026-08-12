import { test } from "node:test"
import assert from "node:assert/strict"
import { isLocalMarkdownFile, localFileDir, localImageUrl, localImageUrlForTarget, localMarkdownTarget, resolveRelativeLocalPath } from "./markdownTargets.ts"

test("absolute POSIX and file URLs become local targets with decoded proxy paths", () => {
  assert.deepEqual(
    localMarkdownTarget("/Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", posixPath: "/Users/me/visual review/shot.png" },
  )
  assert.deepEqual(
    localMarkdownTarget("file:///Users/me/visual%20review/shot.png"),
    { display: "/Users/me/visual review/shot.png", posixPath: "/Users/me/visual review/shot.png" },
  )
  assert.equal(
    localImageUrl("/Users/me/visual review/shot.png"),
    "/_frizz/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
  assert.equal(
    localImageUrlForTarget(localMarkdownTarget("/Users/me/visual%20review/shot.png")!),
    "/_frizz/local-image?path=%2FUsers%2Fme%2Fvisual%20review%2Fshot.png",
  )
})

test("only server-supported local image extensions become proxy URLs", () => {
  for (const path of ["/tmp/shot.png", "/tmp/shot.JPG", "/tmp/shot.jpeg", "/tmp/shot.gif", "/tmp/shot.webp"]) {
    assert.ok(localImageUrlForTarget(localMarkdownTarget(path)!), path)
  }
  assert.equal(localImageUrlForTarget(localMarkdownTarget("/tmp/shot.svg")!), null)
  assert.equal(localImageUrlForTarget(localMarkdownTarget("C:\\Users\\me\\shot.png")!), null)
})

test("Windows and remote file targets are visibly local but cannot become proxy reads", () => {
  assert.deepEqual(localMarkdownTarget("C:\\Users\\me\\shot.png"), { display: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("C:%5CUsers%5Cme%5Cshot.png"), { display: "C:\\Users\\me\\shot.png" })
  assert.deepEqual(localMarkdownTarget("file://fileserver/share/shot.png"), { display: "file://fileserver/share/shot.png" })
})

test("normal web, relative app, anchor, and mail links remain links", () => {
  for (const href of [
    "https://example.com/shot.png",
    "//cdn.example.com/shot.png",
    "thread/a",
    "/thread/a",
    "/status/active",
    "/",
    "/?filter=active",
    "#details",
    "mailto:dev@example.com",
  ]) assert.equal(localMarkdownTarget(href), null, href)
})

test("malformed URL encoding cannot throw or become an app navigation", () => {
  assert.deepEqual(localMarkdownTarget("/Users/me/bad%ZZ.png"), {
    display: "/Users/me/bad%ZZ.png",
    posixPath: "/Users/me/bad%ZZ.png",
  })
})

test("a local Markdown file is recognized by extension, editor suffix and all", () => {
  for (const path of ["/repo/README.md", "/repo/docs/a.MARKDOWN", "~/.claude/CLAUDE.md", "/repo/AGENTS.md:42", "/repo/AGENTS.md:42:7"])
    assert.equal(isLocalMarkdownFile(path), true, path)
  for (const path of ["/repo/notes.txt", "/repo/app.mdx", "/repo/md", "/repo/a.md.bak", "/repo/docs"])
    assert.equal(isLocalMarkdownFile(path), false, path)
})

test("a document's relative links resolve against its own directory", () => {
  const base = "/repo/docs"
  assert.equal(resolveRelativeLocalPath("guide.md", base), "/repo/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("./guide.md", base), "/repo/docs/guide.md")
  assert.equal(resolveRelativeLocalPath("../AGENTS.md", base), "/repo/AGENTS.md")
  assert.equal(resolveRelativeLocalPath("a/../b/c.md", base), "/repo/docs/b/c.md")
  assert.equal(resolveRelativeLocalPath("shots/one%20two.png", base), "/repo/docs/shots/one two.png")
  // A filesystem path has no query or fragment; the tail is dropped rather than baked into the name.
  assert.equal(resolveRelativeLocalPath("guide.md#section", base), "/repo/docs/guide.md")
})

test("only a genuinely relative destination is rebased", () => {
  const base = "/repo/docs"
  for (const href of ["/abs/x.md", "https://example.com/x.md", "mailto:a@b.c", "file:///x.md", "#anchor", "?q=1", "", "   "])
    assert.equal(resolveRelativeLocalPath(href, base), null, JSON.stringify(href))
  // No base (every surface but the file reader) means no rebasing at all.
  assert.equal(resolveRelativeLocalPath("guide.md", ""), null)
})

test("a document's base directory is its parent", () => {
  assert.equal(localFileDir("/repo/docs/guide.md"), "/repo/docs")
  assert.equal(localFileDir("/README.md"), "/")
})
