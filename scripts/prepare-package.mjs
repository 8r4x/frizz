import { cpSync, existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { assertWorkerPluginClosure } from "../src/worker-plugin-closure.ts"

// prepack/postpack halves of the published `frizz` package's staged build output. Unlike `frizz-dev`
// (which builds a promoted artifact from the source checkout at launch), the registry package runs
// directly from what it ships, so prepack must stage every runtime closure the server reaches for at
// run time:
//   1. web-dist         — the built web client the server serves.
//   2. runtime/board — the frizz board parser the server SHELLS OUT to (server/src/frizz.ts).
//   3. runtime/cc-worker       — the Claude worker plugin every dispatched agent loads (dispatch.ts).
// src/production.ts points FRIZZ_SCRIPTS_DIR / FRIZZ_WORKER_PLUGIN_DIR at (2)/(3); the cc-worker shims
// resolve the board via `../../board` relative to the plugin, so the two MUST share the
// `runtime/` parent (mirrors the source-checkout artifact layout in src/artifacts.ts).
//
// `--clean` is the postpack half, and the reason prepack stages into `runtime/` rather than listing
// `board/` and `cc-worker/` in `files` directly: every published path is build output, so `files` can
// never name repository content (src/package-contents.test.ts). Build output has to be swept up after
// the tarball is written, though. Nothing in a source checkout reads either staged copy — frizz-dev
// builds its artifact from `board/` and `cc-worker/` themselves — so left behind they are worse than
// dead weight: a frozen duplicate of every worker skill, hook and board script, sitting in the tree
// agents grep, reading exactly like source and answering searches with last month's text.
const here = dirname(fileURLToPath(import.meta.url))
// The published package IS the repo root: scripts/ -> <repo>.
const repo = resolve(here, "..")
const webTarget = resolve(repo, "web-dist")
const runtime = resolve(repo, "runtime")

if (process.argv[2] === "--clean") {
  for (const staged of [webTarget, runtime]) rmSync(staged, { recursive: true, force: true })
  console.log("publish staging: removed the prepack-staged web-dist/ and runtime/")
  process.exit(0)
}

// 1. Web client.
const webDist = resolve(repo, "packages/web/dist")
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
rmSync(runtime, { recursive: true, force: true })
const stage = (from, to, label) => {
  if (!existsSync(from)) throw new Error(`Frizz runtime closure source is missing: ${label} (${from})`)
  cpSync(from, to, { recursive: true, filter: (s) => !skip(s) })
}
stage(resolve(repo, "board"), resolve(runtime, "board"), "board")
stage(resolve(repo, "cc-worker"), resolve(runtime, "cc-worker"), "cc-worker")

// Fail loudly if the closure the server asserts at run time did not land — the SAME assertion the
// promoted-artifact build runs, imported rather than restated, so widening the closure is one edit.
assertWorkerPluginClosure(runtime)
