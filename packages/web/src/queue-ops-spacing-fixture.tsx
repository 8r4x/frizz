import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the BOTTOM of a queue card: the docked prompt box and the line of op counts above it
// (QueueOpsSummary), whose hover panel holds the ⤷ AGENT / SHELL / File / Link rows. Until 2026-10-05
// the rows hung under the prompt box above a lifecycle footer, and this fixture measured that column's
// rhythm (the maintainer read the gap under the prompt box as too large); the rows keep that rhythm
// inside the panel, so it still measures them there.

const SLUG = "queue-ops-spacing-demo"

const messages: TranscriptMessage[] = [
  { role: "user", text: "Poll the panes and report what you find.", tools: [], parts: [{ kind: "text", text: "Poll the panes and report what you find." }] },
  {
    role: "assistant",
    text: "Three watchers are live; I'll fold their output in as they land.",
    tools: [],
    parts: [{ kind: "text", text: "Three watchers are live; I'll fold their output in as they land." }],
  },
]

const thread = {
  id: SLUG,
  title: "Ops-strip spacing",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  // ?agents=1 puts the live ⤷ sub-agent lines directly above the ⤷ shell rows — the adjacency the
  // strip's pt-1.5 is matched to, and the only state where the two lists' rhythm can be compared.
  subAgents: new URLSearchParams(location.search).get("agents") === "1"
    ? [{ id: "agent-a", label: "Diff the queue card against the drawer footer", startedAt: "2026-07-18T09:05:00.000Z", state: "running" }]
    : [],
  // ?shells=0 is the CONTROL case: with no live ops the counts line unmounts, so the prompt box must
  // still sit correctly on the dock's own 12px.
  // Every row carries an `id` so it renders the dismiss × — the shipped row has had one on all three
  // densities since 2026-07-30, and the × is the tallest thing on the line, so a fixture without it
  // measures a row height the app never draws.
  bgShells: new URLSearchParams(location.search).get("shells") === "0" ? [] : [
    { id: "shell-a", label: "Poll panes for perm-prompt false positives", startedAt: "2026-07-18T09:06:00.000Z", state: "stale" },
    { id: "shell-b", label: "Poll panes for near-miss perm markers", startedAt: "2026-07-18T09:07:00.000Z", state: "running" },
    { id: "shell-c", label: "Record 5min of frizz board SSE", startedAt: "2026-07-18T09:09:00.000Z", state: "running" },
  ],
  // ?links=1 appends the saved-reference rows (ThreadLinks) under the live ones — the one adjacency
  // in which a File/Link row's box can be read against an AGENT/SHELL row's. Their rows shipped
  // with `py-0.5 leading-5` on top of the ops rows' bare inherited line box, 24px against 17.25px
  // (maintainer 2026-09-11: "It should be the exact same spacing and padding"); this is where that
  // is measured.
  links: new URLSearchParams(location.search).get("links") === "1" ? [
    { id: "lnk_file_a", kind: "file", label: "Structured restriction report", target: "/tmp/reports/structured-restriction.md" },
    { id: "lnk_file_b", kind: "file", label: "HKS pair-merge report", target: "/tmp/reports/hks-pair-merge.md" },
    { id: "lnk_url", kind: "link", label: "Dev server", target: "http://127.0.0.1:5173/" },
  ] : [],
  lastActivityAt: "2026-07-18T09:11:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
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
