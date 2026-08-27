import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { Sidebar } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the BAND a declared park lands in, over the REAL <Sidebar/> and the real
// sectionThreads — which is what snoozed-rows-fixture cannot show, since that one hands SectionHeader and
// ThreadRow their rows already sorted. Every row here carries `awaitingBackground: true` the way
// board.ts sets it on a parked ```awaiting fence, because that flag is the whole bug: hasLiveOps read it
// as "its own dispatched work is still live", which stopped being what it means when a timer park
// started setting it (2026-08-24, f50f9e60). The timer row banded ACTIVE, which is the band for a thread
// with something in flight (maintainer 2026-08-26: "showing up in a separate rail that isn't held").
//
//   HELD (dimmed, labeled — the park band)
//     A  armed future timer, nothing else out   → hourglass   (THE CHANGE; was in Active)
//   ACTIVE (no queue card, something in flight)
//     B  live background shell behind the fence → blue dot    (unchanged — own work is never dimmed)
//     C  registered PR watcher, CI green        → ellipsis    (unchanged — a handoff must stay visible)
//
// A is the row that MOVED. B and C are the two OTHER parks the same flag describes, and they are the
// controls: the carve-out is `parkedOnArmedTimerAlone`, so anything else behind the fence keeps the row
// out of Snoozed exactly as before.

// The timer's own instant is computed at load so the wake always sits in the future.
const fireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

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
  subAgents: [],
  bgShells: [],
  needsYou: false,
  awaitingBackground: true,
  runtime: "turn-idle",
  spawnedAt: "2026-08-25T22:06:58.413Z",
} as const

// A — the reported row: an ```awaiting fence naming a timer that really is armed, and nothing else.
const timerPark = {
  ...base,
  id: "close-the-august-numbers",
  title: "Close the August numbers",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
  lastFence: {
    kind: "awaiting",
    body: "Seven commits on the branch, lint and typecheck clean. The timer fires next week for the closed-August report.",
    hints: [{ kind: "timer", value: "tmr_0028d7f6c28d" }, { kind: "for", value: "7d" }],
  },
  watches: [{
    id: "timer:close-the-august-numbers:tmr_0028d7f6c28d",
    kind: "timer", target: "tmr_0028d7f6c28d", state: "armed",
    createdAt: "2026-08-25T22:33:31.777Z",
    timer: { fireAt, prompt: "August is closed — generate the investor update and hand it over." },
  }],
  lastActivityAt: "2026-08-26T00:20:14.894Z",
  lastUserAt: "2026-08-26T00:19:45.772Z",
} as unknown as ThreadView

// B — CONTROL: the same fence shape parked on a background SHELL that is still running. Own live work
// is never dimmed (maintainer 2026-07-10), so this stays in Active wearing the pulsing dot.
const shellPark = {
  ...base,
  id: "port-the-v2-drivers",
  title: "Port the v2 drivers",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000002",
  lastFence: {
    kind: "awaiting",
    body: "Waiting on the three-platform run before porting the drivers.",
    hints: [{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }],
  },
  bgShells: [{ label: "nub run test --platforms", startedAt: "2026-08-26T00:10:00.000Z", state: "running" }],
  lastActivityAt: "2026-08-26T00:18:00.000Z",
  lastUserAt: "2026-08-26T00:05:00.000Z",
} as unknown as ThreadView

// C — CONTROL: a registered PR watcher whose CI has already gone green. Settled, so no dot — but a PR
// whose reviews may never arrive must not silently vanish into the dimmed band (maintainer 2026-07-22).
const prPark = {
  ...base,
  id: "fix-the-cache-collision",
  title: "Fix the cache collision",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000003",
  lastFence: {
    kind: "awaiting",
    body: "Ten checks green, no conflicts. Waiting on your merge.",
    hints: [{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "6h" }],
  },
  watches: [{
    id: "github:fix-the-cache-collision:acme/app#391",
    kind: "github", target: "acme/app#391", state: "armed",
    createdAt: "2026-08-26T00:00:00.000Z",
    github: {
      checks: "passing", running: 0, passed: 10, failed: 0, failing: [],
      merge: "mergeable", state: "open", polledAt: "2026-08-26T00:19:00.000Z",
    },
  }],
  lastActivityAt: "2026-08-26T00:15:00.000Z",
  lastUserAt: "2026-08-26T00:01:00.000Z",
} as unknown as ThreadView

store.board = {
  projectDir: "/fixture/frizz",
  threads: [timerPark, shellPark, prPark],
} as unknown as BoardSnapshot
store.drawers = []

// The rail's composer and its pickers read the ordinary RPC surface; answer everything with the empty
// success envelope so nothing real is hit and no request can fail the render.
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname.startsWith("/_frizz/rpc/")) {
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
