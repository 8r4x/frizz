import { useState } from "react"
import { Puzzle } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
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
//  • a BROKER-backed Claude thread. The tmux path has no control channel to ask, and frizz's codex
//    app-server client speaks no reload method at all.
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
        // Mirrors RestartWorkerButton exactly — 24px square, borderless, 12px glyph at fg/55 — because
        // the two sit adjacent and are the same KIND of verb (maintenance, icon-only, no label). Any
        // divergence here would read as a difference in importance that does not exist.
        // PUZZLE, not a refresh arrow: the Restart button beside this one already wears `RefreshCw`,
        // and two adjacent icon-only verbs must not share a glyph vocabulary — the softer verb reading
        // as "reload" and the harder one as "refresh" would invert what the operator expects. Puzzle is
        // the near-universal "plugin/extension" mark, so it names WHAT is being reloaded instead.
        className="flex size-6 items-center justify-center rounded-md text-fg/55 hover:bg-panel-2 hover:text-fg/80 disabled:opacity-50"
      >
        <Puzzle size={12} />
      </button>
    </Tooltip>
  )
}
