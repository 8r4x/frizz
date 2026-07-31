// A scheduler wake, rendered as FRAY speaking rather than as the human's own words.
//
// The wake is recorded as an ordinary user turn (it is pasted into the worker's composer), so the chat
// rendered it in the off-white right-justified bubble the human's messages wear — which claimed the
// operator had typed a message the pr-watch watcher composed. These cards are the correction: left
// aligned like every other first-party card, in the shared TranscriptCard chrome, with the GitHub
// activity broken back out into rows the human can actually click through to.
import type { ReactNode } from "react"
import { Bell, Bot, Github, User } from "lucide-react"
import { parseGithubWakeSteer, type GithubWakeItem } from "@fray-ui/shared"
import { CARD_BODY, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { MessageDebugId } from "./MessageDebugId.tsx"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { wakeCardTitle, wakeItemAge, wakeRefUrl } from "../lib/githubWakeCard.ts"

// A 12px lucide glyph beside a 12px label at `gap-1`, with the measured optical nudge — the same
// icon+label rhythm every dense row in the app uses. The card's own kind glyph is NOT one of these:
// it lives in TranscriptCard's left gutter at 14px, and the rows below start where the TITLE does, so
// the card reads down one spine rather than two.
const ROW_ICON = `shrink-0 ${ICON_LABEL_NUDGE}`

// The app's link language, straight off `.md-body a` in styles.css: accent, underlined, 2px offset.
// A link has to LOOK like one at rest — `text-fg` with a hover-only underline reads as a plain label,
// and nobody hovers a label to find out.
const CARD_LINK = "text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"

function WakeShell({ sourceId, children }: { sourceId?: string; children: ReactNode }) {
  // NOT `self-end`: right-justification is the human's side of the conversation, and that placement is
  // most of what made a watcher notification read as something the operator sent.
  return (
    <div data-fray-msg={sourceId} data-fray-wake className="group/msg relative min-w-0 max-w-[85%]">
      <MessageDebugId sourceId={sourceId} side="right" />
      {children}
    </div>
  )
}

// Rows exist only for a BURST (or a capped burst): a lone item is said entirely by the card's title,
// so there is nothing left for a row to add. Each row therefore always names its own kind — a burst
// routinely mixes an approval with two comments, and the counted heading cannot say which is which.
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
  // `-mx-2 px-2` lets the hover fill bleed into the card's own padding so the row reads as a full-width
  // target, while the icon still starts on the card's content edge — the same x as the kind header's.
  const shape = "-mx-2 flex items-center gap-1 rounded-md px-2 py-1 text-[12px] leading-5"
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

export function GithubWakeCard({ text, sourceId, wrap }: { text: string; sourceId?: string; wrap?: boolean }) {
  const steer = parseGithubWakeSteer(text)
  // A steer the parser doesn't recognize — a legacy transcript, a CI/timer/limit wake, a format this
  // build predates — still gets first-party chrome. Only the structured rows are lost, never the text.
  if (!steer) {
    return (
      <WakeShell sourceId={sourceId}>
        <TranscriptCard icon={Bell} label="Fray">
          <div className={`${CARD_BODY} whitespace-pre-wrap [overflow-wrap:anywhere]${wrap ? ` ${QUEUE_WRAP}` : ""}`}>{text}</div>
        </TranscriptCard>
      </WakeShell>
    )
  }
  const refUrl = wakeRefUrl(steer.ref)
  const total = steer.items.length + steer.omitted
  // A card carrying exactly ONE item is the common case by far, and it used to render a heading plus a
  // single row — which read as a table with one entry and an empty second column (maintainer
  // 2026-07-31). Collapsed, it is one line: the whole event on the left, the PR it happened on right
  // justified. The row's two jobs move INTO that line — the actor joins the title, and the title
  // itself carries the item's permalink, which is the one link the worker actually needs.
  const only = steer.items.length === 1 && steer.omitted === 0 ? steer.items[0] : null
  // Which PR this is about, RIGHT justified on the title row (maintainer 2026-07-31), in the shared
  // `aside` slot every card's trailing reference uses. It was previously read inside the heading
  // ("New review comment on owner/repo#587"), which works while the heading is short but competes
  // with the actor now that the title names who filed the thing. The ref keeps the app's accent link
  // language so it still LOOKS clickable at rest; an unparseable ref degrades to muted text in the
  // same position rather than to a dead link.
  const ref = refUrl ? (
    <a href={refUrl} target="_blank" rel="noreferrer noopener" className={`${CARD_LINK} text-[12px]`}>
      {steer.ref}
    </a>
  ) : (
    <span className="text-[12px] text-muted">{steer.ref}</span>
  )
  const title = wakeCardTitle(total, steer.items[0].label, only?.actor)
  // The permalink rides the TITLE in the collapsed card, because the row that used to carry it is
  // gone and "read that exact comment" is the whole point of the wake. Without a per-item url (a
  // GitHub shape surprise) the title stays plain text and the ref link is still the way through.
  const age = only ? wakeItemAge(only.at) : null
  const label = (
    <>
      {only?.url ? (
        <a href={only.url} target="_blank" rel="noreferrer noopener" className="underline decoration-fg/25 underline-offset-2 hover:decoration-fg">
          {title}
        </a>
      ) : (
        title
      )}
      {age && (
        // `nowrap` keeps the age one unit: on a narrow queue card the title wraps, and a bare "ago"
        // stranded on its own last line reads as a broken sentence.
        <span title={only?.at} className="whitespace-nowrap font-normal text-muted/70">
          {" · "}
          {age}
        </span>
      )}
    </>
  )
  return (
    <WakeShell sourceId={sourceId}>
      <TranscriptCard icon={Github} label={label} aside={ref}>
        {only ? undefined : (
          <>
            <div className="flex flex-col">
              {steer.items.map((item) => (
                <ItemRow key={item.url ?? `${item.actor}-${item.at ?? ""}-${item.label}`} item={item} />
              ))}
            </div>
            {steer.omitted > 0 && (
              // Never let the card imply it listed everything: the steer counted these but did not name them.
              <div className="mt-1 text-[11px] leading-5 text-muted/60">…and {steer.omitted} more not listed</div>
            )}
          </>
        )}
      </TranscriptCard>
    </WakeShell>
  )
}
