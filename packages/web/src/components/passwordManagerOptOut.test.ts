import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

// 1Password's browser extension treats a bare <textarea> as a place to paste a public key and pops
// "Create SSH key" the moment the prompt box takes focus. `data-1p-ignore` is its documented opt-out,
// and it only counts when present at mount, so it rides on the element itself rather than being set
// from an effect. Every textarea here is prose for an agent, never a credential.
test("every textarea in the app opts out of 1Password's inline menu", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url))
  const missing: string[] = []
  let seen = 0
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
    const source = readFileSync(`${dir}/${file}`, "utf8")
    for (const match of source.matchAll(/<textarea\b([\s\S]*?)\/>/g)) {
      seen++
      if (!/\bdata-1p-ignore\b/.test(match[1]!)) missing.push(`${file}:${source.slice(0, match.index).split("\n").length}`)
    }
  }
  assert.ok(seen >= 6, `expected to find the app's textareas, found ${seen}`)
  assert.deepEqual(missing, [])
})
