import { useState } from "react"
import { Plug } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { INK_TRIM_PLUG } from "../lib/iconRhythm.ts"
import { Tooltip } from "./Tooltip.tsx"

// Re-read this worker's plugin closure — hooks, skills, agent profiles, MCP servers — INTO the running
// session. The board's half of Claude's own `/reload-plugins`.
//
// It sits beside Restart because it is the verb you almost always actually wanted there. Restart is a
// process-level reset: it discards the running turn and the session's in-memory sub-agents in order to
// apply a file change the live session could simply re-read. Editing a hook or a skill and wanting the
// running worker to pick it up is the common case, and paying a full conversation-restarting reset for
// it is far too blunt.
//
// OFFERED only where it can actually work, on the same discipline as RestartWorkerButton — a button
// that throws is worse than an absent one:
//  • a session thread, not a read-only foreign row;
//  • a BROKER-backed Claude thread. A row dispatched before the broker became the sole Claude
//    transport has no control channel to ask, and frizz's codex app-server client speaks no reload
//    method at all.
//  • a live process. On an exited thread the next follow-up already cold-starts on current tooling.
export function ReloadPluginsButton({ thread }: { thread: ThreadView }) {
  const [busy, setBusy] = useState(false)

  if (thread.kind !== "session" || thread.foreign) return null
  if (thread.claudeRuntime !== "broker") return null
  if (thread.runtime === "exited") return null

  async function reload() {
    setBusy(true)
    try {
      const r = await rpc.reloadThreadPlugins({ slug: thread.id, sessionId: thread.sessionId ?? "" })
      // Report what CHANGED, not "done": the operator's question is "did my edit land?", and a bare
      // success toast answers it no better than silence.
      const parts = [`${r.plugins} plugin${r.plugins === 1 ? "" : "s"}`, `${r.commands} skill${r.commands === 1 ? "" : "s"}`, `${r.agents} agent${r.agents === 1 ? "" : "s"}`]
      // An MCP change is the one with a real cost — the provider re-reads the whole conversation
      // instead of using its prompt cache — so it is named rather than folded into the counts.
      const mcp = r.mcpServers.length ? ` · MCP: ${r.mcpServers.join(", ")}` : ""
      const errors = r.errorCount ? ` · ${r.errorCount} load error${r.errorCount === 1 ? "" : "s"}` : ""
      showToast(`Reloaded ${parts.join(", ")}${mcp}${errors}`)
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Plugin reload failed").slice(0, 120))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tooltip label="Reload plugins — hooks, skills, agents and MCP re-read from disk, same conversation" side="top">
      <button
        type="button"
        data-reload-plugins
        disabled={busy}
        aria-label="Reload plugins"
        // Focus must not leave the composer: same discipline as every other footer verb.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void reload()}
        // Mirrors RestartWorkerButton — 24px square, borderless, fg/55 — because the two sit adjacent
        // and are the same KIND of verb (maintenance, icon-only, no label). Any divergence here would
        // read as a difference in importance that does not exist.
        // PLUG, not a refresh arrow: the Restart button beside this one already wears `RefreshCw`,
        // and two adjacent icon-only verbs must not share a glyph vocabulary — the softer verb reading
        // as "reload" and the harder one as "refresh" would invert what the operator expects. The plug
        // names WHAT is being reloaded instead (maintainer, 2026-08-04: "should be a plug icon, not the
        // puzzle piece").
        //
        // 13, not the strip's 12, and that ONE px is measured rather than taste. The plug is a narrow
        // mark — 12 ink units wide in a 24 viewBox where `RefreshCw` spans 18 — so matching the sizes
        // does NOT match the weights: painted ink (stroke length × painted stroke width) came out at
        // 0.80× its neighbour's at 12 and 0.93× at 13, and 0.80 is the visible-deficit range. Both
        // glyphs are symmetric about the viewBox centre, so ink centre and box centre coincide exactly
        // (measured dy 0.00 at every size) and no vertical nudge applies. For the record the puzzle
        // this replaces ran 1.34× — it OUT-weighed the restart verb, which the swap also fixes.
        //
        // The narrowness has a SPACING cost the 24px square hides, which is what `INK_TRIM_PLUG` pays:
        // 8px of ink centred in a 24px box leaves ~8px of dead space a side, so on the strip's flat
        // `gap-1.5` this mark sat 20.5px of clear space from the restart verb while the two pills
        // beside them sat 5.78px apart. The trim collapses the layout box onto the ink so the footer's
        // one gap governs this mark exactly as it governs a bordered pill (lib/iconRhythm.ts).
        className={`flex size-6 items-center justify-center rounded-md text-fg/55 hover:bg-panel-2 hover:text-fg/80 disabled:opacity-50 ${INK_TRIM_PLUG}`}
      >
        <Plug size={13} />
      </button>
    </Tooltip>
  )
}
