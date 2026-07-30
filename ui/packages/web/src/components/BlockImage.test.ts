import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("screenshots are horizontally centered without stretching their intrinsic frame", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  const blockImage = source.match(/export function BlockImage[\s\S]*?\n}\n/)?.[0]
  const markdownImage = styles.match(/\.md-body img\[data-local-path\] \{[\s\S]*?\n\}/)?.[0]

  assert.ok(blockImage, "BlockImage source should remain discoverable")
  assert.match(blockImage, /data-local-image="true"/)
  assert.match(blockImage, /className="[^"]*\bself-center\b[^"]*"/)
  assert.doesNotMatch(blockImage, /\bself-start\b/)
  assert.ok(markdownImage, "Markdown screenshot styles should remain discoverable")
  assert.match(markdownImage, /display:\s*block/)
  assert.match(markdownImage, /margin-inline:\s*auto/)
})
