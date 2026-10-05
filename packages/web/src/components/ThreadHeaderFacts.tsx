import type { ThreadView } from "@frizz/shared"
import { lastActiveLabelAt } from "../groups.ts"
import { LastActive } from "./LastActive.tsx"
import { ContextMeter, hasContextReading } from "./ContextMeter.tsx"

// A THREAD HEADER'S SECOND LINE: the facts about the thread as a whole, in words — "Last active 2m ago ·
// ◔ 74% context". The queue card and the thread header (drawer and /full) both render it, so the two
// cannot drift. The context reading joined "Last active" here on 2026-10-05 when the lifecycle footer
// that carried it went (see ThreadLifecycle.tsx for the top/bottom split).
//
// `empty:hidden`: a thread with no timestamp and no reading draws nothing, and must not leave the line's
// 2px top margin behind.
export function ThreadHeaderFacts({ thread }: { thread: ThreadView }) {
  return (
    <div data-thread-header-facts className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-75 empty:hidden">
      <LastActive at={lastActiveLabelAt(thread)} fallbackAt={thread.spawnedAt} className="min-w-0 truncate" />
      {hasContextReading(thread) && (
        <>
          {/* The separator shows only after a "Last active" that rendered — LastActive draws nothing for a
              thread with no timestamp at all, and a reading must never open on a dangling `·`. */}
          <span aria-hidden className="hidden shrink-0 text-muted-45 [time+&]:inline">·</span>
          <ContextMeter thread={thread} />
        </>
      )}
    </div>
  )
}
