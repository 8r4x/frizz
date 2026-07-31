import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { shortDebugId } from "./MessageDebugId.tsx"

const chatView = () => readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
// The wake divider's host moved OUT of ChatView when the divider was extracted into its own module
// (so the GitHub wake card could wear it without a cycle). It is still one of the message roots this
// file enumerates — scan it alongside ChatView rather than dropping it from the count.
const wakeDivider = () => readFileSync(new URL("./WakeDivider.tsx", import.meta.url), "utf8")

test("shortDebugId shows only the part that varies between messages", () => {
  // sessionId is constant across a thread — the byte offset is the distinguishing part.
  assert.equal(shortDebugId("claude:c339e6e4-fc73-4f41-a2e6-1eea19ccd447:24009"), "24009")
  // Codex appends an event ordinal; both trailing components matter.
  assert.equal(shortDebugId("codex:01ab-cd:9312:2"), "9312:2")
  // Anything that isn't a well-formed id is shown verbatim rather than silently truncated.
  assert.equal(shortDebugId("delivery:abc"), "delivery:abc")
  assert.equal(shortDebugId("weird"), "weird")
})

// The REGRESSION this pins: `data-transcript-source-id` is load-bearing for transcript pagination —
// captureTranscriptViewportAnchor / restoreTranscriptViewportAnchor and the virtualized
// requestEarlier anchor all query it and expect it on ROW wrappers (which also carry
// data-transcript-row-key / data-transcript-sticky). Stamping the same attribute on each nested
// MESSAGE root would have put non-row nodes into those result sets — and, on a pinned band,
// would have defeated the `data-transcript-sticky` filter that stops a pinned band (invariant top,
// zero delta) from being chosen as the scroll anchor. The debug handle is a SEPARATE attribute.
// Three legitimate sites: the virtual row wrapper, the VIRTUALIZED drawer's own hoisted sticky band,
// and the shared StickyUserBand (still used by the eager ChatView branch and the queue cards). Every
// one of the three ALSO carries either data-transcript-row-key or data-transcript-sticky, so none is a
// bare Message root.
test("the per-message debug handle never joins the pagination-anchor attribute", () => {
  const source = chatView()
  const anchorSites = [...source.matchAll(/data-transcript-source-id=/g)]
  assert.equal(anchorSites.length, 3, "only the virtual row wrapper, the hoisted sticky band, and StickyUserBand may carry the anchor attribute")
  // 1) the virtual row wrapper
  assert.match(source, /data-transcript-source-id=\{row\.kind === "message" \? row\.message\.sourceId : undefined\}/)
  // 2) the virtualized drawer's hoisted pinned current-ask — anchor immediately followed by the sticky
  //    marker so requestEarlier's `:not([data-transcript-sticky])` filter skips it as a scroll anchor.
  assert.match(source, /data-transcript-source-id=\{stickyMessageRow\.message\.sourceId\}\s*\n\s*data-transcript-sticky="true"/)
  // 3) the shared StickyUserBand definition
  assert.match(source, /data-transcript-source-id=\{sourceId\}\s*\n\s*data-transcript-sticky="true"/)
})

test("every message root hosts a debug chip in a named hover group", () => {
  // Both files that define a message root, so extracting one into its own module cannot quietly drop
  // it from this guarantee — which is exactly what the divider extraction would otherwise have done.
  const sources = [chatView(), wakeDivider()]
  const hosts = sources.flatMap((source) => [...source.matchAll(/data-fray-msg=\{(m\.sourceId|sourceId)\}[^>]*className=\{?[`"]([^`"]*)/g)])
  // assistant turn, user bubble, answers card, event line, boundary rule, reasoning block — plus the
  // wake divider, now in WakeDivider.tsx.
  assert.equal(hosts.length, 6, "each rendered message variant must expose its own debug handle")
  for (const [, , className] of hosts) {
    assert.match(className, /group\/msg/, "host must open the NAMED hover group the chip keys off")
    assert.match(className, /relative/, "host must be the positioning context for the absolute chip")
  }
  // A bare `group` would also be toggled by any ancestor group (the ops strip uses one), so the
  // name is what keeps the chip scoped to its own message.
  for (const source of sources) {
    assert.equal([...source.matchAll(/group-hover\/msg:/g)].length, 0, "the chip's group-hover lives in MessageDebugId, not its hosts")
  }
  assert.equal(sources.reduce((n, source) => n + [...source.matchAll(/<MessageDebugId /g)].length, 0), 6)
})

test("the chip is absolutely positioned so it never perturbs virtualizer measurement", () => {
  const source = readFileSync(new URL("./MessageDebugId.tsx", import.meta.url), "utf8")
  const className = source.match(/className=\{`([^`]*)`\}/)?.[1]
  assert.ok(className, "chip must carry a className")
  assert.match(className, /absolute/, "an in-flow chip would add height to every message and re-measure every virtual row on hover")
  assert.match(className, /opacity-0/, "chip stays invisible until its message is hovered or it is focused")
  assert.match(className, /group-hover\/msg:opacity-100/)
  assert.match(className, /focus-visible:opacity-100/, "chip must be reachable by keyboard, not hover-only")
  // The full id is what gets copied; the short form is only what's drawn.
  assert.match(source, /writeText\(sourceId\)/)
})
