import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { SectionHeader, ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Reproduces the HELD band from the maintainer's screenshot: a user-snoozed thread and an
// `awaiting timer:` thread. Before the fix these rendered on TWO lines in two divergent styles
// ("SNOOZED · Tomorrow at 11:11 AM" vs "Snoozed until today at 11:09 PM"); after the fix both are a
// SINGLE line and the wake detail lives only in the hourglass tooltip (hover the indicator).
//
// The ACTIVE band below carries the rows a snooze does NOT quiet — a running thread, and one still
// waiting on a sub-agent. Those kept an inline "SNOOZED · …" / "BUMPS · …" subtitle until 2026-08-03
// ("hide the SNOOZED label from the sidebar … the user should be able to see the snooze duration by
// hovering over the icon"), so they are single-line too now and their park rides the SPINNER's tooltip
// as a second line under "Working".

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

// Row C — a worker whose turn was cut off by the subscription SESSION limit; frizz will auto-resume it
// when the window resets. It keeps the held hourglass, but (unlike A and B) it carries the same
// hover-revealed Retry as a stalled row, so an operator with capacity elsewhere can continue it now.
const limitAt = Math.floor((Date.now() + 42 * 60_000) / 1000) // "resets in ~42 min"
const limitThread = {
  ...base,
  id: "refactor-usage-endpoint",
  title: "Refactor the usage-limit endpoint",
  runtime: "exited",
  limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", resumesAt: limitAt, autoResume: true },
} as unknown as ThreadView

// Row F — a `pr-watch:` thread the human parked with the "PR watcher armed" card's Snooze. A watch
// never parks itself, so this (and a `human:` gate co-declared beside the watch) is how one reaches the
// Held band — and until 2026-08-03 it sat here under the same hourglass as A and B, saying nothing
// about the PR that is actually going to wake it. It now wears GitHub's mark, and its tooltip leads
// with the ref: the snooze is only a safety timeout, and new PR activity clears it.
const watchThread = {
  ...base,
  id: "watch-the-resolver-pr",
  title: "Fix the cache collision in the resolver",
  snoozedUntil: snoozeAt,
  lastFence: { kind: "awaiting", body: "PR is open and CI is green. Watching for review.", hints: [{ kind: "pr-watch", value: "acme/app#391" }] },
} as unknown as ThreadView

// Row D — snoozed WHILE ITS OWN TURN RUNS. isHeld excuses a running thread, so the park has not taken
// effect: the row keeps its spinner and stays in Active. It is the row that used to read "SNOOZED · …".
const runningSnoozed = {
  ...base,
  id: "seed-the-buried-question-queue",
  title: "Seed the buried-question queue",
  runtime: "running",
  snoozedUntil: snoozeAt,
} as unknown as ThreadView

// Row E — snoozed with a BUMP armed (a follow-up frizz sends at the deadline), still waiting on a live
// sub-agent. Same excusal, and it is the row that used to read "BUMPS · …".
const bumpingSnoozed = {
  ...base,
  id: "watch-the-release-workflow",
  title: "Watch the release workflow",
  snoozedUntil: snoozeAt,
  snoozePrompt: "Check whether the release job went green and cut the tag if so.",
  subAgents: [{ id: "op-1", label: "verify:release", state: "running", startedAt: new Date().toISOString() }],
} as unknown as ThreadView

store.board = { threads: [timerThread, snoozeThread, watchThread, limitThread, runningSnoozed, bumpingSnoozed] } as BoardSnapshot

function ActiveBand() {
  return (
    <section aria-label="Active">
      <SectionHeader label="Active" count={2} />
      <ThreadRow t={runningSnoozed} />
      <ThreadRow t={bumpingSnoozed} />
    </section>
  )
}

function HeldBand() {
  // Mirrors the real Sidebar HELD section markup (hr + label + count) so the visual context matches;
  // the ROWS are the real ThreadRow component under test.
  return (
    <section aria-label="Held">
      <hr className="my-3 border-border/50" />
      <SectionHeader label="Held" count={4} />
      <ThreadRow t={timerThread} />
      <ThreadRow t={snoozeThread} />
      <ThreadRow t={watchThread} />
      <ThreadRow t={limitThread} />
    </section>
  )
}

// The usage-limit row now renders RowRetryButton, whose Retry is an ordinary eager send
// (lib/retrySession → sendEagerFollowUp) and so reads the query client the real app always provides.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <main className="min-h-screen bg-bg px-10 py-10 text-fg">
        <div data-sidebar-rail className="w-[clamp(320px,34vw,680px)]">
          <ActiveBand />
          <HeldBand />
        </div>
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
