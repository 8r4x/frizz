// Build the published `frayui` runtime. A published package is installed UNDER node_modules, where
// Node refuses to strip TypeScript types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — so unlike
// `fray-dev` (which runs raw .ts straight from the source checkout) the registry package MUST ship
// compiled JS. esbuild absorbs the CLI, server and every workspace/JS dependency into self-contained
// ESM bundles; only the native loaders stay external and are installed as real dependencies.
//
// Real entry FILES are emitted because each is executed as its OWN `node <file>` process:
//   - frayui.js                    the bin / production launcher (production.ts)
//   - dev-child.js                 the server child the supervisor spawns (dev-supervisor childEntry)
//   - one .js per DETACHED_DAEMON_ENTRIES — each a detached daemon spawned as its own process
//     (codex-app-server-daemon.js, claude-agent-broker.js — the Claude session broker).
// production.ts resolves the child beside itself (./dev-child.js) and dev-child resolves each daemon
// beside itself (./<daemon>.js), so ALL of them MUST land in the same dist/ directory. The daemon list
// is DERIVED from detached-daemons.ts (the single source of truth) so a newly-added daemon can never be
// silently dropped from the published bundle — the exact class of packaging bug that comment warns of.
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { rmSync, existsSync } from "node:fs"
import { build } from "esbuild"
import { DETACHED_DAEMON_ENTRIES, detachedDaemonOutputName } from "../packages/server/src/detached-daemons.ts"

const here = dirname(fileURLToPath(import.meta.url))
// The published package IS the repo root: scripts/ -> <repo>.
const workspace = resolve(here, "..")
const dist = resolve(workspace, "dist")

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  absWorkingDir: workspace,
  // Some bundled deps (e.g. ws) keep CommonJS `require()` of Node built-ins; in an ESM bundle esbuild
  // otherwise installs a throwing require shim. Give it a real bundle-relative CJS resolver.
  banner: {
    js: 'import { createRequire as __frayCreateRequire } from "node:module"; const require = __frayCreateRequire(import.meta.url);',
  },
  // Native loaders + the dev-only vite server stay external and are resolved from node_modules at
  // runtime (better-sqlite3/node-pty/@parcel/watcher are frayui dependencies; vite is never reached
  // in production, which serves the prebuilt web-dist).
  external: ["better-sqlite3", "node-pty", "@parcel/watcher", "vite"],
  logLevel: "silent",
}

rmSync(dist, { recursive: true, force: true })

const entries = {
  "frayui.js": "src/production.ts",
  "dev-child.js": "packages/server/src/dev-child.ts",
}
// Every detached daemon ships as its own real sibling .js — derived, never hand-listed.
for (const entry of DETACHED_DAEMON_ENTRIES) {
  entries[detachedDaemonOutputName(entry)] = entry
}

for (const [outName, entry] of Object.entries(entries)) {
  await build({ ...shared, entryPoints: [entry], outfile: join(dist, outName) })
}

for (const outName of Object.keys(entries)) {
  if (!existsSync(join(dist, outName))) throw new Error(`build-package: expected ${outName} was not emitted`)
}
