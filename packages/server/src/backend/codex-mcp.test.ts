import { test } from "node:test"
import assert from "node:assert/strict"
import { codexMcpConfigArgs } from "./codex-mcp.ts"
import { CHROME_DEVTOOLS_MCP, FRIZZ_MCP } from "./types.ts"

// These pin the SHAPE of the `-c` overrides. The shape is otherwise only observable by running a real
// codex app-server (see _live_codex_mcp_inject.mts), so a refactor could silently stop mounting the
// servers and every unit test would still pass while codex workers quietly lost their tools — which
// is exactly the state this module was written to fix.

/** `-c` is variadic-free here: the args are strictly alternating flag/value pairs. */
function values(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], "-c", `expected a -c flag at index ${i}, got ${args[i]}`)
    out.push(args[i + 1]!)
  }
  return out
}

test("codexMcpConfigArgs: chrome-devtools is mounted even with no frizz descriptor", () => {
  const vals = values(codexMcpConfigArgs(undefined, "/abs/node", "/abs/plugin/bin/browser-mcp.mjs"))
  const chrome = vals.find((v) => v.startsWith(`mcp_servers.${CHROME_DEVTOOLS_MCP.name}=`))
  assert.ok(chrome, "chrome-devtools override missing")
  // The runtime release gate needs a browser on any machine; this must not be conditional.
  // What is mounted is frizz's LAZY PROXY under the ABSOLUTE node path — never `npx`, whose `npm exec`
  // shim was 70 MB per worker of pure waste and whose real server started whether or not the worker
  // ever opened a page (backend/types.ts).
  assert.match(chrome, /command="\/abs\/node"/)
  assert.ok(chrome.includes(JSON.stringify("/abs/plugin/bin/browser-mcp.mjs")), "the proxy script must be argv[0]")
  assert.ok(!chrome.includes("npx"), "npx must not survive anywhere in the codex mount")
  for (const arg of CHROME_DEVTOOLS_MCP.args) assert.ok(chrome.includes(JSON.stringify(arg)), `missing ${arg}`)
  // The version pin travels in the env, so backend/types.ts stays the only place it is written down.
  assert.ok(
    chrome.includes(`FRIZZ_BROWSER_MCP_PACKAGE="${CHROME_DEVTOOLS_MCP.package}@${CHROME_DEVTOOLS_MCP.version}"`),
    "the pinned package must ride the mount env",
  )
  assert.ok(!vals.some((v) => v.startsWith(`mcp_servers.${FRIZZ_MCP.name}=`)), "frizz must not be mounted without a descriptor")
})


test("codexMcpConfigArgs: the frizz server carries an ABSOLUTE node path and its FRIZZ_STATE_DIR", () => {
  const vals = values(codexMcpConfigArgs({ scriptPath: "/abs/plugin/bin/frizz-mcp.mjs", stateDir: "/abs/state" }, "/abs/node"))
  const frizz = vals.find((v) => v.startsWith(`mcp_servers.${FRIZZ_MCP.name}=`))
  assert.ok(frizz, "frizz override missing")
  assert.match(frizz, /command="\/abs\/node"/)
  assert.match(frizz, /args=\["\/abs\/plugin\/bin\/frizz-mcp\.mjs"\]/)
  assert.match(frizz, /env=\{FRIZZ_STATE_DIR="\/abs\/state"\}/)
})

// Both backends mount the same script through the same env builder. Pinned on the CODEX side too
// because this is the half that gets forgotten: the claude path is the one anyone tests by hand, and a
// codex worker whose tools quietly address the launching project's board looks identical until its
// spawned thread turns up on the wrong card.
test("codexMcpConfigArgs: the frizz server is told where the lock is and which project it serves", () => {
  const vals = values(codexMcpConfigArgs({
    scriptPath: "/abs/plugin/bin/frizz-mcp.mjs",
    stateDir: "/abs/state",
    serverLock: "/abs/launcher/server.lock",
    projectId: "b47f4055-4262-432a-af18-ded4cbfb3071",
  }, "/abs/node"))
  const frizz = vals.find((v) => v.startsWith(`mcp_servers.${FRIZZ_MCP.name}=`))
  assert.ok(frizz, "frizz override missing")
  assert.match(frizz, /FRIZZ_SERVER_LOCK="\/abs\/launcher\/server\.lock"/)
  assert.match(frizz, /FRIZZ_PROJECT_ID="b47f4055-4262-432a-af18-ded4cbfb3071"/)
})

test("codexMcpConfigArgs: approvals are pre-answered — a headless worker cannot click a prompt", () => {
  // Without this a mounted call is CANCELLED at the moment of use ("user cancelled MCP tool call"),
  // which is strictly worse than not mounting the server at all.
  assert.ok(values(codexMcpConfigArgs(undefined)).includes('default_tools_approval_mode="approve"'))
})

test("codexMcpConfigArgs: values are TOML-quoted so a path with a space or quote cannot break parsing", () => {
  const vals = values(codexMcpConfigArgs({ scriptPath: '/has space/and"quote/frizz-mcp.mjs', stateDir: "/s" }, "/node"))
  const frizz = vals.find((v) => v.startsWith(`mcp_servers.${FRIZZ_MCP.name}=`))!
  // An unquoted/naively-quoted path would terminate the TOML string early and the whole override would
  // fail to parse — codex then starts with NO frizz server and nothing says so.
  assert.ok(frizz.includes('"/has space/and\\"quote/frizz-mcp.mjs"'), `not escaped: ${frizz}`)
})

test("codexMcpConfigArgs: every emitted value is a well-formed `key=value` override", () => {
  for (const v of values(codexMcpConfigArgs({ scriptPath: "/p/s.mjs", stateDir: "/d" }, "/node"))) {
    assert.match(v, /^[a-z_]+(\.[a-z-]+)*=/, `malformed override: ${v}`)
  }
})
