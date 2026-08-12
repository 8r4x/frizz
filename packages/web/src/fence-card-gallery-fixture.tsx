import { useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AwaitingHint, BoardSnapshot, ThreadView } from "@frizz/shared"
import { composeBlockAnswer, parseQuestionBlock, type BlockAnswer } from "./lib/questionBlocks.ts"
import {
  FenceCard,
  LimitPauseCard,
  NativeInputRequiredCard,
  PendingAskCard,
  PermPolicyDenialCard,
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
  if (url.pathname.startsWith("/_frizz/rpc/")) {
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
  watches: [],
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
  // Several watches is a different SHAPE, not the same card with more data: one ref rides the title row
  // in the `aside` slot, so a fence carrying three gets a wrapped row of its own under the prose.
  {
    slug: "g-pr-many",
    label: "```awaiting · pr-watch (several)",
    kind: "awaiting",
    body: "All three adoption PRs are open and green, in their maintainers' hands.",
    hints: [
      { kind: "pr-watch", value: "withastro/astro#17487" },
      { kind: "pr-watch", value: "vitejs/vite#23019" },
      { kind: "pr-watch", value: "strapi/strapi#26864" },
    ],
  },
  { slug: "g-human", label: "```awaiting · human", kind: "awaiting", body: "The API shape needs approval.", hints: [{ kind: "human", value: "Alice to approve the API shape" }] },
  { slug: "g-legacy", label: "```awaiting · legacy ci (no action)", kind: "awaiting", body: "The legacy build is still running.", hints: [{ kind: "ci", value: "acme/app#7" }] },
]

// The `approval` kind is RETIRED (2026-07-26) — a go/no-go is just a two-option question, and the last
// two entries are exactly that: the gate shapes a worker used to tag `approval` / `approval danger`,
// now rendering through the ordinary staged chips + Send path like every other block.
const questions: { label: string; raw: string; kind: "question" | "multi"; danger?: boolean }[] = [
  {
    label: "```question",
    kind: "question",
    raw: "Should the settings store use SQLite or a JSON file?\n\n- A. SQLite — transactional, matches the session registry (recommended: consistency with what exists)\n- B. JSON file — zero deps, human-editable, racy under concurrent writes",
  },
  {
    label: "```question · go/no-go (was `approval`)",
    kind: "question",
    raw: "Ready to create CONTRIBUTING.md with the draft above?\n\n- A. Approve as-is\n- B. Approve with edits — tell me what to change",
  },
  {
    label: "```question multi",
    kind: "multi",
    raw: "Which of these findings should I fix in this pass?\n\n- A. Null-deref in parse() — crashes on empty input\n- B. Off-by-one in slice() — drops the last row\n- C. Flaky timeout in the retry test — passes on rerun",
  },
  {
    label: "```question danger",
    kind: "question",
    danger: true,
    raw: "Force-merge PR #391 over the failing flaky check and delete the `legacy-api` branch?\n\n- A. Do it — the failure is the known-flaky timeout\n- B. Hold — I'll wait for a green run",
  },
]

const board: BoardSnapshot = {
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
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

// One question block wired to REAL local answer state (chips toggle, the free-text box types) plus a
// readout of what Send would put ON THE WIRE. Live state is what makes the gallery answer the questions
// a static render can't: does a chip select, does the free-text box take a newline, does ⌘-Enter send.
function QuestionSection({ q }: { q: (typeof questions)[number] }) {
  const parsed = useMemo(() => parseQuestionBlock(q.raw, q.kind, q.danger), [q])
  const [answer, setAnswer] = useState<BlockAnswer>({ chosen: null, text: "", chosenSet: [] })
  const [sent, setSent] = useState<string | null>(null)
  return (
    <Section label={q.label}>
      <QuestionBlockCard
        raw={q.raw}
        questionKind={q.kind}
        danger={q.danger}
        interactive={{
          answer,
          onChip: (optIdx: number) =>
            setAnswer((a) =>
              q.kind === "multi"
                ? { ...a, chosen: null, chosenSet: (a.chosenSet ?? []).includes(optIdx) ? (a.chosenSet ?? []).filter((i) => i !== optIdx) : [...(a.chosenSet ?? []), optIdx].sort((x, y) => x - y) }
                : { chosen: a.chosen === optIdx ? null : optIdx, text: "" },
            ),
          onText: (text: string) => setAnswer((a) => (q.kind === "multi" ? { ...a, text } : { chosen: null, text })),
          onSubmit: () => setSent(composeBlockAnswer(parsed, answer)),
        }}
      />
      {sent !== null && (
        <p data-sent className="whitespace-pre-wrap text-[11px] text-accent">
          sent → {sent}
        </p>
      )}
    </Section>
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
          <QuestionSection key={q.label} q={q} />
        ))}
        <p className="petite-caps mt-4 text-[10px] text-accent">Runtime banners</p>
        <Section label="permission prompt">
          <PermPromptBanner onTerminal={() => {}} />
        </Section>
        {/* Denials only. The approval line this used to sit beside is gone — see PermPolicyDenialCard. */}
        <Section label="permission policy — denied">
          <PermPolicyDenialCard
            policy={{
              decision: "deny",
              rule: "catastrophic-delete",
              reason: "Refused: this recursively force-deletes a root-level or home directory, which is unrecoverable. If you genuinely need to remove a large tree, target an explicit project-relative path instead.",
              tool: "Bash",
              command: "rm -rf ~",
              at: new Date().toISOString(),
            }}
            denies={2}
          />
        </Section>
        <Section label="permission policy — denied (long command, wrapping)">
          <PermPolicyDenialCard
            policy={{
              decision: "deny",
              rule: "history-rewrite",
              reason: "Refused: this force-pushes a rewritten history over a shared branch, which destroys commits other agents may already be building on.",
              tool: "Bash",
              command: "cd ~/.cache/nub/worktrees/canary-debug && git fetch origin && git rebase origin/main && git push origin HEAD:main --force --follow-tags",
              at: new Date().toISOString(),
            }}
          />
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
