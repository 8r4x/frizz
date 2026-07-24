// Build the published `frayui` runtime. A published package is installed UNDER node_modules, where
// Node refuses to strip TypeScript types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — so unlike
// `fray-dev` (which runs raw .ts straight from the source checkout) the registry package MUST ship
// compiled JS. esbuild absorbs the CLI, server and every workspace/JS dependency into self-contained
// ESM bundles; only the native loaders stay external and are installed as real dependencies.
//
// Three real entry FILES are emitted because each is executed as its OWN `node <file>` process:
//   - frayui.js                    the bin / production launcher (production.ts)
//   - dev-child.js                 the server child the supervisor spawns (dev-supervisor childEntry)
//   - codex-app-server-daemon.js   a detached daemon spawned as its own process (detached-daemons.ts)
// production.ts resolves the child beside itself (./dev-child.js) and dev-child resolves the daemon
// beside itself (./codex-app-server-daemon.js), so all three MUST land in the same dist/ directory.
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { rmSync, existsSync } from "node:fs"
import { build } from "esbuild"

const here = dirname(fileURLToPath(import.meta.url))
const cli = resolve(here, "..")
const ui = resolve(cli, "..", "..")
const dist = resolve(cli, "dist")

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  absWorkingDir: ui,
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
  "frayui.js": "packages/cli/src/production.ts",
  "dev-child.js": "packages/server/src/dev-child.ts",
  "codex-app-server-daemon.js": "packages/server/src/backend/codex-app-server-daemon.ts",
}

for (const [outName, entry] of Object.entries(entries)) {
  await build({ ...shared, entryPoints: [entry], outfile: join(dist, outName) })
}

for (const outName of Object.keys(entries)) {
  if (!existsSync(join(dist, outName))) throw new Error(`build-package: expected ${outName} was not emitted`)
}
