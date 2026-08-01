import { CHROME_DEVTOOLS_MCP, FRAY_MCP, type FrayMcp } from "./types.ts"

// ---- Codex MCP injection -------------------------------------------------------------------------
// The codex twin of dispatch.ts's `claudeMcpFlags`. Claude mounts fray's MCP servers via one inline
// `--mcp-config` JSON on the worker's argv; codex has no such flag, so they ride `-c` TOML overrides
// on the APP-SERVER's argv instead.
//
// WHY THE APP-SERVER'S ARGV AND NOT THE PER-THREAD CONFIG BAG. `thread/start` takes an untyped
// `config` object (it already carries `bypass_hook_trust` + `hooks`), and putting `mcp_servers` there
// is the obvious-looking move. It does not work: MCP servers are PROCESS-level, so a per-conversation
// override has nothing to attach to. Measured against codex-cli 0.146.0 by driving the real bridge —
// the model answered the literal word `NOTOOL`, its own report that the tool was not in its registry.
// The argv override does mount a callable tool, proven by an out-of-band marker file only a real
// invocation can write. Both results are reproducible via
// `packages/server/src/backend/_live_codex_mcp_inject.mts`; read its header before changing anything
// here.
//
// The app-server is PER-PROJECT (its socket key is sha256(stateDir + projectId)), so one process-level
// mount serves every codex thread in that project with the right FRAY_STATE_DIR. Note the app-server
// is long-lived: a change here only reaches NEWLY spawned ones.
//
// `default_tools_approval_mode="approve"` is not optional. Under a restrictive approval policy with no
// approval channel, a mounted MCP call is CANCELLED rather than missing — the log reads
// `mcp: <server>/<tool> started` then `(failed)` + "user cancelled MCP tool call". A headless worker
// has nobody to click that, so without this the tools mount and then fail at the moment of use, which
// is strictly worse than not mounting them.

/** TOML basic-string quoting. JSON's string grammar is a subset of TOML's for these values. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** `key={a="…",b=["…"]}` — one inline table per server, the shape `codex -c` parses. */
function inlineTable(entries: [string, string][]): string {
  return `{${entries.map(([k, v]) => `${k}=${v}`).join(",")}}`
}

function serverTable(command: string, args: readonly string[], env?: Record<string, string>): string {
  const entries: [string, string][] = [
    ["command", tomlString(command)],
    ["args", `[${args.map(tomlString).join(",")}]`],
  ]
  if (env && Object.keys(env).length > 0) {
    entries.push(["env", inlineTable(Object.entries(env).map(([k, v]) => [k, tomlString(v)]))])
  }
  return inlineTable(entries)
}

/**
 * The `-c` overrides that mount fray's MCP servers into a codex app-server.
 *
 * chrome-devtools is ALWAYS mounted (the runtime release gate needs a browser out of the box on any
 * machine — the same CHROME_DEVTOOLS_MCP spec claude uses, which is what keeps the two backends in
 * lockstep). The unified `fray` server rides along when its descriptor resolved; absent ⇒ the worker
 * simply lacks those tools, exactly as on the claude side.
 *
 * Returns a flat argv fragment: ["-c", "…", "-c", "…"]. Pure and exported so a regression cannot
 * silently stop mounting them — the shape is unit-pinned rather than only observable by running codex.
 */
export function codexMcpConfigArgs(frayMcp?: FrayMcp, nodeBin: string = process.execPath): string[] {
  const args: string[] = [
    "-c",
    `mcp_servers.${CHROME_DEVTOOLS_MCP.name}=${serverTable(CHROME_DEVTOOLS_MCP.command, CHROME_DEVTOOLS_MCP.args)}`,
  ]
  if (frayMcp) {
    // The ABSOLUTE node path, never bare "node": the app-server spawns this itself and its PATH varies
    // by launch context (a GUI-launched app, a login-shell difference). The claude side pins the same
    // thing for the same reason — a bare "node" that is not on PATH makes the server silently never
    // start, so the tool merely never appears.
    args.push(
      "-c",
      `mcp_servers.${FRAY_MCP.name}=${serverTable(nodeBin, [frayMcp.scriptPath], { FRAY_STATE_DIR: frayMcp.stateDir })}`,
    )
  }
  // Headless workers cannot answer an approval prompt, and an unapproved MCP call is cancelled at the
  // moment of use rather than never offered. See the header.
  args.push("-c", `default_tools_approval_mode=${tomlString("approve")}`)
  return args
}

/**
 * The app-server's full argv for a transport.
 *
 * ONE builder for every spawn site — the native listener, the forked daemon, and both `--stdio`
 * fallbacks. MCP servers mount PROCESS-wide (see codex-mcp.ts), so a site that forgets the overrides
 * produces an app-server whose threads silently have no tools, and nothing reports it. Keeping the
 * argv in one place is what stops the transports from drifting apart.
 */
export function codexAppServerArgv(
  transport: readonly string[],
  frayMcp?: FrayMcp,
): string[] {
  return ["app-server", ...codexMcpConfigArgs(frayMcp), ...transport]
}
