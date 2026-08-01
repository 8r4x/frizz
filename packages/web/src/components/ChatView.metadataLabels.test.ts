import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { TRANSCRIPT_META_LABEL_CLASS } from "../lib/transcriptMetaLabels.ts"

test("quiet transcript events use the same regular light-grey scale as activity rows", () => {
  // 14px is the ASSISTANT PROSE size (`.md-body`), which these rows deliberately match — they were a
  // 13px second scale interleaved with the prose, and tone (not size) is what makes them recede.
  assert.equal(TRANSCRIPT_META_LABEL_CLASS, "text-[14px] leading-5 text-muted")

  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  // The quiet event line's own root. It gained a `group/msg relative` host for the hover-revealed
  // debug-id chip, so the class is now interpolated rather than passed bare — but the RHYTHM contract
  // is unchanged, and the two additions must stay purely positional.
  const eventClass = source.match(/className=\{`group\/msg relative \$\{TRANSCRIPT_META_LABEL_CLASS\}([^`]*)`\}/)?.[1]
  assert.ok(eventClass !== undefined, "event line must consume the shared metadata-label class")
  assert.doesNotMatch(eventClass, /(?:text-\[|leading-|text-muted|petite-caps)/, "event line must not override the shared type rhythm")
  assert.match(source, /<MessageDebugId sourceId=\{sourceId\} \/>\s*\{text\}/, "event line still renders its text verbatim beside the chip")
})

test("minimal tool activity is settled history with no live shimmer or spinner indentation", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/function MinimalToolActivity[\s\S]*?\n}/)?.[0]
  assert.ok(block, "MinimalToolActivity must exist")
  assert.match(block, /settledToolActivityLabel\(total, editedFileCount\(tools\)\)/, "settled batches render the completed summary, including how many files the run edited")
  assert.match(block, /data-tool-activity-state="settled"/, "every historical disclosure is settled presentation")
  assert.doesNotMatch(block, /shimmer-text/, "the historical disclosure must never own the live shimmer")
  assert.match(block, /className=\{`group flex w-full[^`]*gap-1/, "the disclosure keeps the full row click target and a compact label gap")
  // It consumes the shared scale rather than restating one: this row alternates with "Thought for Ns"
  // in a single column, and the two drifted apart while the size was copied here by hand.
  assert.match(block, /\$\{TRANSCRIPT_META_LABEL_CLASS\}/, "the disclosure must consume the shared metadata-label class")
  assert.doesNotMatch(block, /text-\[1[0-9]px\]/, "and must not restate its own type scale")
  assert.match(block, /data-tool-activity-label[\s\S]*className="min-w-0 truncate text-muted"/, "the label shrinks before the adjacent chevron")
  assert.match(block, /data-tool-activity-chevron[^\n]*size-\[1em\]/, "the adjacent chevron scales with the label")
  assert.doesNotMatch(block, /ml-auto/, "the chevron must stay beside the digest label instead of jumping to the far edge")
  assert.doesNotMatch(block, /fray-tool-spinner|data-running-indicator|w-2\.5/, "no spinner or reserved mark slot may indent the label")
})

test("the current gerund replaces Thinking in the exact bottom shimmer span", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/export function WorkingIndicator[\s\S]*?\n}/)?.[0]
  assert.ok(block, "WorkingIndicator must exist")
  assert.match(block, /data-working-indicator/, "the runtime tail needs a stable browser-QA target")
  // The generic reading names what the model is DOING with the turn — composing its next move — not
  // that the session is alive, which the reader can already see (maintainer 2026-08-01: "Do you think
  // it makes more sense to change it to 'thinking'?").
  assert.match(block, /<span className="[^"]*shimmer-text">\{activityLabel \?\? "Thinking…"\}<\/span>/, "tool activity and the generic reading must use the exact same shimmer element")
  assert.doesNotMatch(block, /"Working…"/, "the generic reading is Thinking, not Working")
  assert.equal((block.match(/shimmer-text/g) ?? []).length, 1, "the runtime tail must have one shimmer treatment")
  // ONE LINE, always. The label TRUNCATES rather than wrapping (maintainer 2026-07-31: "prevent the
  // actual gerund from ever breaking onto two lines. It should get truncated instead") — a live status
  // reading that grows taller as a path lengthens makes the whole transcript tail jump.
  assert.match(block, /<span className="min-w-0 truncate shimmer-text"/, "the label truncates to one line")
  assert.doesNotMatch(block, /break-words/, "and never wraps")
  assert.match(block, /\{durationLabel\}/, "the runtime tail still reads its own elapsed time")
  assert.match(block, /<span className="shrink-0 whitespace-nowrap [^"]*">\{durationLabel\}<\/span>/, "the elapsed reading never breaks mid-value or shrinks")
})

test("codex reasoning toggle is a peer of quiet metadata labels", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  const block = source.match(/function ReasoningBlock[\s\S]*?\n}/)?.[0]
  assert.ok(block, "ReasoningBlock must exist")
  // Same regular light-grey line as "Thought for Ns" — not a bespoke uppercase treatment.
  assert.match(block, /className=\{`\$\{TRANSCRIPT_META_LABEL_CLASS\}[^`]*self-start/, "reasoning toggle must consume the shared metadata-label class")
  assert.doesNotMatch(block, /uppercase|tracking-wide|petite-caps|text-\[\d+px\]|text-muted\/\d/, "reasoning toggle must not reintroduce a bespoke label type/color")
})
