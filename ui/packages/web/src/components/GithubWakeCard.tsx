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
import { wakeCardTitle, wakeItemAge, wakeRefUrl } from "../lib/githubWakeCard.ts"

function WakeShell({
  sourceId,
  children,
}: {
  sourceId?: string
  children: ReactNode
}) {
  // NOT `self-end`: right-justification is the human's side of the conversation, and that placement is
  // most of what made a watcher notification read as something the operator sent.
  return (
    <div data-fray-msg={sourceId} data-fray-wake className="group/msg relative min-w-0 max-w-[85%]">
      <MessageDebugId sourceId={sourceId} side="right" />
      {children}
    </div>
  )
}

function ItemRow({ item, showLabel, wrap }: { item: GithubWakeItem; showLabel: boolean; wrap?: boolean }) {
  const Icon = item.bot ? Bot : User
  const age = wakeItemAge(item.at)
  const body = (
    <>
      <Icon size={12} className="mt-0.5 shrink-0 text-muted/70" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-fg/90">@{item.actor}</span>
        {/* The heading already names the kind when there is only one item ("New comment"), so repeating
            it on the row read as a stutter: "New comment / @colinhacks · comment". */}
        {showLabel && <span className="text-muted"> · {item.label}</span>}
      </span>
      {age && (
        // The exact instant stays available on hover; the row shows the age, which is the thing a
        // human scanning a burst actually reads.
        <span title={item.at} className="shrink-0 tabular-nums text-[11px] text-muted/60">
          {age}
        </span>
      )}
    </>
  )
  const className = `flex items-start gap-2 rounded-md px-2 py-1.5 text-[12px] leading-snug ${wrap ? QUEUE_WRAP : ""}`
  // An item with no permalink (a GitHub shape surprise) stays a row rather than becoming a dead link.
  if (!item.url) return <div className={className}>{body}</div>
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer noopener"
      className={`${className} -mx-2 transition-colors hover:bg-bg/50 focus-visible:bg-bg/50 focus-visible:outline-none`}
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
  return (
    <WakeShell sourceId={sourceId}>
      <TranscriptCard icon={Github} label={wakeCardTitle(steer.items.length + steer.omitted, steer.items[0].label)}>
        <div className={CARD_BODY}>
          {refUrl ? (
            <a href={refUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-fg/90 hover:underline">
              {steer.ref}
            </a>
          ) : (
            <span className="font-medium text-fg/90">{steer.ref}</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-col">
          {steer.items.map((item) => (
            <ItemRow
              key={item.url ?? `${item.actor}-${item.at ?? ""}-${item.label}`}
              item={item}
              showLabel={steer.items.length > 1}
              wrap={wrap}
            />
          ))}
        </div>
        {steer.omitted > 0 && (
          // Never let the card imply it listed everything: the steer counted these but did not name them.
          <div className="mt-1.5 px-2 text-[11px] text-muted/60">
            …and {steer.omitted} more not listed
          </div>
        )}
      </TranscriptCard>
    </WakeShell>
  )
}
