// CI test for the broker bridge's PERMISSION → dashboard routing (fake claude CLI, real InteractionStore,
// a real forked daemon — no real claude, no network). Proves: a tool-permission escalation the daemon
// relays is journaled as a provider-neutral approval interaction (provider.kind "claude",
// payload.kind "permission-approval"), and the human's dashboard decision is applied back to the daemon.
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function runCase(decisionId: string, expectBehavior: "allow" | "deny") {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-perm-"))
  const exe = join(dir, "fake-claude--permission.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const store = createInteractionStore(new Database(":memory:"))
  let results = 0
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    interactions: store, projectId: "proj-1",
    onEvent: (_slug: string, _sid: string, ev: ClaudeQueryEvent) => { if (ev.kind === "result") results++ },
  })
  const sessionId = randomUUID()
  const slug = "perm-thread"
  const scope = { projectId: "proj-1", threadSlug: slug, sessionId }
  const waitFor = async (cond: () => boolean, ms = 10_000) => { const d = Date.now() + ms; while (!cond()) { if (Date.now() > d) throw new Error("timeout"); await sleep(100) } }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => store.listPending(scope).length > 0)
    const [rec] = store.listPending(scope)
    assert.equal(rec.provider.kind, "claude", "interaction is attributed to the claude broker")
    assert.equal(rec.payload.kind, "permission-approval", "escalation renders as an approval card")
    assert.ok(rec.allowedDecisions.some((d) => d.id === "claude-allow" && d.semantic === "approve"))
    assert.ok(rec.allowedDecisions.some((d) => d.id === "claude-deny" && d.semantic === "deny"))
    // The daemon must NOT have proceeded before the human decides.
    assert.equal(results, 0, "the tool call is gated until the human decides")

    store.resolve(scope, {
      slug, sessionId, interactionId: rec.id,
      sessionEpoch: rec.owner.sessionEpoch, capabilityRevision: rec.owner.capabilityRevision,
      expectedRecordRevision: rec.recordRevision, responseId: `r-${rec.id}`, decisionId,
    })
    // subscribe → answerPermission → daemon applies the decision → the turn completes with a result.
    await waitFor(() => results > 0)
    assert.ok(results > 0, `daemon proceeded after the human's ${expectBehavior} decision`)
    assert.equal(store.listPending(scope).length, 0, "the interaction is no longer pending")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
}

test("broker routes a permission escalation to the InteractionStore and APPROVES on the human decision", { timeout: 25_000 }, async () => {
  await runCase("claude-allow", "allow")
})

test("broker routes a permission escalation and DENIES on the human decision", { timeout: 25_000 }, async () => {
  await runCase("claude-deny", "deny")
})
