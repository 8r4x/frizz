// A durable, append-only record of the Codex app-server bridge's lifecycle events, per project.
//
// This exists because the one time it was needed — the 2026-07-24 loss of six sub-agents when a daemon
// died mid-turn — there was no way to tell WHY: the bridge's diagnostics were wired to nothing, so a
// daemon death was an opaque "the thread went quiet." Every event that bears on a mid-turn death
// (disconnects, the fresh-daemon replacement + its attributed cause, version-skew reforks, dropped
// event streams, auto-resume nudges) lands here so the next occurrence is diagnosable from a file
// instead of a guess.
//
// Deliberately synchronous and best-effort: a death is exactly when the process may be seconds from
// gone, so the write must land before it, and a logging failure must never perturb the bridge.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CodexAppServerDiagnostic } from "./codex-app-server.ts"

// Rotate at 4 MB and keep exactly one previous file. Forensics need recent history, not a permanent
// archive; an unbounded log on a busy dev box is its own outage.
const MAX_BYTES = 4 * 1024 * 1024

export function codexDiagnosticLogPath(stateDir: string, projectId: string): string {
  return join(stateDir, "codex-app-server", `${projectId}.diagnostics.log`)
}

/** Build the persistent `diagnostic` sink for a project's bridge. Drops the high-frequency `stderr`
 *  byte-count pings (not death forensics, and they would drown the signal); records everything else. */
export function createCodexDiagnosticSink(
  stateDir: string,
  projectId: string,
  now: () => Date = () => new Date(),
): (event: CodexAppServerDiagnostic) => void {
  const dir = join(stateDir, "codex-app-server")
  const path = codexDiagnosticLogPath(stateDir, projectId)
  let ensured = false
  return (event) => {
    if (event.event === "stderr") return
    try {
      if (!ensured) { mkdirSync(dir, { recursive: true }); ensured = true }
      try { if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`) } catch {}
      appendFileSync(path, `${JSON.stringify({ at: now().toISOString(), ...event })}\n`)
    } catch {
      // best-effort: never let observability perturb the bridge
    }
  }
}
