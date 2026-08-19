// EVERY WAKE FRIZZ DELIVERS, rendered as frizz speaking rather than as the human's own words.
//
// Named for the whole family since 2026-08-19, when the last two members joined it: it was
// `GithubWakeCard` back when a review steer was the only thing it drew, and the name outlived the job by
// two features. What arrives here is any user turn the server flagged `wake` — a PR watcher's review
// activity, its status lines, a background shell that finished while nobody was awake, and whatever the
// parsers below do not recognize.
//
// THE RULE THE WHOLE FILE FOLLOWS: a wake frizz composed ITSELF is a hairline, because it is one line of
// news about something outside the turn. A wake carrying prose someone else WROTE — a worker's own timer
// text, a message this build cannot parse — keeps the card, because a card is the shape with a body in
// it. The agent-facing trailer that frizz appends to its own messages is dropped in every case: it
// instructs the worker about its own registrations, and the human reading the transcript has none.
//
// The wake is recorded as an ordinary user turn (it is pasted into the worker's composer), so the chat
// rendered it in the off-white right-justified bubble the human's messages wear — which claimed the
// operator had typed a message the pr-watch watcher composed. This is the correction.
//
// It is a WAKE DIVIDER, not a card (maintainer 2026-07-31, after a gallery of ten alternatives: "I hate
// the design of the new comment notification card… it just feels wrong"). The diagnosis that picked
// this shape: the transcript already had one idiom for this class of event, and this was the only
// holdout. A background shell coming to rest, a Monitor timing out, a sub-agent finishing and a
// sub-agent reporting up all render as WakeDivider — and a pr-watch wake is the same class, an external
// event the worker was waiting on that reached a notable state and re-invoked it. It alone still wore a
// full TranscriptCard, which is what made it read as a different, louder kind of thing than it is.
//
// Three defects went with the card and are gone with it: ~350px of dead air between a left-pinned title
// and a right-pinned ref; a p-4 inset wrapped around a SINGLE 20px line, when every other card in that
// shell has a body; and three marks on one row that all looked clickable (an underlined title, an
// accent ref, the corner glyph) with no hierarchy between them.
import { Bell, Github, TerminalSquare } from "lucide-react"
import { isGithubWakeBacklog, parseGithubWakeSteer, parsePrWatchWake, parseShellDoneWake, type GithubWakeSteer, type PrWatchWake, type ShellDoneWake } from "@frizz/shared"
import { CARD_BODY, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { WakeDivider } from "./WakeDivider.tsx"
import { githubRefUrl } from "../lib/githubRef.ts"
import { wakeCardTitle, wakeItemAge } from "../lib/githubWakeCard.ts"

// The divider's own link language. It is NOT the accent `CARD_LINK` the cards use: a divider is quiet
// transcript punctuation, and an accent-gold link inside one shouts louder than the event does. This is
// the same muted underline the sub-agent divider's drill-in title wears, so every divider's link reads
// the same way.
const DIVIDER_LINK = "rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"

// ---- THE ROW LIST IS GONE (2026-08-13) -----------------------------------------------------------
// A burst used to hang one row per item under the divider — actor, kind, age, each its own permalink.
// Two things killed it, and they point the same way.
//
// IT DID NOT SCALE, and the case that broke it is the common one. The first park on a PR replays
// everything already sitting there, so a PR that has been open a while rendered its whole review history
// into a queue card: "For PRs that have been around for a long time, it's going to render like a hundred
// reviews, so let's hide all of that on the initial watcher registration" (maintainer 2026-08-13).
//
// AND NOBODY NEEDED IT HERE. The full detail still reaches the WORKER — every item, with its permalink
// and its read-the-inline-comments instruction, in the delivered steer — which is where it is acted on:
// "we could certainly surface all of those things to the agent quietly, just so the agent knows the
// history… the agent can kind of handle it itself". What the transcript owes a human is one line saying
// the watcher fired and roughly what landed, with the PR one click away. That is the divider.

export function FrizzWake({ steer: served, text, sourceId, wrap }: { steer?: GithubWakeSteer; text: string; sourceId?: string; wrap?: boolean }) {
  // A BACKGROUND SHELL that finished behind a resting worker. Settled first and on its own: it is a
  // whole delivery, never a part of one, and it shares nothing with the GitHub grammar below.
  const shell = parseShellDoneWake(text)
  if (shell) return <ShellDoneDivider wake={shell} sourceId={sourceId} />
  // ONE DELIVERY, UP TO TWO PARTS. A poll that saw CI flip AND a comment land composes both into one
  // message (prWatchWakeMessage), and each is its own event, so each gets its own hairline. The status
  // part goes first because that is the order the scheduler wrote them in.
  const status = parsePrWatchWake(text)
  // The SERVER's parse wins, because it is the only one that cannot be a build behind the formatter
  // that wrote this text (see TranscriptMessage.wakeSteer). Parsing here is the fallback for a legacy
  // transcript or a server too old to send the field — it is also what this component did exclusively
  // until a steer grew two lines the shipped parsers had never seen and every open tab lost its divider.
  //
  // The COMBINED case is the one exception, and it is deliberate that the server does not serve it: the
  // steer's parser reads line 0 and nothing else, so a status line above it means no served steer — and
  // that is what keeps an already-open tab on an older bundle rendering the whole text rather than
  // silently dropping the CI verdict it would not know to draw. Here the status lines come off first
  // (each is exactly what `parsePrWatchWake` recognizes on its own) and the remainder is the steer.
  const steer = served ?? parseGithubWakeSteer(status ? text.split("\n").filter((line) => !parsePrWatchWake(line)).join("\n") : text)
  // Neither part recognized — a legacy transcript, a timer or limit wake, a format this build predates —
  // still gets first-party chrome. Only the structured lines are lost, never the text. This one stays a
  // CARD: there is arbitrary prose to show, and a divider is a one-line shape.
  // NOT `self-end`: right-justification is the human's side of the conversation, and that placement is
  // most of what made a watcher notification read as something the operator sent.
  if (!steer && !status) {
    return (
      <div data-frizz-msg={sourceId} data-frizz-wake className="min-w-0 max-w-[85%]">
        <TranscriptCard icon={Bell} label="Frizz">
          <div className={`${CARD_BODY} whitespace-pre-wrap [overflow-wrap:anywhere]${wrap ? ` ${QUEUE_WRAP}` : ""}`}>{text}</div>
        </TranscriptCard>
      </div>
    )
  }
  if (status) {
    return (
      <>
        <PrWatchStatusDivider wake={status} sourceId={sourceId} />
        {/* The second part takes no sourceId: `data-frizz-msg` is the chat's per-message handle (scroll
            anchor, React key) and two rendered nodes must never claim one id. */}
        {steer && <GithubSteerDivider steer={steer} text={text} />}
      </>
    )
  }
  return <GithubSteerDivider steer={steer!} text={text} sourceId={sourceId} />
}

// ---- THE BACKGROUND-SHELL HAIRLINE -----------------------------------------------------------------
// Deliberately INDISTINGUISHABLE from the divider the runtime-reported completion draws — same glyph,
// same «guillemets», same outcome words as the server's own `backgroundWakeLabel`. That is the entire
// point: one shell finishing is one event, and which of the two reporters saw it is an accident of
// whether the worker happened to be at rest.
//
// The TASK ID is parsed but not drawn. It is the handle the worker names on an `awaiting` fence, not
// something a reader correlates by eye, and the runtime's own line has never carried one — printing it
// on only the half of the cases frizz reports would put the difference back on the screen.
function ShellDoneDivider({ wake, sourceId }: { wake: ShellDoneWake; sourceId?: string }) {
  // The server truncates its own label at 64 chars for the same reason: a divider is a hairline, and a
  // 400-character shell description wraps it into a paragraph.
  const desc = wake.label.length > 64 ? `${wake.label.slice(0, 63)}…` : wake.label
  const label = `Background task «${desc}» ${wake.outcome}`
  return (
    <WakeDivider icon={TerminalSquare} sourceId={sourceId} marker="event" ariaLabel={label}>
      <span className="min-w-0 truncate">{label}</span>
    </WakeDivider>
  )
}

// ---- THE STATUS HAIRLINE ---------------------------------------------------------------------------
// A PR reaching a terminal state, or CI reaching a terminal verdict. Same watcher, same PR and the same
// class of event as the review divider below, so it wears the same chrome — which it did not until
// 2026-08-18, when it was the last thing a registered watcher said that still arrived as a full-width
// bordered card. Two of them stacked under a run of hairlines is what prompted the fix ("these callouts
// should obviously be hairlines"), and the card was carrying LESS news than the hairlines above it: the
// only thing under its title was one line of state and a parenthetical addressed to the worker.
//
// THE TRAILER IS DROPPED, not rendered. "This watcher is spent" and "STILL ARMED — drop it with
// mcp__frizz__watch_pr" are instructions to the agent about its own registration; a human reading the
// transcript has no watcher to re-register and no tool to call.
//
// STATE FIRST, ref second, matching the review divider's `{title} on {ref}` — so the news survives the
// truncation at queue-rail width, where the label clips from the right.
function PrWatchStatusDivider({ wake, sourceId }: { wake: PrWatchWake; sourceId?: string }) {
  const href = githubRefUrl(wake.ref)
  const ref = href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={DIVIDER_LINK}>
      {wake.ref}
    </a>
  ) : (
    <span>{wake.ref}</span>
  )
  // ONE CASE TREATMENT ON THE LINE — petite caps end to end, ref included (see the note on the review
  // divider's label). `PR` and `CI` are already uppercase, so they render as full caps and stay legible
  // as the acronyms they are.
  const lead = wake.kind === "ci" ? `CI ${wake.verdict === "passing" ? "passed" : "failed"} on ` : `PR ${wake.kind} on `
  // The failing jobs ride INSIDE the truncating span: naming them is the most useful thing a red line can
  // do, and losing the tail of a long list costs nothing the verdict has not already said.
  const jobs = wake.kind === "ci" && wake.verdict === "failing" && wake.failing.length ? `: ${wake.failing.join(", ")}` : ""
  const checks = wake.kind === "ci" && wake.verdict === "passing" && wake.passed !== undefined
    ? `${wake.passed} ${wake.passed === 1 ? "check" : "checks"} green`
    : null
  return (
    <WakeDivider
      icon={Github}
      sourceId={sourceId}
      marker="github"
      // Only the inert form takes the separator role — a divider carrying a focusable link may not.
      ariaLabel={href ? undefined : `${lead}${wake.ref}${jobs}${checks ? ` · ${checks}` : ""}`}
    >
      <span className="min-w-0 truncate">
        {lead}
        {ref}
        {jobs}
      </span>
      {checks && (
        // Outside the truncating span, like the review divider's age: when the sentence clips, the tally
        // is the one field small enough to always survive it.
        <span className="shrink-0 tabular-nums">· {checks}</span>
      )}
    </WakeDivider>
  )
}

// ---- THE REVIEW-ACTIVITY HAIRLINE ------------------------------------------------------------------
function GithubSteerDivider({ steer, text, sourceId }: { steer: GithubWakeSteer; text: string; sourceId?: string }) {
  const refUrl = githubRefUrl(steer.ref)
  const total = steer.items.length + steer.omitted
  // THE FIRST-PARK REPLAY IS NOT NEWS, and saying "2 new items" about a PR's existing history is a lie
  // the reader acts on. It reads as what it is — the watcher catching the worker up — and it never
  // names an actor or an age, because "who filed it" and "how stale" are questions about an EVENT.
  const backlog = isGithubWakeBacklog(text)
  // A wake carrying exactly ONE item is the common case by far, and it is said entirely by the divider's
  // label: the kind, who filed it, which PR, and how stale. Several items read as a count — naming three
  // kinds in one line is worse than counting them, and the worker has the full list either way.
  const only = !backlog && steer.items.length === 1 && steer.omitted === 0 ? steer.items[0] : null
  const age = only ? wakeItemAge(only.at) : null
  // ONE link on the line, and it is the ref. The card this replaced put a link on the title AND on the
  // ref AND a glyph beside them — three marks that all looked interactive, with no hierarchy saying
  // which one to press.
  //
  // So the two collapse into one: the visible text stays `owner/repo#N`, but for a single item the href
  // is that ITEM'S PERMALINK. "Read that exact comment" is the whole point of the wake, and a comment
  // permalink IS a url on that PR — following the ref lands you on the PR *at the comment*, which is
  // strictly what you wanted from either of the two links. A burst has no single item to deep-link, so
  // it points at the PR and its rows carry their own permalinks.
  const href = only?.url ?? refUrl
  // "ALREADY on", not "caught up ON … ON": the ref is appended with `on` below, so any title ending in a
  // preposition says it twice. `already` is also the word doing the work — it is what tells the reader
  // this is history the watcher handed over, not something that just happened.
  const title = backlog
    ? `${total} ${total === 1 ? "item" : "items"} already`
    : wakeCardTitle(total, steer.items[0]?.label ?? "item", only?.actor)
  // ONE CASE TREATMENT ON THE LINE, and that is the whole fix (maintainer 2026-08-13: "the rendering on
  // '2 new items …' Looks fucking insane because it's mixing small caps with regular font").
  //
  // The label used to escape three of its own runs back to ordinary case with `WAKE_DIVIDER_IDENT` — the
  // login, the ref and the age — on the reasoning that a GitHub token is something you match by eye and
  // small capitals make it read as prose. Each escape was defensible alone; together they alternated the
  // line's casing FOUR times in twelve words, and the line stopped reading as a line.
  //
  // So it wears its family's treatment whole, like every other divider in the transcript (the shell
  // wake, the sub-agent wake, the collapsed-run summary — all petite-caps end to end). The ref keeps its
  // link underline, which is what marks it as the thing to press; it no longer needs a second signal in
  // a different alphabet. `WAKE_DIVIDER_IDENT` survives for callers with a genuinely mixed line.
  const ref = href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={DIVIDER_LINK}>
      {steer.ref}
    </a>
  ) : (
    <span>{steer.ref}</span>
  )
  return (
    <WakeDivider
      icon={Github}
      sourceId={sourceId}
      marker="github"
      // Only the inert form takes the separator role — a divider carrying a focusable link may not.
      // The sentence here must stay in step with the nodes below.
      ariaLabel={href ? undefined : `${title} on ${steer.ref}`}
    >
      {/* The label TRUNCATES rather than wrapping. At queue-rail width the full sentence does not fit,
          and a divider whose label wraps to four lines stops being a hairline at all — it was the first
          thing that broke when this shape was tried. */}
      <span className="min-w-0 truncate">
        {title} on {ref}
      </span>
      {age && (
        // The age sits OUTSIDE the truncating span and never shrinks: when the sentence clips, "how
        // stale is this" is the one field that must survive the clip. `title` keeps the exact instant.
        <span title={only?.at} className="shrink-0 tabular-nums">
          · {age}
        </span>
      )}
    </WakeDivider>
  )
}
