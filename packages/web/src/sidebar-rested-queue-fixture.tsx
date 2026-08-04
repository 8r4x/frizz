import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { Sidebar } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the RESTED-WITH-A-BACKGROUND-SHELL indicator (maintainer 2026-08-01: "if a thread has
// rested but it still has background work going, like background shells, we should keep it in the
// actively running rail, but we should stop the spinner and put a pulsing blue dot in the middle of the
// rounded circle shape" — and, scoping it, "this should not show up if there are sub-agents"). Renders
// the REAL <Sidebar/> — the same ThreadRow + indented SubAgentRows the app draws — over a fixed
// five-thread board that pins the one changed case against the four that must NOT change:
//
//   RUNNING BAND (live work that isn't waiting on you — and NOTHING here has a queue card)
//     B  own turn in flight + a live child        → [/] spinner   (unchanged)
//     C  at rest, live child, not queued          → [/] spinner   (unchanged — the child comes back)
//     E  at rest, background SHELL only           → [•] blue dot  (THE CHANGE; was […], one band down)
//   RESTED BAND (the queue order — every row here HAS a card)
//     A  at rest, QUEUED, live children           → […] ellipsis  (unchanged — 2026-07-27)
//     D  at rest, queued, nothing out             → […] ellipsis  (unchanged baseline)
//
// E is the row that MOVED, and the pair C/E is the whole point of the split: a dispatched CHILD will
// return and re-invoke its parent, so that row is genuinely in motion and spins; a detached SHELL will
// not, so its row is alive but still, and pulses instead.
//
// E's `needsYou: false` is SERVER TRUTH, not fixture convenience: board.deriveNeedsYou excuses a rest on
// live own work from the queue entirely (maintainer 2026-08-01: "if something is listed as currently
// running, then it should never show up in the queue"). The band split IS the queue split — a row above
// the rule never has a card, a row below it always does. The CHILD rows keep their own spinners
// throughout: they really are still going.

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

// A — the 2026-07-27 case: rested, queued (the awaiting-background handoff), two live sub-agents. It
// keeps the ellipsis and the rested band; the shell rule below deliberately does not reach it.
const restedQueued = {
  ...base,
  id: "refactor-pricing-parser",
  title: "Refactor the pricing parser",
  runtime: "turn-idle",
  needsYou: true,
  awaitingBackground: true,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
  subAgents: [
    child("a1", "Audit the parser for edge cases", "frizz:opus-high", "2026-07-27T09:05:00.000Z"),
    child("a2", "Write property tests for the tiers", "frizz:sonnet-high", "2026-07-27T09:05:20.000Z"),
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
  subAgents: [child("b1", "Reproduce the nudge on a live tail", "frizz:sonnet-medium", "2026-07-27T09:06:00.000Z")],
  lastActivityAt: "2026-07-27T09:08:00.000Z",
  lastUserAt: "2026-07-27T09:02:00.000Z",
} as unknown as ThreadView

// C — CONTROL, and the direct comparison for E: at rest with a live child but NOT queued (its
// awaiting-background card is event-snoozed). Nothing has been handed to the human and the child's
// return will re-invoke this thread, so the row is honestly still in motion → spinner.
const cookingNotQueued = {
  ...base,
  id: "audit-broker-crash-paths",
  title: "Audit the broker crash paths",
  runtime: "turn-idle",
  needsYou: false,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000003",
  subAgents: [child("c1", "Trace every exit the broker can take", "frizz:opus-medium", "2026-07-27T09:04:00.000Z")],
  lastActivityAt: "2026-07-27T09:06:30.000Z",
  lastUserAt: "2026-07-27T09:01:00.000Z",
} as unknown as ThreadView

// D — BASELINE: the ordinary bare rested queue handoff. NOTHING it launched is still running, so it is
// the one row that keeps the ellipsis and the one row that belongs in the queue-ordered rested band.
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

// E — THE CASE UNDER TEST: rested with a background SHELL and NO sub-agents at all. Excused from the
// queue like any other running row, so it sits in the running band with no card behind it; the
// awaiting-background card still states the fact in the drawer and on the full-screen page.
const shellOnlyRested = {
  ...base,
  id: "wire-up-the-preview-server",
  title: "Wire up the preview server",
  runtime: "turn-idle",
  needsYou: false,
  awaitingBackground: true,
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000005",
  subAgents: [],
  bgShells: [{ label: "nub run dev --host", startedAt: "2026-07-27T09:02:00.000Z", state: "running" }],
  lastActivityAt: "2026-07-27T09:05:40.000Z",
  lastUserAt: "2026-07-27T08:58:00.000Z",
} as unknown as ThreadView

store.board = {
  projectDir: "/fixture/frizz",
  threads: [restedQueued, ownTurnRunning, cookingNotQueued, bareRestedQueued, shellOnlyRested],
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
