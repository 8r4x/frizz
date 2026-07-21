import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Reproduces the HELD band from the maintainer's screenshot: a user-snoozed thread and an
// `awaiting timer:` thread. Before the fix these rendered on TWO lines in two divergent styles
// ("SNOOZED · Tomorrow at 11:11 AM" vs "Snoozed until today at 11:09 PM"); after the fix both are a
// SINGLE line and the wake detail lives only in the hourglass tooltip (hover the indicator).

// Wall-clock targets computed at load so the rows always sit in the future (Held requires it).
const timerAt = (() => {
  const d = new Date()
  d.setHours(23, 9, 0, 0) // "today at 11:09 PM"
  if (d.getTime() <= Date.now() + 60_000) d.setDate(d.getDate() + 1)
  return d.toISOString()
})()
const snoozeAt = (() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(11, 11, 0, 0) // "tomorrow at 11:11 AM"
  return d.toISOString()
})()

const base = {
  kind: "session",
  backend: "codex",
  runtime: "turn-idle",
  status: "active",
  titleAuto: false,
  needsYou: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  crashed: false,
  archived: false,
  foreign: false,
  state: "open",
  subAgents: [],
  bgShells: [],
  spawnedAt: "2026-07-21T09:00:00.000Z",
  lastAssistantAt: "2026-07-21T12:00:00.000Z",
} as const

// Row A — a worker parked itself with an ```awaiting timer:` fence.
const timerThread = {
  ...base,
  id: "check-in-on-create-prs",
  title: "Check in on create-* pull requests",
  lastFence: { kind: "awaiting", hints: [{ kind: "timer", value: timerAt }] },
} as unknown as ThreadView

// Row B — the human hit Snooze on the thread (snoozedUntil set by rpc.setThreadSnooze).
const snoozeThread = {
  ...base,
  id: "dependabot-nub-ecosystem",
  title: "dependabot-nub-ecosystem",
  snoozedUntil: snoozeAt,
} as unknown as ThreadView

store.board = { threads: [timerThread, snoozeThread] } as BoardSnapshot

function HeldBand() {
  // Mirrors the real Sidebar HELD section markup (hr + label + count) so the visual context matches;
  // the ROWS are the real ThreadRow component under test.
  return (
    <section aria-label="Held">
      <hr className="my-3 border-border/50" />
      <div className="flex w-full items-center justify-between px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted/55">
        <span>Held</span>
        <span className="tabular-nums">2</span>
      </div>
      <ThreadRow t={timerThread} />
      <ThreadRow t={snoozeThread} />
    </section>
  )
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="min-h-screen bg-bg px-10 py-10 text-fg">
      <div data-sidebar-rail className="w-[clamp(320px,34vw,680px)]">
        <HeldBand />
      </div>
    </main>
  </TooltipProvider>,
)
