import { test } from "node:test"
import assert from "node:assert/strict"
import { githubRefUrl } from "./githubRef.ts"

test("githubRefUrl builds the PR link, and returns null rather than a broken one", () => {
  assert.equal(githubRefUrl("nubjs/nub#587"), "https://github.com/nubjs/nub/pull/587")
  assert.equal(githubRefUrl("acme/app.js#12"), "https://github.com/acme/app.js/pull/12")
  // A worker writes the hint by hand, so the value routinely arrives with stray whitespace.
  assert.equal(githubRefUrl("  nubjs/nub#587  "), "https://github.com/nubjs/nub/pull/587")
  for (const bad of ["nubjs/nub", "#587", "", "not a ref", "nubjs/nub#abc", "nubjs/nub#587 extra"]) {
    assert.equal(githubRefUrl(bad), null, bad)
  }
})
