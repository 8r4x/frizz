import { ExternalLink, FileText } from "lucide-react"
import type { ThreadLinkView } from "@frizz/shared"
import { CHILD_ARROW, CHILD_ARROW_CLASS } from "../lib/childOps.ts"
import { openLocalPath } from "../lib/local-file-links.ts"

// Option A: the activity-row grammar, without a liveness marker or a trailing open icon.
const ROW = "group flex min-w-0 items-baseline gap-1.5 rounded-sm py-0.5 text-left text-[11.5px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-fg/60"
// Both glyphs are symmetric vertically; the resolved cap height follows the font setting.
const ICON = "h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-muted/45"

export function ThreadLinks({ links }: { links: readonly ThreadLinkView[] }) {
  if (!links.length) return null
  return (
    <div data-thread-links aria-label="Registered links" className="mt-2 flex min-w-0 flex-col gap-0.5 border-t border-border pt-1.5">
      {links.map((link) => {
        const isUrl = link.kind === "link"
        const Icon = isUrl ? ExternalLink : FileText
        const content = <>
          <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
          <Icon aria-hidden className={ICON} />
          <span data-link-kind className="petite-caps w-[33px] shrink-0 text-[9px] text-muted/45">{isUrl ? "Link" : "File"}</span>
          <span data-link-label className="min-w-0 flex-1 truncate text-muted/70 group-hover:text-fg/80 group-hover:underline">{link.label}</span>
          {isUrl && <span data-link-destination className="font-mono-keep ml-auto max-w-[45%] min-w-0 truncate text-right text-[10px] text-muted/45">{link.target}</span>}
        </>
        return isUrl ? (
          <a key={link.id} data-thread-link={link.id} href={link.target} target="_blank" rel="noopener noreferrer" title={link.target} className={ROW} onClick={(event) => event.stopPropagation()}>{content}</a>
        ) : (
          <button key={link.id} data-thread-link={link.id} type="button" title={link.target} className={`${ROW} cursor-pointer`} onClick={(event) => { event.stopPropagation(); openLocalPath(link.target) }}>{content}</button>
        )
      })}
    </div>
  )
}
