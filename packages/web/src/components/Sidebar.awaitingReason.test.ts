import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow, hintGloss, awaitingReason, sessionIndicatorFor } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// WHERE THE WORKER'S `reason:` GOES, and where it must not (maintainer 2026-08-16: "we should take the
// reason field and display it in the popover when you hover over the ellipsis indicator, but you should
// not be showing that reason in a sidebar label").
//
// The two halves are one decision. The reason is a SENTENCE a worker wrote for a human, and the rail's
// subtitle is its scarcest line: a sentence there reads as a second, competing status beside the row's
// own — the same complaint that hid the SNOOZED label from these rows. A popover has room for it and is
// where you go when you want the detail.
//
// The popover half is asserted on the TIP rather than on rendered markup, deliberately: a Radix tooltip
// renders nothing until it opens, so `renderToStaticMarkup` cannot see it, and asserting on the icon
// alone would happily pass a popover that said the wrong thing.

const base = {
  kind: "session",
  backend: "claude",
  title: "Ship the resolver fix",
  status: "active",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
} as unknown as ThreadView

const REASON = "waiting on the three-platform run before porting the v2 drivers"

const thread = (hints: { kind: string; value: string }[], extra: Partial<ThreadView> = {}) =>
  ({ ...base, id: "resting-thread", lastFence: { kind: "awaiting", body: "", hints }, ...extra }) as unknown as ThreadView

function markup(t: ThreadView) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t })),
    ),
  )
}

const WAIT = [{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }]

test("a rested awaiting thread puts its reason in the POPOVER, beside the state it qualifies", () => {
  const t = thread([...WAIT, { kind: "reason", value: REASON }])
  const { tip } = sessionIndicatorFor(t)
  // The SHAPE of the wait leads — that is what the glyph beside it is claiming — and the reason follows.
  // Which shape depends on whether the server honoured the park (Held) or left it queued (at rest); the
  // reason rides both, deliberately, so the popover cannot mean different things on the two rows.
  assert.match(tip ?? "", /Waiting on its own background work|At rest/, "the state leads")
  assert.match(tip ?? "", new RegExp(REASON.slice(0, 30)), "…and the worker's own sentence follows it")
  assert.match(tip ?? "", /—/, "…joined, not concatenated")
})

test("…and NEVER in the rail's label", () => {
  const t = thread([...WAIT, { kind: "reason", value: REASON }])
  assert.equal(hintGloss(t.lastFence!.hints), null, "the subtitle has nothing to say about a reason")
  assert.doesNotMatch(markup(t), new RegExp(REASON.slice(0, 30)), "and none of it reaches the rendered row")
})

test("a fence with no reason leaves the popover saying only what it knows", () => {
  const { tip } = sessionIndicatorFor(thread(WAIT))
  assert.doesNotMatch(tip ?? "", /—\s*$/, "no dangling separator where a reason would have gone")
  assert.doesNotMatch(tip ?? "", new RegExp(REASON.slice(0, 20)), "and nothing invented")
})

// A PR ref is the one fence line naming a THING rather than describing the wait, and it exists nowhere
// else on the row — so it stays the inline gloss while the reason stays in the popover.
test("a PR ref still glosses inline, and does not drag the reason in with it", () => {
  const hints = [{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "2h" }, { kind: "reason", value: REASON }]
  assert.equal(hintGloss(hints), "PR acme/app#391")
  assert.doesNotMatch(markup(thread(hints)), new RegExp(REASON.slice(0, 30)))
})

test("awaitingReason reads only an awaiting fence, and only a non-empty one", () => {
  assert.equal(awaitingReason(thread([...WAIT, { kind: "reason", value: REASON }])), REASON)
  assert.equal(awaitingReason(thread([...WAIT, { kind: "reason", value: "   " }])), null, "whitespace is not a reason")
  assert.equal(awaitingReason(thread(WAIT)), null)
  assert.equal(awaitingReason({ lastFence: { kind: "done", body: "", hints: [] } } as unknown as ThreadView), null)
})
