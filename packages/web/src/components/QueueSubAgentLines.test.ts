import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueueSubAgentLines } from "./QueueSubAgentLines.tsx"

test("queue cards show BOTH running and stale child work, and no model+effort tag", () => {
  const html = renderToStaticMarkup(createElement(QueueSubAgentLines, {
    slug: "parent-thread",
    subAgents: [
      {
        id: "running-child",
        label: "Complete GVS fix differential repro",
        startedAt: "2026-07-22T16:00:00.000Z",
        state: "running",
        subagentType: "frizz:opus-xhigh",
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
  // The model+effort tag was DELETED from these lines on 2026-07-27 (maintainer): the profile belongs
  // to the prompt box's own control one line above, not repeated on every child line beneath it.
  assert.doesNotMatch(html, /data-agent-profile/)
  assert.doesNotMatch(html, /opus › xhigh/)
  assert.doesNotMatch(html, /frizz:opus-xhigh/)
  // A STALE child now renders on the card too (maintainer ruling 2026-07-24): a stale child is
  // unresolved work, not gone, and hiding it made the card claim "done underneath" while the rail
  // still showed it. It gets the flat stale dot, not the pulsing running indicator.
  assert.match(html, /Old differential repro/)
  assert.match(html, /stale — no recent output/)
})
