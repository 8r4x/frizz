import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { TRANSCRIPT_META_LABEL_CLASS } from "../lib/transcriptMetaLabels.ts"

test("quiet transcript events retain the shared metadata-label rhythm", () => {
  assert.equal(TRANSCRIPT_META_LABEL_CLASS, "petite-caps text-[12px] leading-[18px] text-muted/55")

  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  // The quiet event line's own root. It gained a `group/msg relative` host for the hover-revealed
  // debug-id chip, so the class is now interpolated rather than passed bare — but the RHYTHM contract
  // is unchanged, and the two additions must stay purely positional.
  const eventClass = source.match(/className=\{`group\/msg relative \$\{TRANSCRIPT_META_LABEL_CLASS\}([^`]*)`\}/)?.[1]
  assert.ok(eventClass !== undefined, "event line must consume the shared metadata-label class")
  assert.doesNotMatch(eventClass, /(?:text-\[|leading-|text-muted\/|petite-caps)/, "event line must not override the shared type rhythm")
  assert.match(source, /<MessageDebugId sourceId=\{sourceId\} \/>\s*\{text\}/, "event line still renders its text verbatim beside the chip")
})

test("minimal tool activity is a full-width shimmer disclosure with no spinner indentation", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/function MinimalToolActivity[\s\S]*?\n}/)?.[0]
  assert.ok(block, "MinimalToolActivity must exist")
  assert.match(block, /activity\.pending \? "shimmer-text" : "text-muted"/, "only live gerunds shimmer")
  assert.match(block, /settledToolActivityLabel\(total\)/, "settled batches render the completed summary")
  assert.match(block, /className="group flex w-full/, "the disclosure owns the row so its chevron can right-align")
  assert.match(block, /className=\{`ml-auto size-\[1em\]/, "the chevron is right-justified and scales with the label")
  assert.doesNotMatch(block, /fray-tool-spinner|data-running-indicator|w-2\.5/, "no spinner or reserved mark slot may indent the label")
})

test("codex reasoning toggle is a peer of quiet metadata labels", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/function ReasoningBlock[\s\S]*?\n}/)?.[0]
  assert.ok(block, "ReasoningBlock must exist")
  // Same petite-caps whisper as "Thought for Ns" — not a bespoke uppercase treatment.
  assert.match(block, /className=\{`\$\{TRANSCRIPT_META_LABEL_CLASS\}[^`]*self-start/, "reasoning toggle must consume the shared metadata-label class")
  assert.doesNotMatch(block, /uppercase|tracking-wide|text-\[12px\]|text-muted\/\d/, "reasoning toggle must not reintroduce a bespoke label type/color")
})
