---
name: fray-artifact-e2e
description: End-to-end verification of a fray-ui change on a REAL PROMOTED ARTIFACT (not dev source), driven in a real browser. Use this whenever a change could behave differently in a promoted build than in the dev stack — anything touching packaging/bundling, detached daemons (codex app-server, the Claude broker), spawn/exec paths, worker-environment resolution, or "it works in `adhoc-cdp` but does it ship?" The `adhoc-cdp` skill runs `startServer({dev:true})` = SOURCE and will pass while the promoted artifact is broken. This skill launches the actual artifact. Do this before claiming a dispatch/runtime change is done.
version: 0.1.0
metadata:
  internal: true
---

# fray-artifact-e2e — verify on the promoted artifact, not the dev stack

Fray serves a PROMOTED ARTIFACT from `~/.fray/builds/<digest>/runtime/`, never the source checkout
(see the `fray-servers-run-promoted-artifacts` memory). The `adhoc-cdp` isolated stack runs
`startServer({dev:true})` — SOURCE. So a green `adhoc-cdp` proves the dev path, NOT the shipped build:
bundling, detached-daemon emission (`build-runtime.mjs` writes each `DETACHED_DAEMON_ENTRIES` file beside
`index.js`), and executable/PATH resolution all differ. A real regression class (e.g. the Claude broker's
daemon needing an ABSOLUTE claude path — a bare `"claude"` crashes it before it publishes its record, so
every dispatch times out "did not become ready") is invisible to dev-source gates and to static checks
(`node loads the file`, `the daemon publishes standalone`). Only launching the artifact + dispatching
catches it.

## The recipe

### 1. Launch a real promoted-artifact instance, isolated

`fray-dev` (= `nub … packages/cli/src/index.ts`) builds/promotes an artifact from CURRENT SOURCE and runs
it. Two gotchas:

- **You are probably running inside a fray worker**, so your env has `FRAY_DEV_CHILD=1` and `FRAY_LAUNCH_*`.
  Left set, `fray-dev` takes the CHILD path and dies `"Fray control-plane child has no live matching
  project launch owner"`. Strip them.
- Use a **throwaway git repo** as the project (isolated `~/.fray/projects/<id>`), **real HOME** (so
  Keychain claude auth works — a sandbox HOME fails `AUTH_REQUIRED:claude`), and force the feature on.

```bash
REPO=$(mktemp -d /tmp/fae-XXXX); (cd "$REPO" && git init -q . && git commit -q --allow-empty -m init)
cd "$REPO" && exec env \
  -u FRAY_DEV_CHILD -u FRAY_DEV_PORT -u FRAY_DIRECT_SUPERVISOR -u FRAY_LAUNCH_OWNER_TOKEN \
  -u FRAY_LAUNCH_PROJECT_DIR -u FRAY_LAUNCH_PROJECT_ID -u FRAY_LAUNCH_STATE_DIR -u FRAY_LAUNCH_IDENTITY_SCOPE \
  -u FRAY_LAUNCH_TMUX_SOCKET -u FRAY_LAUNCH_TMUX_SOCKET_MANAGED -u FRAY_PERM_DIR -u FRAY_SCRIPTS_DIR \
  -u FRAY_SOURCE_COMMAND -u FRAY_STABLE_ARTIFACT -u FRAY_STABLE_WEB_DIST -u FRAY_UI_THREAD -u FRAY_WORKER_PLUGIN_DIR \
  FRAY_CLAUDE_BROKER_BRIDGE=1 fray-dev
```

Run it with Bash `run_in_background: true`. First launch BUILDS the artifact (esbuild runtime + web build,
~30-90s). Wait for `requested Fray in your default browser — http://127.0.0.1:<PROXY>` (the proxy port; the
child API logs `server on http://127.0.0.1:<CHILD> (prod)` — `(prod)` confirms it's the artifact, not dev).
Drive the PROXY url.

### 2. Dispatch through the real RPC surface

Use `ui/scripts/lib/rpc-client.mjs` (never hand-rolled fetch — queries are `GET /rpc/<name>?input=`,
mutations `POST`, every response is `{result}`/`{error}`):

```js
import { createRpcClient } from ".../ui/scripts/lib/rpc-client.mjs"
const api = createRpcClient(`http://127.0.0.1:${PROXY}/`); await api.waitForHealth()
const { slug, sessionId } = await api.mutate("dispatch", { prompt: "Reply with exactly HELLO-OK then stop." })
// poll for the agent's reply — this is the real end-to-end signal, not a status field
for (let i=0;i<40;i++){ await sleep(3000)
  const tr = await api.query("threadTranscript",{slug}); if (JSON.stringify(tr).includes("HELLO-OK")) break }
```

For a worker-environment change, dispatch a prompt that uses the real surface — a `fray:haiku` sub-agent,
the fray MCP (`mcp__fray__spawn_thread`), chrome-devtools — and assert the sub-agent's marker token routes
back. A plain "write a file" proves almost nothing.

### 3. Screenshot in a real browser tab

The `chrome-devtools` MCP is the reliable path here (`scripts/shot.mjs`'s puppeteer Chrome tends to hang in
a worker env). `new_page` the proxy url → `wait_for` the thread text → `take_screenshot`. **Write the shot
under a chrome workspace root** (e.g. the fray repo dir), NOT `/tmp` (access denied); then move it to a
trusted embed root (`~/Screenshots`, the project dir, or `os.tmpdir()`) for the handoff and clean the repo.
The board only renders threads when the project has a `.fray/` dir — `mkdir -p $REPO/.fray/threads` if it's
otherwise empty.

### 4. Clean up

Kill the instance by its EXACT proxy+child PIDs (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`, never broad
`pkill`), and `rm -rf` the throwaway repo + its `~/.fray/projects/<id>`. A fray server retains its artifact
snapshot for its process lifetime, so the *in-app restart button* does NOT pick up a new build — only a
full process kill + relaunch re-promotes from current source.
