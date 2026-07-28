import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { Sidebar } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the RESTED-QUEUE indicator (maintainer 2026-07-27: "when an agent comes to rest and
// shows up in the queue, it should get the ellipsis indicator in the sidebar, even though its
// sub-agents are still spinning"). Renders the REAL <Sidebar/> — the same ThreadRow + indented
// SubAgentRows the app draws — over a fixed four-thread board that pins the one changed case against
// the three neighbours that must NOT change:
//
//   RUNNING BAND (live work that isn't waiting on you)
//     B  own turn in flight + a live child        → [/] spinner   (unchanged)
//     C  at rest, live children, NOT queued       → [/] spinner   (unchanged — still just cooking)
//   RESTED BAND (the queue order)
//     A  at rest, QUEUED, live children           → […] ellipsis  (THE CHANGE; was [/])
//     D  at rest, queued, no children             → […] ellipsis  (unchanged baseline)
//
// In every case the CHILD rows keep their own spinners — that is the point: the parent stops claiming
// motion it does not have, and the children go on reporting themselves.

const base = {
  kind: "session",
  state: "open",
  status: "active",
  mechanism: null,
  backend: "claude",
  permissionMode: "default",
  humanBlocked: false,
  pendingQuestion: false,
  crashed: false,
  archived: false,
  foreign: false,
  ready: false,
  unread: false,
  hasPlan: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  bgShells: [],
  spawnedAt: "2026-07-27T09:00:00.000Z",
} as const

const child = (id: string, label: string, subagentType: string, startedAt: string) =>
  ({ id, label, subagentType, startedAt, state: "running" as const })

// A — THE CASE UNDER TEST. Rested, queued (the awaiting-background handoff), two live sub-agents.
const restedQueued = {
  ...base,
  id: "refactor-pricing-parser",
  title: "Refactor the pricing parser",
  runtime: "turn-idle",
  needsYou: true,
  awaitingBackground: true,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
  subAgents: [
    child("a1", "Audit the parser for edge cases", "fray:opus-high", "2026-07-27T09:05:00.000Z"),
    child("a2", "Write property tests for the tiers", "fray:sonnet-high", "2026-07-27T09:05:20.000Z"),
  ],
  lastActivityAt: "2026-07-27T09:07:00.000Z",
  lastUserAt: "2026-07-27T09:00:00.000Z",
} as unknown as ThreadView

// B — CONTROL: the parent's OWN turn is in flight. Must keep the spinner.
const ownTurnRunning = {
  ...base,
  id: "sweep-tailer-nudges",
  title: "Sweep the tailer nudge regressions",
  runtime: "running",
  needsYou: false,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000002",
  subAgents: [child("b1", "Reproduce the nudge on a live tail", "fray:sonnet-medium", "2026-07-27T09:06:00.000Z")],
  lastActivityAt: "2026-07-27T09:08:00.000Z",
  lastUserAt: "2026-07-27T09:02:00.000Z",
} as unknown as ThreadView

// C — CONTROL: at rest with a live child but NOT queued (its awaiting-background card is event-snoozed).
// Nothing has been handed to the human, so the row is honestly still cooking → spinner.
const cookingNotQueued = {
  ...base,
  id: "audit-broker-crash-paths",
  title: "Audit the broker crash paths",
  runtime: "turn-idle",
  needsYou: false,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000003",
  subAgents: [child("c1", "Trace every exit the broker can take", "fray:opus-medium", "2026-07-27T09:04:00.000Z")],
  lastActivityAt: "2026-07-27T09:06:30.000Z",
  lastUserAt: "2026-07-27T09:01:00.000Z",
} as unknown as ThreadView

// D — BASELINE: the ordinary bare rested queue handoff that has always shown the ellipsis.
const bareRestedQueued = {
  ...base,
  id: "fix-queue-focus",
  title: "Fix queue focus after an archive",
  runtime: "turn-idle",
  needsYou: true,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000004",
  subAgents: [],
  lastActivityAt: "2026-07-27T09:03:00.000Z",
  lastUserAt: "2026-07-27T08:55:00.000Z",
} as unknown as ThreadView

store.board = {
  projectDir: "/fixture/fray",
  threads: [restedQueued, ownTurnRunning, cookingNotQueued, bareRestedQueued],
  plans: [],
} as unknown as BoardSnapshot
store.drawers = []

// The rail's composer and its pickers read the ordinary RPC surface; answer everything with the empty
// success envelope so nothing real is hit and no request can fail the render.
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname.startsWith("/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <div className="flex min-h-screen bg-bg text-fg">
        <Sidebar />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
