import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the resting card ON THE QUEUE: a thread that came to rest while its OWN background work
// is still live and no human ask is outstanding renders the informational banner + the event "Snooze"
// button and its explainer (see TodosView.AwaitingBackgroundBanner). snoozeAwaitingBackground is mocked so
// nothing real is hit; clicking Snooze fades the card out.
//
// DEFAULT = THE SHELL-ONLY REST, because since 2026-08-04 that is the only shape the server actually puts
// in the queue: a rest on a live SUB-AGENT is excused from it (board.deriveNeedsYou), so the sub-agent
// wording below is reachable only in the drawer / full-screen page. `?agents=1` renders it anyway — it is
// the same component and the same card, and the two voices are worth eyeballing side by side.
//
// The SAME card renders in the drawer and on the full-screen page WITHOUT the Snooze — that pair is
// server-derived (board.awaitingBackground), so it is verified against a real stack rather than here:
// `nub scripts/seed-resting-thread.mjs --home=… --socket=…` against an adhoc stack seeds a thread at
// rest with live children, then /thread/<slug> and /thread/<slug>/full show the button-less card.

const SLUG = "awaiting-bg-demo"
const params = new URLSearchParams(location.search)
// ?watch=1 — the PR-WATCH PARK, which reaches this card as of 2026-08-13: its awaiting fence no longer
// offers a park action, so this card is where the wait is stated and its event-snooze is the one control.
// ?watch=both — a thread holding a shell AND a watcher, so the sentence has to name both kinds.
const watchMode = params.get("watch")
const wantAgents = params.get("agents") === "1"
const wantWatch = watchMode !== null
// Shells are the DEFAULT shape; ?agents=1 swaps them for sub-agents, and ?watch=1 for a lone watcher.
const wantShells = !wantAgents && watchMode !== "1"
const shellOnly = wantShells && !wantAgents

const tail = shellOnly
  ? "Left the dev server and the CI poller running; I'll pick this back up when they report."
  : "Dispatched two audit sub-agents; I'll fold their findings in when they return."

const messages: TranscriptMessage[] = [
  { role: "user", text: "Refactor the pricing parser and verify it end-to-end.", tools: [], parts: [{ kind: "text", text: "Refactor the pricing parser and verify it end-to-end." }] },
  { role: "assistant", text: tail, tools: [], parts: [{ kind: "text", text: tail }] },
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
  subAgents: !wantAgents ? [] : [
    { id: "agent-a", label: "Audit the parser for edge cases", subagentType: "frizz:opus-high", startedAt: "2026-07-23T09:05:00.000Z", state: "running" },
    { id: "agent-b", label: "Write property tests for the tiers", subagentType: "frizz:sonnet-high", startedAt: "2026-07-23T09:05:20.000Z", state: "running" },
  ],
  bgShells: !wantShells ? [] : [
        { label: "vite dev --host", startedAt: "2026-07-23T09:06:00.000Z", state: "running" },
        { label: "gh run watch 1842", startedAt: "2026-07-23T09:06:10.000Z", state: "running" },
      ],
  watches: wantWatch
    ? [{ id: "github:demo:acme/app#391", kind: "github", target: "acme/app#391", state: "armed", createdAt: "2026-07-23T09:04:00.000Z" }]
    : [],
  lastActivityAt: "2026-07-23T09:07:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_frizz/rpc/snoozeAwaitingBackground") {
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "snoozeAwaitingBackground", body: JSON.parse(String(init?.body ?? "{}")) } }))
    // A void mutation serializes as {result:null} (rpc/server.ts) — mirror that so the web client parses success.
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
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
