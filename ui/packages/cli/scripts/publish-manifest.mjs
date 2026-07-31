// prepack/postpack halves of the published-manifest cleanup. npm reads package.json AFTER prepack
// runs, so stripping pnpm's `workspace:` specifiers here is what keeps them out of the registry
// manifest; postpack puts the checked-in file back exactly as it was.
//
// The original is parked beside package.json rather than held in memory because prepack and postpack
// are separate processes. `--strip` refuses to overwrite an existing backup, so a crashed publish
// leaves a recoverable original instead of a stripped file backing itself up; `--restore` is a no-op
// when there is nothing to restore, which makes both halves safe to run twice.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripWorkspaceDependencies } from "../src/publish-manifest.ts"

const cli = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(cli, "package.json")
const backupPath = join(cli, "package.json.publish-backup")
const mode = process.argv[2]

if (mode === "--strip") {
  if (existsSync(backupPath))
    throw new Error(
      `${backupPath} already exists — a previous publish did not finish. Restore it over package.json before packing again.`
    )
  const original = readFileSync(manifestPath, "utf8")
  const { manifest, stripped } = stripWorkspaceDependencies(JSON.parse(original))
  if (stripped.length === 0) process.exit(0)
  writeFileSync(backupPath, original)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`publish manifest: dropped workspace-only ${stripped.join(", ")}`)
} else if (mode === "--restore") {
  if (!existsSync(backupPath)) process.exit(0)
  renameSync(backupPath, manifestPath)
  console.log("publish manifest: restored the checked-in package.json")
} else {
  throw new Error("usage: publish-manifest.mjs --strip | --restore")
}
