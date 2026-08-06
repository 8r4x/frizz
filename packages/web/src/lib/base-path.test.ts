import assert from "node:assert/strict"
import { test } from "node:test"
import { apiBase, basePath, innerPath, outerPath } from "./base-path.ts"

// The launching project is still served unprefixed, so an empty base is a supported state.
test("an unprefixed page has no base and addresses the unprefixed API", () => {
  for (const path of ["/", "/thread/fix-auth", "/status/active", "/thread/a%2Fb"]) {
    assert.equal(basePath(path), "", path)
    assert.equal(innerPath(path), path, path)
    assert.equal(apiBase(path), "/_frizz", path)
  }
})

test("a project page takes its base from the first segment", () => {
  assert.equal(basePath("/nub"), "/nub")
  assert.equal(basePath("/nub/thread/fix-auth"), "/nub")
  assert.equal(basePath("/pullfrog-app/status/active"), "/pullfrog-app")
  assert.equal(apiBase("/nub/thread/fix-auth"), "/_frizz/nub")
})

// The router reasons about the inner path, so a prefixed and an unprefixed page look identical to it.
test("inner and outer paths round-trip", () => {
  assert.equal(innerPath("/nub/thread/fix-auth"), "/thread/fix-auth")
  assert.equal(innerPath("/nub"), "/")
  assert.equal(outerPath("/thread/fix-auth", "/nub/thread/other"), "/nub/thread/fix-auth")
  assert.equal(outerPath("/", "/nub/thread/other"), "/nub")
  // Unprefixed, outer is a no-op — which is what keeps the pre-slug client working.
  assert.equal(outerPath("/thread/fix-auth", "/thread/other"), "/thread/fix-auth")
  assert.equal(outerPath("/", "/"), "/")
})

// A project slug and an in-app route share first position; only the route NAMES are reserved.
test("an in-app route is never mistaken for a project", () => {
  assert.equal(basePath("/thread/nub"), "", "a thread called `nub` is not a project called `thread`")
  assert.equal(basePath("/status/blocked"), "")
  // …and a project may legitimately be called something route-shaped-but-not-a-route.
  assert.equal(basePath("/threads"), "/threads")
  assert.equal(basePath("/statuses"), "/statuses")
})
