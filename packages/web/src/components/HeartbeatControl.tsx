import { useState } from "react"
import { HeartPulse, Pause, Play } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { formatHeartbeatInterval } from "../lib/heartbeat.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"

// The operator's half of a worker-armed heartbeat (server: scheduler.ts SOURCE 4). The WORKER arms and
// stops it — it is the one that knows whether the work the beat drives is finished — so the board
// deliberately offers only pause/resume. A Stop here would let the human silently break an autonomous
// loop the worker is still relying on, and it already has the bigger hammer: archive the thread.
//
// Pause is not cosmetic. It stops new beats AND drops any beat already queued (deliveryContext reads a
// paused row as supersession), so resuming does not deliver a stale nudge the human had silenced.
//
// Renders NOTHING when the thread has no heartbeat, which is almost every thread — so the footer's
// left cluster is unchanged unless there is genuinely something to say.
export function HeartbeatControl({ thread }: { thread: ThreadView }) {
  const [busy, setBusy] = useState(false)
  const beat = thread.heartbeat
  if (!beat) return null

  const paused = beat.paused
  const every = formatHeartbeatInterval(beat.intervalSeconds)
  const verb = paused ? "Resume" : "Pause"
  // The prompt is the whole point of hovering: it is what the thread will be SENT, and a heartbeat the
  // operator cannot read is one they cannot judge whether to silence.
  const label = `${paused ? "Heartbeat paused" : `Heartbeat every ${every}`} — click to ${verb.toLowerCase()}\n${beat.prompt.trim()}`

  async function toggle() {
    setBusy(true)
    try {
      await rpc.setThreadHeartbeatPaused({ slug: thread.id, sessionId: thread.sessionId ?? "", paused: !paused })
      showToast(paused ? `Heartbeat resumed · every ${every}` : "Heartbeat paused")
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Could not change the heartbeat").slice(0, 100))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tooltip label={label} side="top" multiline>
      <button
        type="button"
        data-heartbeat-control
        data-heartbeat-paused={paused ? "true" : "false"}
        disabled={busy}
        onClick={() => void toggle()}
        aria-label={`${verb} heartbeat`}
        className={`flex items-center gap-1 rounded-md px-1 py-0.5 disabled:opacity-50 ${
          paused ? "text-muted/60 hover:text-fg/80" : "text-pink-400/90 hover:text-pink-300"
        }`}
      >
        {/* Same HeartPulse the rail row wears, so the two surfaces name the thread's state in one
            vocabulary; the pause/play glyph beside it is the VERB, not a second state. Both nudged
            down a hair — see the em offsets below. */}
        <HeartPulse size={12} style={{ transform: "translateY(0.02em)" }} />
        {paused
          ? <Play size={10} fill="currentColor" style={{ transform: "translateY(0.01em)" }} />
          : <Pause size={10} fill="currentColor" style={{ transform: "translateY(0.01em)" }} />}
      </button>
    </Tooltip>
  )
}
