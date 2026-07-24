// Seam tests for the native-listener host. These do NOT need the codex binary: they stand a real
// WebSocket server on a real unix socket and drive `nativeListenCodexAppServerHost` at it, which is
// enough to pin the three things that silently break everything if regressed — the upgrade must not
// offer permessage-deflate, the newline-JSON <-> frame translation must be exact in both directions,
// and `kill()` must DETACH rather than terminate.
//
// End-to-end proof that the transport actually carries Codex lives in the artifact harnesses
// (`scripts/verify-artifact-daemon-closure.mjs` and `verify-artifact-restart-survival.mjs`, both run
// with FRAY_CODEX_NATIVE_LISTEN=1).
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { WebSocketServer, type WebSocket } from "ws"
import {
  nativeListenCodexAppServerHost,
  nativeRecordPath,
  liveNativeRecord,
} from "./codex-app-server-native.ts"

interface Fixture {
  stateDir: string
  projectId: string
  socketPath: string
  http: Server
  wss: WebSocketServer
  connections: WebSocket[]
  upgradeHeaders: Record<string, string | string[] | undefined>[]
  received: string[]
  closes: number
  cleanup: () => void
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "fray-native-host-"))
  const stateDir = join(root, "state")
  const projectId = randomUUID()
  const socketPath = join(root, "listener.sock")
  mkdirSync(join(stateDir, "codex-app-server-native"), { recursive: true })

  const http = createServer()
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false })
  const state: Pick<Fixture, "connections" | "upgradeHeaders" | "received" | "closes"> = {
    connections: [], upgradeHeaders: [], received: [], closes: 0,
  }
  wss.on("connection", (socket, request) => {
    state.connections.push(socket)
    state.upgradeHeaders.push(request.headers)
    socket.on("message", (data) => state.received.push(data.toString()))
    socket.on("close", () => { state.closes++ })
  })
  await new Promise<void>((resolve) => http.listen(socketPath, resolve))

  // Stand in for a listener this machine already started: a live pid (ours) plus a bound socket is
  // exactly what liveNativeRecord() treats as reattachable.
  writeFileSync(nativeRecordPath(stateDir, projectId), JSON.stringify({
    projectId, generation: "gen-fixture", listenerPid: process.pid, socketPath, createdAt: new Date().toISOString(),
  }))

  return {
    stateDir, projectId, socketPath, http, wss,
    get connections() { return state.connections },
    get upgradeHeaders() { return state.upgradeHeaders },
    get received() { return state.received },
    get closes() { return state.closes },
    cleanup: () => {
      for (const socket of state.connections) { try { socket.terminate() } catch {} }
      try { wss.close() } catch {}
      try { http.close() } catch {}
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    },
  } as Fixture
}

const hostOptions = (f: Fixture) => ({
  projectId: f.projectId,
  stateDir: f.stateDir,
  cwd: process.cwd(),
  codexBin: "codex-should-never-be-spawned",
  env: {},
  clientInfo: {},
  capabilities: {},
  timeoutMs: 10_000,
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

test("reattaches to an existing listener without offering permessage-deflate", async () => {
  const f = await fixture()
  try {
    const attachment = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()
    assert.equal(attachment.reattached, true, "an existing live record must be joined, not replaced")
    assert.equal(attachment.generation, "gen-fixture", "the generation identifies the PROCESS and must survive a reattach")
    // A rejoin over this transport is ALWAYS lossy: the app-server drops events while unattached, and
    // subscriptions are per-connection so this brand-new socket is subscribed to nothing yet. Claiming
    // 0 here would let the bridge take the warm path and wait forever on a `turn/completed` it was
    // never going to be sent. See PRESUMED_LOSSY_REJOIN.
    assert.ok(attachment.droppedWhileDetached > 0, "a reattach must never claim to be lossless")
    assert.equal(f.connections.length, 1)
    // The single most brittle detail in this transport: `ws` offers permessage-deflate by default and
    // codex's tungstenite rejects the ENTIRE upgrade over it ("Missing, duplicated or incorrect header
    // sec-websocket-extensions"), which is what made an earlier probe conclude the listener was broken.
    assert.equal(
      f.upgradeHeaders[0]?.["sec-websocket-extensions"],
      undefined,
      "the client must not advertise any websocket extension",
    )
    attachment.process.kill()
  } finally { f.cleanup() }
})

test("translates newline-delimited JSON to one frame per line, in both directions", async () => {
  const f = await fixture()
  try {
    const attachment = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()

    // Two messages arriving in ONE chunk must leave as TWO frames, and a partial line must be held
    // back until its newline arrives — the bridge writes whenever it likes.
    attachment.process.stdin.write('{"id":1,"method":"initialize"}\n{"method":"initialized"}\n{"id":2,')
    await settle()
    assert.deepEqual(f.received, ['{"id":1,"method":"initialize"}', '{"method":"initialized"}'])
    attachment.process.stdin.write('"method":"thread/start"}\n')
    await settle()
    assert.deepEqual(f.received[2], '{"id":2,"method":"thread/start"}')

    // Server -> client: one frame becomes one newline-terminated line on stdout.
    const lines: string[] = []
    attachment.process.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()))
    f.connections[0]?.send('{"method":"turn/completed","params":{}}')
    await settle()
    assert.deepEqual(lines, ['{"method":"turn/completed","params":{}}\n'])

    attachment.process.kill()
  } finally { f.cleanup() }
})

test("kill() detaches the attachment and leaves the listener running", async () => {
  const f = await fixture()
  try {
    const attachment = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()
    let exited = false
    attachment.process.on("exit", () => { exited = true })

    attachment.process.kill()
    await settle()

    assert.equal(f.closes, 1, "the WebSocket must be closed")
    assert.equal(exited, true, "a lost attachment surfaces to the bridge as an exit")
    // The listener is untouched — still bound, still discoverable, still reattachable. This is the
    // property the operator explicitly likes: quitting fray does not stop Codex.
    assert.ok(liveNativeRecord(f.stateDir, f.projectId), "the record must survive a detach")
    const again = await nativeListenCodexAppServerHost(hostOptions(f))
    await settle()
    assert.equal(again.reattached, true)
    assert.equal(f.connections.length, 2, "a second attachment joins the SAME listener")
    again.process.kill()
  } finally { f.cleanup() }
})
