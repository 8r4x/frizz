import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

// The "child of / branches from" affordance is ONE glyph: ⤷ (U+2937), established by the sidebar's
// sub-agent rows and reused verbatim by the drawer's operation lines and the lifecycle footer. The
// queue card's sub-agent lines drifted to ↳ (U+21B3) when they were added, so a queue card rendered
// two different down-right arrows a few pixels apart. This test is the drift guard: any new surface
// that reaches for a down-right arrow has to reach for the same one.
const CHILD_ARROW = "⤷"
const WRONG_ARROW = "↳"

const SRC = fileURLToPath(new URL("..", import.meta.url))
const SELF = fileURLToPath(import.meta.url)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(path))
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path)
  }
  return out
}

test("every sub-agent / child line uses the one shared ⤷ arrow, never ↳", () => {
  // This file names the banned glyph in order to search for it, so it is the one legitimate holder.
  const offenders = sourceFiles(SRC).filter((path) => path !== SELF && readFileSync(path, "utf8").includes(WRONG_ARROW))
  assert.deepEqual(offenders, [], `U+21B3 ↳ must not appear in web sources — use ⤷ (U+2937): ${offenders.join(", ")}`)
})

test("the shared child arrow is still present in the web sources", () => {
  // Deliberately NOT pinned to a file list: the child rows are being consolidated behind one shared
  // row component, so naming today's call sites would turn this guard into a chore. The durable
  // invariant is the pair above — ↳ appears nowhere, and ⤷ still exists somewhere to be rendered.
  const holders = sourceFiles(SRC).filter((path) => path !== SELF && readFileSync(path, "utf8").includes(CHILD_ARROW))
  assert.ok(holders.length > 0, "no web source carries the shared ⤷ (U+2937) child arrow any more")
})
