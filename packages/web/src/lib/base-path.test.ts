import assert from "node:assert/strict"
import { test } from "node:test"
import { apiBase, basePath, innerPath, outerPath, projectHref, projectSlug } from "./base-path.ts"

// The launching project is still served unprefixed, so an empty base is a supported state.
test("an unprefixed page has no base and addresses the unprefixed API", () => {
  for (const path of ["/", "/thread/fix-auth", "/status/active", "/thread/a%2Fb"]) {
    assert.equal(basePath(path), "", path)
    assert.equal(innerPath(path), path, path)
    assert.equal(apiBase(path), "/_frizz", path)
    assert.equal(projectSlug(path), undefined, path)
  }
})

test("a project page lives under /project, and its API stays flat", () => {
  assert.equal(basePath("/project/nub"), "/project/nub")
  assert.equal(basePath("/project/nub/thread/fix-auth"), "/project/nub")
  assert.equal(projectSlug("/project/pullfrog-app/status/active"), "pullfrog-app")
  assert.equal(projectHref("nub"), "/project/nub")
  // The API is already inside a reserved namespace, so it has no root to protect: `/project` would
  // buy nothing there, and the server's split stays a two-part one.
  assert.equal(apiBase("/project/nub/thread/fix-auth"), "/_frizz/nub")
})

// The router reasons about the inner path, so a prefixed and an unprefixed page look identical to it.
test("inner and outer paths round-trip", () => {
  assert.equal(innerPath("/project/nub/thread/fix-auth"), "/thread/fix-auth")
  assert.equal(innerPath("/project/nub"), "/")
  assert.equal(outerPath("/thread/fix-auth", "/project/nub/thread/other"), "/project/nub/thread/fix-auth")
  assert.equal(outerPath("/", "/project/nub/thread/other"), "/project/nub")
  // Unprefixed, outer is a no-op — which is what keeps the launching project's own URLs working.
  assert.equal(outerPath("/thread/fix-auth", "/thread/other"), "/thread/fix-auth")
  assert.equal(outerPath("/", "/"), "/")
})

// THE POINT of moving projects under a segment of their own: the root namespace stays Frizz's.
test("only /project/<slug> is a project, so the root is free for other pages", () => {
  assert.equal(basePath("/thread/nub"), "", "a thread called `nub` is not a project")
  assert.equal(basePath("/status/blocked"), "")
  // A future top-level page cannot be shadowed by a directory somebody happens to have.
  assert.equal(basePath("/settings"), "")
  assert.equal(basePath("/docs/getting-started"), "")
  assert.equal(projectSlug("/settings"), undefined)
  // …and `/project` with nothing after it is not a project either.
  assert.equal(basePath("/project"), "")
  assert.equal(projectSlug("/project"), undefined)
})
