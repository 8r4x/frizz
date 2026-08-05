// CI test for the broker bridge's PERMISSION → dashboard routing (fake claude CLI, real InteractionStore,
// a real forked daemon — no real claude, no network). Proves: a tool-permission escalation the daemon
// relays is journaled as a provider-neutral approval interaction (provider.kind "claude",
// payload.kind "permission-approval"), and the human's dashboard decision is applied back to the daemon.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"
import { describeClaudeBrokerDiagnostic } from "./claude-broker-diagnostics.ts"
import { CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX, type ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// SIGKILL reaches the DAEMON, not the claude process it forked — which keeps appending to its capture
// log for a few more milliseconds. A one-shot recursive rm loses that race intermittently (ENOTEMPTY:
// a file reappears between readdir and rmdir), so retry briefly instead of failing a green test on
// teardown noise.
async function rmEventually(dir: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

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
    // The IDs must be the frizz web's canonical permission verbs, else the approval buttons don't render.
    assert.ok(rec.allowedDecisions.some((d) => d.id === "grant-turn" && d.semantic === "approve"))
    assert.ok(rec.allowedDecisions.some((d) => d.id === "deny" && d.semantic === "deny"))
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
    await rmEventually(dir)
  }
}

test("broker routes a permission escalation to the InteractionStore and APPROVES on the human decision", { timeout: 25_000 }, async () => {
  await runCase("grant-turn", "allow")
})

test("broker routes a permission escalation and DENIES on the human decision", { timeout: 25_000 }, async () => {
  await runCase("deny", "deny")
})

// ---- freshProcess: the usage-limit latch escape hatch ----------------------------------------------
// A `claude` that has taken a usage-limit 429 refuses every later input until its reset instant, so the
// resume for that thread has to arrive in a process that never saw the 429. This proves the bridge
// actually swaps the process — same session id, new daemon, cold-resumed from the transcript — and that
// it does NOT do so on an ordinary follow-up, where the point is to keep the live context.
test("followUp: freshProcess retires the live daemon and cold-resumes; a plain follow-up keeps it", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-fresh-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  })
  const sessionId = randomUUID()
  const slug = "latched-thread"
  const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  // The fake CLI appends its argv here as it starts, so these ARE the processes that ran.
  const startups = () => {
    try {
      return readFileSync(join(dir, "capture.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; argv?: string[] })
        .filter((r) => r.kind === "startup")
    } catch { return [] }
  }
  const waitForStartups = async (n: number) => {
    const deadline = Date.now() + 10_000
    while (startups().length < n && Date.now() < deadline) await sleep(50)
    assert.equal(startups().length, n, `expected ${n} claude process(es) by now`)
  }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the work", permissionMode: "default" })
    const first = recordOf()
    assert.ok(first, "the dispatch forked a daemon")
    // Let the original process actually come up before swapping it. A latched thread has been running
    // for hours; racing the swap against its own startup would test a case that never happens, and the
    // kill lands before it records its argv, so the evidence below would be missing rather than wrong.
    await waitForStartups(1)

    // An ordinary follow-up reconnects: the operator's context is the whole point of the live session.
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "carry on" })
    assert.equal(recordOf()?.daemonPid, first.daemonPid, "a plain follow-up must never restart the process")
    assert.equal(recordOf()?.generation, first.generation)
    assert.equal(startups().length, 1, "…and it spawns no second claude")

    // The limit resume asks for a fresh one.
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "the limit reset, continue", freshProcess: true })
    const second = recordOf()
    assert.ok(second, "a replacement daemon is published")
    assert.notEqual(second.daemonPid, first.daemonPid, "freshProcess must hand the message to a NEW process, not the latched one")
    assert.notEqual(second.generation, first.generation, "a new generation is what tells frizz the runtime was swapped")
    assert.equal(second.sessionId, sessionId, "the thread keeps its identity — this is a restart, not a new thread")

    // …and it RESUMED rather than starting blank, so every turn banked before the limit comes back
    // with it. This is the difference between recovering the thread and losing it.
    await waitForStartups(2)
    const replacement = startups()[1]
    assert.ok(replacement.argv?.includes("--resume"), "the replacement cold-resumes the on-disk transcript")
    assert.ok(replacement.argv?.includes(sessionId), "…for this exact session")
    assert.ok(!startups()[0].argv?.includes("--resume"), "…where the original was a fresh start, so the two are genuinely different processes")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// THE HANDLER `context.ts` INSTALLS IS THIS ONE, so this is where a refused input has to arrive. The
// `input` frame carries no reply by design, so `deps.onDiagnostic` is the only channel by which the
// frizz server can ever learn that a message the scheduler already recorded as `delivered` was thrown
// away — and until 2026-08-05 the server's end of it discarded everything that was not a daemon crash.
// Thread `are-taking-over-an-in-flight-epic` refused every input for over two hours in total silence.
test("a refused input reaches the bridge's onDiagnostic — the server's only view of a lost message", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-drop-"))
  // `hold-inputs` never answers, so the first uuid stays outstanding and re-using it is refused — the
  // cheapest way to make the daemon's `handle.send` reject through the bridge's own public surface.
  const exe = join(dir, "fake-claude--hold-inputs.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const seen: { slug: string; message: string }[] = []
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    interactions: createInteractionStore(new Database(":memory:")), projectId: "proj-1",
    onEvent: () => {},
    onDiagnostic: (slug, _sid, d) => { if (d.kind === "stderr") seen.push({ slug, message: d.message }) },
  })
  const sessionId = randomUUID()
  const deliveryId = randomUUID()
  const slug = "drop-thread"
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the session", permissionMode: "default" })
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "this one holds the uuid", deliveryId })
    await sleep(300)
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "this one is refused", deliveryId })
    const deadline = Date.now() + 10_000
    while (!seen.some((s) => s.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX))) {
      if (Date.now() > deadline) throw new Error("the drop never reached onDiagnostic")
      await sleep(100)
    }
    const drop = seen.find((s) => s.message.startsWith(CLAUDE_INPUT_DROP_DIAGNOSTIC_PREFIX))!
    assert.equal(drop.slug, slug, "the line names the thread whose message was lost")
    assert.match(drop.message, /already outstanding/, "…and why it was refused")
    // The mapping the server applies to it is describeClaudeBrokerDiagnostic's, tested beside it.
    assert.equal(describeClaudeBrokerDiagnostic({ kind: "stderr", message: drop.message, truncated: false }), drop.message)
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})
