// A scheduler wake, rendered as FRIZZ speaking rather than as the human's own words.
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
import { Bell, Github } from "lucide-react"
import { isGithubWakeBacklog, parseGithubWakeSteer, type GithubWakeSteer } from "@frizz/shared"
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

export function GithubWakeCard({ steer: served, text, sourceId, wrap }: { steer?: GithubWakeSteer; text: string; sourceId?: string; wrap?: boolean }) {
  // The SERVER's parse wins, because it is the only one that cannot be a build behind the formatter
  // that wrote this text (see TranscriptMessage.wakeSteer). Parsing here is the fallback for a legacy
  // transcript or a server too old to send the field — it is also what this component did exclusively
  // until a steer grew two lines the shipped parsers had never seen and every open tab lost its divider.
  const steer = served ?? parseGithubWakeSteer(text)
  // A steer the parser doesn't recognize — a legacy transcript, a CI/timer/limit wake, a format this
  // build predates — still gets first-party chrome. Only the structured rows are lost, never the text.
  // This one stays a CARD: there is arbitrary prose to show, and a divider is a one-line shape.
  // NOT `self-end`: right-justification is the human's side of the conversation, and that placement is
  // most of what made a watcher notification read as something the operator sent.
  if (!steer) {
    return (
      <div data-frizz-msg={sourceId} data-frizz-wake className="min-w-0 max-w-[85%]">
        <TranscriptCard icon={Bell} label="Frizz">
          <div className={`${CARD_BODY} whitespace-pre-wrap [overflow-wrap:anywhere]${wrap ? ` ${QUEUE_WRAP}` : ""}`}>{text}</div>
        </TranscriptCard>
      </div>
    )
  }
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
