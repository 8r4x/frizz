import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StatusBar } from "./StatusBar.tsx"
import { projectIdentity } from "./Sidebar.tsx"

// The bar's ORDER is a spec, not an accident: identity → connection → settings → reload → Claude →
// Codex, left to right on one line. It used to be three separate pieces of chrome in three places
// (identity top-left, settings/reload top-right, quota floating over the sidebar composer), so a
// regression here is a silent return to that scatter rather than a visible break.
function render(label = "colinhacks/fray"): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(StatusBar, { identity: projectIdentity({ projectLabel: label }), connection: "open" }),
    ),
  )
}

test("the status bar lays identity, connection, settings and quota out in one left-to-right line", () => {
  const html = render()

  const identity = html.indexOf('data-project-identity-state="verified"')
  const connection = html.indexOf(">connected<")
  const settings = html.indexOf('aria-label="Settings"')
  const quota = html.indexOf("data-quota-bar")

  assert.ok(identity >= 0 && connection >= 0 && settings >= 0 && quota >= 0, "every segment renders")
  assert.ok(identity < connection, "the owner/repo slug leads")
  assert.ok(connection < settings, "the connection indicator precedes the actions")
  assert.ok(settings < quota, "the quota chips are the tail of the bar")
})

test("the bar is one fixed upper-left strip, not per-item corner chrome", () => {
  const html = render()

  assert.match(html, /data-status-bar/)
  // One line pinned top-left. The reload button is absent in a static render (it only appears
  // once the supervisor status resolves), which is why the order test above pins settings, not it.
  assert.match(html, /class="fixed top-2\.5 left-3 z-20 flex h-7/)
  assert.doesNotMatch(html, /top-3 right-3/)
})

test("the bar is an OPAQUE surface stacked above the sidebar, not bare glyphs on the page", () => {
  const html = render()

  // Its own fill + hairline: a full sidebar (composer pushed to the viewport top) and a scrolling
  // narrow rail both reach this corner, and with no background they painted straight through it.
  assert.match(html, /bg-panel/)
  assert.match(html, /border border-border/)
  // The sidebar deliberately carries NO z-index (see lib/overlaySurface.ts), so z-20 is what keeps the
  // list and the composer BEHIND the bar rather than over it.
  assert.match(html, /\bz-20\b/)
})

test("a cold identity still reserves its measure without collapsing the bar", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(StatusBar, { identity: projectIdentity(null), connection: "connecting" }),
    ),
  )

  assert.match(html, /identity-placeholder/)
  assert.match(html, /aria-label="Settings"/)
  assert.match(html, /data-quota-bar/)
})
