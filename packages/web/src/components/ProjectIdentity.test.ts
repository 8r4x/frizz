import assert from "node:assert/strict"
import test from "node:test"
import { projectIdentity } from "./Sidebar.tsx"

// projectIdentity is the whole derivation: a board keyframe in, one of four settled answers out. It
// used to be paired with an IdentityMark component that RENDERED those answers; the status row draws
// them directly now (its own rendering assertions live in StatusRow.test.ts), so what is left here is
// the pure question of which answer a given keyframe deserves.
function board(projectLabel: string) {
  return { projectLabel }
}

test("no board at all is LOADING — the one state that is genuinely pending", () => {
  assert.deepEqual(projectIdentity(null), { state: "loading" })
  assert.deepEqual(projectIdentity(undefined), { state: "loading" })
})

test("an owner/repo label is VERIFIED, and keeps both halves", () => {
  assert.deepEqual(projectIdentity(board("openai/frizz")), {
    state: "verified", label: "openai/frizz", owner: "openai", repo: "frizz",
  })
  // Only the LAST slash splits, so a nested GitLab-style path keeps its group in the owner half.
  assert.deepEqual(projectIdentity(board("group/sub/frizz")), {
    state: "verified", label: "group/sub/frizz", owner: "group/sub", repo: "frizz",
  })
})

test("a repo with NO REMOTE is LOCAL and carries its directory name", () => {
  // `projectLabel` falls back to the directory basename when there is no origin remote, and this used
  // to fold into "unavailable" — which draws the cold placeholder. No keyframe was ever going to
  // resolve it into an owner/repo, so that skeleton stayed up for the life of the session (maintainer
  // 2026-08-19: "it just shows a skeleton forever"). It is a settled ANSWER, not a pending one.
  assert.deepEqual(projectIdentity(board("scratch-pad")), { state: "local", name: "scratch-pad" })
  // It still refuses to GUESS an owner: there is a name, and no owner/repo anywhere in the result.
  assert.deepEqual(projectIdentity(board("scratch-pad")), { state: "local", name: "scratch-pad" })
})

test("projectName is the second chance before giving up", () => {
  assert.deepEqual(projectIdentity({ projectLabel: "", projectName: "scratch-pad" }), { state: "local", name: "scratch-pad" })
})

test("only a keyframe with NOTHING nameable is UNAVAILABLE, and it never throws", () => {
  // A broken server, not a project shape — which is what the placeholder is honest about, and what it
  // stopped meaning while it also covered every remote-less repo. `projectLabel` is required on the
  // wire, so the missing-field cases only guard a partial keyframe; they used to crash on `.trim()` of
  // undefined, which takes the whole rail down now that the identity renders inside the column.
  assert.deepEqual(projectIdentity({ projectLabel: "", projectName: "" }), { state: "unavailable" })
  assert.deepEqual(projectIdentity({} as { projectLabel: string }), { state: "unavailable" })
  assert.deepEqual(projectIdentity({ projectLabel: "   " }), { state: "unavailable" })
})

test("a new boot or project has no retained identity and only accepts its own board", () => {
  // The app keeps its last adopted board while the stream reconnects; projectIdentity is deliberately
  // stateless, so passing that same board cannot flash a loading fallback.
  assert.deepEqual(projectIdentity(board("openai/old-project")), {
    state: "verified", label: "openai/old-project", owner: "openai", repo: "old-project",
  })
  assert.deepEqual(projectIdentity(null), { state: "loading" })
  assert.deepEqual(projectIdentity(board("other-org/new-project")), {
    state: "verified", label: "other-org/new-project", owner: "other-org", repo: "new-project",
  })
})
