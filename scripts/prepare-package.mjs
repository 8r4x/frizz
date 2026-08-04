import { cpSync, existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

// prepack for the published `frizz` package. Unlike `frizz-dev` (which builds a promoted artifact
// from the source checkout at launch), the registry package runs directly from what it ships, so
// prepack must stage every runtime closure the server reaches for at run time:
//   1. web-dist         — the built web client the server serves.
//   2. runtime/board — the frizz board parser the server SHELLS OUT to (server/src/frizz.ts).
//   3. runtime/cc-worker       — the Claude worker plugin every dispatched agent loads (dispatch.ts).
// production.ts points FRIZZ_SCRIPTS_DIR / FRIZZ_WORKER_PLUGIN_DIR at (2)/(3); the cc-worker shims
// resolve the board via `../../board` relative to the plugin, so the two MUST share the
// `runtime/` parent (mirrors the source-checkout artifact layout in src/artifacts.ts).
const here = dirname(fileURLToPath(import.meta.url))
// The published package IS the repo root: scripts/ -> <repo>.
const repo = resolve(here, "..")

// 1. Web client.
const webDist = resolve(repo, "packages/web/dist")
const webTarget = resolve(repo, "web-dist")
execFileSync("pnpm", ["--dir", repo, "--filter", "@frizz/web", "build"], { stdio: "pipe" })
if (!existsSync(webDist)) throw new Error("Frizz web build did not produce packages/web/dist")
rmSync(webTarget, { recursive: true, force: true })
cpSync(webDist, webTarget, { recursive: true })

// 2 + 3. Runtime closure — board parser + worker plugin. Exclude tests and any stray node_modules;
// keep everything else the shells and the module graph they pull in (ownership, decisions, …) need.
const skip = (src) => {
  const base = src.split("/").pop() ?? ""
  return base === "node_modules" || base.endsWith(".test.mjs")
}
const runtime = resolve(repo, "runtime")
rmSync(runtime, { recursive: true, force: true })
const stage = (from, to, label) => {
  if (!existsSync(from)) throw new Error(`Frizz runtime closure source is missing: ${label} (${from})`)
  cpSync(from, to, { recursive: true, filter: (s) => !skip(s) })
}
stage(resolve(repo, "board"), resolve(runtime, "board"), "board")
stage(resolve(repo, "cc-worker"), resolve(runtime, "cc-worker"), "cc-worker")

// Fail loudly if the closure the server asserts at runtime did not land (mirrors
// WORKER_PLUGIN_REQUIRED_FILES in cli/src/artifacts.ts).
const required = [
  "cc-worker/.claude-plugin/plugin.json",
  "cc-worker/hooks/session-seed.mjs",
  "cc-worker/hooks/agent-bind.mjs",
  "cc-worker/bin/frizz",
  "cc-worker/bin/frizz-update",
  "board/config.mjs",
  "board/agent-bindings.mjs",
  "board/index.mjs",
  "board/thread-update.mjs",
]
for (const file of required) {
  if (!existsSync(resolve(runtime, file))) throw new Error(`Frizz runtime closure is missing ${file} after staging`)
}
