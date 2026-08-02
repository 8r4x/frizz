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
        className="group flex items-center gap-0.5 rounded-md px-1 py-0.5 disabled:opacity-50"
      >
        {/* Same HeartPulse the rail row wears, so both surfaces name the thread's state in one
            vocabulary — pink while it beats, muted when the human has silenced it.
            NO translateY on either glyph. Measured in the running app: the verb's ink centre sits
            0.12px off the heart's, which is under the device grid — the skill's rule is to leave a
            sub-pixel offset alone, and an em nudge there would be a guess dressed as precision. */}
        <HeartPulse size={12} className={paused ? "text-muted/60" : "text-pink-400/90"} />
        {/* The VERB, deliberately NOT pink. Filled bars/triangle are visually much denser than the
            heart's 1.5px stroke, so at equal color the control shouted louder than the state it
            describes — measured ink 5×6.7 solid against 10×9 outline. Muting it puts the one colored
            mark on the STATE and lets the verb read as the affordance it is; hover brings it up. */}
        {paused
          ? <Play size={9} fill="currentColor" className="text-muted/55 group-hover:text-fg/80" />
          : <Pause size={9} fill="currentColor" className="text-muted/55 group-hover:text-fg/80" />}
      </button>
    </Tooltip>
  )
}
