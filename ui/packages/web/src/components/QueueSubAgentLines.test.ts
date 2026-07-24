import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueueSubAgentLines } from "./QueueSubAgentLines.tsx"

test("queue cards show BOTH running and stale child work, without the profile tag", () => {
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
  // The queue card carries no worker-profile tag — it names the work, it isn't the ops toolbar.
  assert.doesNotMatch(html, /fray:opus-xhigh/)
  // A STALE child now renders on the card too (maintainer ruling 2026-07-24): a stale child is
  // unresolved work, not gone, and hiding it made the card claim "done underneath" while the rail
  // still showed it. It gets the flat stale dot, not the pulsing running indicator.
  assert.match(html, /Old differential repro/)
  assert.match(html, /stale — no recent output/)
})
