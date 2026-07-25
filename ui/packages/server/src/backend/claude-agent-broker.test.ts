// CI-runnable protocol test for the Claude session broker + its client, driven by the FAKE claude CLI
// (no real claude, no network — fast and deterministic). Proves the broker↔client typed socket
// protocol, the permission round-trip over the socket, and — the reason the broker exists —
// reconnect with a PENDING permission re-delivered to a fresh client.
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs"
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

function startBroker(scenario: string): { socketPath: string; close: () => Promise<void>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cbroker-"))
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  const socketPath = shortSocket()
  const broker = runClaudeBroker({ socketPath, cwd: dir, sessionId: randomUUID(), executablePath: exe, permissionMode: "default", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } })
  return { socketPath, close: async () => { await broker.close(); rmSync(dir, { recursive: true, force: true }) }, dir }
}

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
