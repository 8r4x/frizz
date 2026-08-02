import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("every rendered image sits in the one frame: border, inset mat, centered picture", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const frame = readFileSync(new URL("./ImageFrame.tsx", import.meta.url), "utf8")
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  const blockImage = source.match(/export function BlockImage[\s\S]*?\n}\n/)?.[0]
  const imageFrame = frame.match(/export function ImageFrame[\s\S]*?\n}\n/)?.[0]
  const markdownImage = styles.match(/\.md-body img\[data-local-path\] \{[\s\S]*?\n\}/)?.[0]

  assert.ok(blockImage, "BlockImage source should remain discoverable")
  assert.match(blockImage, /data-local-image="true"/)
  // Prose paths, tool screenshots, deliveries and attachments all reach the picture through ONE element.
  assert.match(blockImage, /<ImageFrame\b/)
  assert.match(blockImage, /\bFRAMED_IMAGE\b/)

  assert.ok(imageFrame, "ImageFrame source should remain discoverable")
  // The outer border + the tool-card typography, so a `fray-bash-header` can ride inside the frame.
  assert.match(imageFrame, /className="fray-bash\b/)
  // The mat: a little inset padding, a step lighter than the card so a dark screenshot keeps an edge,
  // and the picture centered in it however narrow the picture is.
  assert.match(imageFrame, /justify-center\b[^"]*\bbg-panel-2\b[^"]*\bp-1\.5\b/)
  // The picture never overflows the mat and never loses its aspect.
  assert.match(frame, /FRAMED_IMAGE\s*=\s*"[^"]*\bobject-contain\b/)
  assert.match(frame, /FRAMED_IMAGE\s*=\s*"[^"]*\bmax-w-full\b/)

  assert.ok(markdownImage, "Markdown screenshot styles should remain discoverable")
  assert.match(markdownImage, /display:\s*block/)
  assert.match(markdownImage, /margin-inline:\s*auto/)
})
