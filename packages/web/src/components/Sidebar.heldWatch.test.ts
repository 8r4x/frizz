import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The HELD row's glyph when a `pr-watch:` fence is what the thread is actually waiting on. The rail's
// park mark is the hourglass — "parked on the clock" — and for a watch the clock is only a backstop:
// the scheduler polls the PR and clears the park the moment new activity lands, so GitHub is the real
// wake. These pin that a watching row wears GitHub's mark and that every OTHER park keeps the
// hourglass, since one glyph leaking into the other is exactly the confusion this fixed.
//
// pr-watch never parks ITSELF (groups.ts parkedAwaitingHint excludes it so a watch stays a visible
// queue handoff), so the rows under test are the two that get parked anyway: one the human snoozed off
// the "PR watcher armed" card, and one whose worker co-declared a `human:` gate beside the watch.

const base = {
  kind: "session",
  backend: "claude",
  title: "Ship the resolver fix",
  status: "active",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
} as unknown as ThreadView

function row(extra: Partial<ThreadView>) {
  const t = { ...base, id: "watching-thread", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t })),
    ),
  )
}

// lucide stamps its icon name onto the rendered <svg>, which is the only thing that separates these two
// marks in the markup — they are otherwise the same 9px glyph in the same status box.
const GITHUB = /lucide-github/
const HOURGLASS = /lucide-hourglass/

const FAR_FUTURE = "2999-01-01T00:00:00.000Z"
const watch = (value: string) => ({ kind: "pr-watch" as const, value })

test("a pr-watch thread the human snoozed off its card wears GitHub's mark, not the hourglass", () => {
  const html = row({
    snoozedUntil: FAR_FUTURE,
    lastFence: { kind: "awaiting", body: "PR is open and CI is green.", hints: [watch("acme/app#391")] },
  } as Partial<ThreadView>)
  assert.match(html, GITHUB, "the row says what it is waiting on: the PR")
  assert.doesNotMatch(html, HOURGLASS, "…and never both marks at once")
})

test("a pr-watch fence with a co-declared human gate also wears GitHub's mark", () => {
  // The worker contract tells a worker to pair `human:` with `pr-watch:` when a GitHub PR exists, and
  // it is the `human:` hint that parks the thread — so this shape reaches Held with no snooze at all.
  const html = row({
    lastFence: {
      kind: "awaiting",
      body: "Waiting on the maintainer.",
      hints: [watch("acme/app#391"), { kind: "human", value: "maintainer must approve fork CI" }],
    },
  } as Partial<ThreadView>)
  assert.match(html, GITHUB)
  assert.doesNotMatch(html, HOURGLASS)
})

test("a pr-watch fence with a co-declared timer backstop also wears GitHub's mark", () => {
  const html = row({
    lastFence: { kind: "awaiting", body: "Watching.", hints: [watch("acme/app#391"), { kind: "timer", value: FAR_FUTURE }] },
  } as Partial<ThreadView>)
  assert.match(html, GITHUB)
  assert.doesNotMatch(html, HOURGLASS)
})

test("every park that is NOT a watch keeps the hourglass", () => {
  for (const [name, extra] of [
    ["a bare user snooze, no fence", { snoozedUntil: FAR_FUTURE }],
    ["a snooze over a human gate", { snoozedUntil: FAR_FUTURE, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "human", value: "Alice" }] } }],
    ["an ```awaiting human: gate", { lastFence: { kind: "awaiting", body: "", hints: [{ kind: "human", value: "Alice" }] } }],
    ["an ```awaiting timer: park", { lastFence: { kind: "awaiting", body: "", hints: [{ kind: "timer", value: FAR_FUTURE }] } }],
  ] as [string, Partial<ThreadView>][]) {
    const html = row(extra)
    assert.match(html, HOURGLASS, `${name} is still parked on the clock`)
    assert.doesNotMatch(html, GITHUB, `…so ${name} must not claim a PR watch`)
  }
})

test("a usage-limit park keeps the hourglass even when the fence carries a watch", () => {
  // The limit is what is holding this row — fray auto-resumes it when the window resets — so the mark
  // names THAT, not the PR it happened to be watching when the window ran out.
  const html = row({
    runtime: "exited",
    limitPause: { backend: "claude", window: "session", at: "2026-08-01T00:00:00.000Z", resumesAt: 32503680000, autoResume: true },
    lastFence: { kind: "awaiting", body: "PR is open.", hints: [watch("acme/app#391")] },
  } as unknown as Partial<ThreadView>)
  assert.match(html, HOURGLASS)
  assert.doesNotMatch(html, GITHUB)
})
