// A durable, append-only record of one Claude broker daemon's lifecycle, written BY THE DAEMON.
//
// The Claude twin of codex-app-server-diagnostics.ts, and it exists for the same reason that file
// gives: the one time death forensics were needed, the bridge's diagnostics were wired to nothing and
// a daemon death was an opaque "the thread went quiet."
//
// The broker had that gap twice over. `onDiagnostic` is plumbed all the way through
// claude-broker-client.ts, but the bridge never supplied a handler — so `{kind:"lifecycle",
// phase:"crashed", message}`, the single most useful line there is, went nowhere. And the daemon only
// wrote diagnostics to an ATTACHED client (`if (client) write(...)`, unlike events, which are
// backlogged), so a crash during a fray restart — exactly when a detached daemon is most likely to
// die unobserved — was guaranteed lost.
//
// So the DAEMON owns this file, not fray. A death is precisely when the process may be seconds from
// gone: an in-memory backlog dies with it and a relay needs a listener that a restarting fray does not
// have. Writing from inside the daemon is the only version that survives the event it is recording.
//
// Deliberately synchronous and best-effort — a logging failure must never perturb the session.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ClaudeDiagnostic } from "./claude-agent-sdk-protocol.ts"

// Rotate at 4 MB and keep exactly one previous file — forensics want recent history, not an archive.
const MAX_BYTES = 4 * 1024 * 1024

export function claudeBrokerDiagnosticLogPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "claude-broker", `${sessionId}.diagnostics.log`)
}

export interface ClaudeBrokerDiagnosticRecord {
  at: string
  daemonPid: number
  generation: string
  diagnostic: ClaudeDiagnostic
}

/** Build the daemon's own diagnostic writer. Unlike the codex sink this keeps `stderr`: for Claude
 *  that carries the CLI's actual error text (already credential-redacted and capped at 4 KB by the
 *  protocol), which IS the forensics — not a byte-count ping. Rotation bounds the cost. */
export function createClaudeBrokerDiagnosticWriter(
  path: string,
  meta: { daemonPid: number; generation: string },
  now: () => Date = () => new Date(),
): (diagnostic: ClaudeDiagnostic) => void {
  let ensured = false
  return (diagnostic) => {
    try {
      if (!ensured) { mkdirSync(join(path, ".."), { recursive: true }); ensured = true }
      try { if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`) } catch { /* first write */ }
      const record: ClaudeBrokerDiagnosticRecord = { at: now().toISOString(), ...meta, diagnostic }
      appendFileSync(path, `${JSON.stringify(record)}\n`)
    } catch {
      // best-effort: never let observability perturb the session it is observing
    }
  }
}

/** Read back a session's diagnostics, newest last. Missing/garbage lines are skipped, never thrown —
 *  a truncated final line is the NORMAL shape of a log whose writer was killed mid-append. */
export function readClaudeBrokerDiagnostics(stateDir: string, sessionId: string): ClaudeBrokerDiagnosticRecord[] {
  const out: ClaudeBrokerDiagnosticRecord[] = []
  for (const path of [`${claudeBrokerDiagnosticLogPath(stateDir, sessionId)}.1`, claudeBrokerDiagnosticLogPath(stateDir, sessionId)]) {
    let text: string
    try { text = readFileSync(path, "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as ClaudeBrokerDiagnosticRecord
        if (parsed && typeof parsed.at === "string" && parsed.diagnostic) out.push(parsed)
      } catch { /* truncated tail of a killed writer */ }
    }
  }
  return out
}
