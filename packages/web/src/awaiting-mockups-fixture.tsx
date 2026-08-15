// MOCKUP SHEET — sixteen ways to say "this thread is at rest, waiting on these pull requests".
//
// Not a test and not shipped UI: a design surface for choosing the resting card's shape. Every variant
// renders in the REAL app stylesheet, at the real card width, on the real card chrome where it uses one,
// so a choice made here is a choice about the thing that ships rather than about a sketch.
//
//   nubx vite --port 5477 --strictPort      (from packages/web)
//   http://localhost:5477/awaiting-mockups-fixture.html?font=sans   — ?font=mono for the other setting
//                                                       ?only=E     — one variant, full width
//
// The variants are grouped by the DECISION each one makes, not by how they look:
//   1–4   how much of the row is words          (the shipped row, prose, fraction, glyph-counts)
//   5–8   where the verdict lives               (right column, pill, bar, merge-first)
//   9–12  how much CHROME the wait deserves     (title-fold, rail box, cardless line, chip row)
//   13–16 how a MULTI-PR wait is organised      (table, timeline, grouped summary, split by state)
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  CircleCheck, CircleDashed, CircleDot, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed,
  Hourglass, TerminalSquare,
} from "lucide-react"
import { BLOCK_RADIUS, CARD_BODY, CardActions, CARD_PRIMARY_ACTION, TranscriptCard } from "./components/TranscriptCard.tsx"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default — which
// is how a glyph measured at a 0.00px residual once rode visibly high in the maintainer's sans window.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("only")?.toUpperCase() ?? null

// ---- the data every variant renders -------------------------------------------------------------
type Checks = "running" | "passing" | "failing" | "none"
type Merge = "mergeable" | "blocked" | "conflicting" | "unknown"
type PR = {
  ref: string
  checks: Checks
  running: number
  passed: number
  failed: number
  failing: string[]
  merge: Merge
  state: "open" | "merged" | "closed"
  polled: boolean
}

const pr = (over: Partial<PR> & { ref: string }): PR => ({
  checks: "passing", running: 0, passed: 0, failed: 0, failing: [], merge: "unknown", state: "open", polled: true, ...over,
})

// FOUR PRs, one per check state, so every variant is judged on its whole vocabulary at once: running
// with counts, green and mergeable, red with named jobs, and one frizz has not polled yet.
const FOUR: PR[] = [
  pr({ ref: "acme/app#391", checks: "running", running: 3, passed: 12, merge: "blocked" }),
  pr({ ref: "acme/app#392", checks: "passing", passed: 15, merge: "mergeable" }),
  pr({ ref: "acme/app#393", checks: "failing", running: 1, passed: 9, failed: 2, failing: ["lint", "e2e (chromium)"], merge: "blocked" }),
  pr({ ref: "acme/app#394", checks: "none", polled: false }),
]
// THE REAL BOARD'S COMMON CASE, and the shape in the screenshot that started this: exactly one PR,
// green, mergeable. A variant that only reads well with four rows has solved the rare problem.
const ONE: PR[] = [pr({ ref: "colinhacks/zod#5928", checks: "passing", passed: 7, merge: "mergeable" })]

const total = (p: PR) => p.running + p.passed + p.failed
const tone = (p: PR) =>
  !p.polled ? "text-muted/60"
  : p.state === "merged" ? "text-purple-400"
  : p.state === "closed" ? "text-red-400"
  : p.checks === "failing" ? "text-red-400"
  : p.checks === "passing" ? "text-emerald-500"
  : p.checks === "running" ? "text-amber-400"
  : "text-muted/60"

function Glyph({ p, size = 12 }: { p: PR; size?: number }) {
  // `1cap` is the resolved font's cap height, so a symmetric 1em glyph's ink lands on the cap band in
  // EITHER font at any size. It needs a shared baseline, hence `items-baseline` on every row below.
  const cls = `shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] ${tone(p)}`
  if (!p.polled) return <CircleDashed size={size} className={cls} />
  if (p.state === "merged") return <GitMerge size={size} className={cls} />
  if (p.state === "closed") return <GitPullRequestClosed size={size} className={cls} />
  if (p.checks === "failing") return <CircleX size={size} className={cls} />
  if (p.checks === "passing") return <CircleCheck size={size} className={cls} />
  if (p.checks === "running") return <CircleDot size={size} className={cls} />
  return <CircleDashed size={size} className={cls} />
}

const REF = "font-medium text-fg/90 underline decoration-border-strong underline-offset-2"
const counts = (p: PR) =>
  [p.failed > 0 ? `${p.failed} failing` : null, p.running > 0 ? `${p.running} in progress` : null, p.passed > 0 ? `${p.passed} successful` : null]
    .filter(Boolean).join(", ")
const mergeWord = (p: PR) =>
  p.state !== "open" ? null
  : p.merge === "blocked" && p.checks !== "passing" && p.checks !== "none" ? null
  : p.merge === "mergeable" ? "no conflicts" : p.merge === "blocked" ? "merge blocked" : p.merge === "conflicting" ? "has conflicts" : null

// ---- the sheet's own chrome ----------------------------------------------------------------------
function Variant({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  if (only && only !== id) return null
  return (
    <section data-variant={id} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-accent">{id}</span>
        <span className="text-[13px] font-medium text-fg">{title}</span>
      </div>
      <p className="max-w-[82ch] text-[11.5px] leading-4 text-muted/80">{note}</p>
      <div data-shot={id}>{children}</div>
    </section>
  )
}

function Snooze() {
  return (
    <CardActions>
      <button type="button" className={CARD_PRIMARY_ACTION}>
        <Hourglass size={12} className="translate-y-[calc(0.5em_-_0.5cap)]" />
        Snooze
      </button>
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted/70">Hides card until new activity is detected</span>
    </CardActions>
  )
}

// ══ 1–4 · HOW MUCH OF THE ROW IS WORDS ════════════════════════════════════════════════════════════

/** A — SHIPPED. The glyph carries the verdict; the words carry the counts and the merge state. */
function A({ prs }: { prs: PR[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2.5">
        {prs.map((p) => (
          <div key={p.ref} className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-1.5 text-[12px] leading-5">
              <Glyph p={p} />
              <a className={REF}>{p.ref}</a>
              <span className="min-w-0 truncate text-muted/80">
                {!p.polled ? "Checking…" : [counts(p) || "No checks", mergeWord(p)].filter(Boolean).join(" · ")}
              </span>
            </div>
            {p.failing.length > 0 && <div className="pl-[18px] text-[11.5px] leading-4 text-red-400/85">{p.failing.join(", ")}</div>}
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** B — PROSE. Every PR is a sentence. Reads like a person telling you, costs the most width. */
function B({ prs }: { prs: PR[] }) {
  const say = (p: PR) => {
    if (!p.polled) return "still checking"
    if (p.checks === "failing") return `${p.failed} of ${total(p)} checks failing — ${p.failing.join(", ")}`
    if (p.checks === "passing") return `all ${p.passed} checks passed${p.merge === "mergeable" ? ", ready to merge" : ""}`
    if (p.checks === "running") return `${p.passed} of ${total(p)} checks done`
    return "no checks"
  }
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-1.5 text-[12px] leading-5">
        {prs.map((p) => (
          <p key={p.ref} className="text-muted/80">
            <a className={REF}>{p.ref}</a> — {say(p)}.
          </p>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** C — FRACTION. "12/15" is the whole check story in five characters, and it is the same five
 *  characters on every row, so four PRs read as one column of progress instead of four sentences. */
function C({ prs }: { prs: PR[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2 text-[12px] leading-5">
        {prs.map((p) => (
          <div key={p.ref} className="flex items-baseline gap-2">
            <Glyph p={p} />
            <a className={REF}>{p.ref}</a>
            <span className={`tabular-nums ${p.checks === "failing" ? "text-red-400/90" : "text-muted/80"}`}>
              {p.polled ? (total(p) === 0 ? "no checks" : `${p.passed}/${total(p)}`) : "—"}
            </span>
            {p.polled && total(p) > 0 && <span className="text-muted/55">checks</span>}
            {mergeWord(p) && <span className="text-muted/55">· {mergeWord(p)}</span>}
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** D — GLYPH COUNTS. No count words at all: a coloured mark per state with its number. The densest
 *  the row can get before it stops being readable without a legend. */
function D({ prs }: { prs: PR[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2 text-[12px] leading-5">
        {prs.map((p) => (
          <div key={p.ref} className="flex items-baseline gap-2">
            <a className={REF}>{p.ref}</a>
            <span className="flex items-baseline gap-2.5 tabular-nums">
              {p.failed > 0 && <span className="flex items-baseline gap-1 text-red-400/90"><CircleX size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />{p.failed}</span>}
              {p.running > 0 && <span className="flex items-baseline gap-1 text-amber-400/90"><CircleDot size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />{p.running}</span>}
              {p.passed > 0 && <span className="flex items-baseline gap-1 text-emerald-500/90"><CircleCheck size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />{p.passed}</span>}
              {!p.polled && <span className="text-muted/60">checking…</span>}
              {p.polled && total(p) === 0 && <span className="text-muted/60">no checks</span>}
            </span>
            {p.merge === "mergeable" && <GitMerge size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-emerald-500/70" />}
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ 5–8 · WHERE THE VERDICT LIVES ═════════════════════════════════════════════════════════════════

/** E — RIGHT COLUMN. Refs left, state right-justified against the card edge. The verdicts stack into
 *  a column you read down in one pass; the ragged middle is the price. */
function E({ prs }: { prs: PR[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2 text-[12px] leading-5">
        {prs.map((p) => (
          <div key={p.ref} className="flex items-baseline gap-2">
            <Glyph p={p} />
            <a className={REF}>{p.ref}</a>
            <span className="h-px flex-1 translate-y-[-3px] bg-border/60" />
            <span className={`shrink-0 tabular-nums ${p.checks === "failing" ? "text-red-400/85" : "text-muted/75"}`}>
              {!p.polled ? "checking…" : p.checks === "failing" ? `${p.failed} failing` : p.checks === "running" ? `${p.running} running` : p.checks === "passing" ? (p.merge === "mergeable" ? "ready" : "passed") : "no checks"}
            </span>
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** F — PILL. The verdict as a filled chip, GitHub's status-badge language. Loud, scannable at a
 *  glance across a long queue, and four of them in a column is a lot of colour. */
function F({ prs }: { prs: PR[] }) {
  const pill = (p: PR) =>
    !p.polled ? { label: "checking", cls: "bg-muted/15 text-muted/80" }
    : p.checks === "failing" ? { label: `${p.failed} failing`, cls: "bg-red-500/15 text-red-400" }
    : p.checks === "passing" ? { label: p.merge === "mergeable" ? "ready to merge" : "passing", cls: "bg-emerald-500/15 text-emerald-400" }
    : p.checks === "running" ? { label: `${p.running} running`, cls: "bg-amber-400/15 text-amber-300" }
    : { label: "no checks", cls: "bg-muted/15 text-muted/80" }
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2 text-[12px] leading-5">
        {prs.map((p) => {
          const { label, cls } = pill(p)
          return (
            <div key={p.ref} className="flex items-baseline gap-2">
              <a className={REF}>{p.ref}</a>
              <span className={`shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium leading-4 ${cls}`}>{label}</span>
              {p.passed > 0 && <span className="text-muted/55">{p.passed} passed</span>}
            </div>
          )
        })}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** G — CHECK BAR. The counts drawn instead of written: one segment per outcome, the way a CI dashboard
 *  shows a run. Reads as PROGRESS, which words never quite do, and needs no numbers to be legible. */
function G({ prs }: { prs: PR[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2.5 text-[12px] leading-5">
        {prs.map((p) => (
          <div key={p.ref} className="flex items-baseline gap-2">
            <a className={`shrink-0 ${REF}`}>{p.ref}</a>
            <span className="flex h-1.5 min-w-0 flex-1 translate-y-[-4px] gap-px overflow-hidden rounded-full bg-border/70">
              {p.failed > 0 && <span className="bg-red-400" style={{ width: `${(p.failed / total(p)) * 100}%` }} />}
              {p.passed > 0 && <span className="bg-emerald-500" style={{ width: `${(p.passed / total(p)) * 100}%` }} />}
              {p.running > 0 && <span className="bg-amber-400/50" style={{ width: `${(p.running / total(p)) * 100}%` }} />}
            </span>
            <span className="shrink-0 tabular-nums text-muted/70">
              {!p.polled ? "checking…" : total(p) === 0 ? "no checks" : `${p.passed}/${total(p)}`}
            </span>
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** H — MERGE FIRST. Leads with the only question the human is actually asking — can this land? — and
 *  demotes the CI arithmetic to the second half of the line. */
function H({ prs }: { prs: PR[] }) {
  const verdict = (p: PR) =>
    !p.polled ? { text: "Checking…", cls: "text-muted/70" }
    : p.checks === "failing" ? { text: "Blocked — checks failing", cls: "text-red-400/90" }
    : p.merge === "conflicting" ? { text: "Blocked — conflicts", cls: "text-red-400/90" }
    : p.checks === "running" ? { text: "Waiting on CI", cls: "text-amber-300/90" }
    : p.merge === "mergeable" ? { text: "Ready to merge", cls: "text-emerald-400" }
    : { text: "Blocked", cls: "text-muted/80" }
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2.5 text-[12px] leading-5">
        {prs.map((p) => {
          const v = verdict(p)
          return (
            <div key={p.ref} className="flex items-baseline gap-2">
              <Glyph p={p} />
              <span className={`shrink-0 font-medium ${v.cls}`}>{v.text}</span>
              <a className="min-w-0 truncate text-muted/75 underline decoration-border-strong underline-offset-2">{p.ref}</a>
              {p.polled && total(p) > 0 && <span className="shrink-0 tabular-nums text-muted/55">{p.passed}/{total(p)}</span>}
            </div>
          )
        })}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ 9–12 · HOW MUCH CHROME THE WAIT DESERVES ══════════════════════════════════════════════════════

/** I — TITLE FOLD. For ONE PR the card has no body at all: the heading states the wait and the ref
 *  rides the title row's `aside` slot, exactly as the GitHub wake card already does. */
function I({ prs }: { prs: PR[] }) {
  const p = prs[0]
  const rest = prs.slice(1)
  return (
    <TranscriptCard
      icon={Hourglass}
      label="Awaiting background work"
      aside={
        <span className="flex items-baseline gap-1.5 text-[12px]">
          <Glyph p={p} />
          <a className={REF}>{p.ref}</a>
          <span className="tabular-nums text-muted/70">{p.passed}/{total(p)}</span>
        </span>
      }
    >
      {rest.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 text-[12px] leading-5">
          {rest.map((q) => (
            <div key={q.ref} className="flex items-baseline gap-1.5">
              <Glyph p={q} />
              <a className={REF}>{q.ref}</a>
              <span className="text-muted/75">{q.polled ? counts(q) || "no checks" : "checking…"}</span>
            </div>
          ))}
        </div>
      )}
      <Snooze />
    </TranscriptCard>
  )
}

/** J — RAIL BOX. Each PR in its own inset panel with a coloured left rail — GitHub's merge box, one
 *  per watch. The most literal evocation and the most furniture. */
function J({ prs }: { prs: PR[] }) {
  const rail = (p: PR) =>
    !p.polled ? "border-l-muted/40" : p.checks === "failing" ? "border-l-red-400" : p.checks === "passing" ? "border-l-emerald-500" : p.checks === "running" ? "border-l-amber-400" : "border-l-muted/40"
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-1.5">
        {prs.map((p) => (
          <div key={p.ref} className={`rounded-md border-l-2 bg-elevated/60 px-2.5 py-1.5 ${rail(p)}`}>
            <div className="flex items-baseline gap-2 text-[12px] leading-5">
              <a className={REF}>{p.ref}</a>
              <span className="min-w-0 truncate text-muted/75">{p.polled ? [counts(p) || "no checks", mergeWord(p)].filter(Boolean).join(" · ") : "checking…"}</span>
            </div>
            {p.failing.length > 0 && <div className="text-[11px] leading-4 text-red-400/80">{p.failing.join(", ")}</div>}
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** K — CARDLESS. No card at all: one dimmed line under the transcript, the way a status bar states a
 *  background fact. The lightest possible answer, and the Snooze becomes a text verb. */
function K({ prs }: { prs: PR[] }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border/70 pt-2.5 text-[12px] leading-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted/70">
        <Hourglass size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />
        <span>At rest, watching</span>
        {prs.map((p, i) => (
          <span key={p.ref} className="flex items-baseline gap-1">
            <Glyph p={p} size={11} />
            <a className="text-fg/80 underline decoration-border-strong underline-offset-2">{p.ref}</a>
            {i < prs.length - 1 && <span className="text-muted/40">·</span>}
          </span>
        ))}
        <button type="button" className="ml-1 text-muted/60 underline decoration-border-strong underline-offset-2 hover:text-fg">snooze</button>
      </div>
    </div>
  )
}

/** L — CHIP ROW. Every PR a compact chip on one wrapped line. Scales to a dozen watches without
 *  growing a dozen rows; loses the per-PR detail entirely. */
function L({ prs }: { prs: PR[] }) {
  const chip = (p: PR) =>
    !p.polled ? "border-border-strong text-muted/70" : p.checks === "failing" ? "border-red-400/40 text-red-400/90" : p.checks === "passing" ? "border-emerald-500/40 text-emerald-400/90" : p.checks === "running" ? "border-amber-400/40 text-amber-300/90" : "border-border-strong text-muted/70"
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-wrap gap-1.5">
        {prs.map((p) => (
          <span key={p.ref} className={`flex items-baseline gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] leading-5 ${chip(p)}`}>
            <Glyph p={p} size={11} />
            <span className="text-fg/85">{p.ref}</span>
            {p.polled && total(p) > 0 && <span className="tabular-nums opacity-70">{p.passed}/{total(p)}</span>}
          </span>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ 13–16 · HOW A MULTI-PR WAIT IS ORGANISED ══════════════════════════════════════════════════════

/** M — TABLE. Real aligned columns: glyph, ref, counts, merge. Four PRs read as data; one PR reads as
 *  a table with one row, which is the trade. */
function M({ prs }: { prs: PR[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_auto_1fr_auto] items-baseline gap-x-3 gap-y-2 text-[12px] leading-5">
        {prs.map((p) => (
          <div key={p.ref} className="col-span-4 grid grid-cols-subgrid items-baseline">
            <Glyph p={p} />
            <a className={REF}>{p.ref}</a>
            <span className="tabular-nums text-muted/75">{p.polled ? counts(p) || "no checks" : "checking…"}</span>
            <span className="text-muted/55">{mergeWord(p) ?? ""}</span>
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** N — TIMELINE. A connector down the left binds the rows into one object, the way the thread's own
 *  sub-agent rows already nest. Says "these belong to this wait" without a heading repeating it. */
function N({ prs }: { prs: PR[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="relative mt-3 flex flex-col gap-3 pl-5 text-[12px] leading-5">
        {/* The rail sits BEHIND the glyphs and shows in the gaps between them, so it needs both the
            stronger border token and a row gap wide enough to leave any of itself visible. At gap-2 on
            `bg-border` it was invisible against panel-2 and the variant read as a plain list. */}
        <span className="absolute bottom-2 left-[6.5px] top-2 w-px bg-border-strong" />
        {prs.map((p) => (
          <div key={p.ref} className="flex items-baseline gap-2">
            <span className="absolute left-0 flex bg-panel-2 py-0.5"><Glyph p={p} size={12} /></span>
            <a className={REF}>{p.ref}</a>
            <span className="min-w-0 truncate text-muted/75">{p.polled ? [counts(p) || "no checks", mergeWord(p)].filter(Boolean).join(" · ") : "checking…"}</span>
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

/** O — SUMMARY LINE. The rows collapse into one tally in the heading's own row; the refs follow as
 *  bare links. Constant height whether the thread watches one PR or nine. */
function O({ prs }: { prs: PR[] }) {
  const green = prs.filter((p) => p.polled && p.checks === "passing").length
  const red = prs.filter((p) => p.polled && p.checks === "failing").length
  const amber = prs.filter((p) => p.polled && p.checks === "running").length
  const grey = prs.filter((p) => !p.polled || p.checks === "none").length
  return (
    <TranscriptCard
      icon={Hourglass}
      label="Awaiting background work"
      aside={
        <span className="flex items-baseline gap-2 text-[11.5px] tabular-nums">
          {red > 0 && <span className="flex items-baseline gap-1 text-red-400"><CircleX size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />{red}</span>}
          {amber > 0 && <span className="flex items-baseline gap-1 text-amber-400"><CircleDot size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />{amber}</span>}
          {green > 0 && <span className="flex items-baseline gap-1 text-emerald-500"><CircleCheck size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />{green}</span>}
          {grey > 0 && <span className="flex items-baseline gap-1 text-muted/60"><CircleDashed size={11} className="self-baseline translate-y-[calc(0.5em_-_0.5cap)]" />{grey}</span>}
        </span>
      }
    >
      <p className={`${CARD_BODY} mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5`}>
        {prs.map((p) => <a key={p.ref} className="text-muted/75 underline decoration-border-strong underline-offset-2">{p.ref}</a>)}
      </p>
      <Snooze />
    </TranscriptCard>
  )
}

/** P — SPLIT BY STATE. The one PR that needs a human is pulled out and stated in full; everything
 *  quiet collapses to a tail. Ranks the list instead of printing it. */
function P({ prs }: { prs: PR[] }) {
  const loud = prs.filter((p) => p.polled && (p.checks === "failing" || (p.checks === "passing" && p.merge === "mergeable")))
  const quiet = prs.filter((p) => !loud.includes(p))
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2 text-[12px] leading-5">
        {loud.map((p) => (
          <div key={p.ref} className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-1.5">
              <Glyph p={p} />
              <a className={REF}>{p.ref}</a>
              <span className={p.checks === "failing" ? "font-medium text-red-400/90" : "font-medium text-emerald-400"}>
                {p.checks === "failing" ? `${p.failed} checks failing` : "ready to merge"}
              </span>
            </div>
            {p.failing.length > 0 && <div className="pl-[18px] text-[11.5px] leading-4 text-red-400/80">{p.failing.join(", ")}</div>}
          </div>
        ))}
        {quiet.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-x-2 text-muted/60">
            <span>{quiet.length === 1 ? "also watching" : `${quiet.length} more still running —`}</span>
            {quiet.map((p) => <a key={p.ref} className="underline decoration-border-strong underline-offset-2">{p.ref}</a>)}
          </div>
        )}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ---- the sheet -----------------------------------------------------------------------------------
// Each variant renders BOTH data sets: four PRs (the stress case) and one green mergeable PR (the case
// the maintainer actually met). A shape that only works for one of them has not solved the problem.
const VARIANTS: Array<{ id: string; title: string; note: string; render: (prs: PR[]) => ReactNode }> = [
  { id: "A", title: "Shipped — glyph verdict, counts in words", note: "What is on main now. The glyph says pass/fail/running so the words only carry the numbers and the merge state; a red PR earns a second line naming the jobs.", render: (p) => <A prs={p} /> },
  { id: "B", title: "Prose — each PR is a sentence", note: "Reads like a person telling you. Warmest and widest; four of them is a paragraph, and the shapes stop being scannable as a column.", render: (p) => <B prs={p} /> },
  { id: "C", title: "Fraction — 12/15 checks", note: "The whole check story in five characters, identical on every row, so the column aligns and the eye compares progress rather than parsing three different sentences.", render: (p) => <C prs={p} /> },
  { id: "D", title: "Glyph counts — ✕2 ◔1 ✓9", note: "No count words at all. Densest possible; the colour does the naming, which is fine on a second look and opaque on the first.", render: (p) => <D prs={p} /> },
  { id: "E", title: "Right column — verdict against the card edge", note: "Refs left, state right-justified with a leader rule. Four verdicts stack into one column you read in a single pass; the ragged middle is the cost.", render: (p) => <E prs={p} /> },
  { id: "F", title: "Pill — GitHub's status badge", note: "The verdict as a filled chip. Loudest at a glance across a long queue, and four saturated chips in one card is a lot of colour for a card that is not asking for anything.", render: (p) => <F prs={p} /> },
  { id: "G", title: "Check bar — the counts drawn, not written", note: "One segment per outcome, the way a CI dashboard draws a run. Reads as PROGRESS, which words never quite manage, and is legible with the numbers ignored.", render: (p) => <G prs={p} /> },
  { id: "H", title: "Merge first — can this land?", note: "Leads with the only question being asked and demotes the CI arithmetic. Most useful, least faithful to GitHub's own vocabulary.", render: (p) => <H prs={p} /> },
  { id: "I", title: "Title fold — one PR needs no body", note: "For a single watch the ref rides the title row's aside slot and the card has no body at all. Two lines total. Extra PRs fall back into a list beneath.", render: (p) => <I prs={p} /> },
  { id: "J", title: "Rail box — GitHub's merge box, one per PR", note: "The most literal evocation of the thing the human just came from, and the most furniture: four inset panels inside one card.", render: (p) => <J prs={p} /> },
  { id: "K", title: "Cardless — a status line, not a card", note: "No chrome at all: one dimmed line under the transcript, snooze as a text verb. The lightest answer, and the one that risks reading as 'the agent died'.", render: (p) => <K prs={p} /> },
  { id: "L", title: "Chip row — wraps instead of stacking", note: "Every PR a compact chip on one wrapped line. Scales to a dozen watches without a dozen rows; drops the failing job names entirely.", render: (p) => <L prs={p} /> },
  { id: "M", title: "Table — real aligned columns", note: "Glyph, ref, counts, merge on a subgrid so the columns line up across rows. Four PRs read as data; one PR reads as a table with one row.", render: (p) => <M prs={p} /> },
  { id: "N", title: "Timeline — a connector binds the rows", note: "The rail says 'these belong to this wait' without a heading repeating it, and matches how sub-agent rows already nest in the rail.", render: (p) => <N prs={p} /> },
  { id: "O", title: "Summary — a tally in the title row", note: "The states collapse to counted glyphs beside the heading and the refs follow as bare links. Constant height whether the thread watches one PR or nine.", render: (p) => <O prs={p} /> },
  { id: "P", title: "Split by state — rank, don't list", note: "The PRs that need a human (red, or green and mergeable) are stated in full; everything still churning collapses to a tail.", render: (p) => <P prs={p} /> },
]

function Sheet() {
  return (
    <div className="mx-auto flex w-[min(1320px,calc(100%-48px))] flex-col gap-10 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[15px] font-semibold text-fg">Resting card — sixteen ways to state the same wait</h1>
        <p className="max-w-[80ch] text-[12px] leading-5 text-muted/80">
          Left column: four watched PRs, one per check state (the stress case). Right column: one green mergeable PR
          (the shape on a real board). Both render on the real card chrome in the real stylesheet.
          <code className="ml-1 text-muted/60">?font=mono</code> for the other font setting,
          <code className="ml-1 text-muted/60">?only=E</code> for one variant on its own.
        </p>
      </header>
      {VARIANTS.map((v) => (
        <Variant key={v.id} id={v.id} title={v.title} note={v.note}>
          <div className="flex flex-wrap items-start gap-6">
            <div className={`w-[560px] ${BLOCK_RADIUS}`}>{v.render(FOUR)}</div>
            <div className={`w-[560px] ${BLOCK_RADIUS}`}>{v.render(ONE)}</div>
          </div>
        </Variant>
      ))}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
