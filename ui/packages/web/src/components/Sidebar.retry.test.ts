import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The sidebar's one-click recovery verb. It must appear on EXACTLY the rows the rail already marks
// stalled with [!] — never on a row that is working, resting, held, done, or read-only-foreign, since
// on those "retry" either means nothing or would interrupt live work.

const base = {
  kind: "session",
  backend: "claude",
  title: "A worker that fell over",
  status: "active",
  subAgents: [],
} as unknown as ThreadView

function row(extra: Partial<ThreadView>) {
  const t = { ...base, id: "stalled-thread", ...extra } as ThreadView
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ThreadRow, { t })))
}

const STALLED = { runtime: "exited", crashed: true, needsYou: true } as Partial<ThreadView>

test("a stalled row carries a hover-revealed retry button, right-justified", () => {
  const html = row(STALLED)
  assert.match(html, /data-sidebar-retry="stalled-thread"/, "the stalled row exposes the retry control")
  assert.match(html, /aria-label="Retry exited session"/, "…with an accessible name")
  const btn = html.slice(html.indexOf("data-sidebar-retry"))
  assert.match(btn, /absolute right-1/, "it is pinned to the row's right edge")
  assert.match(btn, /\bhidden\b/, "hidden until the row is pointed at")
  assert.match(btn, /group-hover:flex/, "…and revealed on row hover")
  assert.match(btn, /group-focus-within:flex/, "…and reachable from the keyboard via the row's focus")
})

test("the older exited+needsYou snapshot shape (no `crashed` field) still gets the button", () => {
  assert.match(row({ runtime: "exited", needsYou: true }), /data-sidebar-retry/)
})

test("no retry button on rows that are not stalled", () => {
  for (const [name, extra] of [
    ["working", { runtime: "running" }],
    ["at rest", { runtime: "turn-idle" }],
    ["needs input", { runtime: "exited", crashed: true, humanBlocked: true }],
    ["done", { runtime: "turn-idle", lastFence: { kind: "done", hints: [] } }],
    ["archived", { runtime: "exited", crashed: true, state: "archived" }],
    ["foreign (read-only)", { runtime: "exited", crashed: true, needsYou: true, foreign: true }],
  ] as [string, Partial<ThreadView>][]) {
    assert.doesNotMatch(row(extra), /data-sidebar-retry/, `a ${name} row must not offer retry`)
  }
})

test("a legacy row keeps its Mark-as verb and never grows a retry button", () => {
  const t = { ...base, ...STALLED, id: "legacy-row", kind: "legacy" } as unknown as ThreadView
  const html = renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ThreadRow, { t, legacy: true })),
  )
  assert.doesNotMatch(html, /data-sidebar-retry/)
  assert.match(html, /Mark as/)
})
