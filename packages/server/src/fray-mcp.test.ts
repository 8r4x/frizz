import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveFrayMcp } from "./dispatch.ts"
import { FRAY_MCP } from "./backend/types.ts"

// Drives the REAL cc-worker/bin/fray-mcp.mjs over its real stdio JSON-RPC transport (no mocks, no
// re-implementation of the protocol) and — for the tool call — against a REAL http server standing in
// for fray's /rpc/dispatch. This is what proves the unified server actually answers as `fray` with a
// `spawn_thread` tool, i.e. that a worker sees `mcp__fray__spawn_thread`.

interface Rpc {
  send(msg: unknown): void
  next(id: number): Promise<any>
  kill(): void
}

function startServer(env: Record<string, string>): Rpc {
  const descriptor = resolveFrayMcp("/unused")
  assert.ok(descriptor, "the packaged fray MCP script must be resolvable")
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

test("the fray MCP server identifies as `fray` and exposes its worker tools", async () => {
  const rpc = startServer({ FRAY_STATE_DIR: mkdtempSync(join(tmpdir(), "fray-mcp-")) })
  try {
    rpc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    const init = await rpc.next(1)
    // The mounted server NAME (dispatch.ts) is what forms the tool id the worker sees; serverInfo must
    // agree with it, or the two halves of `mcp__fray__spawn_thread` drift apart.
    assert.equal(init.result.serverInfo.name, FRAY_MCP.name)

    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const list = await rpc.next(2)
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["spawn_thread"])
    for (const required of ["prompt", "model", "effort"]) {
      assert.ok(list.result.tools[0].inputSchema.required.includes(required))
    }
    // An unregistered name is a protocol error, not a crash — the registry routes by name now.
    rpc.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spawn_fray_thread", arguments: {} } })
    const gone = await rpc.next(3)
    assert.match(gone.error.message, /unknown tool: spawn_fray_thread/)
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
  const stateDir = mkdtempSync(join(tmpdir(), "fray-mcp-"))
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  const rpc = startServer({ FRAY_STATE_DIR: stateDir })
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
    assert.deepEqual(seen, [{ url: "/rpc/dispatch", body: { prompt: "do the thing", model: "opus", effort: "high", title: "Child" } }])

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
