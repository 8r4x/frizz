import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AwaitingHint, BoardSnapshot, ThreadView } from "@fray-ui/shared"
import {
  FenceCard,
  LimitPauseCard,
  NativeInputRequiredCard,
  PendingAskCard,
  PermPromptBanner,
  ProviderFaultCard,
  QuestionBlockCard,
  ThreadSlugContext,
} from "./components/ChatView.tsx"
import { setBoard } from "./store.ts"
import "./styles.css"

// Every card FAMILY the transcript can render, side by side on one page — the surface the
// "right-justify the actions / give every card the done card's kind header" work is judged against.
// Nothing real is hit: rpc is stubbed the same way done-card-button-fixture does it.
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname.startsWith("/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const thread = (id: string, title: string): ThreadView => ({
  id,
  title,
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
  subAgents: [],
  bgShells: [],
})

const timerIso = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()

const fences: { slug: string; label: string; kind: "done" | "awaiting"; body: string; hints: AwaitingHint[] }[] = [
  {
    slug: "g-done",
    label: "```done",
    kind: "done",
    body: "- Fixed the cache collision in `src/resolver.ts` — the lookup now keys on the normalized id.\n- Added a regression test; `npm test` green.",
    hints: [],
  },
  { slug: "g-timer", label: "```awaiting · timer", kind: "awaiting", body: "Park until the checkpoint.", hints: [{ kind: "timer", value: timerIso }] },
  { slug: "g-pr", label: "```awaiting · pr-watch", kind: "awaiting", body: "PR is open and CI is green. Watching for review.", hints: [{ kind: "pr-watch", value: "acme/app#391" }] },
  { slug: "g-human", label: "```awaiting · human", kind: "awaiting", body: "The API shape needs approval.", hints: [{ kind: "human", value: "Alice to approve the API shape" }] },
  { slug: "g-legacy", label: "```awaiting · legacy ci (no action)", kind: "awaiting", body: "The legacy build is still running.", hints: [{ kind: "ci", value: "acme/app#7" }] },
]

const questions: { label: string; raw: string; kind: "question" | "approval" | "multi"; danger?: boolean }[] = [
  {
    label: "```question",
    kind: "question",
    raw: "Should the settings store use SQLite or a JSON file?\n\n- A. SQLite — transactional, matches the session registry (recommended: consistency with what exists)\n- B. JSON file — zero deps, human-editable, racy under concurrent writes",
  },
  {
    label: "```question approval",
    kind: "approval",
    raw: "Ready to create CONTRIBUTING.md with the draft above?\n\n- A. Approve as-is\n- B. Approve with edits — tell me what to change",
  },
  {
    label: "```question multi",
    kind: "multi",
    raw: "Which of these findings should I fix in this pass?\n\n- A. Null-deref in parse() — crashes on empty input\n- B. Off-by-one in slice() — drops the last row\n- C. Flaky timeout in the retry test — passes on rerun",
  },
  {
    label: "```question approval danger",
    kind: "approval",
    danger: true,
    raw: "Force-merge PR #391 over the failing flaky check and delete the `legacy-api` branch?\n\n- A. Do it — the failure is the known-flaky timeout\n- B. Hold — I'll wait for a green run",
  },
]

const board: BoardSnapshot = {
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
  frayActive: true,
  threads: fences.map((f) => thread(f.slug, f.label)),
  errors: [],
  warnings: [],
}
setBoard(board)

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">{label}</p>
      {children}
    </div>
  )
}

function Fixture() {
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-4 py-8">
        <p className="petite-caps text-[10px] text-accent">Signal fences</p>
        {fences.map((f) => (
          <Section key={f.slug} label={f.label}>
            <ThreadSlugContext.Provider value={f.slug}>
              <FenceCard fenceKind={f.kind} body={f.body} hints={f.hints} />
            </ThreadSlugContext.Provider>
          </Section>
        ))}
        <p className="petite-caps mt-4 text-[10px] text-accent">Question blocks</p>
        {questions.map((q) => (
          <Section key={q.label} label={q.label}>
            <QuestionBlockCard
              raw={q.raw}
              questionKind={q.kind}
              danger={q.danger}
              interactive={{
                answer: { chosen: null, text: "", chosenSet: [] },
                onChip: () => {},
                onText: () => {},
                onSubmit: () => {},
              }}
            />
          </Section>
        ))}
        <p className="petite-caps mt-4 text-[10px] text-accent">Runtime banners</p>
        <Section label="permission prompt">
          <PermPromptBanner onTerminal={() => {}} />
        </Section>
        <Section label="provider fault (sign-in required)">
          <ProviderFaultCard
            slug="g-fault"
            sessionId="s1"
            fault={{ backend: "claude", category: "authentication_required" }}
            retryText="fix the flaky test"
          />
        </Section>
        <Section label="usage-limit pause">
          <LimitPauseCard
            slug="g-pause"
            sessionId="s1"
            pause={{ backend: "claude", window: "session", at: new Date().toISOString(), resumesAt: Math.round(Date.now() / 1000) + 7200, autoResume: true }}
          />
        </Section>
        <Section label="native input required">
          <NativeInputRequiredCard input={{ kind: "tool-approval", title: "Allow `rm -rf build/`?" }} onTerminal={() => {}} />
        </Section>
        <Section label="pending native ask">
          <PendingAskCard
            ask={{
              questions: [
                {
                  question: "Which library should we use for date formatting?",
                  header: "Library",
                  multiSelect: false,
                  options: [
                    { label: "date-fns", description: "tree-shakeable, no tz database" },
                    { label: "Luxon", description: "full tz support, larger" },
                  ],
                },
              ],
            }}
            onTerminal={() => {}}
          />
        </Section>
      </main>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
