// A scheduler wake, rendered as FRAY speaking rather than as the human's own words.
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
import { Bell, Bot, Github, User } from "lucide-react"
import { parseGithubWakeSteer, type GithubWakeItem, type GithubWakeSteer } from "@fray-ui/shared"
import { CARD_BODY, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { MessageDebugId } from "./MessageDebugId.tsx"
import { WakeDivider, WAKE_DIVIDER_IDENT } from "./WakeDivider.tsx"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { githubRefUrl } from "../lib/githubRef.ts"
import { wakeCardTitle, wakeItemAge } from "../lib/githubWakeCard.ts"

// A 12px lucide glyph beside a 12px label at `gap-1`, with the measured optical nudge — the same
// icon+label rhythm every dense row in the app uses.
const ROW_ICON = `shrink-0 ${ICON_LABEL_NUDGE}`

// The divider's own link language. It is NOT the accent `CARD_LINK` the cards use: a divider is quiet
// transcript punctuation, and an accent-gold link inside one shouts louder than the event does. This is
// the same muted underline the sub-agent divider's drill-in title wears, so every divider's link reads
// the same way.
const DIVIDER_LINK = "rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"

// Rows exist only for a BURST (or a capped burst): a lone item is said entirely by the divider's own
// label, so there is nothing left for a row to add. Each row therefore always names its own kind — a
// burst routinely mixes an approval with two comments, and the counted heading cannot say which is which.
function ItemRow({ item }: { item: GithubWakeItem }) {
  const Icon = item.bot ? Bot : User
  const age = wakeItemAge(item.at)
  const body = (
    <>
      <Icon size={12} className={`${ROW_ICON} text-muted/70`} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg/90">@{item.actor}</span>
        <span className="text-muted"> · {item.label}</span>
      </span>
      {age && (
        // The exact instant stays available on hover; the row shows the age, which is what a human
        // scanning a burst actually reads.
        <span title={item.at} className="shrink-0 tabular-nums text-[11px] text-muted/60">
          {age}
        </span>
      )}
    </>
  )
  const shape = "flex items-center gap-1 rounded-md px-2 py-1 text-[12px] leading-5"
  if (!item.url) return <div className={shape}>{body}</div>
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer noopener"
      className={`${shape} outline-none transition-colors hover:bg-bg/60 focus-visible:bg-bg/60 focus-visible:ring-1 focus-visible:ring-fg/40`}
    >
      {body}
    </a>
  )
}

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
      <div data-fray-msg={sourceId} data-fray-wake className="group/msg relative min-w-0 max-w-[85%]">
        <MessageDebugId sourceId={sourceId} side="right" />
        <TranscriptCard icon={Bell} label="Fray">
          <div className={`${CARD_BODY} whitespace-pre-wrap [overflow-wrap:anywhere]${wrap ? ` ${QUEUE_WRAP}` : ""}`}>{text}</div>
        </TranscriptCard>
      </div>
    )
  }
  const refUrl = githubRefUrl(steer.ref)
  const total = steer.items.length + steer.omitted
  // A wake carrying exactly ONE item is the common case by far, and it is said entirely by the divider's
  // label: the kind, who filed it, which PR, and how stale. Several items read as a count, because
  // naming three kinds in one line is worse than counting them and listing them beneath.
  const only = steer.items.length === 1 && steer.omitted === 0 ? steer.items[0] : null
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
  // An unparseable ref with no item permalink degrades to plain text in the same position rather than
  // to a dead link.
  const ref = href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={`${WAKE_DIVIDER_IDENT} ${DIVIDER_LINK}`}>
      {steer.ref}
    </a>
  ) : (
    <span className={WAKE_DIVIDER_IDENT}>{steer.ref}</span>
  )
  return (
    <div className="flex flex-col">
      <WakeDivider
        icon={Github}
        sourceId={sourceId}
        marker="github"
        // Only the inert form takes the separator role — a divider carrying a focusable link may not.
        // The sentence here must stay in step with the nodes below; `wakeCardTitle` is the one that
        // spells it, and its test pins the wording.
        ariaLabel={href ? undefined : `${wakeCardTitle(total, steer.items[0].label, only?.actor)} on ${steer.ref}`}
      >
        {/* The label TRUNCATES rather than wrapping. At queue-rail width the full sentence does not
            fit, and a divider whose label wraps to four lines stops being a hairline at all — it was
            the first thing that broke when this shape was tried.

            The login is spelled as its OWN node rather than baked into the title string, because it
            has to escape the petite-caps treatment: `@PULLFROG[BOT]` in small capitals reads as prose,
            when it is a token you match against GitHub by eye. It also carries the line's one bit of
            emphasis — who filed this is the first thing a human scanning the transcript wants. */}
        <span className="min-w-0 truncate">
          {only ? (
            <>
              New {only.label} from <span className={`${WAKE_DIVIDER_IDENT} text-fg/80`}>@{only.actor}</span>
            </>
          ) : (
            `${total} new items`
          )}{" "}
          on {ref}
        </span>
        {age && (
          // The age sits OUTSIDE the truncating span and never shrinks: when the sentence clips, "how
          // stale is this" is the one field that must survive the clip. `title` keeps the exact instant.
          <span title={only?.at} className={`${WAKE_DIVIDER_IDENT} shrink-0 tabular-nums`}>
            · {age}
          </span>
        )}
      </WakeDivider>
      {!only && (
        // Centred under the divider's own label rather than flush left, so the burst reads as one
        // object hanging off the section break instead of as a list that happens to follow it.
        <div className="mx-auto flex w-fit max-w-full flex-col">
          {steer.items.map((item) => (
            <ItemRow key={item.url ?? `${item.actor}-${item.at ?? ""}-${item.label}`} item={item} />
          ))}
          {steer.omitted > 0 && (
            // Never let the card imply it listed everything: the steer counted these but did not name them.
            <div className="px-2 text-[11px] leading-5 text-muted/60">…and {steer.omitted} more not listed</div>
          )}
        </div>
      )}
    </div>
  )
}
