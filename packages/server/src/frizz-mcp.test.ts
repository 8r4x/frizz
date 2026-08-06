import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
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

function startServer(env: Record<string, string>): Rpc {
  const descriptor = resolveFrizzMcp("/unused")
  assert.ok(descriptor, "the packaged frizz MCP script must be resolvable")
  const child = spawn(process.execPath, [descriptor.scriptPath], {
    stdio: ["pipe", "pipe", "inherit"],
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
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["spawn_thread", "recurring_prompt", "timer"])
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
      ["action", "heartbeat_seconds", "prompt", "stop_hook"],
    )
    // `timer` is the same shape of tool and takes the same care: `action` alone is required, everything
    // else depends on which action, and it too exposes NO THREAD parameter.
    assert.deepEqual(list.result.tools[2].inputSchema.required, ["action"])
    assert.deepEqual(
      Object.keys(list.result.tools[2].inputSchema.properties).sort(),
      ["action", "at", "id", "in_seconds", "prompt"],
    )
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
      body: { slug: "owning-thread", prompt: "keep the migration moving", stopHook: true, heartbeat: false },
    })
    // The reply must teach how it ENDS, or a worker only knows how to start one — and it must warn
    // about the sentinel rather than merely offering it, since that exit is permanent.
    assert.match(armed.result.content[0].text, /action.{0,4}stop/)
    assert.match(armed.result.content[0].text, /ALLDONE/)
    assert.match(armed.result.content[0].text, /permanently stalls/)

    // BOTH triggers named on a schedule-only start, and the cadence carried through as seconds.
    rpc.send({
      jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "check the deploy", heartbeat_seconds: 600 } },
    })
    const scheduled = await rpc.next(6)
    assert.equal(scheduled.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "check the deploy", stopHook: false, heartbeat: true, intervalSeconds: 600 },
    }, "giving a cadence and nothing else means the schedule trigger alone")
    assert.match(scheduled.result.content[0].text, /every 10 min/)

    rpc.send({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "recurring_prompt", arguments: { action: "start", prompt: "keep going", stop_hook: true, heartbeat_seconds: 900 } },
    })
    await rpc.next(7)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: "keep going", stopHook: true, heartbeat: true, intervalSeconds: 900 },
    }, "both triggers at once is the ordinary keep-this-moving case")

    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recurring_prompt", arguments: { action: "stop" } } })
    const stopped = await rpc.next(3)
    assert.equal(stopped.result.isError, undefined)
    assert.deepEqual(seen.at(-1), {
      url: "/_frizz/rpc/setOwnThreadRecurringPrompt",
      body: { slug: "owning-thread", prompt: null, stopHook: false, heartbeat: false },
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
    assert.match(bogus.result.content[0].text, /`action` must be either/)
    assert.equal(seen.length, before)
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
