import { activityTimestamp, formatLastActive } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"

export function LastActive({ at, fallbackAt, className = "" }: { at: string | undefined; fallbackAt?: string; className?: string }) {
  const now = useNowMs()
  const timestamp = activityTimestamp(at, fallbackAt)
  const label = formatLastActive(timestamp, now)
  if (!label || !timestamp) return null
  return (
    <time dateTime={timestamp} className={className}>
      {label}
    </time>
  )
}
