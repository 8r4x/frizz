import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, ChevronUp, CircleHelp, CornerLeftUp, ExternalLink, Paperclip } from "lucide-react"
import { prWatchWakeMessage, type BoardSnapshot, type RegisteredQuestionView, type ThreadView } from "@frizz/shared"
import type { ChatMessage } from "./hooks.ts"
import { Message, withMessageSpacers } from "./components/ChatView.tsx"
import { STEP, VSpace } from "./components/rhythm.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { LinkedHtml } from "./components/LinkedHtml.tsx"
import {
  RegisteredAnsweringContext, RegisteredQuestionCard, RegisteredQuestionStack, questionIsStaged, useRegisteredAnswering,
  type RegisteredAnswering,
} from "./components/RegisteredQuestionCards.tsx"
import { useMarkdownHtml } from "./lib/useMarkdown.ts"
import { store } from "./store.ts"
import "./styles.css"

// MOCKUP SHEET — WHERE AN OPEN QUESTION GOES WHEN THE THREAD RESUMES AND RESTS AGAIN.
//
// Not shipped UI and not a test. The maintainer, 2026-10-01: "The thing that we're doing now where if a
// session resumes, then the questions are taken out of the place where they were sort of embedded in the
// transcript and all just show up in a bunch at the bottom of the chat is not working very well."
//
// Today (lib/questionAnchor + lib/questionShadow placeQuestions, `atRest`): once the thread rests again
// with the worker last to speak, EVERY open question anchors to the newest rest, and a placement marker
// in an older handoff stops placing. The cards leave the prose that set them up and stack at the tail.
// That move exists for two reports (2026-08-31, 2026-09-13) where the newest rest showed no ask at all.
//
// Every frame below is the REAL Message renderer and the REAL RegisteredQuestionCard / Stack, sharing one
// useRegisteredAnswering per frame, so picks and Send behave as they do in the app (the RPC is stubbed).
// The dock, the pointer card, the moved-card context and the placeholder are new and drawn here.
//
//   http://localhost:5478/question-resume-mockup-fixture.html
//   ?theme=light · ?surface=queue · ?scenario=wake · ?extra=on (a new question at the newest rest too)
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const SHEET_CSS = `
@keyframes qr-flash { 0%, 35% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 60%, transparent); } 100% { box-shadow: 0 0 0 3px transparent; } }
.qr-flash { animation: qr-flash 1.6s ease-out; border-radius: 12px; }
`

// ── the thread ────────────────────────────────────────────────────────────────────────────────────

const MIN = 60_000
const at = (min: number) => new Date(Date.now() - min * MIN).toISOString()

const Q_CACHES: RegisteredQuestionView = {
  id: "qst_7a1c0e2f",
  askedAt: at(82),
  spec: {
    question: "Fix the import-map cache and the tsconfig lookup in this change too, or leave them for a separate one?",
    kind: "question",
    options: [
      { label: "Fix them here", description: "same root cause and the same test shape — one review instead of two", recommended: true },
      { label: "A separate change", description: "keeps this diff to the bug that was reported" },
    ],
  },
} as RegisteredQuestionView

const Q_FORMAT: RegisteredQuestionView = {
  id: "qst_9b3d51aa",
  askedAt: at(82),
  spec: {
    question: "Ship the new cache format as it is, or add a migration that rewrites the old entries?",
    kind: "question",
    options: [
      { label: "Ship it as it is", description: "one cold start per machine, and no migration code to keep", recommended: true },
      { label: "Add a migration", description: "no cold start; about 80 lines that run once and then sit there" },
    ],
  },
} as RegisteredQuestionView

const Q_NEW_HUMAN: RegisteredQuestionView = {
  id: "qst_c40e9d17",
  askedAt: at(3),
  spec: {
    question: "The same 30-second debounce also slows the first `nub run dev` after a rename. Lower it there as well?",
    kind: "question",
    options: [
      { label: "Lower it to 2s", description: "only the first rebuild after a rename gets faster", recommended: true },
      { label: "Leave the dev config alone", description: "it is a separate setting with its own users" },
    ],
  },
} as RegisteredQuestionView

const Q_NEW_WAKE: RegisteredQuestionView = {
  id: "qst_c40e9d17",
  askedAt: at(3),
  spec: {
    question: "CI is green on all three legs. Mark #391 ready for review now, or keep it a draft until the cache calls are settled?",
    kind: "question",
    options: [
      { label: "Mark it ready", description: "neither call changes what a reviewer reads first", recommended: true },
      { label: "Keep it a draft", description: "a reviewer would see a diff that may still grow" },
    ],
  },
} as RegisteredQuestionView

const ASK_HANDOFF = [
  "**Needs you** — renamed files resolved stale because the resolver cached on the raw path. The fix is on the `cache-key` branch, and two calls stand between it and `main`.",
  "",
  "The cache now keys on the normalized id, so a rename misses the old entry and re-resolves. The new regression test fails without the change and passes with it.",
  "",
  "The same pattern sits in two more places — the import-map cache and the tsconfig lookup. Neither has a reported bug, but both go stale the same way on a rename:",
  "",
  "```question qst_7a1c0e2f",
  "```",
  "",
  "The fix also changes the on-disk cache format, so every existing entry misses once after the upgrade. On this repo that is one 40-second cold start per machine:",
  "",
  "```question qst_9b3d51aa",
  "```",
  "",
  "Either way, the branch stays rebased on `main` until these are settled.",
].join("\n")

type Scenario = "human" | "wake"

const NEWEST: Record<Scenario, string> = {
  human: "**Fixed** — the 40 seconds was the watch fixture's 30-second debounce, not the resolver. The fixture now sets the debounce to 0, and the suite runs in 6s. `4f1c2a9` is on the `cache-key` branch.",
  wake: "**Fixed** — the Windows leg failed on a hard-coded `/` in the new rename test; the fixture path now goes through `path.join`. `4f1c2a9` is pushed to #391, and CI is green on all three legs.",
}

// Option D: the newest handoff as a worker writes it when Frizz holds the rest until every question
// asked at an EARLIER rest is placed again (or withdrawn).
const REPLACED: Record<Scenario, string> = {
  human: [
    NEWEST.human,
    "",
    "The two calls from before are still open, and the faster suite changes neither. The other two caches still go stale the same way on a rename:",
    "",
    "```question qst_7a1c0e2f",
    "```",
    "",
    "The cold start after the format change is now about 6 seconds rather than 40, which makes shipping without a migration cheaper still:",
    "",
    "```question qst_9b3d51aa",
    "```",
  ].join("\n"),
  wake: [
    NEWEST.wake,
    "",
    "The two cache calls from before are still open; the Windows fix touches neither. The other two caches still go stale the same way on a rename:",
    "",
    "```question qst_7a1c0e2f",
    "```",
    "",
    "And the format change still costs one 40-second cold start per machine:",
    "",
    "```question qst_9b3d51aa",
    "```",
  ].join("\n"),
}

const text = (sourceId: string, role: "user" | "assistant", body: string, min: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  sourceId, role, text: body, tools: [], parts: role === "user" ? [] : [{ kind: "text", text: body }], at: at(min), ...extra,
} as ChatMessage)
const work = (sourceId: string, lead: string, tools: { name: string; detail: string; desc?: string }[], min: number): ChatMessage => ({
  sourceId, role: "assistant", text: "", tools: [], parts: [{ kind: "text", text: lead }, { kind: "tools", tools }], at: at(min),
} as ChatMessage)

function transcript(scenario: Scenario, newest: string): ChatMessage[] {
  const head = [
    text("u1", "user", "Renamed files keep resolving to their old module until I restart the dev server. Find out why and fix it.", 95),
    work("a1", "Reading the resolver and its cache first.", [
      { name: "Read", detail: "src/resolver/cache.ts" },
      { name: "Grep", detail: "cacheKey" },
      { name: "Edit", detail: "src/resolver/cache.ts" },
      { name: "Write", detail: "src/resolver/rename.test.ts" },
      { name: "Bash", detail: "nub run test resolver", desc: "Running the resolver tests" },
    ], 90),
    text("a2", "assistant", ASK_HANDOFF, 82),
  ]
  const resume = scenario === "human"
    ? [
        text("u2", "user", "Before you land it — why does the resolver suite take 40 seconds on CI now?", 40),
        work("a3", "Timing the suite.", [
          { name: "Bash", detail: "nub --test --test-reporter=spec src/resolver", desc: "Timing each resolver test" },
          { name: "Read", detail: "src/resolver/fixtures/watch.ts" },
          { name: "Edit", detail: "src/resolver/fixtures/watch.ts" },
          { name: "Bash", detail: "nub run test resolver", desc: "Running the resolver tests" },
        ], 30),
      ]
    : [
        text("w1", "user", prWatchWakeMessage({ target: "acme/app#391", checks: { verdict: "failing", passed: 2, failed: 1, failing: ["test (windows-latest)"] } }), 40, { wake: true } as Partial<ChatMessage>),
        work("a3", "Reading the failed Windows job.", [
          { name: "Bash", detail: "gh run view 1842 --log-failed", desc: "Reading the failed Windows job" },
          { name: "Edit", detail: "src/resolver/rename.test.ts" },
          { name: "Bash", detail: "git push", desc: "Pushing the fix" },
        ], 30),
      ]
  return [...head, ...resume, text("a4", "assistant", newest, 3)]
}

// ── the frame: a thread page or a queue card, with a scroller the new pieces can jump inside ──────────

type Surface = "page" | "queue"
type Option = "today" | "dock" | "pointer" | "carry" | "replace"

interface FrameApi { jump: (selector: string) => void; surface: Surface }
const FrameContext = createContext<FrameApi>({ jump: () => {}, surface: "page" })

function jumpIn(scroller: HTMLElement | null, selector: string) {
  const el = scroller?.querySelector<HTMLElement>(selector)
  if (!scroller || !el) return
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 40
  scroller.scrollTo({ top, behavior: "smooth" })
  el.classList.remove("qr-flash")
  void el.offsetWidth
  el.classList.add("qr-flash")
}

const thread = (slug: string, questions: RegisteredQuestionView[]) => ({
  id: slug, title: "Fix stale resolution after a rename", status: "active", mechanism: null, humanBlocked: false, needsYou: true,
  awaitingBackground: false, ready: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "turn-idle",
  unread: false, archived: false, hasPlan: false, pendingQuestion: false, questions, kind: "session", foreign: false, backend: "claude",
  permissionMode: "default", subAgents: [], bgShells: [], watches: [], lastActivityAt: at(3),
}) as unknown as ThreadView

store.board = { projectDir: "/fixture/acme", threads: [] } as unknown as BoardSnapshot

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  // location.href, not origin: the page also ships as one file:// document, whose origin is "null".
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.href)
  if (url.pathname === "/_frizz/rpc/answerQuestions") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { slug: string; answers: { questionId: string }[] }
    window.dispatchEvent(new CustomEvent("qr-sent", { detail: body }))
    return new Response(JSON.stringify({ result: { answered: [], open: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

function PromptBox() {
  return (
    <div className="rounded-xl border border-border bg-bg">
      <div className="px-3.5 pb-1 pt-2.5 text-[13px] leading-relaxed text-muted">Reply, or steer the worker…</div>
      <div className="flex items-center justify-end gap-2 pb-1.5 pl-1.5 pr-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg text-muted"><Paperclip size={15} strokeWidth={2} /></span>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-panel-2 text-muted"><ArrowUp size={14} strokeWidth={2.5} /></span>
      </div>
    </div>
  )
}

function Frame({ slug, questions, surface, height, bottom, children }: {
  slug: string
  questions: RegisteredQuestionView[]
  surface: Surface
  height: number
  bottom?: ReactNode
  children: ReactNode
}) {
  const t = useMemo(() => thread(slug, questions), [slug, questions])
  const answering = useRegisteredAnswering(t)
  const scroller = useRef<HTMLDivElement>(null)
  const [last, setLast] = useState<string>()
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => {
    const on = (e: Event) => {
      const body = (e as CustomEvent).detail as { slug: string; answers: { questionId: string; answer?: unknown }[] }
      if (body.slug !== slug) return
      setLast(`${body.answers.length} answer${body.answers.length === 1 ? "" : "s"} in one call — ${body.answers.map((a) => a.questionId).join(", ")}`)
    }
    window.addEventListener("qr-sent", on)
    return () => window.removeEventListener("qr-sent", on)
  }, [slug])
  return (
    <FrameContext.Provider value={{ jump: (selector) => jumpIn(scroller.current, selector), surface }}>
      <RegisteredAnsweringContext.Provider value={answering}>
        <div className="w-[720px] max-w-full">
          <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-bg" style={{ height }}>
            <div className="flex shrink-0 items-baseline gap-2 border-b border-border px-5 py-2.5">
              <span className="truncate text-[13px] font-medium">Fix stale resolution after a rename</span>
              <span className="ml-auto shrink-0 text-[11.5px] text-muted">{surface === "queue" ? "Queue card · rested 3m ago" : "Thread page"}</span>
            </div>
            <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
              <div className="px-6 pb-5 pt-5">{children}</div>
            </div>
            <div className="shrink-0 px-4 pb-4 pt-1">
              {bottom}
              <PromptBox />
            </div>
          </div>
          <div className="mt-1.5 h-4 text-[11px] text-muted-80">{last ? `Sent: ${last}` : ""}</div>
        </div>
      </RegisteredAnsweringContext.Provider>
    </FrameContext.Provider>
  )
}

// ── shared pieces ───────────────────────────────────────────────────────────────────────────────────

/** The paragraph a marker closes — the setup the worker wrote for the question. */
function couchingOf(body: string, id: string): string | undefined {
  const at = body.indexOf(`\`\`\`question ${id}`)
  if (at < 0) return undefined
  const paras = body.slice(0, at).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  return paras.at(-1)
}

/** Split a message at its markers, so a slot can be drawn where each one stood. */
function splitAtMarkers(body: string): ({ kind: "text"; text: string } | { kind: "marker"; id: string })[] {
  const out: ({ kind: "text"; text: string } | { kind: "marker"; id: string })[] = []
  const re = /```question (qst_[a-z0-9]+)\n```/g
  let from = 0
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const chunk = body.slice(from, m.index).trim()
    if (chunk) out.push({ kind: "text", text: chunk })
    out.push({ kind: "marker", id: m[1] })
    from = m.index + m[0].length
  }
  const rest = body.slice(from).trim()
  if (rest) out.push({ kind: "text", text: rest })
  return out
}

function SlottedMessage({ m, slot }: { m: ChatMessage; slot: (id: string) => ReactNode }) {
  const parts = splitAtMarkers(m.text)
  const out: ReactNode[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push(<VSpace key={`s${i}`} h={STEP} />)
    out.push(p.kind === "text"
      ? <Message key={i} m={{ ...m, sourceId: `${m.sourceId}-${i}`, text: p.text, parts: [{ kind: "text", text: p.text }] } as ChatMessage} />
      : <div key={i}>{slot(p.id)}</div>)
  })
  return <div>{out}</div>
}

function Couching({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return <LinkedHtml className="md-inline border-l-2 border-border pl-3 text-[13px] leading-[20px] text-muted [&_code]:text-[0.9em]" html={html} />
}

const ASKED_AGO = "1h 22m ago"

function Provenance({ id }: { id: string }) {
  const { jump, surface } = useContext(FrameContext)
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[12px] text-muted">
      <CornerLeftUp size={12} className="shrink-0" />
      <span>From the handoff {ASKED_AGO}{surface === "queue" ? ", before the last reply" : ""}</span>
      <span className="text-muted-60">·</span>
      {surface === "page"
        ? <button type="button" onClick={() => jump(`[data-origin="${id}"]`)} className="underline decoration-border underline-offset-2 hover:text-fg">Show where it was asked</button>
        : <span className="inline-flex items-center gap-1 underline decoration-border underline-offset-2">Open in the thread <ExternalLink size={11} /></span>}
    </div>
  )
}

/** A card that left its prose, carrying the sentence that set it up. */
function CarriedCard({ q }: { q: RegisteredQuestionView }) {
  const couching = couchingOf(ASK_HANDOFF, q.id)
  return (
    <div data-carried={q.id}>
      <Provenance id={q.id} />
      {couching && <div className="mb-3"><Couching md={couching} /></div>}
      <RegisteredQuestionCard q={q} />
    </div>
  )
}

function Placeholder({ id, label }: { id: string; label: string }) {
  const { jump } = useContext(FrameContext)
  return (
    <button
      type="button"
      data-origin={id}
      onClick={() => jump(`[data-carried="${id}"], [data-question-id="${id}"]`)}
      className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left text-[12.5px] text-muted transition-colors hover:text-fg"
    >
      <ArrowDown size={13} className="shrink-0" />
      {label}
    </button>
  )
}

function SendRow({ n }: { n: number }) {
  const a = useContext(RegisteredAnsweringContext)!
  return (
    <span className="flex items-center gap-2.5">
      <span className="text-[11.5px] tabular-nums text-muted">{a.staged} of {n} answered</span>
      <button
        type="button"
        disabled={a.staged === 0 || a.sending}
        onClick={a.submit}
        onMouseDown={(e) => e.preventDefault()}
        className="button-outline rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
      >
        Send answers
      </button>
    </span>
  )
}

function staged(a: RegisteredAnswering, q: RegisteredQuestionView): boolean {
  return questionIsStaged(q, a.answersOf(q))
}

function QuestionLine({ q, n }: { q: RegisteredQuestionView; n: number }) {
  const html = useMarkdownHtml(q.spec.question)
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="w-3 shrink-0 font-semibold tabular-nums text-accent">{n}</span>
      <LinkedHtml as="span" className="md-inline min-w-0 flex-1 truncate [&_code]:text-[0.9em]" html={html} />
    </span>
  )
}

// ── B: the dock on the prompt box ─────────────────────────────────────────────────────────────────

function Dock({ open, offWindow }: { open: RegisteredQuestionView[]; offWindow: RegisteredQuestionView[] }) {
  const a = useContext(RegisteredAnsweringContext)!
  const { jump, surface } = useContext(FrameContext)
  const [expanded, setExpanded] = useState(false)
  const [cursor, setCursor] = useState(open.length)
  const go = (dir: 1 | -1) => {
    const next = (cursor + dir + open.length) % open.length
    setCursor(next)
    jump(`[data-question-id="${open[next].id}"]`)
  }
  if (open.length === 0) return null
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-panel">
      {expanded && (
        <div className="border-b border-border py-1">
          {open.map((q, i) => (
            <button key={q.id} type="button" onClick={() => { setCursor(i); jump(`[data-question-id="${q.id}"]`) }} className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-[12.5px] hover:bg-panel-2">
              <QuestionLine q={q} n={i + 1} />
              <span className="shrink-0 text-[11.5px] text-muted">{q.askedAt === Q_CACHES.askedAt ? ASKED_AGO : "3m ago"}</span>
              <span className="flex w-3.5 shrink-0 justify-center">{staged(a, q) ? <Check size={12} className="text-accent" /> : <ArrowUp size={12} className="text-muted" />}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 py-1 pl-2 pr-1.5 text-[12px]">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-accent hover:bg-panel-2">
          <CircleHelp size={12.5} className="translate-y-px" />
          <span><span className="font-medium tabular-nums">{open.length}</span> open question{open.length === 1 ? "" : "s"}</span>
          {surface === "queue" && offWindow.length > 0 && <span className="text-muted">· {offWindow.length} from an earlier rest</span>}
        </button>
        <button type="button" title="Previous question" onClick={() => go(-1)} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><ChevronUp size={12} /></button>
        <button type="button" title="Next question" onClick={() => go(1)} className="flex h-5 w-5 items-center justify-center rounded text-muted-60 hover:bg-panel-2 hover:text-fg"><ChevronDown size={12} /></button>
        <span className="ml-auto"><SendRow n={open.length} /></span>
      </div>
    </div>
  )
}

// ── A: a pointer card at the newest rest ──────────────────────────────────────────────────────────

function PointerCard({ older, all }: { older: RegisteredQuestionView[]; all: RegisteredQuestionView[] }) {
  const a = useContext(RegisteredAnsweringContext)!
  const { jump, surface } = useContext(FrameContext)
  const [openRow, setOpenRow] = useState<string>()
  return (
    <section className="overflow-hidden rounded-xl border border-border-strong bg-panel">
      <div className="px-4 pb-1.5 pt-3 text-[13px] font-medium">
        {older.length === 1 ? "A question from an earlier rest is still open" : `${older.length} questions from an earlier rest are still open`}
      </div>
      {older.map((q) => {
        const n = all.indexOf(q) + 1
        const expanded = surface === "queue" && openRow === q.id
        return (
          <div key={q.id}>
            <button
              type="button"
              onClick={() => (surface === "page" ? jump(`[data-question-id="${q.id}"]`) : setOpenRow(expanded ? undefined : q.id))}
              className="flex w-full items-baseline gap-2 px-4 py-1.5 text-left text-[13px] hover:bg-panel-2"
            >
              <QuestionLine q={q} n={n} />
              <span className="shrink-0 text-[11.5px] text-muted">asked {ASKED_AGO}</span>
              <span className="flex w-3.5 shrink-0 justify-center">
                {staged(a, q) ? <Check size={12} className="text-accent" /> : surface === "page" ? <ArrowUp size={12} className="text-muted" /> : expanded ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />}
              </span>
            </button>
            {expanded && <div className="px-4 pb-3 pt-1"><CarriedCard q={q} /></div>}
          </div>
        )
      })}
      <div className="mt-1.5 flex justify-end border-t border-border px-3 py-2"><SendRow n={all.length} /></div>
    </section>
  )
}

// ── the five candidates ────────────────────────────────────────────────────────────────────────────

interface Setup { scenario: Scenario; extra: boolean; surface: Surface }

function questionsOf({ scenario, extra }: Setup): { older: RegisteredQuestionView[]; newer: RegisteredQuestionView[]; all: RegisteredQuestionView[] } {
  const older = [Q_CACHES, Q_FORMAT]
  const newer = extra ? [scenario === "human" ? Q_NEW_HUMAN : Q_NEW_WAKE] : []
  return { older, newer, all: [...older, ...newer] }
}

/** The transcript, with the asking handoff drawn by `asking` and everything else through Message. On the
 *  queue card the window opens at the reply that resumed the thread, so the asking rest is not in it. */
function Transcript({ setup, newest, asking, newestPlaced }: { setup: Setup; newest: string; asking: (m: ChatMessage) => ReactNode; newestPlaced?: RegisteredQuestionView[] }) {
  const all = transcript(setup.scenario, newest)
  const from = setup.surface === "queue" ? all.findIndex((m) => m.sourceId === "u2" || m.sourceId === "w1") : 0
  return (
    <>
      {withMessageSpacers(all.slice(from), (m) =>
        m.sourceId === "a2" ? <div key={m.sourceId}>{asking(m)}</div>
        : m.sourceId === "a4" && newestPlaced ? <Message key={m.sourceId} m={m} placed={newestPlaced} />
        : <Message key={m.sourceId} m={m} />,
      )}
    </>
  )
}

function Candidate({ option, setup }: { option: Option; setup: Setup }) {
  const { older, newer, all } = useMemo(() => questionsOf(setup), [setup.scenario, setup.extra])
  const slug = `qr-${option}-${setup.scenario}-${setup.extra ? "x" : "o"}-${setup.surface}`
  const height = setup.surface === "queue" ? 640 : 760
  const tail = (node: ReactNode) => <><VSpace h={20} />{node}</>

  if (option === "today") {
    return (
      <Frame key={slug} slug={slug} questions={all} surface={setup.surface} height={height}>
        {/* The asking handoff's markers are stale at the newest rest, so they draw nothing — exactly as the
            app does — and every open question stacks at the tail with the one Send. */}
        <Transcript setup={setup} newest={NEWEST[setup.scenario]} asking={(m) => <Message m={m} />} />
        {tail(<RegisteredQuestionStack thread={thread(slug, all)} questions={all} />)}
      </Frame>
    )
  }
  if (option === "dock") {
    return (
      <Frame key={slug} slug={slug} questions={all} surface={setup.surface} height={height} bottom={<Dock open={all} offWindow={setup.surface === "queue" ? older : []} />}>
        <Transcript setup={setup} newest={NEWEST[setup.scenario]} asking={(m) => <Message m={m} placed={older} />} />
        {/* The queue card's window opens after the asking rest, so there is no context to leave the cards
            in: they come to the bottom of the card with the sentence that set them up, as in C. */}
        {setup.surface === "queue" && tail(<div className="flex flex-col gap-6">{older.map((q) => <CarriedCard key={q.id} q={q} />)}</div>)}
        {newer.length > 0 && tail(<div className="flex flex-col gap-3">{newer.map((q) => <RegisteredQuestionCard key={q.id} q={q} />)}</div>)}
      </Frame>
    )
  }
  if (option === "pointer") {
    return (
      <Frame key={slug} slug={slug} questions={all} surface={setup.surface} height={height}>
        <Transcript setup={setup} newest={NEWEST[setup.scenario]} asking={(m) => <Message m={m} placed={older} />} />
        {newer.length > 0 && tail(<div className="flex flex-col gap-3">{newer.map((q) => <RegisteredQuestionCard key={q.id} q={q} />)}</div>)}
        {tail(<PointerCard older={older} all={all} />)}
      </Frame>
    )
  }
  if (option === "carry") {
    return (
      <Frame key={slug} slug={slug} questions={all} surface={setup.surface} height={height}>
        <Transcript
          setup={setup}
          newest={NEWEST[setup.scenario]}
          asking={(m) => <SlottedMessage m={m} slot={(id) => <Placeholder id={id} label="Moved to the newest rest — still open" />} />}
        />
        {tail(<div className="flex flex-col gap-6">{older.map((q) => <CarriedCard key={q.id} q={q} />)}</div>)}
        {tail(<RegisteredQuestionStack thread={thread(slug, all)} questions={newer} showSend />)}
      </Frame>
    )
  }
  return (
    <Frame key={slug} slug={slug} questions={all} surface={setup.surface} height={height}>
      <Transcript
        setup={setup}
        newest={REPLACED[setup.scenario]}
        newestPlaced={older}
        asking={(m) => <SlottedMessage m={m} slot={(id) => <Placeholder id={id} label="Asked again in the newest handoff — still open" />} />}
      />
      {tail(<RegisteredQuestionStack thread={thread(slug, all)} questions={newer} showSend />)}
    </Frame>
  )
}

// ── the page ──────────────────────────────────────────────────────────────────────────────────────

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span>{label}</span>
      <div className="flex rounded-md border border-border p-0.5">
        {options.map((o) => (
          <button key={o.value} type="button" onClick={() => onChange(o.value)} className={`rounded px-2 py-0.5 transition-colors ${o.value === value ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

interface Spec { option: Option; letter: string; title: string; pick?: boolean; note: ReactNode; good: string[]; bad: string[] }

const SPECS: Spec[] = [
  {
    option: "today",
    letter: "0",
    title: "Today — every open question moves to the newest rest",
    note: "The control. The asking handoff keeps its setup sentences (each ends in a colon) with nothing after them, and the cards stack under a handoff about something else.",
    good: ["The newest rest always shows the ask, and the cards are answerable without scrolling.", "One Send for every card."],
    bad: ["The cards lose the prose that explained them, and that prose now points at nothing.", "Questions from different rests and topics pile into one stack."],
  },
  {
    option: "dock",
    letter: "A",
    pick: true,
    title: "Cards stay where they were asked; a line on the prompt box counts them and sends",
    note: "Nothing in the transcript moves. A line docked on the prompt box says how many questions are open, steps between them (the arrows scroll to each card and flash it), opens a list on a click, and carries the one Send with a count of what is answered. On the queue card the asking rest is outside the card, so there the cards come to the bottom with the sentence that set them up (as in C), and the line counts and sends. It is the desktop form of the phone's bottom bar, and the same line the queue-card mockup already uses for pending comments.",
    good: ["The cards keep their context, and the transcript reads as history.", "Most resumes are wakes; with this, a wake that rests again adds its message and moves nothing.", "The ask is on screen at any scroll position, not only at the bottom.", "Send and the count are always on screen, so an answer given far up does not need a scroll back down.", "Fresh questions look as they do today: the line replaces the Send button under the cards."],
    bad: ["New chrome on the prompt box.", "Answering an old question on the thread page means a jump up, then a jump back.", "A question above the loaded window needs earlier history to load before the jump."],
  },
  {
    option: "pointer",
    letter: "B",
    title: "Cards stay where they were asked; the newest rest ends in a card that points back up",
    note: "Nothing moves. The newest rest ends with a card that lists the still-open questions from earlier rests, one line each, and carries the one Send. On the thread page a line jumps to its card; on the queue card a line opens the card in place with its setup sentence.",
    good: ["The cards keep their context.", "The newest rest visibly ends in the ask, in the transcript itself.", "No new chrome outside the transcript."],
    bad: ["Answer up there, Send down here: the Send scrolls out of view while the human answers.", "Two shapes for one question (the card, and its line in the pointer)."],
  },
  {
    option: "carry",
    letter: "C",
    title: "Cards still move, but carry their setup and leave a placeholder",
    note: "The smallest change. Each moved card brings the paragraph that set it up and a link back to where it was asked; the old spot keeps a dashed placeholder that jumps down to it.",
    good: ["The newest rest shows the ask with its reasoning, and everything is answerable in place.", "Works the same on the queue card."],
    bad: ["The cards still leave the prose; the asking handoff still reads with holes.", "The tail grows: every moved card brings a quote."],
  },
  {
    option: "replace",
    letter: "D",
    title: "The worker asks again in its new handoff",
    note: "A contract and server change. When a thread rests with a question still open from an earlier rest, Frizz holds the rest until the new handoff places that question again (with a marker) or withdraws it. Today's marker code already moves the card into the new handoff. Can combine with A as the fallback when a worker does not comply.",
    good: ["The best context: the worker rewrites the setup for what has changed (\"now about 6 seconds rather than 40\").", "Forces a stale question to be withdrawn rather than left to rot."],
    bad: ["Workers placed a carried question again on their own for only 14% of them, so this needs a forced extra turn at most rests.", "Repeated prose on every wake: one question here outlived 35 rests, and D would ask it 35 times.", "The cards still move, once per rest."],
  },
]

const TABLE: { label: string; cells: Record<Option, string> }[] = [
  { label: "Card keeps its setup prose", cells: { today: "No", dock: "Yes", pointer: "Yes", carry: "Quoted", replace: "Rewritten" } },
  { label: "Newest rest shows the ask", cells: { today: "Yes", dock: "On the prompt box", pointer: "Yes", carry: "Yes", replace: "Yes" } },
  { label: "Answer without scrolling", cells: { today: "Yes", dock: "No (jump, then Send stays on screen)", pointer: "No (jump, then scroll back)", carry: "Yes", replace: "Yes" } },
  { label: "Queue card", cells: { today: "Cards at the bottom", dock: "Cards at the bottom, with setup", pointer: "Rows open in place", carry: "Cards with setup", replace: "Cards in the new handoff" } },
  { label: "Worker contract", cells: { today: "Says the card stays put (false)", dock: "True as written", pointer: "True as written", carry: "Must change", replace: "Must change, plus a rest check" } },
  { label: "Cost", cells: { today: "—", dock: "Web, medium", pointer: "Web, small", carry: "Web, small", replace: "Server + contract + a worker turn" } },
]

// Measured 2026-10-01 over ~/.frizz/ui.db `thread_question` and each thread's Claude transcript (Codex
// threads skipped): a REST is a turn boundary in the transcript, a WAKE carries Frizz's trailing
// `<!-- frizz-wake:… -->` comment or is a task notification. Method and examples are in the thread's
// scratch report, not in the repo.
const DATA: [string, string][] = [
  ["Still open at one or more later rests", "331 of 867 (38%) — 53 of them at six or more; one at 35"],
  ["What resumed the thread first", "A Frizz wake for 72% (CI or PR 86, sub-agent finished 61, background command 39, scheduled prompt 24, other 30); the human typing for 28%"],
  ["Rests that carried a question over", "774 — 248 of them with two or more open, and 146 of those mixed questions from different rests (largest: 11)"],
  ["Questions placed with a marker", "284 (33%) — 189 of them mid-prose, 95 at the end"],
  ["Carried questions the worker placed again later", "45 of 331 (14%); 219 (66%) were never mentioned again"],
  ["Carried questions that ended withdrawn", "42%, against 33% for questions settled at their own rest"],
]

function Page() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "dark")
  const [scenario, setScenario] = useState<Scenario>(params.get("scenario") === "wake" ? "wake" : "human")
  const [extra, setExtra] = useState<"off" | "on">(params.get("extra") === "on" ? "on" : "off")
  const [surface, setSurface] = useState<Surface>(params.get("surface") === "queue" ? "queue" : "page")
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const setup: Setup = { scenario, extra: extra === "on", surface }
  return (
    <main className="min-h-screen bg-bg pb-24 text-fg">
      <style>{SHEET_CSS}</style>
      <header className="mx-auto max-w-[1560px] px-8 pb-6 pt-9">
        <h1 className="text-[22px] font-semibold tracking-tight">Open questions after a thread resumes</h1>
        <div className="mt-2 max-w-[920px] space-y-2 text-[13px] leading-[20px] text-muted">
          <p>A worker asks two questions inside its handoff. The thread then resumes without an answer — the human replies about something else, or Frizz wakes the worker — and the worker rests again. Today both cards leave the handoff and stack at the bottom, under a message about something else.</p>
          <p>The move exists for a reason. On 2026-08-31 (“Why was this able to come to rest without a proper handoff?”) and 2026-09-13 (“How did this thread pause without a sign-off?”), the cards stayed at the old rest and the newest rest showed no ask. Every option below keeps the newest rest visibly owing an answer.</p>
          <p>A contributing cause: the worker contract says “Frizz draws every open question at the rest it was asked”, which is false at rest. So a worker rarely places an old question again in a later handoff.</p>
        </div>
        <div className="mt-5 max-w-[920px]">
          <h2 className="mb-2 text-[13px] font-medium text-fg/90">How often it happens — the 867 questions Claude workers asked on this machine since 2026-09-11</h2>
          <table className="w-full border-collapse text-[12.5px] leading-[18px]">
            <tbody>
              {DATA.map(([fact, value]) => (
                <tr key={fact} className="border-b border-border/60 align-top">
                  <td className="py-1.5 pr-6 text-muted">{fact}</td>
                  <td className="py-1.5 text-fg/90">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </header>
      <nav className="sticky top-0 z-50 border-y border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-x-6 gap-y-2 px-8 py-2.5">
          <Seg label="Surface" value={surface} onChange={setSurface} options={[{ value: "page", label: "Thread page" }, { value: "queue", label: "Queue card" }]} />
          <Seg label="Resumed by" value={scenario} onChange={setScenario} options={[{ value: "human", label: "The human, without answering" }, { value: "wake", label: "A Frizz wake (CI)" }]} />
          <Seg label="New question at the newest rest" value={extra} onChange={setExtra} options={[{ value: "off", label: "No" }, { value: "on", label: "Yes" }]} />
          <Seg label="Theme" value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
        </div>
      </nav>
      <div className="mx-auto max-w-[1560px] px-8 pt-10">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(720px,1fr))] gap-x-10 gap-y-14">
          {SPECS.map((s) => (
            <div key={s.option} className="min-w-0">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="font-mono text-[12px] text-muted-80">{s.letter}</span>
                <h3 className="text-[13.5px] font-medium text-fg/90">{s.title}</h3>
                {s.pick && <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10.5px] font-medium text-accent">Recommended</span>}
              </div>
              <p className="mb-2 max-w-[720px] text-[12px] leading-[18px] text-muted-80">{s.note}</p>
              <div className="mb-3 grid max-w-[720px] grid-cols-2 gap-4 text-[12px] leading-[18px]">
                <ul className="list-disc space-y-0.5 pl-4 text-muted">{s.good.map((g) => <li key={g}>{g}</li>)}</ul>
                <ul className="list-disc space-y-0.5 pl-4 text-muted-80 marker:text-danger-soft">{s.bad.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>
              <Candidate option={s.option} setup={setup} />
            </div>
          ))}
        </div>

        <section className="mt-16 max-w-[1200px]">
          <h2 className="mb-3 text-[16px] font-semibold tracking-tight">Side by side</h2>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="py-2 pr-4 font-medium" />
                {SPECS.map((s) => <th key={s.option} className="py-2 pr-4 font-medium">{s.letter} · {s.option === "today" ? "Today" : s.option === "dock" ? "Dock" : s.option === "pointer" ? "Pointer" : s.option === "carry" ? "Carry" : "Ask again"}</th>)}
              </tr>
            </thead>
            <tbody>
              {TABLE.map((row) => (
                <tr key={row.label} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-4 text-muted">{row.label}</td>
                  {SPECS.map((s) => <td key={s.option} className="py-2 pr-4">{row.cells[s.option]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Page />
    </TooltipProvider>
  </QueryClientProvider>,
)
