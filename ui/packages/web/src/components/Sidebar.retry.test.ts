import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The sidebar's one-click recovery verb. It must appear on EXACTLY the rows that actually STOPPED and
// can resume — a session whose PROCESS EXITED, whether it died mid-turn or exited after resting without
// a done fence — and on exactly those rows it must ALSO paint the yellow [!] stalled mark. Never on a
// row that is working, needs-input ([?], answered not retried), held, done, archived, or
// read-only-foreign — on those "retry" either means nothing, has a better-suited affordance, or would
// interrupt live work.

const base = {
  kind: "session",
  backend: "claude",
  title: "A worker that fell over",
  status: "active",
  subAgents: [],
} as unknown as ThreadView

// Retry is an ordinary eager send (lib/retrySession → sendEagerFollowUp), so the button writes its
// optimistic bubble into the transcript cache and needs a real client — the same one the app always
// provides. Rendering without it is how a row would blow up in production, so the harness supplies it.
function row(extra: Partial<ThreadView>) {
  const t = { ...base, id: "stalled-thread", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t })),
    ),
  )
}

const STALLED = { runtime: "exited", crashed: true, needsYou: true } as Partial<ThreadView>

test("a stalled row carries a hover-revealed retry button, right-justified", () => {
  const html = row(STALLED)
  assert.match(html, /data-sidebar-retry="stalled-thread"/, "the stalled row exposes the retry control")
  assert.match(html, /aria-label="Retry exited session"/, "…with an accessible name")
  const btn = html.slice(html.indexOf("data-sidebar-retry"))
  assert.match(btn, /absolute right-1\.5/, "it is pinned to the row's right edge")
  assert.match(btn, /h-\[19px\]/, "sized to the title's first line — never taller than the row")
  assert.match(btn, /text-muted/, "a quiet grey icon, not an accent box")
  assert.match(btn, /\bhidden\b/, "hidden until the row is pointed at")
  assert.match(btn, /group-hover:flex/, "…and revealed on row hover")
  assert.match(btn, /group-focus-within:flex/, "…and reachable from the keyboard via the row's focus")
})

test("the older exited+needsYou snapshot shape (no `crashed` field) still gets the button", () => {
  assert.match(row({ runtime: "exited", needsYou: true }), /data-sidebar-retry/)
})

test("an exited-at-rest row (process gone, no done fence, not a crash) also gets the button", () => {
  // The worker's process EXITED after resting without a done fence. The drawer offered Retry
  // (canRetry) but the rail did not; now it does.
  assert.match(row({ runtime: "exited", crashed: false }), /data-sidebar-retry="stalled-thread"/)
})

// The stalled mark the operator looks for: the accent (yellow, #e8b923) checkbox around a bold "!".
const STALLED_MARK = /border-accent\/90[\s\S]*?text-accent[^>]*>!</

test("the Retry verb and the yellow [!] mark always ship together on the SAME row", () => {
  // THE REPORTED BUG (maintainer 2026-07-23): "the card in the queue has a retry button, but it's not
  // marked as stalled in the sidebar with the yellow and the exclamation point". The row's mark gated
  // on the server's `crashed` bit while the Retry verb gated on the process being gone, so an
  // exited-at-rest thread rendered a Retry button beside a calm "At rest" […]. ONE predicate now
  // decides both — this pins the pairing on the rendered DOM, where the operator actually sees it.
  for (const [name, extra] of [
    ["exited mid-turn (crashed)", { runtime: "exited", crashed: true, needsYou: true }],
    ["exited at bare rest", { runtime: "exited", crashed: false }],
    ["exited, pre-reload snapshot with no `crashed` field", { runtime: "exited", needsYou: true }],
    ["exited at rest and NOT queued", { runtime: "exited", crashed: false, needsYou: false }],
  ] as [string, Partial<ThreadView>][]) {
    const html = row(extra)
    assert.match(html, /data-sidebar-retry/, `a ${name} row offers Retry`)
    assert.match(html, STALLED_MARK, `…so a ${name} row must ALSO wear the yellow [!] mark`)
  }
})

test("no retry button — and no yellow [!] either — on rows that are not stalled", () => {
  for (const [name, extra] of [
    ["working", { runtime: "running" }],
    ["at rest but still live (turn-idle, process not exited)", { runtime: "turn-idle" }],
    ["needs input (exited mid-ask — answered, not retried)", { runtime: "exited", crashed: true, humanBlocked: true }],
    ["done", { runtime: "turn-idle", lastFence: { kind: "done", hints: [] } }],
    ["done and exited (process gone but it finished)", { runtime: "exited", lastFence: { kind: "done", hints: [] } }],
    ["archived", { runtime: "exited", crashed: true, state: "archived" }],
    ["foreign (read-only)", { runtime: "exited", crashed: true, needsYou: true, foreign: true }],
  ] as [string, Partial<ThreadView>][]) {
    const html = row(extra)
    assert.doesNotMatch(html, /data-sidebar-retry/, `a ${name} row must not offer retry`)
    assert.doesNotMatch(html, STALLED_MARK, `…nor wear the yellow [!] stalled mark`)
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
