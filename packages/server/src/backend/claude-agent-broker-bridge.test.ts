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
import Database from "better-sqlite3"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

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
    // The IDs must be the fray web's canonical permission verbs, else the approval buttons don't render.
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
    assert.notEqual(second.generation, first.generation, "a new generation is what tells fray the runtime was swapped")
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

// ---- Remote Control: making a fray thread reachable from claude.ai/code and the Claude mobile app ---
// The whole point is that an SDK session never registers on its own — Claude Code auto-starts that
// bridge only from its interactive REPL — so a thread dispatched from the dashboard was unreachable
// from a phone no matter how the operator's own Claude settings read. This proves fray asks (naming
// the session after the thread), that the daemon's answer reaches the bridge, that a RECONNECT
// re-learns it from the hello rather than losing it with the socket, and that the request is not made
// at all when the setting is off.
test("a session registers for remote control, names itself after the thread, and survives a reconnect", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-rc-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const urls: Array<{ slug: string; sessionId: string; url: string }> = []
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    remoteControlEnabled: () => true,
    onRemoteControl: (slug, sessionId, url) => urls.push({ slug, sessionId, url }),
  })
  const sessionId = randomUUID()
  const slug = "reachable-thread"
  const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  const captured = () => {
    try {
      return readFileSync(join(dir, "capture.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; enabled?: boolean; name?: string })
    } catch { return [] }
  }
  const waitFor = async (cond: () => boolean, ms = 10_000) => { const d = Date.now() + ms; while (!cond()) { if (Date.now() > d) throw new Error("timeout"); await sleep(50) } }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the work", permissionMode: "default" })
    await waitFor(() => urls.length > 0)
    assert.deepEqual(urls[0], { slug, sessionId, url: "https://claude.ai/code/session_01FAKEfakeFAKEfake" })
    const request = captured().find((row) => row.kind === "remote-control")
    assert.equal(request?.enabled, true, "fray asks for remote control ON")
    assert.equal(request?.name, `fray · ${slug}`, "the claude.ai session list names the fray thread")

    // A fray restart is a RECONNECT to the same live daemon: the URL must come back on the hello,
    // because otherwise the thread's only route to a phone dies with the socket that carried it.
    const before = recordOf()
    bridge.close()
    const rejoined: string[] = []
    const second = createClaudeAgentBrokerBridge({
      stateDir: dir, executablePath: exe,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      remoteControlEnabled: () => true,
      onRemoteControl: (_slug, _sessionId, url) => rejoined.push(url),
      ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
    })
    try {
      await second.warmUp()
      await waitFor(() => rejoined.length > 0)
      assert.deepEqual(rejoined, ["https://claude.ai/code/session_01FAKEfakeFAKEfake"])
      assert.equal(recordOf()?.daemonPid, before?.daemonPid, "…and it rejoined the SAME daemon rather than forking one")
      // Asked exactly once: the daemon registered at startup, and a reattach must not re-register.
      assert.equal(captured().filter((row) => row.kind === "remote-control").length, 1)
    } finally {
      second.releaseSession(slug, sessionId, "session-deleted")
      second.close()
    }
  } finally {
    try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

test("with remote control off, the session is never registered with claude.ai at all", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-rc-off-"))
  const exe = join(dir, "fake-claude--basic.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  let announced = 0
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    remoteControlEnabled: () => false,
    onRemoteControl: () => { announced++ },
  })
  const sessionId = randomUUID()
  const slug = "local-only-thread"
  const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the work", permissionMode: "default" })
    // Give the daemon the same window the enabled case needed to register in.
    await sleep(2_000)
    const rows = readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string })
    assert.ok(rows.some((row) => row.kind === "startup"), "the session really did start")
    assert.equal(rows.filter((row) => row.kind === "remote-control").length, 0, "no registration request reaches claude.ai")
    assert.equal(announced, 0)
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// A provider that REFUSES (API-key auth, a long-lived token, an org policy with `disableRemoteControl`)
// is the case where this feature could do real damage: registration is a network round-trip fray asks
// for on every dispatch, so a refusal that took the session down with it would break threads for
// exactly the operators who cannot use Remote Control anyway. The thread must run normally and the
// reason must reach the operator's diagnostics rather than vanishing.
test("a refused registration leaves the thread running and reports why", { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-rc-refused-"))
  const exe = join(dir, "fake-claude--remote-control-refused.mjs")
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  let results = 0
  let announced = 0
  const diagnostics: string[] = []
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    remoteControlEnabled: () => true,
    onRemoteControl: () => { announced++ },
    onEvent: (_slug: string, _sid: string, ev: ClaudeQueryEvent) => { if (ev.kind === "result") results++ },
    onDiagnostic: (_slug: string, _sid: string, d) => { if (d.kind === "stderr") diagnostics.push(d.message) },
  })
  const sessionId = randomUUID()
  const slug = "unreachable-thread"
  const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
  const waitFor = async (cond: () => boolean, ms = 10_000) => { const d = Date.now() + ms; while (!cond()) { if (Date.now() > d) throw new Error("timeout"); await sleep(50) } }
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "start the work", permissionMode: "default" })
    await waitFor(() => results > 0)
    assert.ok(results > 0, "the turn completed — a refused registration is not a dead session")
    // Asserted against the DURABLE log, not the live relay: registration is attempted while the daemon
    // is still coming up, so whether fray is attached in time to hear the refusal is a race — the
    // daemon's own file is the guarantee, exactly as it is for every other diagnostic here.
    const logged = () => {
      try { return readFileSync(join(dir, "claude-broker", `${sessionId}.diagnostics.log`), "utf8") } catch { return "" }
    }
    await waitFor(() => /remote control unavailable/i.test(logged()))
    assert.match(
      logged(),
      /claude\.ai subscription/,
      "the provider's own reason is carried through verbatim, not replaced by a generic failure",
    )
    // Whatever the live relay did or did not catch, it must never have invented a different story.
    for (const message of diagnostics.filter((m) => /remote control/i.test(m))) {
      assert.match(message, /remote control unavailable for this session: /)
    }
    assert.equal(announced, 0, "and no URL is invented for a session that never registered")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})
