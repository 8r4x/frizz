import { useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ChatMessage } from "./hooks.ts"
import { Message, VSpace, WorkingIndicator, withMessageSpacers } from "./components/ChatView.tsx"
import { coalesceToolActivityMessages, historicalToolActivityMessages, liveToolActivityRun, liveToolActivityTail, toolActivityLabel } from "./lib/toolActivity.ts"
import "./styles.css"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

// The prose/UI font is a SETTING (`html[data-font]`, see styles.css and lib/font.ts), so this column
// ships in TWO stacks and any glyph measured beside it has to be checked in both. index.html applies
// the stored value before first paint; a fixture that skips it silently renders the mono default, which
// is how a chevron measured at a 0.00px residual here still rode high in a maintainer's sans window
// (2026-08-05: "this is awful"). `?font=sans` selects the other one.
document.documentElement.dataset.font =
  new URLSearchParams(location.search).get("font") === "sans" ? "sans" : "mono"

function callMessage(sourceId: string, tools: ChatMessage["tools"]): ChatMessage {
  return { sourceId, role: "assistant", text: "", tools, parts: [{ kind: "tools", tools }] }
}

const settledMessages = [
  callMessage("settled-1", [
    { name: "Read", detail: "ui/packages/web/src/components/ChatView.tsx", read: "export function Message() { /* … */ }", status: "completed", durationMs: 18 },
  ]),
  callMessage("settled-2", [
    { name: "Grep", detail: "ToolCalls|ToolCardRouter", status: "completed", durationMs: 32 },
    { name: "Edit", detail: "ui/packages/web/src/lib/toolActivity.ts", edit: { file: "ui/packages/web/src/lib/toolActivity.ts", old: "tool calls", new: "minimal activity" }, status: "completed", durationMs: 41 },
    ...Array.from({ length: 27 }, (_, index) => ({
      name: "Read",
      detail: `ui/packages/web/src/fixture-${index + 1}.ts`,
      status: "completed" as const,
      durationMs: 10 + index,
    })),
  ]),
]

const exceptionMessage = callMessage("exceptions", [
  { name: "Read", detail: "ui/packages/web/src/styles.css", status: "completed" },
  {
    name: "Bash",
    detail: "nub run dev",
    desc: "Run the disposable dev server",
    command: "nub run dev",
    cwd: "/tmp/frizz-fixture/worktree",
    backgroundState: "background",
    status: "pending",
  },
  { name: "Grep", detail: "shimmer-text", status: "completed" },
  {
    name: "Spawn agent",
    detail: "Review the renderer",
    agentId: "fixture-agent",
    input: "fresh context",
    status: "pending",
  },
])

// The board root the shimmer shortens absolute paths against — the fixture's stand-in for
// BoardSnapshot.projectDir, which the real surfaces read through useProjectDir().
const FIXTURE_PROJECT_DIR = "/Users/fixture/Documents/projects/frizz"

function Transcript({ messages, running = false }: { messages: ChatMessage[]; running?: boolean }) {
  const coalesced = useMemo(() => coalesceToolActivityMessages(messages), [messages])
  const liveTool = running ? liveToolActivityTail(coalesced.map((entry) => entry.message)) : undefined
  const liveRun = running ? liveToolActivityRun(coalesced.map((entry) => entry.message)) : undefined
  const activityLabel = liveTool ? toolActivityLabel(liveTool, FIXTURE_PROJECT_DIR) : undefined
  const display = useMemo(
    () => running ? historicalToolActivityMessages(coalesced) : coalesced,
    [coalesced, running],
  )
  return (
    <div data-transcript-column className="flex flex-col">
      {withMessageSpacers(display.map((entry) => entry.message), (message, index) => <Message key={index} m={message} />)}
      {running && (
        <>
          {messages.length > 0 && <VSpace />}
          <WorkingIndicator activityLabel={activityLabel} run={liveRun} />
        </>
      )}
    </div>
  )
}

// The BOTTOM SLOT'S ALTERNATION, one step per click — the reading the maintainer asked for on
// 2026-08-08 ("Ran 23 tool calls. Thinking…" → the call's own description → "Ran 24 tool calls.
// Thinking…"). Each step is the whole live run at that moment; the slot's label is derived, so stepping
// through them is the sequence itself rather than a mock of it.
//
// Step 1's path is ABSOLUTE, exactly as a provider reports it: the shimmer must show it
// project-relative. The count is the LIVE RUN's, so it climbs 1 → 2 across the two landed calls and
// would reset if prose closed the run — which is correct, since a closed run states itself as a digest.
const edit = (status: "pending" | "completed") => ({
  name: "Edit",
  detail: `${FIXTURE_PROJECT_DIR}/ui/packages/web/src/components/ChatView.tsx`,
  status,
})
const grep = (status: "pending" | "completed") => ({ name: "Grep", detail: "minimal renderer", status })

const LIVE_STEPS: { note: string; messages: ChatMessage[] }[] = [
  { note: "a call is executing — its gerund owns the slot", messages: [callMessage("live-1", [edit("pending")])] },
  { note: "its result landed — the gap states the run so far", messages: [callMessage("live-1", [edit("completed")])] },
  {
    note: "the next call starts — its own description replaces the count",
    messages: [callMessage("live-1", [edit("completed")]), callMessage("live-2", [grep("pending")])],
  },
  {
    note: "…and lands: the same reading, one call higher",
    messages: [callMessage("live-1", [edit("completed")]), callMessage("live-2", [grep("completed")])],
  },
]

function Fixture() {
  const [step, setStep] = useState(0)
  const liveMessages = LIVE_STEPS[step].messages
  return (
    <main className="min-h-screen bg-bg p-4 text-fg sm:p-8">
      <section className="mx-auto max-w-[760px] rounded-xl border border-border bg-panel px-5 py-5 shadow-xl shadow-black/30 sm:px-7">
        <header className="mb-6 border-b border-border pb-4">
          <h1 className="text-[16px] font-semibold">Minimal tool activity</h1>
          <p className="mt-1 text-[12px] text-muted">The bottom shimmer alternates between the running call's gerund and the run's own count; settled tool runs return as one digest.</p>
        </header>

        <div className="flex flex-col gap-7">
          <section data-fixture-live>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-[12px] font-medium text-fg/85">
                Live batch rewrite <span data-live-step-note className="font-normal text-muted">— step {step + 1}/{LIVE_STEPS.length}: {LIVE_STEPS[step].note}</span>
              </h2>
              <button
                type="button"
                data-add-tool-batch
                disabled={step === LIVE_STEPS.length - 1}
                onClick={() => setStep((s) => Math.min(s + 1, LIVE_STEPS.length - 1))}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-40"
              >
                Advance
              </button>
            </div>
            <Transcript messages={liveMessages} running />
          </section>

          <section data-fixture-settled>
            <h2 className="mb-2 text-[12px] font-medium text-fg/85">Settled batch — click to inspect</h2>
            <Transcript messages={settledMessages} />
          </section>

          <section data-fixture-exceptions>
            <h2 className="mb-2 text-[12px] font-medium text-fg/85">Background activity with a sub-agent break</h2>
            <Transcript messages={[exceptionMessage]} />
          </section>
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
)
