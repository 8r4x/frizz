import assert from "node:assert/strict"
import test from "node:test"
import { ownedByThisPage } from "./projectOwnership.ts"

test("a payload is refused only when it NAMES a project and that project is not this page's", () => {
  assert.equal(ownedByThisPage("zod", "/project/zod/thread/x"), true)
  assert.equal(ownedByThisPage("zod", "/project/frizz"), false, "the whole point")
  assert.equal(ownedByThisPage("zod", "/project/zodiac"), false, "a prefix is not a match")
})

// Both permissive cases are deliberate, and both would otherwise blank a working board. They are
// pinned because "tighten this up" is the obvious-looking edit that breaks the launching project.
test("silence is not evidence of a mismatch", () => {
  assert.equal(ownedByThisPage(undefined, "/project/zod"), true, "a pre-restart server sends no slug")
  assert.equal(ownedByThisPage(null, "/project/zod"), true)
  assert.equal(ownedByThisPage("zod", "/thread/x"), true, "the unprefixed launching project names none")
  assert.equal(ownedByThisPage("zod", "/"), true, "nor does the all-projects grid")
})
