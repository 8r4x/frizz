import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { restartWorker, restartWorkerBlockedReason } from "../lib/restartWorker.ts"
import { Tooltip } from "./Tooltip.tsx"

// "Restart worker" — replace this thread's live `claude` process, keeping the conversation.
//
// The verb exists because a worker reads its plugin (hooks) and its system prompt ONCE, at process
// start, and cannot pick up a newer fray build in place — so a worker dispatched before a hook shipped
// runs without it for the rest of its life, no matter how many turns it takes. See lib/restartWorker.ts
// for the measurement behind that claim.
//
// OFFERED only where it is both meaningful and safe:
//  • a session thread, not a read-only foreign row;
//  • Claude — a codex thread takes its hooks as per-conversation config, and the bridge's fresh-process
//    path is Claude-only, so offering it there would be a button that throws;
//  • a LIVE process. On an exited thread the next follow-up already cold-starts on current tooling,
//    which is exactly what the existing Retry verb does — a second button for it would be a lie about
//    doing something different.
//
// DISABLED (not hidden) while the worker has running sub-agents, so the operator learns WHY rather than
// hunting a button that vanished. The server enforces the same refusal; this is the explanation.
export function RestartWorkerButton({ thread }: { thread: ThreadView }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  if (thread.kind !== "session" || thread.foreign) return null
  if (thread.backend === "codex") return null
  if (thread.runtime === "exited") return null

  const blocked = restartWorkerBlockedReason(thread)
  const label = blocked ?? "Restart worker — same conversation, fresh process on current tooling"

  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        disabled={busy || blocked !== null}
        aria-label="Restart worker"
        // Focus must not leave the composer: same discipline as every other footer verb.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setBusy(true)
          restartWorker(queryClient, thread.id).finally(() => setBusy(false))
        }}
        // Wears the SAME pill as the verbs beside it (the snooze group's exact border + surface). It
        // shipped borderless for one review pass and read as a static label rather than a control —
        // in a strip where every other verb is a bordered pill, the bare one is the odd mark out, and
        // this one restarts a process. Tone stays at fg/75, below Mark-as-done, so the hierarchy still
        // says "maintenance verb": the BOX says clickable, the TONE says secondary.
        className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/75 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        Restart worker
      </button>
    </Tooltip>
  )
}
