import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@fray-ui/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the AWAITING-BACKGROUND card: a queued thread that came to rest while its OWN dispatched
// sub-agents are still live and no human ask is outstanding renders the informational banner + the event
// "Snooze" button (see TodosView.AwaitingBackgroundBanner). ?shells=1 exercises the shell-only wording.
// snoozeAwaitingBackground is mocked so nothing real is hit; clicking Snooze fades the card out.

const SLUG = "awaiting-bg-demo"
const shellOnly = new URLSearchParams(location.search).get("shells") === "1"

const messages: TranscriptMessage[] = [
  { role: "user", text: "Refactor the pricing parser and verify it end-to-end.", tools: [], parts: [{ kind: "text", text: "Refactor the pricing parser and verify it end-to-end." }] },
  {
    role: "assistant",
    text: "Dispatched two audit sub-agents; I'll fold their findings in when they return.",
    tools: [],
    parts: [{ kind: "text", text: "Dispatched two audit sub-agents; I'll fold their findings in when they return." }],
  },
]

const thread = {
  id: SLUG,
  title: "Refactor the pricing parser",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: true,
  awaitingBackground: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "idle",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: shellOnly ? [] : [
    { id: "agent-a", label: "Audit the parser for edge cases", subagentType: "fray:opus-high", startedAt: "2026-07-23T09:05:00.000Z", state: "running" },
    { id: "agent-b", label: "Write property tests for the tiers", subagentType: "fray:sonnet-high", startedAt: "2026-07-23T09:05:20.000Z", state: "running" },
  ],
  bgShells: shellOnly ? [{ label: "vite dev --host", startedAt: "2026-07-23T09:06:00.000Z", state: "running" }] : [],
  lastActivityAt: "2026-07-23T09:07:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/fray", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/rpc/threadTranscript" || url.pathname === "/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/rpc/snoozeAwaitingBackground") {
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "snoozeAwaitingBackground", body: JSON.parse(String(init?.body ?? "{}")) } }))
    // A void mutation serializes as {result:null} (rpc/server.ts) — mirror that so the web client parses success.
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
      <TodosView />
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
