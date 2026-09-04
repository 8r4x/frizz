import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { LocalFileOpener } from "@frizz/shared"
import {
  MARKDOWN_READ_LIMIT,
  openLocalFile,
  readLocalMarkdown,
  readLocalTextFile,
  resolveLocalFile,
  resolveOpenableFile,
  resolveWatchableLocalFile,
} from "./local-file.ts"

test("local opener canonicalizes a regular file inside its trusted root and uses fixed argv", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-"))
  const file = join(root, "space ; $(not-a-command).md")
  writeFileSync(file, "safe")
  const calls: Array<{ command: string; args: readonly string[]; shell: unknown }> = []
  const result = openLocalFile(file, "system", [root], { spawn: (command, args, options) => {
    calls.push({ command, args, shell: options.shell })
    return { unref() {} }
  } })
  assert.deepEqual(result, { action: "opened", path: realpathSync(file) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.at(-1), realpathSync(file))
  assert.equal(calls[0].shell, false)
})

test("each opener preference selects its own app, and an image ignores the preference entirely", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-opener-"))
  const file = join(root, "app.ts")
  writeFileSync(file, "safe")
  const argvFor = (opener: LocalFileOpener, forceSystem = false) => {
    let call: { command: string; args: readonly string[] } | undefined
    openLocalFile(file, opener, [root], { forceSystem, spawn: (command, args) => { call = { command, args }; return { unref() {} } } })
    return [call!.command, ...call!.args.slice(0, -1)]
  }
  // The reported bug was upstream of here — the transcript's file links carried a `cursor://` href the
  // OS resolved, so "VS Code" never reached this function at all — but nothing pinned the mapping the
  // setting is FOR, so a swap here would have gone unnoticed too.
  const expected = process.platform === "darwin"
    ? { system: ["open"], cursor: ["open", "-a", "Cursor"], vscode: ["open", "-a", "Visual Studio Code"], finder: ["open", "-R"] }
    : { system: ["xdg-open"], cursor: ["cursor"], vscode: ["code"], finder: ["xdg-open"] }
  assert.deepEqual(argvFor("system"), expected.system)
  assert.deepEqual(argvFor("cursor"), expected.cursor)
  assert.deepEqual(argvFor("vscode"), expected.vscode)
  assert.deepEqual(argvFor("finder"), expected.finder)
  // An image has a viewer of its own, so it goes to the OS default whatever the editor preference says.
  assert.deepEqual(argvFor("vscode", true), expected.system)
})

test("local opener refuses relative, outside, directory, and escaping symlink paths", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-root-"))
  const outside = mkdtempSync(join(tmpdir(), "frizz-local-file-outside-"))
  const outsideFile = join(outside, "secret.txt")
  writeFileSync(outsideFile, "no")
  const link = join(root, "escape.txt")
  symlinkSync(outsideFile, link)
  assert.throws(() => resolveLocalFile("relative.txt", [root]), /absolute/)
  assert.throws(() => resolveLocalFile(outsideFile, [root]), /trusted roots/)
  assert.throws(() => resolveLocalFile(root, [root]), /regular file/)
  assert.throws(() => resolveLocalFile(link, [root]), /trusted roots/)
})

test("copy preference returns only the canonical trusted path without spawning", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-copy-"))
  const file = join(root, "artifact.txt")
  writeFileSync(file, "safe")
  assert.deepEqual(openLocalFile(file, "copy", [root], { spawn: () => { throw new Error("must not spawn") } }), { action: "copy", path: realpathSync(file) })
})

test("resolveOpenableFile classifies references: home (~), project-relative, absolute, :line, and misses", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-openable-home-")))
  const project = realpathSync(mkdtempSync(join(tmpdir(), "frizz-openable-proj-")))
  const roots = [home, project]
  writeFileSync(join(home, "CLAUDE.md"), "cfg")
  mkdirSync(join(project, "packages", "web", "src"), { recursive: true })
  writeFileSync(join(project, "packages", "web", "src", "App.tsx"), "code")

  // ~-relative expands to the home root
  assert.equal(resolveOpenableFile("~/CLAUDE.md", project, roots, home), join(home, "CLAUDE.md"))
  // repo-relative resolves against the project dir
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // an absolute path is taken as-is
  assert.equal(resolveOpenableFile(join(project, "packages/web/src/App.tsx"), project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // a trailing :line[:col] editor suffix is stripped before resolving
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx:42:7", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // misses → null (never throws): nonexistent, a directory, and a path outside the roots
  assert.equal(resolveOpenableFile("~/nope.md", project, roots, home), null)
  assert.equal(resolveOpenableFile("packages/web", project, roots, home), null) // a directory, not a file
  assert.equal(resolveOpenableFile("/etc/hosts", project, roots, home), null) // outside the openable roots
  assert.equal(resolveOpenableFile("   ", project, roots, home), null)
})

test("the Markdown reader admits only Markdown, only inside the roots, and only as a real file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-md-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-md-outside-")))
  writeFileSync(join(root, "README.md"), "# Title\n\nBody.\n")
  writeFileSync(join(root, "notes.txt"), "not markdown")
  writeFileSync(join(root, "post.mdx"), "import X from './x'\n\n# Post\n")
  writeFileSync(join(outside, "secret.md"), "no")
  // A `.md` name whose canonical target is something else: the extension is on the href, not the file.
  writeFileSync(join(root, "real.conf"), "PASSWORD=hunter2")
  symlinkSync(join(root, "real.conf"), join(root, "decoy.md"))
  // …while an ordinary symlinked doc (a skill file linked out of a shared tree) still reads.
  symlinkSync(join(root, "README.md"), join(root, "linked.md"))

  assert.deepEqual(readLocalMarkdown(join(root, "README.md"), [root]), {
    path: join(root, "README.md"),
    markdown: "# Title\n\nBody.\n",
    truncated: false,
  })
  assert.equal(readLocalMarkdown(join(root, "linked.md"), [root]).path, join(root, "README.md"))
  assert.equal(readLocalMarkdown(join(root, "post.mdx"), [root]).markdown, "import X from './x'\n\n# Post\n")
  assert.throws(() => readLocalMarkdown(join(root, "notes.txt"), [root]), /not a Markdown file/)
  assert.throws(() => readLocalMarkdown(join(root, "decoy.md"), [root]), /not a Markdown file/)
  assert.throws(() => readLocalMarkdown(join(outside, "secret.md"), [root]), /trusted roots/)
  assert.throws(() => readLocalMarkdown(join(root, "gone.md"), [root]), /was not found/)
  assert.throws(() => readLocalMarkdown("README.md", [root]), /absolute/)
})

test("an oversized Markdown file is cut at a line boundary and reports the cut", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-md-big-")))
  const file = join(root, "huge.md")
  const line = `${"x".repeat(99)}\n`
  writeFileSync(file, line.repeat(Math.ceil((MARKDOWN_READ_LIMIT * 1.5) / line.length)))
  const read = readLocalMarkdown(file, [root])
  assert.equal(read.truncated, true)
  assert.ok(read.markdown.length <= MARKDOWN_READ_LIMIT, "the cut respects the ceiling")
  assert.ok(read.markdown.length > MARKDOWN_READ_LIMIT - line.length, "the cut takes the whole prefix it can")
  // Whole lines only — the tail is never a half-written line (nor a split multi-byte character).
  assert.equal(read.markdown.endsWith("x".repeat(99)), true)
  assert.equal(read.markdown.split("\n").every((l) => l === "" || l.length === 99), true)
})

test("the text reader spans every openable root, not the project dir alone, and refuses binary", () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-text-project-")))
  // A worker's checkout is very often NOT the project directory — a git worktree, a sibling clone,
  // `/tmp` scratch. The viewer's gate is the reader's, so every one of those rows opens.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-text-worktree-")))
  const untrusted = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-text-untrusted-")))
  const roots = [project, worktree]
  writeFileSync(join(project, "app.ts"), "export const a = 1\n")
  writeFileSync(join(worktree, "mod.rs"), "fn main() {}\n")
  writeFileSync(join(untrusted, "elsewhere.ts"), "no")
  writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))

  assert.equal(readLocalTextFile(join(project, "app.ts"), roots).text, "export const a = 1\n")
  assert.deepEqual(readLocalTextFile(join(worktree, "mod.rs"), roots), {
    path: join(worktree, "mod.rs"),
    text: "fn main() {}\n",
    truncated: false,
  })
  assert.throws(() => readLocalTextFile(join(untrusted, "elsewhere.ts"), roots), /trusted roots/)
  assert.throws(() => readLocalTextFile(join(worktree, "logo.png"), roots), /not a text file/)
})

test("a watch attaches exactly where the read is allowed, and a decoy .md arms nothing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-watch-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-watch-outside-")))
  writeFileSync(join(root, "README.md"), "# Title\n")
  writeFileSync(join(root, "app.ts"), "export const a = 1\n")
  writeFileSync(join(root, "real.conf"), "PASSWORD=hunter2")
  symlinkSync(join(root, "real.conf"), join(root, "decoy.md"))
  writeFileSync(join(outside, "other.ts"), "no")

  assert.equal(resolveWatchableLocalFile(join(root, "README.md"), [root]), join(root, "README.md"))
  assert.equal(resolveWatchableLocalFile(join(root, "app.ts"), [root]), join(root, "app.ts"))
  // The Markdown reader refuses a `.md` href whose canonical target is not Markdown, so the watch must
  // too — otherwise a file the reader cannot show still reports that it changed.
  assert.throws(() => resolveWatchableLocalFile(join(root, "decoy.md"), [root]), /not a Markdown file/)
  assert.throws(() => resolveWatchableLocalFile(join(outside, "other.ts"), [root]), /trusted roots/)
})
