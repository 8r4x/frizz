import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel } from "@frizz/shared"
import { ThreadLifecycleFooter } from "./components/ThreadLifecycleFooter.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the EYE's tooltip — the footer readout of a thread's armed watchers. It was read once
// as "Watching 2 things / Shell: bzvtnt3ig / Shell: b8m0w8qjk" and produced the wrong reading twice over
// (maintainer 2026-08-14: "shells are not watchers… I don't see either of them as background shells
// underneath the prompt box"), so what this surface is for is checking the copy AS IT WRAPS: the tooltip
// caps at 22rem, and the unseen-watcher caveat is the longest line the readout can draw.
//
// `?case=` picks the state. `?font=sans|mono` sets `data-font`, because this app renders in two type
// stacks and a line that fits on one can wrap on the other.

const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"

const SHELL = { id: "toolu_01MkxJgNuEsDomuqLTFqzzjU", taskId: "bzvtnt3ig", label: "Running a larger spot-check batch", startedAt: "2026-08-14T15:29:23.952Z", state: "running" as const, stoppable: true }
// Relative to the REAL clock, so the readout draws the same elapsed strings the maintainer's screenshot
// did (`since 34 min ago`) rather than an ever-growing distance from a frozen anchor.
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

// Each case is [what it is testing, the armed watchers, the live shells the strip would also be drawing].
const CASES: Record<string, { watches: ThreadViewModel["watches"]; bgShells: ThreadViewModel["bgShells"] }> = {
  // THE SHIPPED FIX: the target resolves to a live shell, so the tooltip names it the way the row under
  // the prompt box does instead of printing a runtime handle that appears nowhere else.
  resolved: {
    watches: [{ id: "wch_1", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(34), seen: true }],
    bgShells: [SHELL],
  },
  // THE MAINTAINER'S OWN SCREENSHOT: two watchers, neither target ever observed alive, no shells left to
  // point at. This is the longest the readout ever gets, and the case the wrap has to survive.
  wedged: {
    watches: [
      { id: "wch_1", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(34), seen: false },
      { id: "wch_2", kind: "shell", target: "b8m0w8qjk", state: "armed", createdAt: ago(8), seen: false },
    ],
    bgShells: [],
  },
  // The `github` kind shares this readout and has no registry row behind it.
  mixed: {
    watches: [
      { id: "wch_1", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(34), seen: true },
      { id: "github:t:colinhacks/zod#6382", kind: "github", target: "colinhacks/zod#6382", state: "armed", createdAt: ago(120), seen: true },
    ],
    bgShells: [SHELL],
  },
}

const active = CASES[params.get("case") ?? "wedged"] ?? CASES.wedged

const thread = {
  id: "watch-readout-demo",
  title: "Watch readout",
  status: "active",
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  runtime: "idle",
  archived: false,
  state: "open",
  subAgents: [],
  pendingQuestion: false,
  needsYou: true,
  context: { tokens: 348_950, window: 1_000_000 },
  lastActivityAt: "2026-08-14T16:04:00.000Z",
  ...active,
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
      {/* The footer is normally the bottom edge of a card, so give it one: the tooltip opens upward and
          needs somewhere to land, and the strip's own corner radius only reads against a border. */}
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <div className="h-40 p-4 text-[12px] text-muted">…transcript…</div>
        <ThreadLifecycleFooter thread={thread} />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
