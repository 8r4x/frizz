import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { restartWorker } from "../lib/restartWorker.ts"
import { useDevFrizzBuild } from "../lib/devBuild.ts"
import { INK_TRIM_REFRESH } from "../lib/iconRhythm.ts"
import { Tooltip } from "./Tooltip.tsx"

// "Restart worker" — replace this thread's live `claude` process, keeping the conversation.
//
// The verb exists because a worker reads its plugin (hooks) and its system prompt ONCE, at process
// start, and cannot pick up a newer frizz build in place — so a worker dispatched before a hook shipped
// runs without it for the rest of its life, no matter how many turns it takes. See lib/restartWorker.ts
// for the measurement behind that claim.
//
// DEV BUILDS ONLY. It is a niche maintenance verb — it earns its place while frizz itself is being
// developed (a worker dispatched an hour ago is routinely a build behind), and it would be clutter in a
// shipped frizz, where the operator has no reason to think about which build their worker booted on.
//
// The gate is the LAUNCHER's own answer, fetched at runtime (lib/devBuild.ts), and it has to be. This
// shipped gated on `import.meta.env.DEV` and was consequently invisible to the one person it was built
// for: that constant is true only under `vite dev` middleware, while frizz-dev's ordinary route builds
// an immutable artifact and serves the Vite PRODUCTION bundle — where Vite replaces it with `false` and
// eliminates this component outright. Grepping the promoted bundle for "Restart worker" found nothing
// while "Mark as done" beside it was present. Running frizz-dev IS running a development build, whether
// or not Vite is in the loop, so only the process that chose the launcher can answer this.
//
// The trade that buys: the component and its strings now reach a published bundle and are hidden at
// runtime instead of compiled out. Accepted deliberately — a compile-time gate cannot ever satisfy
// "show it in the artifact I build from source", which is the entire requirement. The runtime answer
// is strict (absent field ⇒ not dev), so a published Frizz never renders it.
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
  const devBuild = useDevFrizzBuild()

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
        // 24px square, mirroring this app's OWN icon-action size (lib/statusBar.ts: "the WCAG 2.2
        // minimum pointer target, and the largest size that still reads as part of a 12px text strip
        // rather than as chrome parked next to it"). The glyph stays at the strip's own 12px so the
        // one verb WITHOUT a label does not out-weigh the two with them, and the tone sits a step
        // below theirs (fg/55) to keep saying "maintenance verb". Ink measures 0.20px off the labels'
        // cap band — under the ~0.3px floor where a nudge only blurs it, and tighter than the Check
        // beside it (0.45px), so no vertical correction.
        //
        // The square is the HOVER TARGET, not the mark, and `INK_TRIM_REFRESH` is what keeps the two
        // from being confused: 10px of ink in a 24px box carries 7px of dead space a side, so this
        // button used to sit 13px of clear space from the Snooze pill while the pills sat 5.78px from
        // each other. Sizing the box against the strip's rhythm was the old attempt at that (24px was
        // picked over 28px for spending 12px rather than 14px to the pill) and it could never work —
        // no square is small enough to space a 10px glyph like a bordered pill AND large enough to
        // click. The trim separates the two questions: the box stays 24px, its layout footprint
        // becomes the ink, and one gap spaces the whole strip (lib/iconRhythm.ts).
        //
        // Consequence worth knowing: the trims pull this box and the plug's into a ~2.5px overlap.
        // Invisible, because only one of the two can ever paint a hover fill at a time, and the
        // overlap is empty padding on both sides — the ink stays 12px apart. The later element in the
        // DOM (this one) wins the pointer there.
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/55 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-not-allowed disabled:opacity-45 ${INK_TRIM_REFRESH}`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
      </button>
    </Tooltip>
  )
}
