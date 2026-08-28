import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chatView = () => readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
// The wake divider's message root moved OUT of ChatView when the divider was extracted into its own
// module (so the GitHub wake card could wear it without a cycle). It is still one of the message roots
// this file enumerates — scan it alongside ChatView rather than dropping it from the count.
const wakeDivider = () => readFileSync(new URL("./WakeDivider.tsx", import.meta.url), "utf8")
// …and so did the ANSWERS card, on 2026-08-27, so the registered-question surface could draw the
// human's answer from the same component while it was still on its way to the worker.
const answersCard = () => readFileSync(new URL("./AnswersCard.tsx", import.meta.url), "utf8")

// The REGRESSION this pins: `data-transcript-source-id` is load-bearing for transcript pagination —
// captureTranscriptViewportAnchor / restoreTranscriptViewportAnchor and the virtualized
// requestEarlier anchor all query it and expect it on ROW wrappers (which also carry
// data-transcript-row-key / data-transcript-sticky). Stamping the same attribute on each nested
// MESSAGE root would put non-row nodes into those result sets — and, on a pinned band, would defeat
// the `data-transcript-sticky` filter that stops a pinned band (invariant top, zero delta) from being
// chosen as the scroll anchor. A message root's own handle is the SEPARATE `data-frizz-msg` attribute.
// Three legitimate sites: the virtual row wrapper, the VIRTUALIZED drawer's own hoisted sticky band,
// and the shared StickyUserBand (still used by the eager ChatView branch and the queue cards). Every
// one of the three ALSO carries either data-transcript-row-key or data-transcript-sticky, so none is a
// bare Message root.
test("a message root never joins the pagination-anchor attribute", () => {
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

// `data-frizz-msg` outlived the hover-revealed debug-id chip it was introduced for (dropped 2026-08-01,
// maintainer: "they're not necessary anymore"). It stays because it is the only per-message handle the
// e2e suites can select on — workingTailSpacing, metaColumnRhythm and intermediateCollapseDivider all
// query it to find message roots and read their geometry. Losing it in a later cleanup would take
// those with it, so the count is pinned here.
test("every rendered message variant still carries its own data-frizz-msg handle", () => {
  const sources = [chatView(), wakeDivider(), answersCard()]
  // assistant turn, user bubble, event line, reasoning block — plus the wake divider (WakeDivider.tsx)
  // and the answers card, which moved to its own module on 2026-08-27 when the registered-question path
  // needed to draw the human's answer while it was still in flight to the worker.
  const hosts = sources.reduce((n, source) => n + [...source.matchAll(/data-frizz-msg=\{(?:m\.)?sourceId\}/g)].length, 0)
  assert.equal(hosts, 6, "each rendered message variant must stamp its own sourceId")
})
