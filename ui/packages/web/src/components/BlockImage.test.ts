import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("screenshots are horizontally centered without stretching their intrinsic frame", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const blockImage = source.match(/export function BlockImage[\s\S]*?\n}\n/)?.[0]

  assert.ok(blockImage, "BlockImage source should remain discoverable")
  assert.match(blockImage, /data-local-image="true"/)
  assert.match(blockImage, /className="[^"]*\bself-center\b[^"]*"/)
  assert.doesNotMatch(blockImage, /\bself-start\b/)
})
