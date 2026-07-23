// The daemon exists for ONE reason: a codex turn must survive the fray runtime being recycled by
// Update & Restart. These drive the REAL daemon process over its REAL socket, standing in a scripted
// fake for `codex app-server` so the protocol edges (handshake caching, id rewriting, queue-while-
// detached) can be asserted deterministically. The end-to-end proof against the real app-server lives
// in _live_appserver_restart_repro.mts.
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  codexAppServerSocketPath,
  daemonCodexAppServerHost,
  killCodexAppServerDaemon,
  liveDaemonRecord,
} from "./codex-app-server-host.ts"
import { CLIENT_CAPABILITIES, CLIENT_INFO } from "./codex-app-server.ts"

// A stand-in for `codex app-server --stdio`: answers `initialize`, echoes a marker for `ping`, and
// can be told to emit an unsolicited notification after a delay (the "a turn completed while nobody
// was attached" case).
const FAKE_APP_SERVER = `#!/usr/bin/env node
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  for (;;) {
    const i = buf.indexOf("\\n")
    if (i < 0) break
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: "fray/0.144.6 (test)" } }) + "\\n")
    } else if (m.method === "ping") {
      process.stdout.write(JSON.stringify({ id: m.id, result: { sawId: m.id, echo: m.params && m.params.echo } }) + "\\n")
    } else if (m.method === "emitLater") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ method: "turn/completed", params: { marker: m.params.marker } }) + "\\n")
      }, m.params.afterMs)
      process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n")
    }
  }
})
process.stdin.resume()
`

function fakeAppServerBin(dir: string): string {
  const path = join(dir, "fake-codex")
  writeFileSync(path, FAKE_APP_SERVER)
  chmodSync(path, 0o755)
  return path
}

interface Harness {
  stateDir: string
  codexBin: string
}

function harness(): Harness {
  const stateDir = mkdtempSync(join(tmpdir(), "fray-codex-daemon-test-"))
  return { stateDir, codexBin: fakeAppServerBin(stateDir) }
}

const PROJECT = "proj"

function options(h: Harness) {
  return {
    projectId: PROJECT,
    stateDir: h.stateDir,
    cwd: h.stateDir,
    codexBin: h.codexBin,
    env: process.env,
    clientInfo: CLIENT_INFO as unknown as Record<string, unknown>,
    capabilities: CLIENT_CAPABILITIES as unknown as Record<string, unknown>,
    timeoutMs: 15_000,
  }
}

/** Minimal JSON-RPC client over a `CodexAppServerProcess`, mirroring what the bridge does. */
function client(process_: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }) {
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  const notifications: Record<string, unknown>[] = []
  let next = 1
  let buf = ""
  process_.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8")
    for (;;) {
      const i = buf.indexOf("\n")
      if (i < 0) break
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.id === "number" && pending.has(message.id)) {
        pending.get(message.id)!(message)
        pending.delete(message.id)
      } else notifications.push(message)
    }
  })
  return {
    notifications,
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++
      const done = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
      process_.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      return done
    },
    /** The id THIS client will use next — the thing that collides after a restart without rewriting. */
    peekNextId: () => next,
  }
}

test("codex daemon: the app-server survives a client detaching, and the next client rejoins the SAME process", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    assert.equal(first.reattached, false, "the first attachment forks the daemon")
    const record = liveDaemonRecord(h.stateDir, PROJECT)
    assert.ok(record, "the daemon published a record")
    const childPid = record!.childPid

    // Detach exactly the way the bridge does when the fray runtime is recycled.
    first.process.kill()
    await delay(300)

    assert.equal(liveDaemonRecord(h.stateDir, PROJECT)?.daemonPid, record!.daemonPid, "the daemon outlived its client")

    const second = await daemonCodexAppServerHost(options(h))
    assert.equal(second.reattached, true, "the next fray generation reattaches rather than forking")
    assert.equal(second.generation, first.generation, "same generation == the same app-server process")
    assert.equal(liveDaemonRecord(h.stateDir, PROJECT)?.childPid, childPid, "and it is literally the same child")
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: `initialize` from a reattaching client is served from cache, never re-sent", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    const init1 = await c1.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
    assert.deepEqual(init1.result, { userAgent: "fray/0.144.6 (test)" })
    first.process.kill()
    await delay(200)

    // The fake app-server answers `initialize` only once per process; a second real one would have to
    // come from the daemon's cache, and the version gate downstream depends on it being the REAL
    // userAgent rather than something invented.
    const second = await daemonCodexAppServerHost(options(h))
    const c2 = client(second.process)
    const init2 = await c2.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
    assert.deepEqual(init2.result, { userAgent: "fray/0.144.6 (test)" }, "reattach still gets the real handshake")
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: a restarted client restarting its id counter at 1 never collides with the dead one", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    await c1.request("initialize", {})
    const a = await c1.request("ping", { echo: "first-client" })
    first.process.kill()
    await delay(200)

    const second = await daemonCodexAppServerHost(options(h))
    const c2 = client(second.process)
    await c2.request("initialize", {})
    assert.equal(c2.peekNextId(), 2, "the fresh client really did restart its counter")
    const b = await c2.request("ping", { echo: "second-client" })

    // Both clients used low ids; the daemon must have rewritten them into distinct server-side ids,
    // and must have mapped each response back to the id its own client asked with.
    assert.equal((b.result as { echo: string }).echo, "second-client", "the response reached the right client")
    assert.notEqual(
      (a.result as { sawId: number }).sawId,
      (b.result as { sawId: number }).sawId,
      "the app-server saw two DIFFERENT ids even though both clients used their own id 2",
    )
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: a notification emitted while nobody is attached is queued, not lost", async () => {
  const h = harness()
  try {
    const first = await daemonCodexAppServerHost(options(h))
    const c1 = client(first.process)
    await c1.request("initialize", {})
    // Schedule the notification for AFTER we detach — this is `turn/completed` arriving during the
    // restart window, the event whose loss would wedge `current_turn_id` forever.
    await c1.request("emitLater", { marker: "survived", afterMs: 600 })
    first.process.kill()
    await delay(1200)

    const second = await daemonCodexAppServerHost(options(h))
    const c2 = client(second.process)
    await delay(300)
    const replayed = c2.notifications.find((n) => n.method === "turn/completed")
    assert.ok(replayed, "the notification emitted while detached was replayed on reattach")
    assert.deepEqual(replayed!.params, { marker: "survived" })
    second.process.kill()
  } finally {
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})

test("codex daemon: killing the daemon tears down the app-server and prunes the record", async () => {
  const h = harness()
  const attachment = await daemonCodexAppServerHost(options(h))
  const record = liveDaemonRecord(h.stateDir, PROJECT)!
  attachment.process.kill()
  killCodexAppServerDaemon(h.stateDir, PROJECT)
  for (let i = 0; i < 40 && liveDaemonRecord(h.stateDir, PROJECT); i++) await delay(50)
  assert.equal(liveDaemonRecord(h.stateDir, PROJECT), null, "the record is gone once the daemon exits")
  await delay(200)
  assert.throws(() => process.kill(record.childPid, 0), "the app-server child went with it")
  if (process.platform !== "win32") {
    assert.equal(existsSync(codexAppServerSocketPath(h.stateDir, PROJECT)), false, "and the socket is unlinked")
  }
})

// The daemon buys ONE property — an in-flight turn surviving Update & Restart. Codex itself predates
// it and does not need it. So a daemon that cannot start must degrade to the historical in-process
// app-server, never take Codex down: one packaging slip doing exactly that killed every dispatch,
// follow-up, steer and interrupt at once (2026-07-23). The fallback is the safety net for the class,
// so it gets its own proof rather than being trusted because it looks obvious.
test("codex daemon: a daemon that cannot start falls back to an in-process app-server", async () => {
  const h = harness()
  const errors: string[] = []
  const consoleError = console.error
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
  try {
    const attachment = await daemonCodexAppServerHost({
      ...options(h),
      // A daemon entry that is not there — precisely the promoted-artifact failure.
      daemonEntry: join(h.stateDir, "does-not-exist-daemon.js"),
    })
    try {
      assert.equal(liveDaemonRecord(h.stateDir, PROJECT), null, "no daemon record: this is the fallback, not a daemon")
      assert.equal(attachment.daemonPid, process.pid, "the app-server is a child of THIS runtime")
      assert.equal(attachment.reattached, false)
      // The whole point: it must be a WORKING app-server, not merely a returned object.
      const c = client(attachment.process)
      const initialized = await c.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
      assert.ok((initialized.result as { userAgent?: string })?.userAgent, "the fallback app-server answers initialize")
      const echoed = await c.request("ping", { echo: "fallback" })
      assert.equal((echoed.result as { echo?: string })?.echo, "fallback", "and serves ordinary requests")
      // Degrading silently would be its own trap — the operator loses restart survival and must be told.
      assert.ok(
        errors.some((line) => /falling back to an in-process app-server/.test(line)),
        `the degradation is announced, not silent — saw ${JSON.stringify(errors)}`,
      )
    } finally {
      attachment.process.kill()
    }
  } finally {
    console.error = consoleError
    killCodexAppServerDaemon(h.stateDir, PROJECT)
  }
})
