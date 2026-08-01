import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { restartWorker } from "../lib/restartWorker.ts"
import { useDevFrayBuild } from "../lib/devBuild.ts"
import { Tooltip } from "./Tooltip.tsx"

// "Restart worker" — replace this thread's live `claude` process, keeping the conversation.
//
// The verb exists because a worker reads its plugin (hooks) and its system prompt ONCE, at process
// start, and cannot pick up a newer fray build in place — so a worker dispatched before a hook shipped
// runs without it for the rest of its life, no matter how many turns it takes. See lib/restartWorker.ts
// for the measurement behind that claim.
//
// DEV BUILDS ONLY. It is a niche maintenance verb — it earns its place while fray itself is being
// developed (a worker dispatched an hour ago is routinely a build behind), and it would be clutter in a
// shipped fray, where the operator has no reason to think about which build their worker booted on.
//
// The gate is the LAUNCHER's own answer, fetched at runtime (lib/devBuild.ts), and it has to be. This
// shipped gated on `import.meta.env.DEV` and was consequently invisible to the one person it was built
// for: that constant is true only under `vite dev` middleware, while fray-dev's ordinary route builds
// an immutable artifact and serves the Vite PRODUCTION bundle — where Vite replaces it with `false` and
// eliminates this component outright. Grepping the promoted bundle for "Restart worker" found nothing
// while "Mark as done" beside it was present. Running fray-dev IS running a development build, whether
// or not Vite is in the loop, so only the process that chose the launcher can answer this.
//
// The trade that buys: the component and its strings now reach a published bundle and are hidden at
// runtime instead of compiled out. Accepted deliberately — a compile-time gate cannot ever satisfy
// "show it in the artifact I build from source", which is the entire requirement. The runtime answer
// is strict (absent field ⇒ not dev), so a published Fray never renders it.
//
// OFFERED only where it is both meaningful and safe:
//  • a session thread, not a read-only foreign row;
//  • Claude — a codex thread takes its hooks as per-conversation config, and the bridge's fresh-process
//    path is Claude-only, so offering it there would be a button that throws;
//  • a LIVE process. On an exited thread the next follow-up already cold-starts on current tooling,
//    which is exactly what the existing Retry verb does — a second button for it would be a lie about
//    doing something different.
//
// NEVER disabled for running sub-agents. It used to be — a restart kills the parent's in-memory
// children, so the verb greyed itself out until they finished — and that made the one recovery
// affordance unavailable at exactly the moment it is reached for (maintainer 2026-08-01: "do not
// disable the button when there are sub-agents running"). See lib/restartWorker.ts.
export function RestartWorkerButton({ thread }: { thread: ThreadView }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const devBuild = useDevFrayBuild()

  if (!devBuild) return null
  if (thread.kind !== "session" || thread.foreign) return null
  if (thread.backend === "codex") return null
  if (thread.runtime === "exited") return null

  return (
    <Tooltip label="Restart worker — same conversation, fresh process on current tooling" side="top">
      <button
        type="button"
        disabled={busy}
        aria-label="Restart worker"
        // Focus must not leave the composer: same discipline as every other footer verb.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setBusy(true)
          restartWorker(queryClient, thread.id).finally(() => setBusy(false))
        }}
        // An ICON, not a labelled pill (maintainer, 2026-08-01: "It should just be a simple reload
        // button, a simple update icon. It doesn't need to be a full button."). A borderless SQUARE
        // rather than a bare glyph: the hover fill is what says "control", which is the job the pill's
        // border used to do — an earlier pass shipped this as bare TEXT with no box at all and read as
        // a static label, and that is the failure being avoided here, not the absence of a border.
        //
        // 28px matches the exact height of the pills beside it, so the strip keeps one baseline and the
        // hover targets line up; it also clears the WCAG 2.2 24px minimum. The glyph stays at the
        // strip's own 12px, so the one verb WITHOUT a label does not out-weigh the two with them, and
        // the tone sits a step below theirs (fg/55) to keep saying "maintenance verb".
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg/55 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
      </button>
    </Tooltip>
  )
}
