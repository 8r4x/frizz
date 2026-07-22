import { test } from "node:test"
import assert from "node:assert/strict"
import { threadComposerStatus, threadFollowUpBlocked, threadPermissionBlockedReason, threadPermissionEffectMessage } from "./threadPermissions.ts"

const state = (over: Partial<Parameters<typeof threadPermissionBlockedReason>[0]> = {}) => ({ ...over })

test("thread permission control: only idle or exited owned threads are editable", () => {
  assert.equal(threadPermissionBlockedReason(state({ runtime: "turn-idle" })), null)
  assert.equal(threadPermissionBlockedReason(state({ runtime: "exited" })), null)
  assert.match(threadPermissionBlockedReason(state({ runtime: "running" }))!, /current turn/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", permissionPending: "bypassPermissions" }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", permissionChangePending: true }))!, /already in progress/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", profileChangePending: true }))!, /model and effort change/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", runtimeControlPending: true }))!, /runtime control/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", subAgents: [{ state: "running" }] }))!, /background operation/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", bgShells: [{ state: "stale" }] }))!, /unresolved background operation/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "perm-prompt" }))!, /terminal approval or question/)
  assert.match(threadPermissionBlockedReason(state({ runtime: "turn-idle", nativeInputRequired: { kind: "question" } }))!, /terminal approval or question/)
})

test("thread permission control: foreign threads remain read-only", () => {
  assert.match(threadPermissionBlockedReason(state({ foreign: true }))!, /Read-only/)
})

test("any durable runtime-control owner blocks follow-up submission", () => {
  assert.equal(threadFollowUpBlocked(state()), false)
  assert.equal(threadFollowUpBlocked(state({ runtimeControlPending: true })), true)
  assert.equal(threadFollowUpBlocked(state({ permissionPending: "default" })), true)
  assert.equal(threadFollowUpBlocked(state({ permissionChangePending: true })), true)
  assert.equal(threadFollowUpBlocked(state({ profileChangePending: true })), true)
})

test("composer status surfaces only an ancillary profile-options failure", () => {
  assert.equal(threadComposerStatus(), null)
  assert.deepEqual(threadComposerStatus(" profile lookup failed "), {
    kind: "profile-error",
    message: "Profile controls unavailable: profile lookup failed",
  })
})

test("thread permission control: feedback distinguishes a live apply from next resume", () => {
  assert.equal(threadPermissionEffectMessage("applied", "codex"), "Sandbox applied to the live session")
  assert.equal(threadPermissionEffectMessage("next-resume", "codex"), "Sandbox saved for the next resume")
})
