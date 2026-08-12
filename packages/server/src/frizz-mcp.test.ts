import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveFrizzMcp } from "./dispatch.ts"
import { FRIZZ_MCP } from "./backend/types.ts"

// Drives the REAL cc-worker/bin/frizz-mcp.mjs over its real stdio JSON-RPC transport (no mocks, no
// re-implementation of the protocol) and — for the tool call — against a REAL http server standing in
// for frizz's /rpc/dispatch. This is what proves the unified server actually answers as `frizz` with a
// `spawn_thread` tool, i.e. that a worker sees `mcp__frizz__spawn_thread`.

interface Rpc {
  send(msg: unknown): void
  next(id: number): Promise<any>
  kill(): void
}

// `cwd` matters: with no FRIZZ_PROJECT_ID the shim derives its project by walking UP for `.frizz/.id`,
// so a child left in this repo would address frizz's own project. Default it to an empty temp dir —
// "a worker with no stamp and no project in its tree" — and let a test that wants the walk-up ask for it.
function startServer(env: Record<string, string>, cwd = mkdtempSync(join(tmpdir(), "frizz-mcp-cwd-"))): Rpc {
  const descriptor = resolveFrizzMcp("/unused")
  assert.ok(descriptor, "the packaged frizz MCP script must be resolvable")
  const child = spawn(process.execPath, [descriptor.scriptPath], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: { ...process.env, ...env },
  })
  const pending = new Map<number, (value: any) => void>()
  let buf = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  return {
    send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
    next: (id) => new Promise((resolve) => pending.set(id, resolve)),
    kill: () => child.kill(),
  }
}

test("the frizz MCP server identifies as `frizz` and exposes its worker tools", async () => {
  const rpc = startServer({ FRIZZ_STATE_DIR: mkdtempSync(join(tmpdir(), "frizz-mcp-")) })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    const init = await rpc.next(1)
    // The mounted server NAME (dispatch.ts) is what forms the tool id the worker sees; serverInfo must
    // agree with it, or the two halves of `mcp__frizz__spawn_thread` drift apart.
    assert.equal(init.result.serverInfo.name, FRIZZ_MCP.name)

    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const list = await rpc.next(2)
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["spawn_thread", "recurring_prompt", "timer", "watch"])
    for (const required of ["prompt", "model", "effort"]) {
      assert.ok(list.result.tools[0].inputSchema.required.includes(required))
    }
    // `recurring_prompt` requires only `action` — `prompt` and a valid `every_seconds` are required for
    // `start` alone, enforced in the handler so a lenient client cannot skip them either (asserted
    // below). It exposes NO THREAD parameter: the slug comes from the server's env, never from the
    // model, which is what stops one thread arming a loop on another.
    assert.deepEqual(list.result.tools[1].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[1].inputSchema.properties).sort(),
      ["action", "heartbeat_seconds", "pause_on_questions", "post_compaction", "prompt", "stop_hook"],
    )
    // The READ action is part of the advertised surface, not just the handler — a worker only reaches for
    // what `tools/list` shows it, and writing blind is what having no read at all produced.
    assert.deepEqual(list.result.tools[1].inputSchema.properties.action.enum, ["start", "stop", "get"])
    // `timer` is the same shape of tool and takes the same care: `action` alone is required, everything
    // else depends on which action, and it too exposes NO THREAD parameter.
    assert.deepEqual(list.result.tools[2].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[2].inputSchema.properties).sort(),
      ["action", "at", "id", "in_seconds", "prompt"],
    )
    // `watch` is the registry the ```awaiting fence could not be: `action` alone is required, and like
    // its siblings it exposes NO THREAD parameter — a worker may only ever register a wait on its own.
    assert.deepEqual(list.result.tools[3].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[3].inputSchema.properties).sort(),
      ["action", "id", "kind", "target"],
    )
    assert.deepEqual(list.result.tools[3].inputSchema.properties.action.enum, ["add", "list", "drop"])
    // Only the kind frizz can actually WAKE is offered. `pr`/`ci` rows are valid in the registry and
    // land with the poller migration; advertising them now would accept a wait nothing honours.
    assert.deepEqual(list.result.tools[3].inputSchema.properties.kind.enum, ["shell"])

    // An unregistered name is a protocol error, not a crash — the registry routes by name now.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_frizz_thread", arguments: {} } })
    const gone = await rpc.next(3)
    assert.match(gone.error.message, /unknown tool: spawn_frizz_thread/)
  } finally {
    rpc.kill()
  }
})

test("`spawn_thread` POSTs the real dispatch RPC and returns the thread's drawer link", async () => {
  const seen: Array<{ url: string; body: unknown }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high", title: "Child" } },
    })
    const call = await rpc.next(2)
    assert.equal(call.result.isError, undefined)
    assert.match(call.result.content[0].text, /\[Child\]\(\/thread\/spawned-child\)/)
    assert.deepEqual(seen, [{ url: "/_frizz/rpc/dispatch", body: { prompt: "do the thing", model: "opus", effort: "high", title: "Child" } }])

    // model/effort stay REQUIRED server-side, not only in the schema — a lenient client must not be
    // able to skip the deliberate choice.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_thread", arguments: { prompt: "x" } } })
    const bad = await rpc.next(3)
    assert.equal(bad.result.isError, true)
    assert.match(bad.result.content[0].text, /`spawn_thread` failed: `model` is required/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// ONE frizz serves every project on the machine, and it publishes exactly ONE `server.lock` — the
// LAUNCHING project's. A worker in any other open project therefore has to be told two things it
// cannot derive: where that lock is, and which project it is acting for. Get the first wrong and every
// frizz tool dies on ENOENT (the observed break: nub, boron and pullfrog-app workers all reported
// "could not read the frizz server lock … ENOENT", and zod, which still had a stale lock from its own
// pre-singleton server, reported "dispatch request failed" against a dead port). Get the SECOND wrong
// and it is worse than an error: an unprefixed `/_frizz/rpc/dispatch` is the LAUNCHING project by
// definition, so the worker silently spawns its thread onto somebody else's board.
test("the tools address the CALLING project's RPC, at the lock the singleton actually publishes", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  // The lock lives in the LAUNCHER's state dir; this worker's own project dir has none, exactly as on
  // a real machine — so a run that still resolved the lock from FRIZZ_STATE_DIR fails here.
  const launcherStateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-launcher-"))
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-tenant-"))
  writeFileSync(join(launcherStateDir, "server.lock"), JSON.stringify({ port }))
  const projectId = "b47f4055-4262-432a-af18-ded4cbfb3071"
  const rpc = startServer({
    FRIZZ_STATE_DIR: stateDir,
    FRIZZ_SERVER_LOCK: join(launcherStateDir, "server.lock"),
    FRIZZ_PROJECT_ID: projectId,
    FRIZZ_THREAD_SLUG: "owning-thread",
  })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "spawn_thread", arguments: { prompt: "do the thing", model: "opus", effort: "high" } },
    })
    assert.equal((await rpc.next(2)).result.isError, undefined)
    // Every tool travels the same transport, so the prefix has to be on the shared path and not only
    // on spawn's: a timer armed on the launcher's board would fire into a thread that is not ours.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(3)).result.isError, undefined)
    assert.deepEqual(seen, [`/_frizz/${projectId}/rpc/dispatch`, `/_frizz/${projectId}/rpc/listOwnThreadTimers`])
  } finally {
    rpc.kill()
    http.close()
  }
})

// AN UPDATE MUST REACH A WORKER THAT IS ALREADY RUNNING.
//
// This process lives in a DETACHED daemon that outlives frizz, so anything frozen into its env at spawn
// is stale the moment "Update & Restart" moves the port — and a worker whose only address was stale lost
// every frizz tool it had, with no way back short of restarting the worker. Both facts are therefore
// re-resolved from the filesystem on EVERY call: the address from the machine-wide lock, and the project
// from the tree the worker is standing in. Neither can be frozen, and neither can be named by the model.
test("a stale address heals itself: the machine lock wins when the stamped one is dead", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port

  // The frizz root, laid out as on a real machine: `<root>/server.lock` beside `<root>/projects/<id>/`.
  const root = mkdtempSync(join(tmpdir(), "frizz-mcp-root-"))
  const stateDir = join(root, "projects", "11111111-1111-4111-8111-111111111111")
  mkdirSync(stateDir, { recursive: true })
  // What the server stamped at spawn, now pointing at a DEAD process on a port nothing serves — exactly
  // the shape zod's lock had (pid 76070, gone since Aug 1), which reported only "fetch failed".
  const stale = join(root, "projects", "22222222-2222-4222-8222-222222222222")
  mkdirSync(stale, { recursive: true })
  writeFileSync(join(stale, "server.lock"), JSON.stringify({ pid: 999_999, port: port + 1 }))
  // The machine address, republished by the restart that moved the port.
  writeFileSync(join(root, "server.lock"), JSON.stringify({ pid: process.pid, port }))

  const rpc = startServer({
    FRIZZ_STATE_DIR: stateDir,
    FRIZZ_SERVER_LOCK: join(stale, "server.lock"),
    FRIZZ_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
    FRIZZ_THREAD_SLUG: "owning-thread",
  })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(2)).result.isError, undefined, "a dead stamped lock must not be fatal")
    assert.deepEqual(seen, ["/_frizz/11111111-1111-4111-8111-111111111111/rpc/listOwnThreadTimers"])
  } finally {
    rpc.kill()
    http.close()
  }
})

test("with no stamp at all, the project is the one the worker is STANDING IN", async () => {
  const seen: string[] = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push(req.url ?? "")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { slug: "spawned-child" } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ pid: process.pid, port }))
  // A checkout with frizz's own identity file, and the worker two directories down inside it.
  const repo = mkdtempSync(join(tmpdir(), "frizz-mcp-repo-"))
  mkdirSync(join(repo, ".frizz"), { recursive: true })
  writeFileSync(join(repo, ".frizz", ".id"), "33333333-3333-4333-8333-333333333333\n")
  const deep = join(repo, "packages", "server")
  mkdirSync(deep, { recursive: true })

  // No FRIZZ_PROJECT_ID: this is a worker spawned by a server that predates the stamp.
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" }, deep)
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    assert.equal((await rpc.next(2)).result.isError, undefined)
    assert.deepEqual(seen, ["/_frizz/33333333-3333-4333-8333-333333333333/rpc/listOwnThreadTimers"],
      "the id walked up from cwd, not the launching project")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The stop-hook tool's whole reason to exist is that it acts on the CALLING thread, which it can only
// learn from its env — so what this pins is the slug actually reaching the RPC body, over the real
// stdio transport against a real HTTP server. A tool that armed a hook on the wrong thread (or on none)
// would look identical to the worker, and would make some OTHER thread loop forever.
test("`recurring_prompt` arms and disarms the CALLING thread, identified from its env", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "keep the migration moving" } },
    })
    const armed = await rpc.next(2)
    assert.equal(armed.result.isError, undefined)
    // NAMING NO TRIGGER defaults to the rest one. A `start` with neither is a model asking to be
    // re-prompted and leaving the mechanism to us; rest is the safe reading, because it cannot talk over
    // a running turn and cannot fire on a thread that has stopped needing it.
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "keep the migration moving", stopHook: true, heartbeat: false, postCompaction: false, pauseOnQuestions: true },
    })
    // The reply must teach how it ENDS, or a worker only knows how to start one — and it must warn
    // about the sign-off rather than merely offering it, since that exit files the thread away.
    assert.match(armed.result.content[0].text, /action.{0,4}stop/)
    assert.match(armed.result.content[0].text, /```done/)
    assert.match(armed.result.content[0].text, /only when there is genuinely nothing left/)

    // BOTH triggers named on a schedule-only start, and the cadence carried through as seconds.
    rpc.send({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "check the deploy", heartbeat_seconds: 600 } },
    })
    const scheduled = await rpc.next(6)
    assert.equal(scheduled.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "check the deploy", stopHook: false, heartbeat: true, postCompaction: false, pauseOnQuestions: true, intervalSeconds: 600 },
    }, "giving a cadence and nothing else means the schedule trigger alone")
    assert.match(scheduled.result.content[0].text, /every 10 min/)

    rpc.send({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "keep going", stop_hook: true, heartbeat_seconds: 900 } },
    })
    await rpc.next(7)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "keep going", stopHook: true, heartbeat: true, postCompaction: false, pauseOnQuestions: true, intervalSeconds: 900 },
    }, "both triggers at once is the ordinary keep-this-moving case")

    // THE HOLD DEFAULTS ON (matching the footer panel), so the only interesting case is opting OUT of
    // it: a worker that genuinely wants a beat to reach it mid-question has to say so.
    rpc.send({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "beat me anyway", heartbeat_seconds: 600, pause_on_questions: false } },
    })
    await rpc.next(8)
    assert.equal((seen.at(-1) as { body: { pauseOnQuestions: boolean } }).body.pauseOnQuestions, false)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "stop" } } })
    const stopped = await rpc.next(3)
    assert.equal(stopped.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: null, stopHook: false, heartbeat: false, postCompaction: false, pauseOnQuestions: false },
    })

    // A `start` with no prompt is refused in the HANDLER, not merely by the schema.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "start" } } })
    const bare = await rpc.next(4)
    assert.equal(bare.result.isError, true)
    assert.match(bare.result.content[0].text, /`prompt` is required/)
    assert.equal(seen.length, before, "and nothing was sent to the server")

    // A bogus action likewise never reaches the RPC.
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "pause" } } })
    const bogus = await rpc.next(5)
    assert.equal(bogus.result.isError, true)
    assert.match(bogus.result.content[0].text, /`action` must be one of/)
    assert.equal(seen.length, before)
  } finally {
    rpc.kill()
    http.close()
  }
})

// The READ action. A worker that can only WRITE its recurring prompt overwrites the human's own edit
// without ever seeing it, and after a compaction cannot tell an armed thread from an unarmed one. What
// this pins is that `get` reads the row back VERBATIM (a summary of your own instruction is as blind as
// no read at all), that it mutates nothing, and that a `start` names the row it superseded.
test("`recurring_prompt` reads back what is armed, and a `start` reports what it replaced", async () => {
  const armed = {
    prompt: "the human's own words, edited in the footer",
    stopHook: true,
    heartbeat: true,
    postCompaction: false,
    intervalSeconds: 600,
    armedAt: "2026-08-06T10:00:00.000Z",
    lastRestFiredAt: "2026-08-06T11:00:00.000Z",
  }
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const url = req.url ?? ""
      seen.push({ url, body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        result: url.endsWith("/getOwnThreadRecurringPrompt")
          ? { recurringPrompt: armed }
          : { replaced: armed },
      }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "get" } } })
    const got = await rpc.next(2)
    assert.equal(got.result.isError, undefined)
    assert.deepEqual(seen.at(-1), { url: "/_frizz/rpc/getOwnThreadRecurringPrompt", body: { slug: "owning-thread" } })
    const text: string = got.result.content[0].text
    // VERBATIM, or the read is worthless — this is the text a worker would have to retype to restore.
    assert.ok(text.includes(armed.prompt), text)
    assert.match(text, /stop_hook/)
    // The SAME cadence form `start` prints — one formatter, so a worker cannot be told "every 10 min"
    // when it arms and "every 600s" when it reads back the very same number.
    assert.match(text, /every 10 min/)
    assert.match(text, /last fired 2026-08-06T11:00:00\.000Z/)
    // A trigger that is OFF must not be listed as if it were live.
    assert.doesNotMatch(text, /post_compaction/)

    // An unarmed thread reads back as an explicit "nothing", never as an empty report.
    const empty = createServer((req, res) => {
      req.resume()
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ result: { recurringPrompt: null } }))
      })
    })
    await new Promise<void>((resolve) => empty.listen(0, "127.0.0.1", resolve))
    writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (empty.address() as { port: number }).port }))
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "get" } } })
    const none = await rpc.next(3)
    assert.equal(none.result.isError, undefined)
    assert.match(none.result.content[0].text, /No recurring prompt is armed/)
    empty.close()

    // …and a `start` over an existing row hands the superseded words back, so an overwrite the worker
    // did not intend is visible in the same reply rather than silently gone.
    writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
    rpc.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "my own new text" } },
    })
    const replaced = await rpc.next(4)
    assert.equal(replaced.result.isError, undefined)
    assert.match(replaced.result.content[0].text, /IT REPLACED an existing recurring prompt/)
    assert.ok(replaced.result.content[0].text.includes(armed.prompt), replaced.result.content[0].text)
  } finally {
    rpc.kill()
    http.close()
  }
})

// A frizz server older than this tool 404s the read procedure. A bare HTTP status would read to a worker
// as "nothing is armed", which is the opposite of the truth — so the refusal has to say UNKNOWN.
test("`recurring_prompt` get says the state is UNKNOWN against a server that predates the read", async () => {
  const http = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("no procedure getOwnThreadRecurringPrompt")
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (http.address() as { port: number }).port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "get" } } })
    const stale = await rpc.next(2)
    assert.equal(stale.result.isError, true)
    assert.match(stale.result.content[0].text, /UNKNOWN/)
  } finally {
    rpc.kill()
    http.close()
  }
})

// The ONE-OFF TIMER, over the same real transport. What this pins is the CONVERSION the tool owns: a
// worker names a delay or an instant, and exactly one representation — the exact UTC instant — reaches
// the server, so the row, the delivered trailer and the tool's own reply can never name three times.
test("`timer` resolves in_seconds/at into one exact instant and POSTs the calling thread's slug", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: { id: "tmr_abc", fireAt: "2026-08-04T15:00:00.000Z", timers: [] } }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const before = Date.now()
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "timer", arguments: { action: "set", prompt: "re-check the deploy", in_seconds: 600 } },
    })
    const set = await rpc.next(2)
    assert.equal(set.result.isError, undefined)
    assert.equal(seen.at(-1)!.url, "/_frizz/rpc/setOwnThreadTimer")
    assert.equal(seen.at(-1)!.body.slug, "owning-thread")
    assert.equal(seen.at(-1)!.body.prompt, "re-check the deploy")
    const fired = Date.parse(seen.at(-1)!.body.fireAt)
    assert.ok(fired >= before + 600_000 && fired <= Date.now() + 600_000, `fireAt ${seen.at(-1)!.body.fireAt} must be ~10 min out`)
    // The reply has to carry the id (there is no other way to cancel) and say that it fires once.
    assert.match(set.result.content[0].text, /tmr_abc/)
    assert.match(set.result.content[0].text, /ONCE/)

    // An absolute instant is normalized to the same UTC form, so a worker cannot arm a row the trailer
    // and the scheduler would print differently.
    const at = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z")
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "timer", arguments: { action: "set", prompt: "x", at } } })
    await rpc.next(3)
    assert.equal(seen.at(-1)!.body.fireAt, new Date(Date.parse(at)).toISOString())

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "timer", arguments: { action: "list" } } })
    await rpc.next(4)
    assert.deepEqual(seen.at(-1), { url: "/_frizz/rpc/listOwnThreadTimers", body: { slug: "owning-thread" } })

    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "timer", arguments: { action: "cancel", id: "tmr_abc" } } })
    await rpc.next(5)
    assert.deepEqual(seen.at(-1), { url: "/_frizz/rpc/cancelOwnThreadTimer", body: { slug: "owning-thread", id: "tmr_abc" } })

    // …and an invented thread argument never reaches the server, exactly as for `recurring_prompt`.
    rpc.send({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "timer", arguments: { action: "list", slug: "someone-else", thread: "someone-else" } },
    })
    await rpc.next(6)
    assert.deepEqual(seen.at(-1)!.body, { slug: "owning-thread" })
  } finally {
    rpc.kill()
    http.close()
  }
})

// Every one of these is refused in the HANDLER, before any HTTP call — the same bar the cadence gets,
// and for the same reason: a lenient client must not be able to slip a nonsense alarm past the schema.
test("`timer` refuses a bad delay, a missing/doubled instant and a missing id without contacting the server", async () => {
  const seen: unknown[] = []
  const http = createServer((_req, res) => {
    seen.push(1)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: null }))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    const refused = async (id: number, args: Record<string, unknown>, pattern: RegExp) => {
      rpc.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "timer", arguments: args } })
      const reply = await rpc.next(id)
      assert.equal(reply.result.isError, true, JSON.stringify(args))
      assert.match(reply.result.content[0].text, pattern)
    }

    await refused(2, { action: "set", prompt: "x", in_seconds: 3 }, /must be between 10 and 2592000/)
    await refused(3, { action: "set", prompt: "x", in_seconds: 99_999_999 }, /must be between 10 and 2592000/)
    await refused(4, { action: "set", prompt: "x" }, /give either `in_seconds`/)
    await refused(5, { action: "set", prompt: "x", in_seconds: 60, at: "2026-08-04T15:00:00Z" }, /not both/)
    await refused(6, { action: "set", in_seconds: 60 }, /`prompt` is required/)
    await refused(7, { action: "set", prompt: "x", at: "2020-01-01T00:00:00Z" }, /at least 10s in the future/)
    await refused(8, { action: "set", prompt: "x", at: "next tuesday" }, /must be an ISO-8601 instant/)
    await refused(9, { action: "cancel" }, /`id` is required/)
    await refused(10, { action: "snooze" }, /`action` must be one of/)

    assert.equal(seen.length, 0, "none of them reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// A model can choose the TEXT of a recurring prompt but never the THREAD. The tool takes no thread parameter,
// so the only way it could act on someone else's is if a supplied argument leaked into the body.
test("`recurring_prompt` ignores any thread the caller tries to name — the slug comes from the env alone", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "p", slug: "someone-else", thread: "someone-else" } },
    })
    await rpc.next(2)
    assert.equal(seen.at(-1)!.body.slug, "owning-thread", "an invented slug argument must not reach the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// Without a slug the tool must FAIL rather than guess — arming one on the wrong thread is worse than
// not arming one, and a silent no-op would read to the worker as success.
test("`recurring_prompt` refuses to act when its thread identity was never stamped into its env", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: 1 }))
  // FRIZZ_THREAD is the documented fallback, so both vars have to be absent for this to hold.
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "", FRIZZ_THREAD: "" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "stop" } } })
    const failed = await rpc.next(2)
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /not told which thread it belongs to/)
  } finally {
    rpc.kill()
  }
})

// The CADENCE's own validation contract. The arm/disarm test above covers the trigger combinations;
// this one covers the number, because a schedule out of range is the input a model is most likely to
// invent — and it must be refused in the HANDLER, never merely by the schema, so a lenient client
// cannot slip one past.
test("`recurring_prompt` refuses a cadence out of range without contacting the server", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "owning-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "x", heartbeat_seconds: 5 } },
    })
    const tooFast = await rpc.next(2)
    assert.equal(tooFast.result.isError, true)
    assert.match(tooFast.result.content[0].text, /must be between 60 and 86400/)

    rpc.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "x", heartbeat_seconds: 99999 } },
    })
    const tooSlow = await rpc.next(3)
    assert.equal(tooSlow.result.isError, true)
    assert.match(tooSlow.result.content[0].text, /must be between 60 and 86400/)

    // Explicitly switching BOTH triggers off on a `start` is not an arming at all — it is a request to
    // be re-prompted by nothing. Refused, rather than silently writing a row that can never fire.
    rpc.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "x", stop_hook: false } },
    })
    const noTrigger = await rpc.next(4)
    assert.equal(noTrigger.result.isError, true)
    assert.match(noTrigger.result.content[0].text, /at least one is required/)

    assert.equal(seen.length, 0, "none of the three reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})

// The WATCHER REGISTRY over the real stdio transport. What matters here is the same thing the recurring
// prompt's test pins — the CALLING thread's slug reaching the RPC body from the env, never from the
// model — plus the two refusals that keep an unusable registration from ever being made, because a
// watcher that cannot fire is worse than no watcher: the worker rests believing it is covered.
test("`watch` registers, lists and drops against the CALLING thread", async () => {
  const seen: Array<{ url: string; body: any }> = []
  const replies: any[] = [
    { id: "wch_abc123", alreadyArmed: false, watches: [{ id: "wch_abc123", kind: "shell", target: "nub run test", state: "armed", createdAt: "2026-08-12T00:00:00.000Z" }] },
    { watches: [{ id: "wch_abc123", kind: "shell", target: "nub run test", state: "armed", createdAt: "2026-08-12T00:00:00.000Z" }] },
    { dropped: true, watches: [] },
  ]
  const http = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body || "{}") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: replies.shift() ?? null }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  const stateDir = mkdtempSync(join(tmpdir(), "frizz-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRIZZ_STATE_DIR: stateDir, FRIZZ_THREAD_SLUG: "watching-thread" })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    await rpc.next(1)

    rpc.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "watch", arguments: { action: "add", kind: "shell", target: "nub run test" } },
    })
    const added = await rpc.next(2)
    assert.equal(added.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/addOwnThreadWatch",
      body: { slug: "watching-thread", kind: "shell", target: "nub run test" },
    })
    // The reply must carry the id (there is nothing to drop without it), say that the registration is
    // DURABLE (that is the whole reason to prefer it over blocking), and push dropping it.
    assert.match(added.result.content[0].text, /wch_abc123/)
    assert.match(added.result.content[0].text, /survives your turn ending, a compaction and a frizz restart/)
    assert.match(added.result.content[0].text, /DROP IT when it stops mattering/)

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "watch", arguments: { action: "list" } } })
    const listed = await rpc.next(3)
    assert.equal(seen.at(-1)?.url, "/_frizz/rpc/listOwnThreadWatches")
    assert.match(listed.result.content[0].text, /wch_abc123\s+shell\s+nub run test/)

    rpc.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "watch", arguments: { action: "drop", id: "wch_abc123" } } })
    const dropped = await rpc.next(4)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/dropOwnThreadWatch",
      body: { slug: "watching-thread", id: "wch_abc123" },
    })
    assert.match(dropped.result.content[0].text, /Nothing is armed on this thread now/)

    // Both refusals happen in the TOOL, before any RPC: an add with no target, and a drop with no id.
    const before = seen.length
    rpc.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "watch", arguments: { action: "add", kind: "shell" } } })
    const noTarget = await rpc.next(5)
    assert.equal(noTarget.result.isError, true)
    assert.match(noTarget.result.content[0].text, /background shells/)

    // A pr watcher is REFUSED with the thing that does work, rather than silently stored.
    rpc.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "watch", arguments: { action: "add", kind: "pr", target: "acme/app#391" } } })
    const noPr = await rpc.next(7)
    assert.equal(noPr.result.isError, true)
    assert.match(noPr.result.content[0].text, /pr-watch: owner\/repo#123/)

    rpc.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "watch", arguments: { action: "drop" } } })
    const noId = await rpc.next(6)
    assert.equal(noId.result.isError, true)
    assert.match(noId.result.content[0].text, /`id` is required/)
    assert.equal(seen.length, before, "neither refusal reached the server")
  } finally {
    rpc.kill()
    http.close()
  }
})
