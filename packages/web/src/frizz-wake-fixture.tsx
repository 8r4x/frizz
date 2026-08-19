import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { formatGithubWakeSteer, prWatchWakeMessage, shellDoneMessage } from "@frizz/shared"
import type { ChatMessage } from "./hooks.ts"
import { Message } from "./components/ChatView.tsx"
import "./styles.css"

// EVERY WAKE FRIZZ DELIVERS, in one transcript, so the family can be judged as a family — which is the
// only way the defect this page was built for is visible at all. Review activity had rendered as a
// hairline since the notification card died; a PR reaching a terminal state, CI reaching a verdict, and a
// background shell finishing behind a resting worker had not, and arrived as full-width bordered cards
// stacked under those hairlines (maintainer 2026-08-18: "these callouts should obviously be hairlines",
// and 2026-08-19 on extending it to the rest).
//
// Every text here is composed by the REAL formatter the scheduler calls — never a hand-written string —
// so this page cannot pass while the shipped wording drifts out from under the parsers.
//
// `?font=sans|mono` sets `data-font`. The prose font is a user setting applied before first paint, and a
// fixture that does not set it silently renders the mono default — which is how a glyph fitted here once
// rode visibly high in the maintainer's sans window.
const font = new URLSearchParams(location.search).get("font")
if (font === "sans" || font === "mono") document.documentElement.dataset.font = font

// No `wakeSteer` is served on any of these. That is the real wire state for a status wake (the server's
// steer parser reads line 0, so a status line above one means no served field) and it exercises the
// client's own fallback parse, which is the only parser the combined case has.
const wake = (sourceId: string, text: string): ChatMessage => ({ sourceId, role: "user", wake: true, text, tools: [], parts: [] })

const review = formatGithubWakeSteer({
  ref: "nubjs/nub#756",
  omitted: 0,
  items: [{ label: "comment", actor: "colinhacks", bot: false, at: new Date(Date.now() - 26 * 3_600_000).toISOString(), url: "https://github.com/nubjs/nub/pull/756#issuecomment-5120099362" }],
})

const messages: ChatMessage[] = [
  wake("w1", review),
  wake("w2", prWatchWakeMessage({ target: "nubjs/nub#760", closed: true })),
  wake("w3", prWatchWakeMessage({ target: "nubjs/nub#756", merged: true })),
  wake("w4", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "passing", passed: 7, failed: 0, failing: [] } })),
  wake("w5", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "passing", passed: 1, failed: 0, failing: [] } })),
  wake("w6", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 4, failed: 2, failing: ["build (windows-latest)", "test (macos-14)"] } })),
  wake("w7", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 0, failed: 1, failing: [] } })),
  // Both parts in one delivery — one poll that saw CI flip AND a comment land. Two hairlines, not one.
  wake("w8", prWatchWakeMessage({
    target: "nubjs/nub#587",
    checks: { verdict: "failing", passed: 1, failed: 1, failing: ["typecheck"] },
    review: formatGithubWakeSteer({
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [{ label: "review comment", actor: "pullfrog", bot: true, at: new Date(Date.now() - 9 * 60_000).toISOString(), url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4810252801" }],
    }),
  })),
  // A BACKGROUND SHELL that finished while nobody was awake to be told. It must be indistinguishable
  // from the divider the runtime-reported completion draws — same glyph, same words — because it is the
  // same event; the reporter differs, and that is not a thing the transcript should show.
  // THE CONTROL, and the whole reason this pair sits adjacent: the SAME shell completion as the line
  // below it, reported by the RUNTIME instead of by frizz — a `boundary: "wake"` event, drawn by
  // ChatView's own EventLine from the server's `backgroundWakeLabel`. The two must be pixel-identical.
  // Asserting that in a comment is how it silently stops being true; rendering them adjacent is how a
  // reader catches it.
  { sourceId: "ctl", role: "assistant", kind: "event", boundary: "wake", text: "Background task «the churn suite» finished", tools: [], parts: [] },
  wake("w9", shellDoneMessage({ taskId: "bzvtnt3ig", label: "the churn suite", status: "completed" })),
  wake("w10", shellDoneMessage({ taskId: "b52kqwc13", label: "vite --port 5199 --strictPort", status: "failed" })),
  wake("w11", shellDoneMessage({ label: "Running the focused tests", status: "killed" })),
  // The FALLBACK still has to work: a wake this build cannot read keeps its first-party card and loses
  // no text. A one-off timer is the everyday example — and it keeps the card on purpose, because the
  // body is the WORKER'S OWN prose and a hairline is a one-line shape with nowhere to put it.
  wake("w12", "⏰ Re-check the promoted artifact once the release job finishes.\n\n(Timer — set for 2026-08-18T18:15:00Z. It will not fire again.)"),
]

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto flex max-w-[760px] flex-col border border-border bg-panel px-5 py-4 shadow-xl shadow-black/30 sm:px-7">
        <header className="border-b border-border pb-3">
          <h1 className="text-[16px] font-semibold text-fg">Frizz wakes — every shape frizz speaks in</h1>
          <p className="mt-0.5 text-[12px] text-muted">Review activity, a finished PR, a CI verdict, both at once, a background shell, and the unparsed fallback.</p>
        </header>
        <div className="flex flex-1 flex-col gap-3.5 py-5">
          {messages.map((message) => <Message key={message.sourceId} m={message} />)}
        </div>
      </section>
    </main>
  )
}

// `Message` reaches for react-query (the tool cards' lazy detail fetches), so the fixture supplies a
// client the way every other transcript fixture does — without it the page throws and renders nothing.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
)
