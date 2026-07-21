import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@fray-ui/shared"
import { threadLifecycleAvailability, completionArchivesImmediately } from "./threadLifecycle.ts"

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "owned-thread",
    title: "Owned thread",
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    pendingQuestion: false,
    kind: "session",
    foreign: false,
    state: "open",
    needsYou: true,
    crashed: false,
    actionableInteraction: false,
    ...over,
  }
}

test("thread lifecycle controls have one footer home independent of queue/done presentation", () => {
  assert.deepEqual(threadLifecycleAvailability(thread()), {
    footer: true,
    snooze: true,
    archive: true,
  })
  assert.deepEqual(threadLifecycleAvailability(thread({ lastFence: { kind: "done", body: "Shipped", hints: [] } })), {
    footer: true,
    snooze: true,
    archive: true,
  }, "a done fence cannot move Archive inline or into a header")
  // An archived thread has no lifecycle controls at all — reopening is done by sending it another
  // message, not a Reopen button — so the footer does not render.
  assert.deepEqual(threadLifecycleAvailability(thread({ state: "archived", archived: true })), {
    footer: false,
    snooze: false,
    archive: false,
  })
  assert.equal(threadLifecycleAvailability(thread({ state: undefined, archived: true })).footer, false, "rolling snapshots still suppress the footer once archived")
  assert.equal(threadLifecycleAvailability(thread({ foreign: true })).footer, false)
  assert.equal(threadLifecycleAvailability(thread({ kind: "legacy" })).footer, false)
})

// completionArchivesImmediately gates the OPTIMISTIC Mark-as-done dismissal, so it must match the
// server's completionNeedsConfirmation (server/src/router.ts) INVERTED: true only when the server would
// archive without an "End this session?" dialog. A false positive would flash-dismiss a card the server
// then asks to confirm; a false negative just waits out the round-trip. It must never mispredict an
// executing turn as immediate.
test("completionArchivesImmediately mirrors the server's no-confirmation cases", () => {
  const busySub = { label: "child", startedAt: "2026-07-21T00:00:00Z", state: "running" as const }
  const staleSub = { label: "child", startedAt: "2026-07-21T00:00:00Z", state: "stale" as const }
  const busyShell = { label: "watch", startedAt: "2026-07-21T00:00:00Z", state: "running" as const }

  // Resting / exited / human-blocked → immediate (no dialog).
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle" })), true)
  assert.equal(completionArchivesImmediately(thread({ runtime: "exited", crashed: true })), true)
  assert.equal(completionArchivesImmediately(thread({ runtime: "perm-prompt" })), true)
  assert.equal(completionArchivesImmediately(thread({ pendingAsk: { questions: [] } })), true)
  assert.equal(completionArchivesImmediately(thread({ nativeInputRequired: { kind: "tool-approval", title: "Approval required" } })), true)
  // A human-blocked shell is safe to stop even with live background work (server short-circuits on it).
  assert.equal(completionArchivesImmediately(thread({ runtime: "perm-prompt", subAgents: [busySub] })), true)

  // Executing / spawning turn → must confirm (never optimistic).
  assert.equal(completionArchivesImmediately(thread({ runtime: "running" })), false)
  assert.equal(completionArchivesImmediately(thread({ runtime: "spawning" })), false)
  // Resting but with live background sub-agents/shells → server confirms, so not optimistic.
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle", subAgents: [busySub] })), false)
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle", subAgents: [staleSub] })), false)
  assert.equal(completionArchivesImmediately(thread({ runtime: "turn-idle", bgShells: [busyShell] })), false)
})

test("every owned open queue reason retains enabled lifecycle actions in the footer", () => {
  for (const state of [
    thread({ pendingQuestion: true }),
    thread({ pendingAsk: { questions: [] } }),
    thread({ nativeInputRequired: { kind: "tool-approval", title: "Approval required" } }),
    thread({ runtime: "perm-prompt" }),
    thread({ actionableInteraction: true }),
    thread({ crashed: true, runtime: "exited" }),
  ]) {
    assert.deepEqual(threadLifecycleAvailability(state), {
      footer: true,
      snooze: true,
      archive: true,
    })
  }
})
