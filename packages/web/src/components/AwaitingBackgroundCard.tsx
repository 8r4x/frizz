// THE resting card — one card, three surfaces. A thread whose top-level turn has come to rest while
// its OWN dispatched work (sub-agents / launched background shells) is still live is not stalled and is
// not waiting on the human: it is waiting on results it kicked off. Server-derived
// (board.deriveAwaitingBackground); this module only renders it.
//
// It renders on the DRAWER and the FULL-SCREEN page, because the rest is a fact about the thread. On the
// QUEUE it renders too — but only for the shape that queues, and the event-Snooze is passed in as
// `actions` there (parking a card is a queue verb, and the queue is where a card you don't want to look
// at costs you something). The drawer and standalone page pass none, since you opened the thread
// deliberately and have nothing to dismiss (maintainer 2026-07-25: "in the drawer or in the full screen
// view, it should not").
//
// WHICH SHAPE QUEUES has flipped twice, and the current split is the point of this card's two voices:
//   • rest on a live SUB-AGENT — excused from the queue (board.deriveNeedsYou, 2026-07-30). The child
//     returns and re-invokes the parent within seconds, so the thread is mid-flight in substance and
//     there is nothing for the human to do. The drawer and the full-screen page are then the ONLY places
//     this state is stated in words, which raises the stakes on the card rather than lowering them.
//   • rest on a background SHELL alone — QUEUED (maintainer 2026-08-04: "if a thread has rested and the
//     only thing remaining is background shells, we should put it into the queue"). A shell is detached;
//     the thread has finished its turn in every sense that matters to the operator, so it is a handoff.
//     Shells were briefly excused too (2026-08-01) and that is what this reverses.
//
// Without it those surfaces showed NOTHING at rest: the shimmer stops and the transcript just ends,
// which reads as "the agent died" for exactly the threads that are healthiest. (The shimmer coming back
// on afterwards is CORRECT, not a bug — a child's <task-notification> lands as a re-invoking user record
// and the parent genuinely resumes; measured 15/15 times on a live worker thread, with idle windows as
// short as 0.13s. This card is what makes that alternation legible.)
import type { ReactNode } from "react"
import { CircleCheck, CircleDashed, CircleDot, CircleX, GitMerge, GitPullRequestClosed, Hourglass, TerminalSquare } from "lucide-react"
import type { GithubWatchStatus, ThreadView, ThreadWatchView } from "@frizz/shared"
import { isDirectSubAgent } from "@frizz/shared"
import { githubRefUrl } from "../lib/githubRef.ts"
import { CARD_BODY, CardActions, TranscriptCard } from "./TranscriptCard.tsx"

// Name what the thread is ACTUALLY waiting on. Three real cases, and the sentence has to be true in all
// of them: "sub-agents" is wrong for a shell-only thread (a launched dev server is not a child whose
// result you await), so shells get their own noun; and a thread with BOTH kinds live must name both
// rather than silently dropping the shells behind the agent count.
//
// The noun is "background shell", which is what the maintainer calls them and what the card's own title
// now says (it was the vaguer "background task" while the two shapes shared one title).
//
// The count is DIRECT children only. The sentence below says "it dispatched", and a descendant — a
// sub-agent's own sub-agent, which `subAgents` also carries now so the rows can nest — was dispatched by
// the child, not by this thread's worker. Counting them would make the sentence false.
// PR WATCHERS ARE THE THIRD KIND (2026-08-13), and they are listed exactly like the other two rather
// than getting a card of their own: the awaiting fence no longer offers a park action for `pr-watch`
// (lib/awaitingPresentation), so this card and its event-snooze are the one place a parked watcher is
// stated in words and the one control for hiding it.
export function prWatcherCount(thread: Pick<ThreadView, "watches">): number {
  return (thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed").length
}

// `watchers: false` is for the sentence that ends "…it dispatched": a PR watcher is not dispatched, it
// is PARKED ON, and naming it there makes the sentence false. That branch names it in its own clause.
export function awaitingBackgroundSubject(
  thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">,
  opts: { watchers?: boolean } = {},
): string {
  const agents = (thread.subAgents ?? []).filter((a) => isDirectSubAgent(a) && a.state === "running").length
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  const watchers = opts.watchers === false ? 0 : prWatcherCount(thread)
  // Each kind names itself and the list is comma-joined with a trailing "and" — a thread can genuinely
  // have all three out, and silently dropping one behind another's count is what this replaced.
  const parts = [
    agents > 0 ? `${agents} sub-agent${agents === 1 ? "" : "s"}` : null,
    shells > 0 ? `${shells} background shell${shells === 1 ? "" : "s"}` : null,
    watchers > 0 ? `${watchers} PR watcher${watchers === 1 ? "" : "s"}` : null,
  ].filter((p): p is string => p !== null)
  if (parts.length === 0) return "0 background shells" // unreachable via the card's own gate; never an empty sentence
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

// Whether the thread is genuinely WAITING or merely still has something running — the distinction the
// rail now draws with two different marks (groups.sessionIndicatorKind: a live sub-agent spins, a
// shell-only rest pulses), and the card has to agree with it. A dispatched sub-agent returns and
// re-invokes its parent, so "awaiting the results" is exactly right. A launched dev server never returns
// anything; saying the thread awaits its results describes a wait that is not happening.
function awaitsResults(thread: Pick<ThreadView, "subAgents">): boolean {
  return (thread.subAgents ?? []).some((a) => isDirectSubAgent(a) && a.state === "running")
}

// "when one of them finishes" is false of a single thing, and a thread with exactly one is the common
// case — so the pronoun agrees with the count rather than assuming the plural. SHELLS ONLY: a watcher is
// never the subject of this sentence any more, because it has a row of its own further down.
function liveShellCount(thread: Pick<ThreadView, "bgShells">): number {
  return (thread.bgShells ?? []).filter((s) => s.state === "running").length
}

/** Is there any work the SENTENCE has to name — i.e. work with no row of its own? A watched PR gets a
 *  row, so a rest on watchers alone needs no prose at all: the heading says the thread is waiting and the
 *  rows say on what. Counting the same watchers in a sentence directly above the rows is the restatement
 *  the maintainer called busy (2026-08-14). */
function hasUnrowedWork(thread: Pick<ThreadView, "subAgents" | "bgShells">): boolean {
  return awaitsResults(thread) || liveShellCount(thread) > 0
}

// The title, and it is CONDITIONAL for the same reason the body sentence is. "Background shells running"
// is the maintainer's own name for the shell-only rest (2026-08-04) and it is the shape that now carries
// a queue card, so that is the title the human meets in the queue. A rest on a live SUB-AGENT is a
// different state on a different surface — it is genuinely awaiting a result, and calling it "background
// shells" would name work it never launched — so it keeps the older title.
//
// The GLYPH follows the title. An hourglass is a WAIT, which is true of the sub-agent rest and false of
// the shell one: a queued handoff behind a detached shell is not waiting on anything, and stamping the
// wait mark on it would contradict the whole reason it is in the queue.
// NO KIND-SPECIFIC TITLE FOR A WATCHER. This briefly read "PR watcher armed" here, which quietly
// rebuilt the very card the consolidation removed — a bespoke PR-watcher card, just on a different
// surface (maintainer 2026-08-13: "the card that you're showing me still says 'PR watcher armed'. It is
// not a generic card, snooze card. I thought we decided to go generic").
//
// So the kind-naming title survives for EXACTLY the case the maintainer named it for — a rest on
// background shells and nothing else (2026-08-04) — and every other shape takes the generic one. That
// keeps it honest in both directions: "Background shells running" never names work the thread did not
// launch, and no new kind gets a heading of its own. The sentence beneath is where the specifics live.
export function awaitingBackgroundLabel(thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">): string {
  return shellsAlone(thread) ? "Background shells running" : "Awaiting background work"
}

/** Background shells and nothing else — the one shape with a title of its own. */
function shellsAlone(thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">): boolean {
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running").length
  return shells > 0 && !awaitsResults(thread) && prWatcherCount(thread) === 0
}

// ---- ONE ROW PER WATCHED PR ----------------------------------------------------------------------
// Maintainer 2026-08-14: "in the card that renders all of the 'awaiting background tasks' stuff, we
// should have a row for each GitHub watcher. If the PRs are mergeable, then we should indicate as much
// in the UI. We should basically have it evoke the GitHub UI that shows up for running versus completed
// checks."
//
// So the row is GitHub's merge box on ONE line: its own state glyph, the ref, the check counts and the
// merge verdict. The count VOCABULARY is GitHub's, because the human has just come from there and a
// second set of words for one fact is a second thing to learn.
//
// IT WAS THREE LINES UNTIL 2026-08-14 — a prose verdict ("All checks have passed"), the same verdict as
// counts ("— 7 successful"), and a merge sentence under it ("This branch has no conflicts with the base
// branch") — and four PRs then filled eleven lines with three ways of saying green (maintainer: "this
// looks busy and shitty"). Each fact now appears exactly once, in its shortest true form:
//   • the GLYPH carries the verdict, so the words carry only what the glyph cannot: the numbers.
//   • the counts drop the prose headline that restated them.
//   • the merge verdict joins the same line, and only when it is not already implied (below).
//
// AN UNPOLLED PR SAYS "Checking…", not "no checks". They are different facts — frizz has not looked yet
// versus this PR has no CI — and only the second of them means the wait is nearly over. The same
// distinction decides the queue rule server-side, where not-knowing never parks a thread.

// The merge verdict, appended to the counts. Two of GitHub's four states are SILENT here, for two
// different reasons:
//   • UNKNOWN — GitHub computes mergeability asynchronously and reports it while still thinking, so a
//     phrase for it would say "frizz has not heard back" in words that sound like a verdict.
//   • BLOCKED WHILE CI IS RED OR RUNNING — "blocked" is then just the checks restated, which is the
//     doubling this row exists to remove. It survives on a GREEN PR, where it is the one thing the
//     counts do not say: CI is done and something else (a review, a required branch) still holds it.
const MERGE_CLAUSE: Record<GithubWatchStatus["merge"], string | null> = {
  mergeable: "no conflicts",
  blocked: "merge blocked",
  conflicting: "has conflicts",
  unknown: null,
}

function mergeClause(status: GithubWatchStatus): string | null {
  if (status.state !== "open") return null
  if (status.merge === "blocked" && status.checks !== "passing" && status.checks !== "none") return null
  return MERGE_CLAUSE[status.merge]
}

function ChecksGlyph({ status }: { status: GithubWatchStatus | undefined }) {
  // `1cap` is the RESOLVED font's cap height, so this puts a symmetric 1em glyph's ink on the cap band
  // in either font at any size — nothing to re-measure when the font setting flips or the type scale
  // moves. It needs a shared baseline to align against, hence `items-baseline` on the row.
  //
  // NO INK TRIM HERE, and that is a MEASURED result rather than an omission. The usual glyph-beside-text
  // problem is a bare glyph wearing dead box on both sides; a lucide CIRCLE at size 12 paints ~11.5 of
  // its 12 box px, so it behaves like a text run. Measured on this row (scripts/ink-gaps.mjs, dsf 4,
  // sans): glyph→ref 6.50px against ref→headline 6.27px, both on one `gap-1.5`. A -1px trim "to be
  // safe" made it WORSE (5.50 vs 6.27). 0.23px is inside the instrument's own noise floor — leave it.
  const cls = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
  if (!status) return <CircleDashed size={12} className={`${cls} text-muted/60`} />
  if (status.state === "merged") return <GitMerge size={12} className={`${cls} text-purple-400`} />
  if (status.state === "closed") return <GitPullRequestClosed size={12} className={`${cls} text-red-400`} />
  if (status.checks === "failing") return <CircleX size={12} className={`${cls} text-red-400`} />
  if (status.checks === "passing") return <CircleCheck size={12} className={`${cls} text-emerald-500`} />
  if (status.checks === "running") return <CircleDot size={12} className={`${cls} text-amber-400`} />
  return <CircleDashed size={12} className={`${cls} text-muted/60`} />
}

/** "2 failing, 1 in progress, 9 successful" — GitHub's own count words, and only the counts that are
 *  nonzero: a row of zeroes reads as noise, and every count that is there is a count worth reading.
 *
 *  SEVERITY FIRST, and the order is fixed rather than per-state: the number that decides what the human
 *  does is the failing one, and a reader scanning four rows should find it in the same place on each.
 *  It is also what survives the row's `truncate` on a narrow queue card — measured at a 368px card, a
 *  red PR renders "2 failing, 1 in progress, 9 succ…", losing the count that matters least. */
export function checkCountLine(status: GithubWatchStatus): string {
  const parts = [
    status.failed > 0 ? `${status.failed} failing` : null,
    status.running > 0 ? `${status.running} in progress` : null,
    status.passed > 0 ? `${status.passed} successful` : null,
  ].filter((p): p is string => p !== null)
  return parts.join(", ")
}

/** The whole right-hand side of a row: what the checks say, then the merge verdict, on one line.
 *
 *  Merged/closed outrank everything — a merged PR's CI is history. Otherwise the counts speak and the
 *  glyph beside them carries the verdict they used to spell out in prose. */
export function watchStatusLine(status: GithubWatchStatus | undefined): string {
  if (!status) return "Checking…" // frizz has not polled yet — NOT "no checks"
  if (status.state === "merged") return "Merged"
  if (status.state === "closed") return "Closed"
  const counts = checkCountLine(status)
  const merge = mergeClause(status)
  // "No checks" rather than an empty left half: a PR with no CI at all is a real state, and the wait
  // then hangs entirely on the merge verdict beside it.
  return [counts || "No checks", merge].filter((p): p is string => p !== null).join(" · ")
}

function GithubWatchRow({ watch }: { watch: ThreadWatchView }) {
  const status = watch.github
  const url = githubRefUrl(watch.target)
  return (
    <div className="flex flex-col gap-0.5">
      {/* items-baseline, not items-center: `self-baseline` on the glyph needs a shared baseline to
          align against, and the 1em-symmetric correction beside it puts the ink on the cap band in
          EITHER font (this app renders in two, and a hand-fitted constant is right in only one). */}
      <div className="flex items-baseline gap-1.5 text-[12px] leading-5" data-pr-watch-row={watch.target}>
        <span data-pr-glyph className="flex shrink-0"><ChecksGlyph status={status} /></span>
        {url
          ? <a data-pr-ref href={url} target="_blank" rel="noreferrer noopener" className="font-medium text-fg/90 underline decoration-border-strong underline-offset-2 hover:decoration-fg/60">{watch.target}</a>
          : <span data-pr-ref className="font-medium text-fg/90">{watch.target}</span>}
        <span data-pr-headline className="min-w-0 truncate text-muted/80">{watchStatusLine(status)}</span>
      </div>
      {/* The one thing that earns a SECOND line, and only on a red PR: WHICH jobs failed. "2 failing"
          costs the reader a click to learn that; the names cost nothing here and are the whole reason to
          look. Every other fact fits on the line above. */}
      {status && status.failing.length > 0 && (
        <div className="pl-[18px] text-[11.5px] leading-4 text-red-400/85">{status.failing.join(", ")}</div>
      )}
    </div>
  )
}

/** Does the CHAT show the resting card at the bottom of this thread?
 *
 *  Three conditions, and the last two were added on 2026-08-14 after the maintainer found it on threads
 *  it had no business being on: "this snooze card only shows up at the bottom of a rendered chat thread
 *  inside of an agent that has actually come to rest. Doesn't make sense for it to be showing up in a
 *  currently running thread. Or a thread that is currently snoozed."
 *
 *  - `awaitingBackground` — the server says the thread is waiting on something it NAMED.
 *  - AT REST, checked here rather than inferred. The card's slot already loses to the working indicator,
 *    but that indicator keys on `running`/`spawning` alone, so every other non-resting runtime — a
 *    permission prompt, an exited pane — fell through to a card claiming a rest that is not happening.
 *  - NOT EVENT-SNOOZED. This one reverses a dated decision rather than extending it: the snooze was
 *    deliberately confined to the queue, because the drawer showing NOTHING at rest reads as "the agent
 *    died". That argument is about a thread nobody has parked. Once the human has parked THIS rest, the
 *    same card with the same button one surface over is not information. */
export function showsRestingCard(
  thread: Pick<ThreadView, "awaitingBackground" | "runtime" | "bgSnoozed"> | undefined,
): boolean {
  return thread?.awaitingBackground === true && thread.runtime === "turn-idle" && thread.bgSnoozed !== true
}

export function AwaitingBackgroundCard({ thread, actions }: {
  thread: Pick<ThreadView, "subAgents" | "bgShells" | "watches">
  // The queue card's event-Snooze. Only the QUEUE passes one, and the shapes that reach the queue are
  // the shell-only rest and — since 2026-08-13 — the pr-watch park, whose own fence card no longer
  // offers one. So this is the control for both.
  actions?: ReactNode
}) {
  const waiting = awaitsResults(thread)
  return (
    // The SAME shell as every transcript card (TranscriptCard). This card stacks directly under an
    // awaiting fence card on a queue card, and it used to be a visibly different object there —
    // smaller radius, a washed-out fill, its own padding, no kind header — for the same job.
    <TranscriptCard
      data-awaiting-background
      // THE GLYPH FOLLOWS THE TITLE, and there are exactly two of each. The terminal square goes with
      // the one kind-naming heading ("Background shells running"); everything else takes the generic
      // heading and the hourglass, which is honest for it — a thread holding a sub-agent or a PR
      // watcher genuinely IS waiting on something to come back. A per-kind glyph would rebuild the
      // per-kind card the consolidation removed, exactly as a per-kind title did.
      icon={shellsAlone(thread) ? TerminalSquare : Hourglass}
      label={awaitingBackgroundLabel(thread)}
    >
      {/* The sentence is BODY text (maintainer 2026-07-24): the self-return is a fact about the thread,
          not a caption for the button, so it reads as prose rather than as a label the Snooze control
          drags around with it — and it therefore stays on the surfaces that have no button.

          AND IT ONLY NAMES WORK THAT HAS NO ROW. A watched PR is listed below with its own live check
          state, so a sentence counting the same watchers above it is one fact written twice; on a rest
          held by watchers ALONE there is no sentence at all, and the heading plus the rows say the
          whole thing (maintainer 2026-08-14: "this looks busy and shitty"). */}
      {hasUnrowedWork(thread) && (
        <p className={CARD_BODY}>
          {waiting ? (
            // The subject never counts a watcher: a watcher is PARKED ON rather than dispatched, and
            // folding it in made the sentence claim the thread had dispatched a pull request.
            //
            // "It’s awaiting", not "Awaiting": the heading one line above already opens on that word,
            // and two lines starting with it read as a stutter. The verb still has to be AWAIT, which is
            // the distinction this branch exists for — a dispatched sub-agent returns and re-invokes its
            // parent, while a launched shell returns nothing there is anything to await.
            <>
              It’s awaiting the results from {awaitingBackgroundSubject(thread, { watchers: false })} it dispatched. It
              returns to the queue on its own when the work comes back.
            </>
          ) : (
            // NOT "it returns to the queue" — this card IS the queue card now, and telling the human it
            // will arrive somewhere they are already looking is the one sentence that cannot be true
            // here. What is true is the resumption: a finished shell notifies its worker, which picks
            // the thread back up on its own. Kept SHORT because the Snooze beside it says the longer
            // version — the body and its action's caption are two surfaces, not one sentence twice.
            <>
              {awaitingBackgroundSubject(thread, { watchers: false })}{" "}
              {liveShellCount(thread) === 1 ? "is" : "are"} still running. It resumes on its own when{" "}
              {liveShellCount(thread) === 1 ? "it finishes" : "one of them finishes"}.
            </>
          )}
        </p>
      )}
      {/* THE WATCHED PRs, one row each — the card's real content, not an appendix to a sentence.

          gap-2.5 BETWEEN rows against the 2px inside one, and the ratio is the point: a red row carries
          a second line naming the failing jobs, and it must read as belonging to the ref ABOVE it rather
          than to the ref below. The gap was 3 while a row could be three lines deep; folding the merge
          verdict onto the ref line made rows one line each, and 12px between single lines read as a list
          of unrelated items. Measured on the four-state fixture at dsf 6.

          mt-3 UNCONDITIONALLY — 12px, a shade MORE than the 10px between rows, so the heading reads as
          the list's heading rather than as its first item. It is the WHOLE gap rather than an addition:
          CardContent's own mt-1 collapses into it, which is why mt-2 measured 8px and put the first row
          closer to the title than to the row beneath it (measured, sans and mono, dsf 3). */}
      {prWatcherCount(thread) > 0 && (
        <div className="mt-3 flex flex-col gap-2.5">
          {(thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed").map((w) => (
            <GithubWatchRow key={w.id} watch={w} />
          ))}
        </div>
      )}
      {actions ? <CardActions>{actions}</CardActions> : null}
    </TranscriptCard>
  )
}
