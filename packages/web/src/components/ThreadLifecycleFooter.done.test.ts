import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadLifecycleFooter } from "./ThreadLifecycleFooter.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// A COMPLETED thread used to render no lifecycle strip at all, which left its full view with nothing
// anywhere that said the thread was finished — just a title, an activity stamp and a composer
// (maintainer 2026-07-29, on a /full page: "why does this not have a footer with the mark as done
// button?"). The strip now stays and STATES the state. These assertions pin both halves of that: the
// readout appears, and the verbs it replaces do not come back on a thread that cannot take them.

const base = {
  kind: "session",
  backend: "claude",
  title: "A worker",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
  foreign: false,
} as unknown as ThreadView

function footer(extra: Partial<ThreadView>): string {
  const thread = { ...base, id: "t", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadLifecycleFooter, { thread, sticky: true, safeArea: true })),
    ),
  )
}

const STRIP = /data-thread-lifecycle-footer/
const DONE_READOUT = /data-thread-done/
const MARK_AS_DONE = /aria-label="Mark as done"/
const SNOOZE = /aria-label="Snooze/

test("a done thread keeps its lifecycle strip and reads Done where the verbs were", () => {
  for (const [name, extra] of [
    ["state column", { state: "archived", archived: true }],
    ["legacy flag only (rolling reload)", { archived: true }],
  ] as [string, Partial<ThreadView>][]) {
    const html = footer(extra)
    assert.match(html, STRIP, `a done thread (${name}) still renders the strip`)
    assert.match(html, DONE_READOUT, `a done thread (${name}) states that it is done`)
    assert.doesNotMatch(html, MARK_AS_DONE, `a done thread (${name}) cannot be marked done again`)
    assert.doesNotMatch(html, SNOOZE, `a done thread (${name}) cannot be snoozed — the server rejects it`)
  }
})

// The strip is also the ONLY home of the context reading and of the thread column's safe-area inset, so
// suppressing it on a done thread silently dropped both. Pinned here because neither is visible in the
// "Done" copy: a regression would look like nothing at all.
test("a done thread still shows its context reading and keeps the safe-area inset", () => {
  const html = footer({ state: "archived", archived: true, context: { tokens: 348_950, window: 1_000_000 } })
  assert.match(html, /data-context-meter/, "the context donut lives in this strip and nowhere else")
  assert.match(html, /data-context-percent="34"/)
  assert.match(html, /env\(safe-area-inset-bottom\)/, "the thread column's device inset is this strip's padding")
})

test("an open thread keeps the verbs and says nothing about being done", () => {
  const html = footer({ state: "open", archived: false })
  assert.match(html, STRIP)
  assert.match(html, MARK_AS_DONE)
  assert.match(html, SNOOZE)
  assert.doesNotMatch(html, DONE_READOUT)
})

// The readout asserts a completion frizz itself recorded. A foreign/legacy thread has no such record,
// so it gets no strip at all rather than a "Done" frizz cannot vouch for.
test("an unowned thread gets no strip, done-looking or not", () => {
  for (const extra of [
    { foreign: true },
    { foreign: true, state: "archived", archived: true },
    { kind: "legacy" },
    { kind: "legacy", state: "archived", archived: true },
  ] as Partial<ThreadView>[]) {
    const html = footer(extra)
    assert.doesNotMatch(html, STRIP)
    assert.doesNotMatch(html, DONE_READOUT)
  }
})
