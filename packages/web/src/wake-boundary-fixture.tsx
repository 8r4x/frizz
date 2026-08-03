import { createRoot } from "react-dom/client"
import type { ChatMessage } from "./hooks.ts"
import { Message } from "./components/ChatView.tsx"
import "./styles.css"

// Turn-BOUNDARY rendering (the `boundary` flag on a `kind:"event"` message). A background-task/shell
// completion `<task-notification>` re-invokes the agent, opening a fresh turn with no visual separation
// from the prior one — two turns (each ending in its own final message) otherwise paint as one bubble.
// The boundary event renders a centered divider rule carrying the cause label ON it, so the wake — and
// the seam between the two turns — is unmistakable. A plain (non-boundary) event line is shown too for
// contrast: it stays a quiet, divider-less annotation.
//
// The `rest` boundary is here beside the `wake` one on purpose: the two are ADJACENT in real
// transcripts (an agent rests, then a background completion wakes it), so this fixture is where the
// pair is judged — one rule closing a turn, one opening the next, close enough together to see whether
// they read as a family or as two stacked accidents.
const messages: ChatMessage[] = [
  { sourceId: "u1", role: "user", text: "The popover for the restart button needs to indicate the operation is safe.", tools: [], parts: [] },
  {
    sourceId: "a1",
    role: "assistant",
    text: "Done — simplified the restart popover to a single calm sentence and drove it in a real browser at both viewports. Tests pass, typecheck clean.",
    tools: [],
    parts: [],
  },
  { sourceId: "e1", role: "assistant", kind: "event", text: "Agent «restart-popover-copy» finished — 4m", tools: [], parts: [] },
  { sourceId: "r1", role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], parts: [] },
  {
    sourceId: "b1",
    role: "assistant",
    kind: "event",
    boundary: "wake",
    text: "Background task «Start vite from web package dir» exited 143",
    tools: [],
    parts: [],
  },
  {
    sourceId: "a2",
    role: "assistant",
    text: "That's the vite dev server I just killed (exit 143 = SIGTERM), confirming clean shutdown. Nothing further needed — the work is complete and verified.",
    tools: [],
    parts: [],
  },
  { sourceId: "r2", role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], parts: [] },
]

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto flex min-h-[360px] max-w-[760px] flex-col border border-border bg-panel px-5 py-4 shadow-xl shadow-black/30 sm:px-7">
        <header className="border-b border-border pb-3">
          <h1 className="text-[16px] font-semibold text-fg">Turn boundaries — rest and background-task wake</h1>
          <p className="mt-0.5 text-[12px] text-muted">A rule closes each turn where the agent came to rest; the wake rule opens the turn a background completion caused.</p>
        </header>
        <div className="flex flex-1 flex-col gap-3.5 py-5">
          {messages.map((message) => <Message key={message.sourceId} m={message} />)}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
