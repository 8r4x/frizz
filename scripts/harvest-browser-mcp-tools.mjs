// Regenerate `cc-worker/bin/browser-mcp-tools.json` — the committed tool-schema snapshot the lazy
// browser-MCP proxy answers `tools/list` from with nothing spawned.
//
// RUN THIS WHENEVER YOU BUMP `CHROME_DEVTOOLS_MCP.version` in packages/server/src/backend/types.ts.
// A unit test (backend/browser-mcp.test.ts) fails while the snapshot and the pin disagree, so the
// bump cannot land half-done — but the failure tells you to run this, it does not run it for you.
//
// The harvest itself lives in the proxy (`browser-mcp.mjs --frizz-harvest`), not here: the proxy needs
// exactly the same "install the pinned version, boot it, read its registry" path at runtime for the
// case where a version moved without a regenerated snapshot, and two copies of that would drift.
import { execFileSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileSync } from "node:fs"
import { CHROME_DEVTOOLS_MCP } from "../packages/server/src/backend/types.ts"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const proxy = join(repo, "cc-worker", "bin", CHROME_DEVTOOLS_MCP.script)
const out = join(repo, "cc-worker", "bin", "browser-mcp-tools.json")
const pin = `${CHROME_DEVTOOLS_MCP.package}@${CHROME_DEVTOOLS_MCP.version}`

console.log(`harvesting ${pin} …`)
const raw = execFileSync(process.execPath, [proxy, "--frizz-harvest", ...CHROME_DEVTOOLS_MCP.args], {
  encoding: "utf8",
  env: { ...process.env, FRIZZ_BROWSER_MCP_PACKAGE: pin },
  maxBuffer: 32 * 1024 * 1024,
})
const harvested = JSON.parse(raw)
if (harvested.version !== CHROME_DEVTOOLS_MCP.version)
  throw new Error(`harvested ${harvested.version} but the pin says ${CHROME_DEVTOOLS_MCP.version}`)
if (!harvested.tools?.length) throw new Error("the harvest returned no tools")

writeFileSync(out, JSON.stringify(harvested, null, 2) + "\n")
console.log(`wrote ${out} — ${harvested.tools.length} tools, ${harvested.tools.map((t) => t.name).join(", ")}`)
