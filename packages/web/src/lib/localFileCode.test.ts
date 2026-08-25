import { test } from "node:test"
import assert from "node:assert/strict"
import { isPathCandidate } from "./localFileCode.ts"

test("isPathCandidate accepts path-like inline code", () => {
  for (const v of [
    "~/.claude/CLAUDE.md",
    "~",
    "/Users/me/artifacts/shot.png",
    "packages/web/src/App.tsx",
    "./foo/bar.ts",
    "../sibling/x.md",
    "packages/web/src/App.tsx:42:7", // an editor :line[:col] suffix is still a candidate (stripped server-side)
    "a/b", // any slash-bearing token is a candidate; the server decides if it's real
    // A bare filename with an extension — how a worker names a file it wrote at the project root
    // (`it's in \`cloudflare-ask.md\``). Resolved against the project dir server-side, like any
    // other relative path.
    "cloudflare-ask.md",
    "package.json",
    "App.tsx",
    "pnpm-lock.yaml",
    "notes@2026-08-25.md",
  ]) assert.equal(isPathCandidate(v), true, v)
})

test("isPathCandidate rejects non-paths: commands, bare words, URLs, whitespace, and over-long text", () => {
  for (const v of [
    "git status", // whitespace → a command, not a path
    "npm run build",
    "useState", // bare identifier, no slash
    "README", // bare word, no extension
    "1.5", // a version, not a file: the "extension" opens with a digit
    "v1.2",
    "e.g.", // an abbreviation ends on its dot, so there is no extension at all
    "foo.", // nor here
    ".env", // a dotfile has no stem before its one dot; the bare-filename rule needs both
    "https://example.com/x.png", // URL
    "file:///Users/me/x.png", // URL scheme
    "cursor://file/Users/me/x.png", // URL scheme
    "", // empty
    "  ", // whitespace only
    `/${"x".repeat(2000)}`, // over the length cap
  ]) assert.equal(isPathCandidate(v), false, v)
})
