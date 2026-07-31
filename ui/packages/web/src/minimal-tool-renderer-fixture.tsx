import { useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ChatMessage } from "./hooks.ts"
import { Message, withMessageSpacers } from "./components/ChatView.tsx"
import { coalesceToolActivityMessages } from "./lib/toolActivity.ts"
import "./styles.css"

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

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
    cwd: "/tmp/fray-fixture/worktree",
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

function Transcript({ messages }: { messages: ChatMessage[] }) {
  const display = useMemo(() => coalesceToolActivityMessages(messages), [messages])
  return (
    <div data-transcript-column className="flex flex-col">
      {withMessageSpacers(display.map((entry) => entry.message), (message, index) => <Message key={index} m={message} />)}
    </div>
  )
}

function Fixture() {
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([
    callMessage("live-1", [
      { name: "Read", detail: "ui/packages/web/src/components/ChatView.tsx", status: "pending" },
    ]),
  ])
  const advanced = liveMessages.length > 1
  return (
    <main className="min-h-screen bg-bg p-4 text-fg sm:p-8">
      <section className="mx-auto max-w-[760px] rounded-xl border border-border bg-panel px-5 py-5 shadow-xl shadow-black/30 sm:px-7">
        <header className="mb-6 border-b border-border pb-4">
          <h1 className="text-[16px] font-semibold">Minimal tool activity</h1>
          <p className="mt-1 text-[12px] text-muted">One continuously rewritten gerund, with the detailed tool cards one click away.</p>
        </header>

        <div className="flex flex-col gap-7">
          <section data-fixture-live>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-[12px] font-medium text-fg/85">Live batch rewrite</h2>
              <button
                type="button"
                data-add-tool-batch
                disabled={advanced}
                onClick={() => setLiveMessages((messages) => [
                  { ...messages[0], tools: messages[0].tools.map((tool) => ({ ...tool, status: "completed" as const })), parts: [{ kind: "tools", tools: messages[0].tools.map((tool) => ({ ...tool, status: "completed" as const })) }] },
                  callMessage("live-2", [{ name: "Grep", detail: "minimal renderer", status: "pending" }]),
                ])}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-40"
              >
                Add next batch
              </button>
            </div>
            <Transcript messages={liveMessages} />
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
