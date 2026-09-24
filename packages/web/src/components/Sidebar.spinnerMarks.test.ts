import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@frizz/shared"
import { sessionIndicatorFor } from "./Sidebar.tsx"

// THE SPINNER IS THE FRAME, THE MARK INSIDE SAYS WHAT IS ALIVE (2026-09-20). The maintainer's rule for
// the Running band: "everything in the running rail should always have this spinner animation going —
// an empty square if the thread is actively running, a blue dot if there's a background shell, a solid,
// non-pulsing blue dot", and for a parent resting on its sub-agents "the three ellipses for the top-level
// parent agent with the spinner, and then the sub-agents can have their own spinners". A PR wait joins
// the family while its checks run (maintainer: it "should just stay in the running rail if it's actively
// waiting on checks") and drops back to the static octocat once they settle.
//
// The spinner is identified by its <animate> child — the one element in the family that only the
// BoxSpinner renders — and the inner marks by lucide's stamped class or the dot's own class. Asserting
// on rendered markup rather than on element types is what pins the COMPOSITION: an ellipsis and a
// spinner both present is a different picture from either alone.

const base = {
  kind: "session",
  state: "open",
  status: "active",
  backend: "claude",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
  bgShells: [],
  watches: [],
} as unknown as ThreadView

const liveChild = [{ id: "a1", label: "review", startedAt: "2026-09-20T09:05:00.000Z", state: "running" as const }]
const liveShell = [{ label: "nub run dev", startedAt: "2026-09-20T09:02:00.000Z", state: "running" as const }]

const prWatch = (github?: Record<string, unknown>) => [{
  id: "wch_1",
  kind: "github" as const,
  target: "acme/app#391",
  state: "armed" as const,
  createdAt: "2026-09-20T09:00:00.000Z",
  ...(github ? { github: { checks: "running", running: 2, passed: 1, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "unknown", state: "open", polledAt: "2026-09-20T09:01:00.000Z", ...github } } : {}),
}]

const markup = (over: Partial<ThreadView>) => renderToStaticMarkup(sessionIndicatorFor({ ...base, ...over } as ThreadView).node)
const spins = (html: string) => html.includes("<animate ")

test("own turn running: the empty spinner, nothing inside", () => {
  const html = markup({ runtime: "running" })
  assert.ok(spins(html), "the box traces")
  assert.ok(!html.includes("lucide-"), "and holds no glyph")
  assert.ok(!html.includes("frizz-rail-dot"), "and no dot")
})

test("a parent at rest with a sub-agent out: the ellipsis inside the spinner", () => {
  const html = markup({ subAgents: liveChild })
  assert.ok(spins(html), "the child's return will re-invoke it, so the box traces")
  assert.ok(html.includes("lucide-ellipsis"), "the parent itself has stopped, so the ellipsis sits inside")
  assert.equal(sessionIndicatorFor({ ...base, subAgents: liveChild } as ThreadView).tip, "At rest — waiting on its sub-agents")
})

test("a parent whose OWN turn runs keeps the empty spinner even with a child out", () => {
  const html = markup({ runtime: "running", subAgents: liveChild })
  assert.ok(spins(html))
  assert.ok(!html.includes("lucide-ellipsis"), "the ellipsis says 'at rest', and this thread is not")
})

test("resting on a live background shell: the solid blue dot inside the spinner", () => {
  const html = markup({ awaitingBackground: true, bgShells: liveShell })
  assert.ok(spins(html), "something will wake this, so the box traces")
  assert.ok(html.includes("frizz-rail-dot"), "the dot says it is a shell")
})

test("awaiting a PR: the octocat spins while checks run, and stands still once they settle", () => {
  const running = markup({ needsYou: false, awaitingBackground: true, watches: prWatch({}) as never })
  assert.ok(running.includes("lucide-github"), "GitHub's mark")
  assert.ok(spins(running), "inside the spinner while CI runs")
  for (const [what, github] of [
    ["passing", { checks: "passing", running: 0, passed: 3 }],
    ["failing", { checks: "failing", running: 0, failed: 1 }],
    ["merged", { checks: "running", running: 1, state: "merged" }],
  ] as const) {
    const settled = markup({ needsYou: true, watches: prWatch(github) as never })
    assert.ok(settled.includes("lucide-github"), `${what}: still GitHub's mark`)
    assert.ok(!spins(settled), `${what}: in the static box — the wait is on a person now`)
  }
  const unpolled = markup({ needsYou: true, watches: prWatch() as never })
  assert.ok(unpolled.includes("lucide-github") && !spins(unpolled), "an unpolled PR is not known to be moving")
})

test("gated CI reads `running` but does not spin — nothing moves until a maintainer approves", () => {
  const gated = markup({ needsYou: true, watches: prWatch({ running: 0, gated: 3, gating: ["Test Linux", "Test macOS", "Linters"] }) as never })
  assert.ok(gated.includes("lucide-github"))
  assert.ok(!spins(gated), "a spinner over a gate would promise motion for as long as nobody notices")
  const partlyGated = markup({ needsYou: false, awaitingBackground: true, watches: prWatch({ running: 1, gated: 2, gating: ["Test macOS", "Linters"] }) as never })
  assert.ok(spins(partlyGated), "one live run beside the gate is real motion")
})

test("a plain rest keeps the static box with the ellipsis — no spinner, nothing of this thread is out", () => {
  const html = markup({ needsYou: true })
  assert.ok(html.includes("lucide-ellipsis"))
  assert.ok(!spins(html))
})
