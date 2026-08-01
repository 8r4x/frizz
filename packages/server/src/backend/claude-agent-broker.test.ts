// CI-runnable protocol test for the Claude session broker + its client, driven by the FAKE claude CLI
// (no real claude, no network — fast and deterministic). Proves the broker↔client typed socket
// protocol, the permission round-trip over the socket, and — the reason the broker exists —
// reconnect with a PENDING permission re-delivered to a fresh client.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID, createHash } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import { runClaudeBroker } from "./claude-agent-broker.ts"
import { connectClaudeBroker, type ClaudeBrokerClient } from "./claude-broker-client.ts"
import type { ClaudePermissionRequest, ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))

// Short socket path (macOS unix sockets cap at ~104 bytes).
function shortSocket(): string {
  return join(tmpdir(), `cbt-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16)}.sock`)
}

interface Captured { events: ClaudeQueryEvent[]; perms: { requestId: string; request: ClaudePermissionRequest }[]; hellos: string[] }
function clientWith(socketPath: string): { client: ClaudeBrokerClient; cap: Captured; waitPerm: (ms?: number) => Promise<{ requestId: string; request: ClaudePermissionRequest }>; waitEvent: (pred: (e: ClaudeQueryEvent) => boolean, ms?: number) => Promise<ClaudeQueryEvent> } {
  const cap: Captured = { events: [], perms: [], hellos: [] }
  const permWaiters: ((v: any) => void)[] = []
  const eventWaiters: { pred: (e: ClaudeQueryEvent) => boolean; resolve: (e: ClaudeQueryEvent) => void }[] = []
  const client = connectClaudeBroker(socketPath, {
    onHello: (sid) => cap.hellos.push(sid),
    onEvent: (e) => { cap.events.push(e); for (let i = eventWaiters.length - 1; i >= 0; i--) if (eventWaiters[i].pred(e)) { eventWaiters[i].resolve(e); eventWaiters.splice(i, 1) } },
    onPermissionRequest: (requestId, request) => { const p = { requestId, request }; cap.perms.push(p); const w = permWaiters.shift(); if (w) w(p) },
  })
  return {
    client, cap,
    waitPerm: (ms = 5_000) => new Promise((res, rej) => { const p = cap.perms[0]; if (p) return res(p); const t = setTimeout(() => rej(new Error("waitPerm timeout")), ms); permWaiters.push((v) => { clearTimeout(t); res(v) }) }),
    waitEvent: (pred, ms = 5_000) => new Promise((res, rej) => { const e = cap.events.find(pred); if (e) return res(e); const t = setTimeout(() => rej(new Error("waitEvent timeout")), ms); eventWaiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e) } }) }),
  }
}

function startBroker(scenario: string, extra: Partial<Parameters<typeof runClaudeBroker>[0]> = {}): { socketPath: string; close: () => Promise<void>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cbroker-"))
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const socketPath = shortSocket()
  const broker = runClaudeBroker({ socketPath, cwd: dir, sessionId: randomUUID(), executablePath: exe, permissionMode: "default", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, ...extra })
  return { socketPath, close: async () => { await broker.close(); rmSync(dir, { recursive: true, force: true }) }, dir }
}

// The fake CLI writes one JSON record per line beside its executable; `session-title` rows are the
// `generate_session_title` control requests the broker issued.
function captureRows(dir: string): { kind: string; description?: string; persist?: boolean }[] {
  try {
    return readFileSync(join(dir, "capture.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  } catch { return [] }
}
async function waitForRows(dir: string, predicate: (rows: ReturnType<typeof captureRows>) => boolean, ms = 5_000): Promise<ReturnType<typeof captureRows>> {
  const deadline = Date.now() + ms
  for (;;) {
    const rows = captureRows(dir)
    if (predicate(rows)) return rows
    if (Date.now() > deadline) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
}

// The diagnostics log recorded a DROPPED input but never a RECEIVED one, and the drop line fires only
// when `handle.send` REJECTS. A send that never completes — an agent wedged before it drains stdin —
// left the file byte-identical to one where the frame never arrived at all, so the two were
// indistinguishable. That ambiguity is what stalled the 2026-07-31 investigation into a thread whose
// diagnostics held a single `started` line. Receipt is now recorded: ids and sizes ONLY, because the
// message text is the operator's content and must never be written to a diagnostics file.
test("the daemon records every input frame on receipt, without the message text", { timeout: 15_000 }, async () => {
  const sessionId = randomUUID()
  const logDir = mkdtempSync(join(tmpdir(), "cbroker-diag-"))
  const diagnosticLogPath = join(logDir, "diag.log")
  const b = startBroker("basic", { sessionId, diagnosticLogPath })
  const SECRET = "the Landlock people, and this text must never reach the diagnostics file"
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    const id = randomUUID()
    c.client.sendInput({ id, text: SECRET })
    await c.waitEvent((e) => e.kind === "result")

    const log = readFileSync(diagnosticLogPath, "utf8")
    const received = log.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => typeof r.diagnostic?.message === "string" && r.diagnostic.message.startsWith("input received:"))
    assert.equal(received.length, 1, "exactly one receipt line for one input frame")
    assert.match(received[0].diagnostic.message, new RegExp(`id=${id}\\b`), "the receipt names the input's id")
    assert.match(received[0].diagnostic.message, new RegExp(`chars=${SECRET.length}\\b`), "the receipt carries the size")
    assert.ok(!log.includes(SECRET), "the operator's prompt text is NEVER written to the diagnostics log")
    c.client.close()
  } finally {
    await b.close()
    rmSync(logDir, { recursive: true, force: true })
  }
})

test("broker relays a typed permission request and forwards the decision", { timeout: 15_000 }, async () => {
  const b = startBroker("permission")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const perm = await c.waitPerm()
    assert.equal(perm.request.toolName, "Bash") // the fake CLI's permission scenario requests Bash
    assert.ok(typeof perm.requestId === "string")
    c.client.answerPermission(perm.requestId, { behavior: "allow" })
    const result = await c.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result")
    c.client.close()
  } finally { await b.close() }
})

test("a pending permission is re-delivered to a client that reconnects (the broker's reason to exist)", { timeout: 15_000 }, async () => {
  const b = startBroker("permission")
  try {
    const c1 = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c1.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const perm1 = await c1.waitPerm()
    assert.ok(perm1.requestId)
    // fray "dies" mid-permission — drop the client WITHOUT answering.
    c1.client.close()
    await new Promise((r) => setTimeout(r, 300))
    // fray "restarts" — a fresh client reconnects to the SAME live broker.
    const c2 = clientWith(b.socketPath)
    const helloAgain = await new Promise<boolean>((res) => { const t = setTimeout(() => res(false), 5_000); const iv = setInterval(() => { if (c2.cap.hellos.length) { clearInterval(iv); clearTimeout(t); res(true) } }, 50) })
    assert.ok(helloAgain, "reconnected client got a hello")
    const perm2 = await c2.waitPerm()
    assert.equal(perm2.requestId, perm1.requestId, "the SAME pending permission was re-delivered")
    c2.client.answerPermission(perm2.requestId, { behavior: "allow" })
    const result = await c2.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result", "the session continued after reconnect")
    c2.client.close()
  } finally { await b.close() }
})

// ─── The session title ────────────────────────────────────────────────────────────────────────────
// Claude Code titles a session by itself on the first user message — EXCEPT on the Agent-SDK
// transport with a SessionStart hook registered, which is exactly the broker's configuration (it
// always loads the cc-worker plugin). Bisected live against 2.1.220: a plugin carrying only a no-op
// SessionStart hook produces NO `ai-title` record, the same plugin with only PreToolUse/PostToolUse/
// PermissionRequest hooks titles normally. So the broker ASKS, and the board stops falling back to a
// truncation of the raw dispatch prompt.
test("the broker asks Claude to title the session from the first dispatch prompt", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "Fix the login button on mobile" })
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    const titles = rows.filter((row) => row.kind === "session-title")
    assert.equal(titles.length, 1, "exactly one title request")
    assert.equal(titles[0].description, "Fix the login button on mobile", "titled from the dispatch prompt")
    assert.equal(titles[0].persist, true, "persisted — an unpersisted title never reaches the transcript fray reads")
    c.client.close()
  } finally { await b.close() }
})

test("a follow-up never retitles the thread", { timeout: 15_000 }, async () => {
  const b = startBroker("basic")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "first prompt" })
    await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    c.client.sendInput({ id: randomUUID(), text: "and now something completely different" })
    await new Promise((r) => setTimeout(r, 600))
    const titles = captureRows(b.dir).filter((row) => row.kind === "session-title")
    assert.equal(titles.length, 1, "still exactly one title request")
    assert.equal(titles[0].description, "first prompt")
    c.client.close()
  } finally { await b.close() }
})

test("a resumed session keeps the title its transcript already carries", { timeout: 15_000 }, async () => {
  const b = startBroker("basic", { resume: true })
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "carry on where we left off" })
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(captureRows(b.dir).filter((row) => row.kind === "session-title").length, 0, "no title request on resume")
    c.client.close()
  } finally { await b.close() }
})

test("a failed title request neither throws nor stops the turn", { timeout: 15_000 }, async () => {
  const b = startBroker("title-failure")
  try {
    const c = clientWith(b.socketPath)
    await new Promise((r) => setTimeout(r, 300))
    c.client.sendInput({ id: randomUUID(), text: "do the thing" })
    const result = await c.waitEvent((e) => e.kind === "result")
    assert.equal(result.kind, "result", "the turn completed despite the title request failing")
    // The title request is deliberately NOT awaited by the turn, so it races the result event: under
    // load the turn can complete before the fake CLI has flushed its capture row. Wait for the row
    // instead of sampling it — the assertion is that the request happened, not that it happened first.
    const rows = await waitForRows(b.dir, (r) => r.some((row) => row.kind === "session-title"))
    assert.ok(rows.some((row) => row.kind === "session-title"), "the title request was made")
    c.client.close()
  } finally { await b.close() }
})
