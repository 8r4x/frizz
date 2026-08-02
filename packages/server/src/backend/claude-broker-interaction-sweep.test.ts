// A Claude interaction that outlives its answerability must be TERMINALIZED, not left pending.
//
// The defect these pin, from a live thread: a `claude`/`agent-question` row journaled
// 2026-08-02T02:23:52Z on `https-varlock-dev-integrations-overview-can` was still `pending` a day
// later, rendering an answerable question card pinned to the tail of a transcript whose turn had long
// since moved past it. Nothing on the Claude side ever swept: `cancelForSession` was reached only from
// storage.ts (session replaced/deleted) and from the codex bridge, which retires its own on
// `turn/completed` and on a rebind onto a dead turn.
//
// Both tests drive the REAL fork/socket/daemon path with the fake CLI, because the whole question is
// what happens to the journal when a real turn ends and when a real daemon is gone — a stubbed bridge
// would be asserting the stub.
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { buildClaudePermissionInteraction } from "./claude-permission-interactions.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rmEventually(dir: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout")
    await sleep(50)
  }
}

function fakeExe(dir: string, scenario: string): string {
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  return exe
}

/** Journal a pending Claude approval the way the bridge does, for a request nothing will answer. */
function seedOrphan(
  store: ReturnType<typeof createInteractionStore>,
  owner: { projectId: string; threadSlug: string; sessionId: string; cwd: string },
  requestId: string,
): string {
  const request = buildClaudePermissionInteraction(
    { requestId, toolName: "Bash", toolUseId: `tool-${requestId}`, input: { command: "echo orphan" }, suggestions: [] },
    owner,
  )
  assert.ok(request, "the fixture escalation is representable")
  return store.create(request).interaction.id
}

// A `result` ENDS the turn. A permission escalation holds the turn open by construction, so a card
// still pending when the result lands is a card the turn abandoned — the AskUserQuestion refusal and
// the cc-worker PreToolUse hook both answer the daemon directly, leaving anything already journaled
// for that escalation with nothing left to resolve it.
//
// The `ask` scenario is the real shape of the reported bug: the daemon raises AskUserQuestion, the
// bridge denies it on the socket (never journaling a card of its own), and the fake then emits its
// `result`. The seeded row stands in for the card a PREVIOUS fray journaled for that same turn, which
// is exactly what the live thread was carrying.
test("a turn's result retires the interactions it left pending", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-turn-"))
  const exe = fakeExe(dir, "ask")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-turn"
  const projectId = "proj-sweep-turn"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env, interactions: store, projectId,
  })
  try {
    const orphanId = seedOrphan(store, { projectId, threadSlug: slug, sessionId, cwd: dir }, "stranded-request-1")
    assert.equal(store.listPending(scope).length, 1, "the card starts out pending and answerable")

    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "ask me something", permissionMode: "default" })
    // The ask is denied on the socket, the fake answers its own tool call and emits `result`.
    await waitFor(() => store.listPending(scope).length === 0)

    const swept = store.get(scope, orphanId)
    assert.equal(swept?.lifecycle, "cancelled", "the abandoned card is terminal, not pending forever")
    assert.equal(swept?.cancellationReason, "turn-ended")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// The other half: a card journaled by a fray that is GONE. The canUseTool promise lived in that
// daemon's process, `pendingPerms` is memory this bridge never had, and a cold resume re-asks inside a
// new turn under a new request id — so nothing can ever route an answer to it. This boot is the only
// thing that will notice, which is why it must sweep rather than skip.
//
// It also pins the ORDER of the reasons: a dead daemon is `provider-cancelled` (the turn's fate is
// unknown; the provider is provably gone), not `turn-ended`.
test("warmUp retires the interactions of an owned session whose daemon is gone", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-boot-"))
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-boot"
  const projectId = "proj-sweep-boot"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: fakeExe(dir, "permission"), env,
    interactions: store, projectId,
    ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
  })
  try {
    const orphanId = seedOrphan(store, { projectId, threadSlug: slug, sessionId, cwd: dir }, "ghost-request-1")
    assert.equal(store.listPending(scope).length, 1)

    await bridge.warmUp()

    assert.equal(store.listPending(scope).length, 0, "the boot sweep emptied the queue")
    const swept = store.get(scope, orphanId)
    assert.equal(swept?.lifecycle, "cancelled")
    assert.equal(swept?.cancellationReason, "provider-cancelled")
    // The sweep must never be mistaken for a reason to start something: warmUp still only ADOPTS.
    assert.equal(bridge.isDaemonAlive(sessionId), false, "no daemon was forked")
    assert.equal(bridge.binding(slug, sessionId), undefined, "no session was bound")
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})

// The regression guard for the sweep itself: warmUp used to bail on `live.size === 0`, which is the
// single most common boot there is — every fray start after every daemon has aged out. If that early
// return comes back, the sweep silently never runs on exactly the boots that need it, and this is the
// only test that would notice. A second owned session with a still-pending card and no daemon anywhere
// makes the zero-live-daemons path explicit rather than incidental.
test("the boot sweep runs when NO daemon is alive at all", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-none-"))
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const projectId = "proj-sweep-none"
  const store = createInteractionStore(new Database(":memory:"))
  const owned = [
    { threadSlug: "ghost-a", sessionId: randomUUID(), cwd: dir },
    { threadSlug: "ghost-b", sessionId: randomUUID(), cwd: dir },
  ]
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: fakeExe(dir, "permission"), env,
    interactions: store, projectId, ownedSessions: () => owned,
  })
  try {
    for (const target of owned) {
      seedOrphan(store, { projectId, ...target }, `ghost-${target.threadSlug}`)
    }
    await bridge.warmUp()
    for (const target of owned) {
      const scope = { projectId, threadSlug: target.threadSlug, sessionId: target.sessionId }
      assert.equal(store.listPending(scope).length, 0, `${target.threadSlug} was swept`)
    }
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})

// A LIVE daemon re-delivers its held escalation on reattach, so its cards are answerable and must
// survive the boot untouched. This is the control that keeps the sweep above from becoming a boot that
// throws away every pending approval it finds.
test("warmUp leaves the interactions of a session whose daemon is still alive alone", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sweep-live-"))
  const exe = fakeExe(dir, "permission")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sweep-live"
  const projectId = "proj-sweep-live"
  const scope = { projectId, threadSlug: slug, sessionId }
  const store = createInteractionStore(new Database(":memory:"))
  // fray #1 raises a real escalation and journals a real card, then goes away leaving the daemon up.
  const first = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env, interactions: store, projectId,
  })
  let second: ReturnType<typeof createClaudeAgentBrokerBridge> | undefined
  try {
    await first.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => store.listPending(scope).length > 0)
    const [live] = store.listPending(scope)
    first.close()
    await sleep(300)
    assert.ok(readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)), "the daemon outlived fray #1")

    second = createClaudeAgentBrokerBridge({
      stateDir: dir, executablePath: exe, env, interactions: store, projectId,
      ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
    })
    await second.warmUp()
    await sleep(500)

    assert.equal(store.get(scope, live.id)?.lifecycle, "pending", "an answerable card survives the boot")
    assert.ok(second.binding(slug, sessionId), "and its session was adopted, not swept")
  } finally {
    second?.releaseSession(slug, sessionId, "session-deleted")
    second?.close()
    first.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})
