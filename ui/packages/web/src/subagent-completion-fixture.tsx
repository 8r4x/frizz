import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView, TranscriptMessage, TranscriptToolCall } from "@fray-ui/shared"
import { AgentBlock, Message, ThreadSlugContext } from "./components/ChatView.tsx"
import { QueueSubAgentLines } from "./components/QueueSubAgentLines.tsx"
import { SubAgentSheet } from "./components/SubAgentSheet.tsx"
import { ChildOpRow } from "./components/ChildOpRow.tsx"
import { pushSubAgentDrawer, store } from "./store.ts"
import "./styles.css"

// TWO maintainer asks (2026-07-27), both about how a finished CHILD reads:
//
//   1. "a background shell coming to rest or terminating renders in a totally different way from an
//      agent finishing … converge on the format … we use currently for background shells resting,
//      because it's more visually distinct in a big sea of tool call blocks."
//      → §1 sets the two side by side INSIDE a run of ordinary tool cards, which is the only context
//        the judgement can be made in. The "before" panel renders the exact component the old
//        completion point drew (an AgentBlock carrying agentStatus/agentElapsedMs — the server shipped
//        a shallow copy of the launch call and the client routed it straight to AgentBlock), so the
//        contrast is the real one, not a mock-up.
//
//   2. "Anytime we render anything related to a sub-agent, the title of it should be clickable and it
//      should open up in a new drawer. There are some scenarios where that's not the case right now."
//      → EVERY surface below is live: the drawer stack is mounted and subAgentTranscript is mocked, so
//        each title actually opens SubAgentSheet. The child transcript the mock returns itself contains
//        a nested dispatch + a nested completion — the scenario that WAS dead (no ThreadSlugContext in
//        the drawer), now resolved through ChildDrillSlugContext.
//
// ?stale=1 seeds an unknown child id so the drill-in degrades to the "gone" state instead of resolving.

const SLUG = "subagent-completion-demo"
const GONE = new URLSearchParams(location.search).get("stale") === "1"

const nativeFetch = window.fetch.bind(window)
const rpcResult = (result: unknown) =>
  new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-fray-boot": "subagent-completion-fixture" } })

// The CHILD's own transcript, as the drawer renders it: prose, a tool card, its OWN dispatch card, and
// its OWN completion divider. Both of the last two were unclickable dead text before this change.
const childMessages: TranscriptMessage[] = [
  { sourceId: "c-u1", role: "user", text: "Audit the pricing parser for edge cases.", tools: [], parts: [{ kind: "text", text: "Audit the pricing parser for edge cases." }] },
  {
    sourceId: "c-a1",
    role: "assistant",
    text: "Reading the tier table, then farming the property tests out to a helper.",
    tools: [],
    parts: [{ kind: "text", text: "Reading the tier table, then farming the property tests out to a helper." }],
  },
  {
    sourceId: "c-a2",
    role: "assistant",
    text: "",
    tools: [{ name: "Read", detail: "/repo/src/pricing/tiers.ts" }],
    parts: [{ kind: "tools", tools: [{ name: "Read", detail: "/repo/src/pricing/tiers.ts" }] }],
  },
  {
    sourceId: "c-a3",
    role: "assistant",
    text: "",
    tools: [{ name: "Agent", detail: "Write property tests for the tier boundaries", prompt: "Write property tests for every tier boundary.", subagentType: "fray:sonnet-high", agentId: "grandchild-1", status: "completed" }],
    parts: [{ kind: "tools", tools: [{ name: "Agent", detail: "Write property tests for the tier boundaries", prompt: "Write property tests for every tier boundary.", subagentType: "fray:sonnet-high", agentId: "grandchild-1", status: "completed" }] }],
  },
  {
    sourceId: "c-a4",
    role: "assistant",
    text: "",
    tools: [{ name: "Agent", detail: "Write property tests for the tier boundaries", subagentType: "fray:sonnet-high", agentId: "grandchild-1", agentStatus: "completed", agentElapsedMs: 420_000, agentCompletion: true, status: "completed" }],
    parts: [{ kind: "tools", tools: [{ name: "Agent", detail: "Write property tests for the tier boundaries", subagentType: "fray:sonnet-high", agentId: "grandchild-1", agentStatus: "completed", agentElapsedMs: 420_000, agentCompletion: true, status: "completed" }] }],
  },
  {
    sourceId: "c-a5",
    role: "assistant",
    text: "Three boundaries were off by one cent; patch and tests are in.",
    tools: [],
    parts: [{ kind: "text", text: "Three boundaries were off by one cent; patch and tests are in." }],
  },
]

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname === "/rpc/subAgentTranscript") {
    const id = JSON.parse(new URL(url.href).searchParams.get("input") ?? "{}").id as string
    // An id the tailer can no longer resolve → "gone", which the drawer states plainly. That is the
    // required graceful degrade, and it is what a GRANDCHILD really hits today: the tailer keys every
    // sub-agent by the PARENT thread's transcript, so an id that only ever appeared in a child's own
    // file resolves to nothing. A live link into a stated "unavailable" beats dead text.
    if (GONE || id === "unknown-child" || id.startsWith("grandchild")) return rpcResult({ messages: [], state: "gone" })
    return rpcResult({ messages: childMessages, state: "done" })
  }
  return nativeFetch(input, init)
}

const thread: ThreadView = {
  id: SLUG,
  title: "Refactor the pricing parser",
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
  subAgents: [
    { id: "agent-live", label: "Sweep the remaining call sites", startedAt: new Date(Date.now() - 190_000).toISOString(), state: "running", subagentType: "fray:opus-high", lastActivityAt: new Date(Date.now() - 60_000).toISOString() },
    { id: "agent-stale", label: "Prior investigation", startedAt: new Date(Date.now() - 4_000_000).toISOString(), state: "stale", subagentType: "fray:haiku", lastActivityAt: new Date(Date.now() - 2_520_000).toISOString() },
  ],
  bgShells: [{ label: "vite dev --host", startedAt: new Date(Date.now() - 600_000).toISOString(), state: "running" }],
} as unknown as ThreadView

store.board = { projectDir: "/fixture/fray", threads: [thread] } as BoardSnapshot

const dispatchCall: TranscriptToolCall = {
  name: "Agent",
  detail: "Audit the pricing parser for edge cases",
  prompt: "Audit the pricing parser for edge cases.\nReport every tier boundary that rounds the wrong way.",
  subagentType: "fray:opus-high",
  agentId: "agent-done",
  agentStatus: "completed",
  agentElapsedMs: 2_100_000,
  status: "completed",
  durationMs: 2_100_000,
}
const completionCall: TranscriptToolCall = { ...dispatchCall, agentCompletion: true }

const tool = (call: TranscriptToolCall): TranscriptMessage => ({
  sourceId: `t-${call.detail ?? call.name}`,
  role: "assistant",
  text: "",
  tools: [call],
  parts: [{ kind: "tools", tools: [call] }],
})

// A realistic band of tool cards — the "big sea" the divider has to stand out from.
const seaOfTools: TranscriptMessage = {
  sourceId: "sea",
  role: "assistant",
  text: "",
  tools: [],
  parts: [
    {
      kind: "tools",
      tools: [
        { name: "Read", detail: "/repo/src/pricing/tiers.ts", status: "completed" },
        { name: "Grep", detail: "roundHalfEven · /repo/src", status: "completed" },
        { name: "Bash", detail: "pnpm test pricing", command: "pnpm test pricing", desc: "Run the pricing suite", status: "completed", durationMs: 41_000 },
        { name: "Read", detail: "/repo/src/pricing/round.ts", status: "completed" },
      ],
    },
  ],
}

const shellLaunch: TranscriptMessage = tool({ name: "Bash", detail: "vite dev --host", command: "pnpm --filter web dev --host", desc: "Start vite from web package dir", backgroundState: "background", status: "cancelled", durationMs: 1_260_000 })
const shellWake: TranscriptMessage = { sourceId: "shell-wake", role: "assistant", kind: "event", boundary: true, text: "Background task «Start vite from web package dir» exited 143", tools: [], parts: [] }

const afterMessages: TranscriptMessage[] = [
  { sourceId: "u1", role: "user", text: "Refactor the pricing parser and verify it end-to-end.", tools: [], parts: [{ kind: "text", text: "Refactor the pricing parser and verify it end-to-end." }] },
  { sourceId: "a1", role: "assistant", text: "Dispatching an audit sub-agent, then reading the tier table myself.", tools: [], parts: [{ kind: "text", text: "Dispatching an audit sub-agent, then reading the tier table myself." }] },
  tool(dispatchCall),
  seaOfTools,
  shellLaunch,
  { ...tool(completionCall), sourceId: "completion" },
  { sourceId: "a2", role: "assistant", text: "The audit came back with three off-by-one-cent boundaries; folding the fix in now.", tools: [], parts: [{ kind: "text", text: "The audit came back with three off-by-one-cent boundaries; folding the fix in now." }] },
  shellWake,
  { sourceId: "a3", role: "assistant", text: "That was the dev server I killed (143 = SIGTERM). Work is done and verified.", tools: [], parts: [{ kind: "text", text: "That was the dev server I killed (143 = SIGTERM). Work is done and verified." }] },
]

// The SAME timeline, with the completion point drawing what it used to: a second AgentBlock card,
// identical to the launch card six rows up and to every other card in the band.
const beforeMessages: TranscriptMessage[] = afterMessages.map((m) =>
  m.sourceId === "completion" ? { ...m, tools: [dispatchCall], parts: [{ kind: "tools" as const, tools: [dispatchCall] }] } : m,
)

function Transcript({ messages, label }: { messages: TranscriptMessage[]; label: string }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="petite-caps text-[11px] text-accent">{label}</h2>
      <ThreadSlugContext.Provider value={SLUG}>
        <div className="mt-3 flex flex-col gap-3.5">
          {messages.map((m) => <Message key={m.sourceId} m={m} />)}
        </div>
      </ThreadSlugContext.Provider>
    </section>
  )
}

const openChild = (s: NonNullable<ThreadView["subAgents"]>[number]) =>
  pushSubAgentDrawer(SLUG, s.id!, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt })

// The drawer stack, exactly as App mounts it — so every title below really opens a drawer.
function Drawers() {
  const snap = useSnapshot(store)
  let below = 0
  return (
    <>
      {snap.drawers.map((d, i) => {
        const widthDepth = below
        if (!d.closing) below++
        return d.kind === "subagent" ? (
          <SubAgentSheet key={d.id} id={d.id} slug={d.slug} subId={d.subId ?? ""} label={d.label ?? d.slug} subagentType={d.subagentType} startedAt={d.startedAt} depth={i} widthDepth={widthDepth} />
        ) : null
      })}
    </>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-5 px-5 py-10">
      <header>
        <p className="petite-caps text-[11px] text-accent">Fixture</p>
        <h1 className="mt-1 text-lg font-semibold">Sub-agent completion — one rendering, one clickable title</h1>
        <p className="mt-2 text-sm text-muted">Every sub-agent title on this page opens the drawer. ?stale=1 makes the drill-in resolve to “gone”.</p>
      </header>

      <div data-before>
        <Transcript label="Before — the completion point drew a second Agent card" messages={beforeMessages} />
      </div>
      <div data-after>
        <Transcript label="After — the completion point draws the shell’s wake divider" messages={afterMessages} />
      </div>

      <section data-live-rows className="rounded-lg border border-border bg-panel p-4">
        <h2 className="petite-caps text-[11px] text-accent">Live child rows — rail, queue card, ops strip</h2>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col">
            {thread.subAgents!.map((s) => (
              <ChildOpRow key={`rail-${s.id}`} kind="AGENT" label={s.label} state={s.state} density="rail" lastActivityAt={s.lastActivityAt} parentSlug={SLUG} onOpen={() => openChild(s)} />
            ))}
          </div>
          <QueueSubAgentLines slug={SLUG} subAgents={thread.subAgents ?? []} />
          <div className="flex flex-col gap-0.5">
            {thread.subAgents!.map((s) => (
              <ChildOpRow key={`sheet-${s.id}`} kind="AGENT" label={s.label} state={s.state} density="sheet" lastActivityAt={s.lastActivityAt} onDismiss={() => {}} onOpen={() => openChild(s)} />
            ))}
          </div>
        </div>
      </section>

      <section data-outcome-rows className="rounded-lg border border-border bg-panel p-4">
        <h2 className="petite-caps text-[11px] text-accent">Divider outcomes, and a dispatch with no resolvable child</h2>
        <ThreadSlugContext.Provider value={SLUG}>
          <div className="mt-3 flex flex-col gap-3.5">
            <Message m={tool({ ...completionCall, detail: "Sweep every call site of the renamed board projection helper for stale imports across the workspace", agentStatus: "completed", agentElapsedMs: 96_000 })} />
            <Message m={tool({ ...completionCall, detail: "Reproduce the flaky socket test", agentStatus: "failed", agentElapsedMs: 720_000 })} />
            <Message m={tool({ ...completionCall, detail: "Watch the release pipeline", agentStatus: "killed", agentElapsedMs: 3_600_000 })} />
            {/* No agentId at all → plain text, never a dead button. */}
            <Message m={tool({ name: "Agent", detail: "Legacy dispatch with no correlation id", agentStatus: "completed", agentElapsedMs: 60_000, agentCompletion: true })} />
            {/* The launch card keeps its expandable prompt — only the completion copy became a divider. */}
            <AgentBlock detail={dispatchCall.detail} prompt={dispatchCall.prompt} subagentType={dispatchCall.subagentType} agentId="unknown-child" agentStatus="completed" agentElapsedMs={2_100_000} status="completed" durationMs={2_100_000} />
          </div>
        </ThreadSlugContext.Provider>
      </section>
    </main>
    <Drawers />
  </QueryClientProvider>,
)
