import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { restartWorker } from "../lib/restartWorker.ts"
import { useDevFrizzBuild } from "../lib/devBuild.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
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
        // AN ICON IN THE HEADER'S ACTION STRIP, wearing that strip's own chrome (lib/headerIcon.ts) —
        // never a labelled pill (maintainer, 2026-08-01: "It should just be a simple reload button, a
        // simple update icon. It doesn't need to be a full button."). The hover fill is what says
        // "control"; an earlier pass shipped this as bare TEXT with no box at all and read as a static
        // label, which is the failure being avoided, not the absence of a border.
        //
        // IT SAT IN THE LIFECYCLE FOOTER UNTIL 2026-08-26 (maintainer: "the restart worker button
        // should be at the top. I just realized it shouldn't be along the bottom"), at 24px and
        // `text-fg/55` under a hand-measured `INK_TRIM_REFRESH` that collapsed its box onto its ink so
        // one gap could space a strip of pills and bare glyphs alike. None of that came with it: this
        // strip is uniform 28px squares on a flat `gap-0.5`, where every mark carries the same box, so
        // the trim would now pull this one verb out of a rhythm it is already in.
        //
        // THE ONE MARK IN THIS STRIP THAT NEEDS A HORIZONTAL CORRECTION, and it goes the opposite way
        // to the footer's trims: `RefreshCw` paints 12 of its 14 box px where every other icon here
        // paints 7–10.5, so its 28px square carries only 8px of dead space against the strip's 8.75–
        // 10.5 — and the eye reads ink, so the two gaps either side of it CLOSED. Measured with
        // `scripts/ink-gaps.mjs` on `icon-rhythm-fixture.html` (dsf 4), the strip's four ink gaps ran
        // 21.75 / 19.75 / 18.75 / 21.25 before this margin and 21.75 / 21.75 / 20.75 / 21.25 after it.
        // A POSITIVE margin, because the correction needed is more layout box, not less: the footer's
        // `-mx` trims collapse a box onto a mark too small for it, and this is the same law inverted.
        className={`${HEADER_ICON_CLASS} mx-[2px]`}
      >
        {busy ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : <RefreshCw size={14} strokeWidth={2} />}
      </button>
    </Tooltip>
  )
}
