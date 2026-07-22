import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueueSubAgentLines } from "./QueueSubAgentLines.tsx"

test("queue cards show running child work without profile or stale rows", () => {
  const html = renderToStaticMarkup(createElement(QueueSubAgentLines, {
    slug: "parent-thread",
    subAgents: [
      {
        id: "running-child",
        label: "Complete GVS fix differential repro",
        startedAt: "2026-07-22T16:00:00.000Z",
        state: "running",
        subagentType: "fray:opus-xhigh",
      },
      {
        id: "stale-child",
        label: "Old differential repro",
        startedAt: "2026-07-22T15:00:00.000Z",
        state: "stale",
      },
    ],
  }))

  assert.match(html, /data-queue-subagents/)
  assert.match(html, /Complete GVS fix differential repro/)
  assert.match(html, /data-running-indicator="queue-subagent"/)
  assert.doesNotMatch(html, /fray:opus-xhigh/)
  assert.doesNotMatch(html, /Old differential repro|stale/)
})
