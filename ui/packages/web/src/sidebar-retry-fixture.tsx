import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./components/Sidebar.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// The sidebar's one-click recovery verb: a STOPPED row (an exited session) exposes a hover-revealed
// Retry on its right edge. This fixture renders the REAL ThreadRow for two stopped rows — a [!] stalled
// crash AND a […] exited-at-rest (process gone, no done fence) — plus, for contrast, a live working row
// and a live turn-idle resting row (neither may grow the button). Clicking Retry POSTs the ordinary
// follow-up; we stub /rpc/followUp so the click drives the real retrySession → showToast → Toaster path
// end to end and records that the RPC actually fired.

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/rpc/followUp") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    const log = JSON.parse(window.sessionStorage.getItem("followUpCalls") ?? "[]")
    log.push(body)
    window.sessionStorage.setItem("followUpCalls", JSON.stringify(log))
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const base = {
  kind: "session",
  backend: "claude",
  titleAuto: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  archived: false,
  foreign: false,
  state: "open",
  subAgents: [],
  bgShells: [],
  spawnedAt: "2026-07-23T09:00:00.000Z",
  lastAssistantAt: "2026-07-23T12:00:00.000Z",
} as const

// A worker that EXITED mid-turn — the [!] stalled state. This row gets the hover Retry.
const stalledThread = {
  ...base,
  id: "stalled-migration",
  title: "Migrate the tailer launch-race fix onto every backend",
  runtime: "exited",
  status: "active",
  crashed: true,
  needsYou: true,
} as unknown as ThreadView

// A worker whose process EXITED after resting WITHOUT a done fence — the […] at-rest mark, not a crash.
// The drawer offered Retry (canRetry) but the rail did not; now this stopped row gets the hover Retry too.
const exitedAtRestThread = {
  ...base,
  id: "exited-at-rest",
  title: "Draft the changelog",
  runtime: "exited",
  status: "active",
  crashed: false,
  needsYou: true,
} as unknown as ThreadView

// A live worker — spinner, NO retry (retrying would interrupt real work).
const workingThread = {
  ...base,
  id: "working-audit",
  title: "Audit the quota read path",
  runtime: "running",
  status: "active",
  crashed: false,
  needsYou: false,
} as unknown as ThreadView

// An ordinary rested worker — ellipsis, NO retry (it did not stall).
const restingThread = {
  ...base,
  id: "resting-notes",
  title: "Jot the release notes",
  runtime: "turn-idle",
  status: "active",
  crashed: false,
  needsYou: false,
} as unknown as ThreadView

store.board = { threads: [stalledThread, exitedAtRestThread, workingThread, restingThread] } as BoardSnapshot

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="min-h-screen bg-bg px-10 py-10 text-fg">
      <div data-sidebar-rail className="w-[clamp(320px,34vw,680px)]">
        <ThreadRow t={stalledThread} />
        <ThreadRow t={exitedAtRestThread} />
        <ThreadRow t={workingThread} />
        <ThreadRow t={restingThread} />
      </div>
      <Toaster />
    </main>
  </TooltipProvider>,
)
