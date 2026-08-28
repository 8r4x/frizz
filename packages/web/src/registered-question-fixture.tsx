import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, RegisteredQuestionView, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for a REGISTERED question on the queue card — a question a worker created with the `ask`
// tool, which is a row rather than a fence in a message. It renders through the shared QuestionBlockCard
// (RegisteredQuestionCards.tsx), so what is worth looking at here is what a registration adds: the ×,
// the option PREVIEW that opens under a picked option, and the FOLLOW-UP tree that appears as the root
// is answered.
//
//   ?tree=1     — a root whose "Yes" carries two follow-ups. Pick A and watch them appear indented.
//   ?danger=1   — the destructive gate: `risk` tone, and NO × (declining is an option INSIDE it).
//   ?many=1     — three open questions at once, which is what the ONE shared "Send answers" is for.
//   ?busy=1     — a question AND live background work, which is the case the memo calls out: the
//                 question expands and the waits must not compete with it for the one glance.
//   ?fence=1    — busy, AND the tail message carries a live ```awaiting fence naming the shell — the
//                 shape of a worker that registered a question, kept working, and fenced its next rest.
//                 The fence draws as prose here: no hourglass, no title, no shell table; the question
//                 is the one card (maintainer 2026-08-28, with a screenshot of the two stacked).
//   ?font=sans  — the other of the two fonts this app renders in; mono is the default and the wider.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const SETTINGS: RegisteredQuestionView = {
  id: "qst_0001aaaa",
  askedAt: ago(6),
  spec: {
    question: "Where should the settings store live?",
    kind: "question",
    options: [
      {
        label: "SQLite",
        description: "transactional, and it is where sessions already live",
        recommended: true,
        // The ONE input affordance beyond select/multi/free-text, because it is the only one that
        // changes a decision rather than decorating it.
        preview: "```sql\nCREATE TABLE setting (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n```\nMigrates with the rest of the schema; one more table in `ui.db`.",
      },
      { label: "A JSON file", description: "zero dependencies and hand-editable, but racy under concurrent writes", preview: "```json\n{ \"theme\": \"dark\", \"font\": \"mono\" }\n```\nOne file at `~/.frizz/settings.json`. Two servers writing it at once is the failure mode." },
    ],
  },
}

const TREE: RegisteredQuestionView = {
  id: "qst_0002bbbb",
  askedAt: ago(3),
  spec: {
    question: "The parser refactor is green on every gate. Land it on `main`?",
    kind: "question",
    options: [
      {
        label: "Land it",
        description: "the three CI legs are green and the diff is reviewed",
        recommended: true,
        followUps: [
          { question: "Tag a release at the same time?", kind: "question", options: [{ label: "Tag 0.9.0" }, { label: "Leave it unreleased" }] },
          { question: "Anything the release notes must say?", kind: "question" },
        ],
      },
      { label: "Hold it", description: "something about it still reads wrong", followUps: [{ question: "What is blocking it?", kind: "question" }] },
    ],
  },
}

const GATE: RegisteredQuestionView = {
  id: "qst_0003cccc",
  askedAt: ago(1),
  spec: {
    question: "`main` has three commits the remote does not. Force-push over them?",
    kind: "question",
    danger: true,
    options: [
      { label: "Force-push", description: "the three commits are the rebase of the same work — they are not lost" },
      { label: "Stop and leave the remote alone", recommended: true, description: "somebody else may have pulled them" },
    ],
  },
}

const GATES: RegisteredQuestionView = {
  id: "qst_0004dddd",
  askedAt: ago(9),
  spec: {
    question: "Which gates should run before every commit?",
    kind: "multi",
    options: [{ label: "Typecheck" }, { label: "Unit tests" }, { label: "The browser e2e pass", description: "slow — about 90s" }],
  },
}

const questions = params.get("danger") === "1" ? [GATE]
  : params.get("tree") === "1" ? [TREE]
  : params.get("many") === "1" ? [SETTINGS, TREE, GATES]
  : [SETTINGS]

const busy = params.get("busy") === "1" || params.get("fence") === "1"
const prose = "Both stores work. The choice is yours because it is the one thing here that is hard to reverse once there is data in it."
const fence = [
  "```awaiting",
  "shells: [bzvtnt3ig]",
  "for: 1h",
  "title: Launcher gate + nub-cli suite",
  "---",
  "Still parked on the `nub-launcher` workspace gate and the full nub-cli integration suite. Push and PR against `main` follow once both are clean.",
  "",
  "- already green: root `clippy --all-targets --all-features` (0 warnings), `fmt` ×3, nub-core 440 tests",
  "- the last edits are comment- and prose-only, so they cannot change the outcome of the gates running",
  "```",
].join("\n")
const tail = params.get("fence") === "1" ? `${prose}\n\n${fence}` : prose
const messages: TranscriptMessage[] = [
  { role: "user", text: "Add a settings store.", tools: [], parts: [{ kind: "text", text: "Add a settings store." }] },
  { role: "assistant", text: tail, tools: [], parts: [{ kind: "text", text: tail }] },
]

const thread = {
  id: "registered-question-demo",
  title: "Add a settings store",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  // A registered question is a hard queue member — deriveNeedsYou returns true on any open row.
  needsYou: true,
  awaitingBackground: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000009",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  questions,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: busy
    ? [{ id: "agent-a", label: "Audit the parser for edge cases", subagentType: "frizz:high", startedAt: ago(4), state: "running" }]
    : [],
  bgShells: busy
    ? [{ id: "toolu_ci", taskId: "bzvtnt3ig", label: "gh run watch 1842", startedAt: ago(6), state: "running" }]
    : [],
  watches: busy
    ? [{ id: "wch_aaa", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(6) }]
    : [],
  lastActivityAt: ago(1),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  // The two writes the card makes, echoed onto the window so a probe can assert the exact payload the
  // worker would receive — above all that an answer RESTATES the question and carries the option's own
  // label rather than the lettered chip text.
  if (url.pathname === "/_frizz/rpc/answerQuestions" || url.pathname === "/_frizz/rpc/dismissQuestions") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: url.pathname.split("/").pop(), body } }))
    const ids: string[] = body.ids ?? (body.answers ?? []).map((a: { questionId: string }) => a.questionId)
    return new Response(JSON.stringify({ result: { answered: ids, dismissed: ids, open: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
        <TodosView />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
