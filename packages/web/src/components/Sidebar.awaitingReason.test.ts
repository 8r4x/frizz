import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow, awaitingReason, sessionIndicatorFor } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// A RAIL ROW IS ITS TITLE, AND EVERYTHING ELSE IS ONE HOVER AWAY (maintainer 2026-08-19: "there should
// never ever be any fucking thing in the sidebar except for the fucking title"). The row has no
// subtitle line in any state — no PR ref, no snooze, no activity gloss — and the indicator's popover is
// where what frizz knows about the wait now lives: the fence's own items, generated deterministically,
// then the worker's `reason:`.
//
// The two halves are one decision, and this file pins both. The popover half is asserted on the TIP
// rather than on rendered markup, deliberately: a Radix tooltip renders nothing until it opens, so
// `renderToStaticMarkup` cannot see it, and asserting on the icon alone would happily pass a popover
// that said the wrong thing. The row half is asserted on the MARKUP, because that is the surface the
// rule is about.

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

test("a parked awaiting thread puts its whole wait in the POPOVER, state first and reason last", () => {
  const t = thread([...WAIT, { kind: "reason", value: REASON }])
  const lines = (sessionIndicatorFor(t).tip ?? "").split("\n")
  // The band the row is IN leads — that is what the glyph you pointed at is claiming — then what the
  // fence names, then the one line frizz did not write.
  assert.deepEqual(lines, ["Held", "Waiting on a background shell", REASON])
})

// The same fence frizz could NOT honour (nothing running behind it) leaves the row in the queue wearing
// the at-rest ellipsis. The popover keeps its shape: only the state word changes, so the two rows never
// mean different things by the same lines.
test("a fence frizz did not park on swaps the state word and nothing else", () => {
  // needsYou keeps the row in the queue (isHeld refuses it), which is the shape of a park the server
  // could not honour: the fence still says what it thinks it is waiting on, and the popover still says it.
  const t = thread([...WAIT, { kind: "reason", value: REASON }], { needsYou: true } as Partial<ThreadView>)
  assert.deepEqual((sessionIndicatorFor(t).tip ?? "").split("\n"), ["At rest", "Waiting on a background shell", REASON])
})

test("…and NONE of it reaches the row, which is a title and nothing else", () => {
  const html = markup(thread([{ kind: "pr", value: "acme/app#391" }, ...WAIT, { kind: "reason", value: REASON }]))
  assert.match(html, /Ship the resolver/, "the title is what a row is")
  assert.doesNotMatch(html, new RegExp(REASON.slice(0, 30)), "no reason under it")
  assert.doesNotMatch(html, /acme\/app#391/, "no PR ref under it either — the popover has that now")
})

test("a legacy activity gloss is not a subtitle either", () => {
  const t = { ...base, id: "legacy-thread", activity: "Awaiting CI on PR #391" } as unknown as ThreadView
  assert.doesNotMatch(markup(t), /Awaiting CI on PR #391/)
})

test("a fence with no reason leaves the popover saying only what it knows", () => {
  const tip = sessionIndicatorFor(thread(WAIT)).tip ?? ""
  assert.deepEqual(tip.split("\n"), ["Held", "Waiting on a background shell"])
  assert.doesNotMatch(tip, new RegExp(REASON.slice(0, 20)), "nothing invented")
})

test("a watched PR leads the popover, because it names a thing rather than a shape", () => {
  const t = thread([{ kind: "pr", value: "acme/app#391" }, ...WAIT, { kind: "reason", value: REASON }])
  assert.deepEqual((sessionIndicatorFor(t).tip ?? "").split("\n"), [
    "Held",
    "Watching acme/app#391 — new activity wakes it",
    "Waiting on a background shell",
    REASON,
  ])
})

test("awaitingReason reads only an awaiting fence, and only a non-empty one", () => {
  assert.equal(awaitingReason(thread([...WAIT, { kind: "reason", value: REASON }])), REASON)
  assert.equal(awaitingReason(thread([...WAIT, { kind: "reason", value: "   " }])), null, "whitespace is not a reason")
  assert.equal(awaitingReason(thread(WAIT)), null)
  assert.equal(awaitingReason({ lastFence: { kind: "done", body: "", hints: [] } } as unknown as ThreadView), null)
})
