import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { CHROME_DEVTOOLS_MCP, chromeDevtoolsMcpSpec, resolveBrowserMcpScript } from "./types.ts"

// The lazy browser-MCP proxy: the spec both backends render, the committed tool-schema snapshot it
// answers `tools/list` from, and the REAL script driven over its REAL stdio transport.
//
// What these do NOT prove is the upstream integration — the fixture below stands in for
// chrome-devtools-mcp so the suite stays offline and deterministic. The real server, a real headless
// Chrome and a real `evaluate_script` round trip are exercised by hand against the live thing; see the
// notes referenced from browser-mcp.mjs.

const here = dirname(fileURLToPath(import.meta.url))
const proxyPath = resolve(here, "../../../../cc-worker/bin/browser-mcp.mjs")
const snapshotPath = resolve(here, "../../../../cc-worker/bin/browser-mcp-tools.json")

test("chromeDevtoolsMcpSpec mounts the lazy proxy under an absolute node path, never npx", () => {
  const spec = chromeDevtoolsMcpSpec("/abs/plugin/bin/browser-mcp.mjs", "/abs/node")
  assert.equal(spec.command, "/abs/node")
  assert.deepEqual(spec.args, ["/abs/plugin/bin/browser-mcp.mjs", ...CHROME_DEVTOOLS_MCP.args])
  // The version pin lives in backend/types.ts alone and reaches the proxy through its env.
  assert.deepEqual(spec.env, { FRIZZ_BROWSER_MCP_PACKAGE: `${CHROME_DEVTOOLS_MCP.package}@${CHROME_DEVTOOLS_MCP.version}` })
  // Both flags are policy, not taste: never the operator's own Chrome, never a window on their screen.
  assert.ok(spec.args.includes("--headless") && spec.args.includes("--isolated"))
})

test("chromeDevtoolsMcpSpec falls back to a PINNED npx mount when the worker plugin is unresolvable", () => {
  // A worker whose plugin dir is missing is already degraded in five other ways, but it must still get
  // a browser — that invariant is why chrome-devtools is mounted unconditionally in the first place.
  const spec = chromeDevtoolsMcpSpec(undefined, "/abs/node")
  assert.equal(spec.command, "npx")
  assert.deepEqual(spec.args, ["-y", `${CHROME_DEVTOOLS_MCP.package}@${CHROME_DEVTOOLS_MCP.version}`, ...CHROME_DEVTOOLS_MCP.args])
  assert.equal(spec.env, undefined)
})

test("the proxy script resolves out of the worker plugin in a source checkout", () => {
  const resolved = resolveBrowserMcpScript()
  assert.ok(resolved, "browser-mcp.mjs must be resolvable from the checkout")
  assert.equal(resolved, proxyPath)
})

test("the committed tool-schema snapshot matches the pinned version", () => {
  // The snapshot is what lets a machine that has never run frizz answer `tools/list` instantly. If the
  // pin moves without `nub scripts/harvest-browser-mcp-tools.mjs`, every worker on that version pays a
  // live install+boot inside its client's MCP startup window instead — so the drift is a failure here.
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"))
  assert.equal(snapshot.package, CHROME_DEVTOOLS_MCP.package)
  assert.equal(snapshot.version, CHROME_DEVTOOLS_MCP.version)
  assert.ok(Array.isArray(snapshot.tools) && snapshot.tools.length > 0, "the snapshot must carry tools")
  for (const tool of snapshot.tools) {
    assert.equal(typeof tool.name, "string")
    assert.equal(typeof tool.inputSchema, "object")
  }
  assert.ok(snapshot.tools.some((t: { name: string }) => t.name === "take_screenshot"))
})

/** A stand-in upstream server: records that it was started, and answers one tool by echoing the roots. */
function fixtureServer(dir: string): { bin: string; marker: string } {
  const marker = join(dir, "started")
  const bin = join(dir, "fake-upstream.mjs")
  writeFileSync(
    bin,
    `
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(marker)}, String(Date.now()))
let roots = "none"
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "9" } } })
      // Ask the CLIENT for its roots, exactly as chrome-devtools-mcp does — a proxy that swallowed the
      // client's capabilities would never be asked, and screenshots would be confined to the temp dir.
      if (m.params?.capabilities?.roots) send({ jsonrpc: "2.0", id: "fake-roots", method: "roots/list", params: {} })
      continue
    }
    if (m.id === "fake-roots" && m.result) { roots = JSON.stringify(m.result.roots); continue }
    if (m.method === "tools/list") { send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "fake_tool", inputSchema: { type: "object" } }] } }); continue }
    if (m.method === "tools/call") {
      // Wait for the roots round trip rather than racing it: this fixture answers instantly, where the
      // real server does real work first, and the race is the FIXTURE's, not the proxy's.
      const started = Date.now()
      const timer = setInterval(() => {
        if (roots === "none" && Date.now() - started < 2000) return
        clearInterval(timer)
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "called with roots " + roots }] } })
      }, 5)
      continue
    }
  }
})
`,
    "utf8",
  )
  return { bin, marker }
}

test("the proxy answers initialize + tools/list with NOTHING spawned, and starts the server on the first tools/call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-browser-mcp-"))
  const { bin, marker } = fixtureServer(dir)
  const proxy = spawn(process.execPath, [proxyPath, "--headless", "--isolated"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...process.env,
      FRIZZ_BROWSER_MCP_HOME: join(dir, "cache"),
      FRIZZ_BROWSER_MCP_BIN: bin,
      FRIZZ_BROWSER_MCP_PACKAGE: `${CHROME_DEVTOOLS_MCP.package}@${CHROME_DEVTOOLS_MCP.version}`,
    },
  })
  const pending = new Map<number | string, (msg: any) => void>()
  let sawRootsRequest = false
  let buf = ""
  proxy.stdout.setEncoding("utf8")
  proxy.stdout.on("data", (chunk: string) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.method === "roots/list") {
        sawRootsRequest = true
        // The client answers; the proxy must route it back down to the server that asked.
        proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { roots: [{ uri: "file:///repo", name: "repo" }] } }) + "\n")
        continue
      }
      if (msg.method) continue
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  let nextId = 1
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })

  try {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: "test", version: "1" },
    })
    assert.equal(init.result.protocolVersion, "2025-06-18")
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")

    const list = await rpc("tools/list", {})
    // Served from the committed snapshot: the REAL 29 chrome-devtools tools, not the fixture's one.
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"))
    assert.equal(list.result.tools.length, snapshot.tools.length)
    assert.ok(list.result.tools.some((t: { name: string }) => t.name === "take_screenshot"))
    // THE POINT OF THE WHOLE CHANGE: a full tool registry with no upstream server behind it.
    assert.equal(existsSync(marker), false, "the upstream server must NOT be running after tools/list")

    // Claude Code opens a short-lived PROBE connection and sends `server/discover` before the real
    // session. While anything-but-a-known-method meant "start the browser", that probe alone paid a
    // full install + server boot per worker at session start, in a process the client then killed —
    // i.e. the entire saving, undone, with every other test still green. The real server answers
    // `-32601 Method not found` here (verified against 1.7.0, which advertises only logging + tools),
    // so answering it locally is what a direct connection would have done anyway.
    const probe = await rpc("server/discover", {})
    assert.equal(probe.error?.code, -32601)
    assert.equal(existsSync(marker), false, "a capability probe must NOT start the upstream server")
    for (const method of ["resources/list", "prompts/list"]) {
      const other = await rpc(method, {})
      assert.equal(other.error?.code, -32601, `${method} must answer as the real server does`)
    }
    assert.equal(existsSync(marker), false, "no capability probe may start the upstream server")

    const call = await rpc("tools/call", { name: "fake_tool", arguments: {} })
    assert.equal(existsSync(marker), true, "the first tools/call must start the upstream server")
    // The client's OWN roots reached the upstream server through the proxy's replayed handshake. This
    // is the detail that fails SILENTLY when it regresses: chrome-devtools-mcp confines file-writing
    // tools (take_screenshot) to the OS temp dir when the client declared no roots, and nothing errors.
    assert.equal(sawRootsRequest, true, "the upstream server's roots/list must reach the real client")
    assert.match(call.result.content[0].text, /file:\/\/\/repo/)
  } finally {
    proxy.stdin.end()
    proxy.kill()
  }
})
