# Updating a LIVE worker — finishing option A

Written 2026-08-08, after the singleton broke every non-launching project's frizz MCP tools and the fix could not reach a single already-running worker. Maintainer, the same day: *"The whole fucking point is that my update frizz button is supposed to just update everything. The fact that there are these stateful daemons that are blocking us from properly updating is unfortunate. Is there no more complete solution here?"*

**There is, it is half-built already, and this is the other half.**

## The problem, precisely

A worker is a DETACHED daemon that outlives frizz restart after restart. Two things about it are frozen the moment it forks, and an update reaches neither:

1. **Its plugin directory** — hooks, sub-agent profiles, skills, and `bin/frizz-mcp.mjs` all come from the path it was launched against. Every one of frizz's paths is immutable and version-specific (`~/.frizz/builds/<sha>/runtime/cc-worker` in dev, `<npm package>/runtime/cc-worker` in production), so the SDK's `reloadPlugins()` — which takes no arguments and re-reads whatever path the session started with — re-reads the same bytes.
2. **Its MCP server processes** — mounted from the query's `mcpServers` option at session start. New shim code cannot reach a child process that is already running.

So an "Update & Restart" today updates the server and the artifact, and leaves every live worker running the old worker plugin indefinitely. That is not a property of daemons; it is two missing wires.

## What already exists (do not rebuild it)

`packages/server/src/stable-plugin-path.ts` — staging + one repointable symlink, with `ensureSymlink`'s four cases handled explicitly and the version directory published by atomic RENAME. Its own commit (`4857ee8`, 2026-07-31) measured the payoff: *"Repointing that link and asking a live worker to reload is measured to arm a hook the process did not start with — no restart, no lost context, no lost in-memory sub-agents."* That commit ends: **"Not yet wired into either launcher; that is the next step of option A."** It still is not — `stageStablePluginDir` has zero production callers.

`reloadPlugins()` is plumbed end to end already: `claude-agent-sdk.ts:439` → `claude-broker-client.ts` → `claude-agent-broker-bridge.ts:660` → the `reloadThreadPlugins` RPC (`router.ts:1884`). It returns the reloaded plugin/command/agent counts **and `mcpServers`**.

## The two wires

### 1. Launch every worker against the stable path

`workerPluginDir()` (`dispatch.ts:622`) is the single chokepoint — the `--plugin-dir` flag, the broker's `workerEnv.pluginDir`, and `resolveFrizzMcp`'s script path all come from it. Stage the resolved immutable directory on boot and return the stable path instead.

The one real decision is the **version identity**, which must change whenever the plugin content changes or a worker reloads and sees the same bytes:

- production → the package version;
- a promoted artifact → the build digest, which is already in the path (`~/.frizz/builds/<sha>/…`), so it needs no new plumbing;
- a DEV SOURCE checkout → neither works, because `cc-worker/` is edited constantly under a fixed `plugin.json` version. Use a content digest of the directory, or accept that dev does not hot-reload and skip staging there. **Decide this explicitly** — a silently-never-restaging dev path is exactly the failure this whole plan exists to remove.

### 2. Mount the frizz MCP through the PLUGIN, not the query

Today `claudeMcpConfig()` puts the frizz server in the query's `mcpServers`, so it is fixed for the session. The SDK supports plugin-declared MCP servers — `sdk.d.ts:4083` documents an opt-OUT flag (*"When true, the engine loads skills/hooks/agents/commands from this plugin but does NOT read its .mcp.json or manifest mcpServers"*), so the default reads them, and `reloadPlugins()` reports `mcpServers` back.

Declare it in `cc-worker/.claude-plugin` and **remove the query mount in the same change** — two servers named `frizz` would collide.

**This is only viable because of `c5784a1`.** A plugin-declared server is per-version, not per-worker, so it cannot carry `FRIZZ_PROJECT_ID` / `FRIZZ_SERVER_LOCK`. It no longer needs to: the shim discovers the server from `~/.frizz/server.lock` and its project from `.frizz/.id` walked up from its own cwd, re-resolved on every call. Both env vars are already hints rather than mechanism.

### 3. Then: reload on update

With both wires in, an update becomes *repoint the link, then ask live threads to reload*. Reload only threads that are IDLE — never mid-turn — so nothing is interrupted and the agent-completion invariant holds. A thread mid-turn picks it up at its next turn boundary.

## Verification, before this goes anywhere near the maintainer's board

Use `frizz-stack` with `--creds` (isolated, real credentials, real dispatch):

1. dispatch a real worker; confirm it HAS `mcp__frizz__*` and that a tool call succeeds;
2. edit the staged plugin to a NEW version identity and repoint the link;
3. call `reloadThreadPlugins` on that live thread;
4. confirm the tool still works AND that it is running the NEW code — put a distinguishing marker in the shim (e.g. a version string in an error or a tool response) so "it still works" cannot be confused with "it never reloaded";
5. negative control: the same sequence WITHOUT repointing must not report the new marker.

## Blast radius, and why this was not done on 2026-08-08

`workerPluginDir()` feeds every worker spawn. A staging bug takes out hooks, sub-agent profiles and the frizz tools for every thread at once. On the day this was written the maintainer's machine had ~15 live workers mid-triage-sweep, so re-plumbing it in the same session as three other worker-spawn changes was the wrong trade. It wants its own session, with the verification above run first.
