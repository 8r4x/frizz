import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage, TranscriptToolCall } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the higher-level "intermediate logs collapse" in the queue card (QCard). The card shows
// the TEXT ONLY of the agent's first and last messages; EVERYTHING between their prose — the fully-hidden
// middle messages AND the tool calls batched into the first/last messages themselves — collapses behind
// ONE HAIRLINE DIVIDER (the transcript's WakeDivider chrome) whose label is the stacked-chevron
// ChevronsUpDown expand glyph, the tool-call count, and "Click to expand". So the card reads: pinned ask →
// first message's narration (text only) → collapse divider → final message (text only). Clicking is
// one-way: the full log (all tool bands restored) renders and the divider unmounts.
//   ?variant=heavy   (default) a user ask + an opening narration (WITH batched tools) + several tool-heavy
//                    intermediate steps + a final question. First message's tools must fold into the divider.
//   ?variant=single  user ask + ONE assistant reply (no middle → NO collapse divider, control case)
//   ?variant=notools user ask + a couple of prose-only intermediate steps. NOTHING is counted (the step
//                    count was dropped), so this pins the zero-tool label: just "Click to expand".
//   ?variant=batchedends  user ask + first(narration + tools) + ONE middle step + final(summary text + a
//                         trailing tool). BOTH ends' tools fold into the divider; both texts show tool-free.
//   ?variant=questionthentool  user ask + narration + a FINAL question + a trailing TOOLS-ONLY message.
//                         Regression guard: the final-text anchor stays on the question (chips stay live);
//                         the text-less tool message must NOT steal the anchor and hide the question.
//   ?variant=trailingevent  user ask + intermediate steps + a FINAL question, then a sub-agent completion
//                           event AFTER it. Regression guard: the question (with answer chips) must stay
//                           visible — a trailing event must NOT pull it into the collapsed range.
//   ?variant=bgshells  three background shells launched in three SEPARATE assistant records across the
//                      collapsed span (the real shape from thread `started-three-frizz-in-quick-succession`),
//                      one of them already finished. Background tasks are lifted out of the collapse and
//                      render as REAL CARDS — never a `Ran N tool calls` band — with a pulsing blue dot
//                      while live and NO mark at all once done.
//   ?variant=dispatches  two sub-agent dispatches inside the collapsed span, one still running (tracked in
//                      thread.subAgents) and one resolved. Same rule as background tasks: real Agent cards
//                      under the divider, pulsing accent dot on the live one, nothing on the resolved one.
//   ?variant=buriedask  a ```question in the MIDDLE of the run, with tool work and a closing summary after
//                      it. Two guards at once: the ask is lifted OUT of the collapse (a decision the human
//                      owes is not disposable chatter), and its chips are LIVE even though a newer ask is
//                      not what the card is anchored on. Pre-fix the card offered "Send answers" with the
//                      question nowhere on screen.
//   ?variant=twoasks   two ```question messages stacked with work between them, neither answered. BOTH
//                      carry live chips — the queue card used to make only the most recent one answerable.
//   ?variant=humanpast an ask the human already replied PAST (a later user turn), then more agent work.
//                      Under "Load earlier messages" the old ask must still take chips; the card's own
//                      "Send answers" action stands down until one is filled (nothing stands at the tail).
const params = new URLSearchParams(location.search)
const variant = params.get("variant") ?? "heavy"

const SLUG = "intermediate-collapse-demo"

const tool = (name: string, over: Partial<TranscriptToolCall> = {}): TranscriptToolCall => ({
  name,
  status: "completed",
  ...over,
})

const asst = (text: string, tools: TranscriptToolCall[] = []): TranscriptMessage => ({
  role: "assistant",
  text,
  tools,
  parts: [
    ...(tools.length ? [{ kind: "tools" as const, tools }] : []),
    ...(text ? [{ kind: "text" as const, text }] : []),
  ],
})

const event = (text: string): TranscriptMessage => ({ role: "assistant", kind: "event", text, tools: [], parts: [] })

// A real ```question block so the queue card renders answer chips + the "Send answers" flow — this is
// what the trailing-event regression must not hide.
const finalQuestion = [
  "```question",
  "I've added the collapse divider. Which label reads best?",
  "",
  "- A. **`11 tool calls · Click to expand`** — names the scale and the affordance (recommended).",
  "- B. Just **`Click to expand`** — leaner, but the reader can't tell how much is hidden.",
  "```",
].join("\n")

let counter = 0
const withId = (m: TranscriptMessage): TranscriptMessage => ({ ...m, sourceId: `m${counter++}` })

const heavy: TranscriptMessage[] = [
  { sourceId: "u-old", role: "user", text: "An earlier ask from a previous turn.", tools: [], parts: [] },
  withId(asst("Done with that earlier one.")),
  { sourceId: "u-cur", role: "user", text: "Add a collapsed-by-default view for the intermediate agent logs in the queue card, and wire up a one-way expand.", tools: [], parts: [] },
  // --- intermediate run: several tool-heavy assistant steps + chatter ---
  withId(asst("Let me find the queue card renderer and understand how it windows the transcript.", [
    tool("Grep", { detail: "QCard|QueueCard|renderCard" }),
    tool("Read", { detail: "components/TodosView.tsx", read: "…740 lines…" }),
  ])),
  withId(asst("I'll check how tool-call collapsing works today so the new one is clearly higher-level.", [
    tool("Read", { detail: "components/ChatView.tsx" }),
    tool("Grep", { detail: "collapseTools|ToolCalls" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck the web package" }),
  ])),
  withId(asst("Now editing the render loop to inject the summary bar and gate it on the middle range.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Re-typecheck after edits" }),
    tool("Bash", { detail: "nub --test packages/web/src/**/*.test.ts", desc: "Run web tests" }),
  ])),
  withId(asst("Verified the counts line up with what the loop skips (queued + render-nothing messages).", [
    tool("Read", { detail: "packages/shared/src/index.ts" }),
  ])),
  // --- final standing message (always shown in full) ---
  withId(asst(finalQuestion)),
]

// Same as heavy, but a sub-agent completion EVENT lands in the JSONL AFTER the final question — the
// exact sequence that (pre-fix) pulled the question into the collapsed range and disabled answering.
const trailingevent: TranscriptMessage[] = [
  ...heavy,
  withId(event('Agent "reviewer" finished — 5m')),
]

const single: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Quick one — what's the current default label?", tools: [], parts: [] },
  withId(asst("It's the `N tool calls · Click to expand` hairline. Nothing intermediate here, so no collapse divider should appear.")),
]

const notools: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Summarize the trade-offs before you build anything.", tools: [], parts: [] },
  withId(asst("First, the collapse is one-way by design, so we avoid re-collapse jank.")),
  withId(asst("Second, it keys off the pinned ask and the final message, so loaded-earlier history is untouched.")),
  withId(asst("So — proceed with the one-way collapse? That's my recommendation.")),
]

// Tools batched into BOTH the first and the last agent message. The final message is a normal summary
// (not a question) with a trailing tool call. After collapse: first + last show text only, and the
// divider counts every tool across the span (2 first + 2 middle + 1 last = 5). The one fully-hidden
// middle step is still hidden, it is simply no longer counted in the label.
const batchedends: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Rename the flag and update its callers.", tools: [], parts: [] },
  withId(asst("On it — let me locate the flag definition and every reader first.", [
    tool("Grep", { detail: "intermediateExpanded" }),
    tool("Read", { detail: "components/TodosView.tsx", read: "…820 lines…" }),
  ])),
  withId(asst("Found 3 call sites; applying the rename across them.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/ChatView.tsx" }),
  ])),
  withId(asst("Done — renamed the flag and its 3 callers, and re-typechecked clean.", [
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck after rename" }),
  ])),
]

// REGRESSION GUARD: the agent asks a ```question, THEN emits a TOOLS-ONLY message (text "") after it —
// e.g. it kept working past the ask. The final-text anchor must stay on the QUESTION (not slide onto the
// text-less tool message), so its answer chips remain visible + interactive. The trailing tool renders in
// full below the question (it is outside the collapsed span). Pre-fix this hid the question and killed the
// answer flow.
const questionthentool: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Wire up the one-way expand and ask me about the label.", tools: [], parts: [] },
  withId(asst("Let me add the expand handler and draft the two label options.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck" }),
  ])),
  withId(asst(finalQuestion)),
  // Tools-only follow-up (no prose) AFTER the question — must not become the standing message.
  withId(asst("", [tool("Read", { detail: "components/ChatView.tsx" })])),
]

// Background tasks are lifted OUT of the collapsed span and rendered for real — they are lifecycle
// state, not disposable chatter, and a detached process is the one class of call still going after the
// batch that started it (maintainer 2026-08-01: "It's important that those show up in the chat"). This
// run launches three from three SEPARATE assistant records with ordinary tool work in between — the
// exact shape the maintainer hit — so it pins BOTH halves: three real cards rather than a batched
// `Ran N tool calls` band, and only the two LIVE ones marked, the finished one flush at its label.
const bgShell = (desc: string, command: string, over: Partial<TranscriptToolCall> = {}) =>
  tool("Bash", { desc, detail: command, command, backgroundState: "background", status: "pending", ...over })

const bgshells: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Verify the relaunch path against a real server, cold and warm.", tools: [], parts: [] },
  withId(asst("Let me look at what the reuse path actually does today.", [
    tool("Grep", { detail: "existing server|reuse" }),
    tool("Read", { detail: "packages/server/src/project-launch.ts", read: "…410 lines…" }),
  ])),
  withId(asst("", [bgShell("Starting the first server in the sandbox", "nub run dev --port 5311")])),
  withId(asst("Server is up — driving the warm path now.", [
    tool("Bash", { detail: "curl -s localhost:5311/api/health", desc: "Checking the warm relaunch" }),
    tool("Edit", { detail: "packages/server/src/project-launch.ts" }),
  ])),
  withId(asst("", [bgShell("Capturing a genuine cold start panel", "nub run dev --fresh")])),
  // Already finished — the card stays (it is the reader's only handle on a process that ran and ended
  // while they were reading something else), but it carries no mark: the reading says "done · 42 sec".
  withId(asst("", [bgShell("Waiting for the cold start to serve", "nub scripts/wait-for-serve.mjs 5312", { status: "completed", durationMs: 42_000 })])),
  withId(asst("Both paths verified live.", [tool("Bash", { detail: "nub --test", desc: "Running the server suite" })])),
  withId(asst("**Fixed** — a relaunch in a repo that already has a server now says so.")),
]

// The SAME rule for dispatches (maintainer 2026-08-01: "Same for sub-agent dispatches"). One child is
// still running — tracked in `thread.subAgents` below, which is what drives the pulsing accent mark —
// and one has resolved, so both dot states sit under the divider at once.
const LIVE_AGENT_ID = "agent-live-1"

const dispatches: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Audit the transcript renderer for dropped tool states, then fix what you find.", tools: [], parts: [] },
  withId(asst("Fanning out — one reader per surface, then I'll reconcile.", [
    tool("Grep", { detail: "ToolCardRouter|collapseTools" }),
  ])),
  withId(asst("", [tool("Agent", {
    detail: "Audit the queue card's collapse",
    prompt: "Read packages/web/src/components/TodosView.tsx and report every tool state the queue card can drop.",
    subagentType: "frizz:opus-high",
    agentId: LIVE_AGENT_ID,
  })])),
  withId(asst("While that runs, let me read the chat side myself.", [
    tool("Read", { detail: "packages/web/src/components/ChatView.tsx", read: "…4100 lines…" }),
    tool("Edit", { detail: "packages/web/src/lib/toolActivity.ts" }),
  ])),
  withId(asst("", [tool("Agent", {
    detail: "Cross-check the sub-agent drawer",
    prompt: "Read packages/web/src/components/SubAgentSheet.tsx and confirm it shares the parent's coalescing.",
    subagentType: "frizz:sonnet-medium",
    agentId: "agent-done-1",
    agentStatus: "completed",
    agentElapsedMs: 214_000,
  })])),
  withId(asst("Both readers agree with what I found in the renderer.", [
    tool("Bash", { detail: "nub --test", desc: "Running the web suite" }),
  ])),
  withId(asst("**Fixed** — every background lifecycle now keeps its own card.")),
]

// A second, differently-worded ask so the stacked-question variants are readable apart at a glance.
const engineQuestion = [
  "```question",
  "Before I go further — which engine should the layer target?",
  "",
  "- A. Postgres — matches prod (recommended).",
  "- B. SQLite — zero setup, but no parity with prod.",
  "```",
].join("\n")

// The ask sits in the MIDDLE of the run: the agent asked and then kept working (a background wake). The
// collapse must lift it out (it is a decision the human owes) and its chips must be live.
const buriedask: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Set up the database layer end to end.", tools: [], parts: [] },
  withId(asst("Reading the current schema and migration setup first.", [
    tool("Read", { detail: "packages/server/src/storage.ts", read: "…980 lines…" }),
    tool("Grep", { detail: "migrate|schema" }),
  ])),
  withId(asst(engineQuestion)),
  withId(asst("Meanwhile I wired the migrations runner so either answer lands cleanly.", [
    tool("Edit", { detail: "packages/server/src/storage.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Running the server suite" }),
  ])),
  withId(asst("Runner and a connection-pool stub are in — waiting on the engine call above before I go further.")),
]

// Two unanswered asks stacked with work between them. Both must take chips.
const twoasks: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Set up the database layer end to end.", tools: [], parts: [] },
  withId(asst("Reading the current schema first.", [tool("Read", { detail: "packages/server/src/storage.ts" })])),
  withId(asst(engineQuestion)),
  withId(asst("Sketching the collapse label while I wait.", [tool("Edit", { detail: "components/TodosView.tsx" })])),
  withId(asst(finalQuestion)),
]

// The human already replied PAST the ask. Nothing stands at the tail, so the card's Send action is down —
// but the ask itself stays answerable once "Load earlier messages" brings it back on screen.
const humanpast: TranscriptMessage[] = [
  { sourceId: "u-old", role: "user", text: "Set up the database layer end to end.", tools: [], parts: [] },
  withId(asst("Reading the current schema first.", [tool("Read", { detail: "packages/server/src/storage.ts" })])),
  withId(asst(engineQuestion)),
  { sourceId: "u-cur", role: "user", text: "Park the engine question — do the migrations runner first.", tools: [], parts: [] },
  withId(asst("On it — runner first.", [
    tool("Edit", { detail: "packages/server/src/storage.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Running the server suite" }),
  ])),
  withId(asst("Migrations runner is in and green.")),
]

const messages =
  variant === "single" ? single
  : variant === "bgshells" ? bgshells
  : variant === "dispatches" ? dispatches
  : variant === "notools" ? notools
  : variant === "batchedends" ? batchedends
  : variant === "questionthentool" ? questionthentool
  : variant === "trailingevent" ? trailingevent
  : variant === "buriedask" ? buriedask
  : variant === "twoasks" ? twoasks
  : variant === "humanpast" ? humanpast
  : heavy

const thread: ThreadViewModel = {
  id: SLUG,
  title: "Intermediate-logs collapse demo",
  status: "needs-human",
  statusText: "Waiting on your review of the collapsed intermediate view",
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
  // The live child behind the `dispatches` variant's first Agent card — AgentBlock reads its mark and
  // its runtime from HERE (the board's tracked set), not from the transcript call.
  subAgents: variant === "dispatches"
    ? [{ id: LIVE_AGENT_ID, label: "Audit the queue card's collapse", state: "running", startedAt: new Date(Date.now() - 186_000).toISOString(), depth: 1 }]
    : [],
  bgShells: [],
  lastActivityAt: new Date().toISOString(),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/rpc/threadTranscript" || url.pathname === "/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
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
