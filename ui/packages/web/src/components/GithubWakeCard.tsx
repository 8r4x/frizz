// A scheduler wake, rendered as FRAY speaking rather than as the human's own words.
//
// The wake is recorded as an ordinary user turn (it is pasted into the worker's composer), so the chat
// rendered it in the off-white right-justified bubble the human's messages wear — which claimed the
// operator had typed a message the pr-watch watcher composed. These cards are the correction: left
// aligned like every other first-party card, in the shared TranscriptCard chrome, with the GitHub
// activity broken back out into rows the human can actually click through to.
import type { ReactNode } from "react"
import { ArrowUpRight, Bell, Bot, Github, User } from "lucide-react"
import { parseGithubWakeSteer, type GithubWakeItem } from "@fray-ui/shared"
import { CARD_BODY, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { MessageDebugId } from "./MessageDebugId.tsx"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { wakeCardTitle, wakeItemAge, wakeRefUrl } from "../lib/githubWakeCard.ts"

// ONE icon+label rhythm for the whole card. The kind header (CardKind) pairs a 12px lucide glyph with
// its label at `gap-1` and the measured optical nudge; every row below repeats exactly that, so the
// card reads as one grid instead of a header and a list that disagree about their spacing by 4px.
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

function ItemRow({ item, showLabel }: { item: GithubWakeItem; showLabel: boolean }) {
  const Icon = item.bot ? Bot : User
  const age = wakeItemAge(item.at)
  const body = (
    <>
      <Icon size={12} className={`${ROW_ICON} text-muted/70`} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg/90">@{item.actor}</span>
        {/* The heading already names the kind when there is only one item ("New comment"), so repeating
            it on the row read as a stutter: "New comment / @colinhacks · comment". */}
        {showLabel && <span className="text-muted"> · {item.label}</span>}
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
  // Which PR this is about, parked at the header's right edge (maintainer 2026-07-29). It is the card's
  // subject, not a line of its content — on its own body line it pushed the activity down and read as
  // the first of the rows.
  const ref = refUrl ? (
    <a href={refUrl} target="_blank" rel="noreferrer noopener" className={`flex items-center gap-1 text-[11px] ${CARD_LINK}`}>
      {steer.ref}
      <ArrowUpRight size={12} className={ROW_ICON} />
    </a>
  ) : (
    <span className="text-[11px] text-muted">{steer.ref}</span>
  )
  return (
    <WakeShell sourceId={sourceId}>
      <TranscriptCard icon={Github} label={wakeCardTitle(total, steer.items[0].label)} aside={ref}>
        <div className="flex flex-col">
          {steer.items.map((item) => (
            <ItemRow
              key={item.url ?? `${item.actor}-${item.at ?? ""}-${item.label}`}
              item={item}
              showLabel={steer.items.length > 1}
            />
          ))}
        </div>
        {steer.omitted > 0 && (
          // Never let the card imply it listed everything: the steer counted these but did not name them.
          <div className="mt-1 text-[11px] leading-5 text-muted/60">…and {steer.omitted} more not listed</div>
        )}
      </TranscriptCard>
    </WakeShell>
  )
}
