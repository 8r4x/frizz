import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadLifecycleFooter } from "./ThreadLifecycleFooter.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// ONE THING IS DESCRIBED IN ONE PLACE. The footer used to carry an eye whose tooltip listed every armed
// watcher — and every one of those objects was already a row in the strip directly above this footer,
// with its own liveness dot. The duplicate was the confusing copy: it named a background shell by the
// runtime handle (`bzvtnt3ig`) that appears nowhere else in the UI, so one shell read as two unrelated
// things (maintainer 2026-08-14: "shells are not watchers… I don't see either of them as background
// shells underneath the prompt box", then "we do not need to redundantly list out background shells
// inside of the watcher icon menu").
//
// These are ABSENCE tests, and absence tests are exactly the ones that rot silently — so they assert on
// the RENDERED MARKUP of a footer given watchers of every kind, rather than on the deleted component.
// A reintroduced list would have to render something here, and this catches it whatever it is called.

const base = {
  kind: "session",
  backend: "claude",
  title: "A worker",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
  foreign: false,
  state: "open",
  archived: false,
} as unknown as ThreadView

function footer(extra: Partial<ThreadView>): string {
  const thread = { ...base, id: "t", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadLifecycleFooter, { thread, sticky: true })),
    ),
  )
}

const SHELL_WATCH = { id: "wch_1", kind: "shell" as const, target: "bzvtnt3ig", state: "armed" as const, createdAt: new Date(Date.now() - 34 * 60_000).toISOString() }
const PR_WATCH = { id: "github:t:acme/app#391", kind: "github" as const, target: "acme/app#391", state: "armed" as const, createdAt: new Date(Date.now() - 120 * 60_000).toISOString() }

test("the footer names no watcher of any kind — the strip above it owns that", () => {
  for (const [name, watches] of [
    ["a shell watcher", [SHELL_WATCH]],
    ["a PR watcher", [PR_WATCH]],
    ["both", [SHELL_WATCH, PR_WATCH]],
  ] as [string, ThreadView["watches"]][]) {
    const html = footer({ watches })
    assert.match(html, /data-thread-lifecycle-footer/, `${name}: the footer itself still renders`)
    assert.doesNotMatch(html, /data-armed-watches/, `${name}: no watcher readout`)
    assert.doesNotMatch(html, /Watching/, `${name}: nothing claims to be watching`)
    // The two targets, in every spelling the old readout used. A shell's runtime handle must never
    // reach the operator at all — it names nothing they can see anywhere else.
    assert.doesNotMatch(html, /bzvtnt3ig/, `${name}: no runtime handle`)
    assert.doesNotMatch(html, /acme\/app#391/, `${name}: no PR ref`)
  }
})

// The footer's OTHER left-cluster marks are its neighbours in the same flex row, and removing one is
// exactly how a sibling gets deleted by accident. Pinned so the removal stays a removal of one thing.
test("removing it left the rest of the strip alone", () => {
  const html = footer({ watches: [SHELL_WATCH], context: { tokens: 348_950, window: 1_000_000 } })
  assert.match(html, /data-context-meter/, "the context donut still leads the cluster")
  assert.match(html, /aria-label="Mark as done"/, "the lifecycle verbs are untouched")
  assert.match(html, /aria-label="Snooze/, "…including Snooze")
})
