import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The provider mark is an atomic inline box, so the line breaker may break right before it — which
// stranded it alone on a second line under a wrapping title. It must ride with the title's last word.
function row(title: string) {
  const thread = {
    id: "title-trailers",
    kind: "session",
    title,
    titleLocked: true,
    backend: "claude",
    runtime: "turn-idle",
    status: "running",
    subAgents: [],
  } as unknown as ThreadView
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ThreadRow, { t: thread })),
  )
}

test("the provider mark shares a nowrap group with the title's last word", () => {
  const html = row("Render steered and send message with full width notifications")

  assert.match(
    html,
    /<span class="whitespace-nowrap">notifications<span role="img" aria-label="[^"]*"/,
    "the last word and the provider mark cannot be split across lines",
  )
  assert.match(html, /Render steered and send message with full width /, "the rest of the title still wraps freely")
})

test("an over-long last word glues only its tail, so its head can still break", () => {
  const html = row("Fix ThisIsOneAbsurdlyLongUnbreakableIdentifier")

  assert.match(
    html,
    /ThisIsOneAbsurdlyLongUnbreakab<span class="whitespace-nowrap">leIdentifier<span role="img"/,
    "the mark keeps company without a rail-width token being glued whole",
  )
})

test("a single-word title still glues the mark to it", () => {
  const html = row("Triage")

  assert.match(html, /<span class="whitespace-nowrap">Triage<span role="img"/, "no leading text is invented")
})
