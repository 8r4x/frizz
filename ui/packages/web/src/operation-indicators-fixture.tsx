import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@fray-ui/shared"
import { AgentBlock, BackgroundOpsStrip, ThreadSlugContext, ToolStatusMeta } from "./components/ChatView.tsx"
import { QueueSubAgentLines } from "./components/QueueSubAgentLines.tsx"
import { ChildOpRow } from "./components/ChildOpRow.tsx"
import { ToolDisclosureHeader } from "./components/ToolDisclosureHeader.ts"
import { store } from "./store.ts"
import "./styles.css"

// Both the last-active reading AND the RUNTIME (`startedAt`, on every child row and on the dispatch
// card) are relative to NOW, so seed them that way rather than with a frozen date — a child dispatched
// 12 min ago should read "12m" whenever the fixture is opened. A hard-coded 2026-07-14 read "372hr 53m"
// the moment the dispatch card started rendering a runtime, which is nobody's real reading.
const agoIso = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

const thread: ThreadView = {
  id: "operation-indicators",
  title: "Per-operation running indicators",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  // The `subagentType` spread is retained as DRILL-IN + tooltip data (the rail's type reading rides its
  // row tooltip). It is no longer rendered as a bracketed tag on any density — see ChildOpRow.
  // The `activityDetail` / `toolUses` / `tokens` spread is the LIVE-READING coverage: a child mid-step
  // with counters, a long step that has to truncate beside a long label, and — the case that must not
  // regress — a child reporting NOTHING (a tmux or codex dispatch), which has to read exactly as the
  // row did before those fields existed rather than leaving a gap where the step would go.
  subAgents: [
    { id: "agent-a", label: "Inspect logs", startedAt: agoIso(4), state: "running", subagentType: "fray:opus-xhigh", lastActivityAt: agoIso(0), activity: "Bash", activityDetail: "Running sleep for 20 seconds", toolUses: 12, tokens: 13_476 },
    { id: "agent-b", label: "Run regression suite", startedAt: agoIso(12), state: "running", subagentType: "worker gpt-5.6-terra/high", lastActivityAt: agoIso(6), activity: "Edit", activityDetail: "Editing packages/server/src/tailer.ts", toolUses: 1, tokens: 947 },
    { id: "agent-long", label: "Sweep every call site of the renamed board projection helper for stale imports", startedAt: agoIso(78), state: "running", subagentType: "fray:sonnet-medium", lastActivityAt: agoIso(2), activity: "Grep", activityDetail: "Searching for every remaining reference to the old projection helper name across the workspace", toolUses: 148, tokens: 132_000 },
    // No task stream at all (a tmux thread / a codex child): identity only, and no empty slot.
    { id: "agent-plain", label: "Explore the resume path", startedAt: agoIso(0.6), state: "running", subagentType: "general-purpose", lastActivityAt: agoIso(3) },
    { id: "agent-stale", label: "Prior investigation", startedAt: agoIso(51), state: "stale", subagentType: "fray:haiku", lastActivityAt: agoIso(42), activityDetail: "Reading the orphan reaper", toolUses: 3, tokens: 2_400_000 },
    // RESTED: its own run ended while the fan-out it launched kept going — the hollow dot, on every
    // density and on the dispatch card that opens it.
    { id: "agent-rested", label: "Fan out the migration sweep", startedAt: agoIso(23), state: "rested", subagentType: "fray:opus-high", lastActivityAt: agoIso(18) },
  ],
  bgShells: [
    { label: "Watch CI", startedAt: "2026-07-14T10:00:00.000Z", state: "running", lastActivityAt: agoIso(1) },
    { label: "Tail build log", startedAt: "2026-07-14T10:01:00.000Z", state: "running", lastActivityAt: agoIso(0) },
    // Alive but quiet: a dev server waiting for requests, and a Monitor (which has no output file, so
    // it is ALWAYS reported stale). Both are live processes — they breathe, never a dead gray dot.
    { label: "Dev server (waiting, no recent output)", startedAt: "2026-07-14T09:00:00.000Z", state: "stale", lastActivityAt: agoIso(78) },
    { label: "Monitor: PR checks", startedAt: "2026-07-14T09:30:00.000Z", state: "stale" },
  ],
}

store.board = { threads: [thread] } as BoardSnapshot

function DisclosureFixture({ running }: { running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = `fixture-disclosure-${running ? "running" : "done"}`
  return (
    <div className="fray-bash">
      <ToolDisclosureHeader
        className="fray-bash-header"
        controls={bodyId}
        expanded={expanded}
        label={`${expanded ? "Collapse" : "Expand"} ${running ? "running" : "completed"} operation`}
        onToggle={() => setExpanded((value) => !value)}
        meta={<ToolStatusMeta status={running ? "pending" : "completed"} backgroundState={running ? "background" : undefined} />}
      >
        <span className="petite-caps fray-bash-label shrink-0">Bash</span>
        <span className="min-w-0 truncate text-[11.5px] text-muted">{running ? "Watch CI until checks finish" : "Completed CI checks"}</span>
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!expanded} className="border-t border-border px-2.5 py-2 text-[11.5px] text-muted">Operation details remain available without changing the header alignment.</div>
    </div>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
  <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-5 py-10">
    <header>
      <p className="petite-caps text-[11px] text-accent">Fixture</p>
      <h1 className="mt-1 text-lg font-semibold">Per-operation running indicators</h1>
      <p className="mt-2 text-sm text-muted">Each dot belongs to a named operation. There is intentionally no aggregate session “Running” pulse.</p>
    </header>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Chat background operations</h2>
      <BackgroundOpsStrip slug={thread.id} className="pt-3" />
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Queue sub-agents</h2>
      {/* The card now lists the STALE child too (it reads "42 min ago"), not just the two running ones. */}
      <QueueSubAgentLines slug={thread.id} subAgents={thread.subAgents} />
    </section>
    <section data-rail-rows className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Sidebar rail rows</h2>
      {/* The rail density of the same shared row — checkbox spinner + the light-gray last-active reading. */}
      <div className="mt-3 flex flex-col">
        {/* The rail's type reading lives in the row TOOLTIP; no density renders a profile tag any more
            (maintainer 2026-07-27 — ChildOpRow no longer takes `subagentType` at all). */}
        {thread.subAgents.map((s) => (
          <ChildOpRow key={s.id} kind="AGENT" label={s.label} state={s.state} density="rail" startedAt={s.startedAt} title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label} onOpen={() => {}} />
        ))}
      </div>
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Tool disclosures</h2>
      <div className="mt-3 flex flex-col gap-2 text-[12px]">
        <div className="flex items-center justify-between gap-3"><span>Watch CI (launch wrapper returned)</span><ToolStatusMeta status="completed" backgroundState="background" liveBackgroundState="running" /></div>
        <div className="flex items-center justify-between gap-3"><span>Completed build</span><ToolStatusMeta status="completed" durationMs={32_000} /></div>
        <div className="flex items-center justify-between gap-3"><span>Failed test</span><ToolStatusMeta status="failed" exitCode={1} durationMs={12_000} /></div>
        <div className="flex items-center justify-between gap-3"><span>Cancelled command</span><ToolStatusMeta status="cancelled" /></div>
      </div>
    </section>
    {/* Agent rows carry TWO independent status sources — their own state reading (with its mark) and
        the shared meta slot — so they are the one card family that can render a DOUBLE indicator. Each
        row below must show exactly one `data-running-indicator`, and the no-child rows must still
        surface their terminal status/duration through the meta slot.
        These rows are also the coverage for the 2026-07-29 header shape: mark → "Agent" → title →
        right-justified RUNTIME → chevron, mirroring the prompt-box child lines two sections up. Read
        the two sections together — the marks and the runtime readings must agree. */}
    <section data-agent-rows className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Agent rows</h2>
      <div className="mt-3 flex flex-col gap-2">
        <ThreadSlugContext.Provider value={thread.id}>
          {/* Live child, running: pulsing mark, bare live-ticking runtime, no state verb. */}
          <AgentBlock detail="Measure private repo placeholder prevalence" prompt="Measure how many repos use the placeholder." subagentType="fray:opus-high" agentId="agent-a" status="pending" />
          {/* Live child gone quiet: the flat stale mark, and no "running" badge to contradict it. */}
          <AgentBlock detail="Prior investigation" prompt="Investigate the earlier failure." subagentType="fray:sonnet-high" agentId="agent-stale" status="pending" />
          {/* Rested child: the hollow mark — it stopped, its own fan-out has not. */}
          <AgentBlock detail="Fan out the migration sweep" prompt="Fan out the sweep across every package." subagentType="fray:opus-high" agentId="agent-rested" status="pending" />
          {/* Completed child: NO mark and no slot for one — the header starts flush at "Agent", and the
              bare runtime is what says it ran and stopped. Read this row against the three above it: the
              marked rows step in by the slot, these four do not, and that is the point. */}
          <AgentBlock detail="Diagnose remotion model routing anomaly" prompt="Diagnose the routing anomaly." subagentType="fray:opus-high" agentId="agent-done" agentStatus="completed" agentElapsedMs={183_000} status="completed" durationMs={183_000} />
          {/* A NON-nominal outcome keeps its verb — no mark can say it — but the two are TONED APART, and
              this pair is the coverage for that. A STOPPED child is not an error (interrupted, or timed
              out), so it reads at the same quiet weight as the "done · 32 sec" meta above; only a real
              FAILURE takes the red. Read the two rows together — if the stop is as loud as the failure,
              the regression is back.
              READ ALL EIGHT ROWS AS A COLUMN. Every reading is ONE treatment (ChatView's ToolMetaReading,
              worded by lib/agentReading.ts): one size, one petite-caps casing, one `·` separator, one
              duration formatter, and a palette of exactly two tones. The column shipped with two of each
              — the four rows below reading lowercase sans at three alphas while these last two read
              petite-caps in amber and red — so a second treatment appearing here is the regression. */}
          <AgentBlock detail="Interrupted long-running audit" prompt="Audit every call site." subagentType="fray:sonnet-medium" agentId="agent-killed" agentStatus="killed" agentElapsedMs={2_460_000} status="completed" durationMs={2_460_000} />
          <AgentBlock detail="Crashed dependency sweep" prompt="Sweep every dependency." subagentType="fray:sonnet-medium" agentId="agent-failed" agentStatus="failed" agentElapsedMs={738_000} status="failed" durationMs={738_000} />
          {/* No child record at all — the meta slot is the ONLY status surface, so a terminal status
              and its duration must still render here (this is what the suppression must never eat). */}
          <AgentBlock detail="Cancelled dispatch (no child record)" prompt="This dispatch was interrupted." status="cancelled" />
          <AgentBlock detail="Failed dispatch (no child record)" prompt="This dispatch failed." status="failed" durationMs={12_000} />
        </ThreadSlugContext.Provider>
      </div>
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Disclosure row alignment</h2>
      <div className="mt-3 flex flex-col gap-2">
        <DisclosureFixture running />
        <DisclosureFixture running={false} />
      </div>
    </section>
  </main>
  </QueryClientProvider>,
)
