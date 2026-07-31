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

/**
 * Why a broker daemon — and the claude process and every in-flight sub-agent inside it — ended.
 *
 * The codex daemon has carried this vocabulary since the 2026-07-24 six-sub-agent loss
 * (`app-server-exited-code-*`, `self-collected-*`, `signal-*`, `idle-timeout`); the broker's
 * `shutdown()` wrote nothing at all, so a daemon collected by its 6h idle timer, terminated by a
 * signal, or self-collected for unreachability all vanished identically and fray could only report the
 * generic "the thread went quiet". These are the named causes, one per exit path in
 * claude-agent-broker.ts:
 *
 *  - `fray-requested`               — RunningBroker.close(); fray asked for it.
 *  - `signal-SIG*`                  — SIGTERM/SIGINT/SIGHUP, i.e. killBroker or the operator/OS.
 *  - `session-stream-ended`         — the SDK's event stream ended normally (claude exited).
 *  - `session-stream-broken`        — EVENT_ERROR_TOLERANCE consecutive stream errors; genuinely broken.
 *  - `event-pump-failed`            — the pump itself threw outside the per-event guard.
 *  - `idle-timeout`                 — nobody attached for IDLE_EXIT_MS.
 *  - `self-collected-record-reassigned` — unattached and the record no longer names us (a successor
 *                                    stole it, or a sweep removed it): undiscoverable, so collected.
 *  - `socket-listen-failed`         — the listen() that makes this daemon reachable never succeeded.
 */
export type ClaudeBrokerExitReason =
  | "fray-requested"
  | "signal-SIGTERM"
  | "signal-SIGINT"
  | "signal-SIGHUP"
  | "session-stream-ended"
  | "session-stream-broken"
  | "event-pump-failed"
  | "idle-timeout"
  | "self-collected-record-reassigned"
  | "socket-listen-failed"

/** An exit breadcrumb, appended to the SAME log as the diagnostics so a death and the stderr that
 *  preceded it read as one story. It carries `exit` rather than `diagnostic`, which is exactly what
 *  keeps `readClaudeBrokerDiagnostics` (it requires `.diagnostic`) unchanged by this addition. */
export interface ClaudeBrokerExitRecord {
  at: string
  daemonPid: number
  generation: string
  exit: { reason: ClaudeBrokerExitReason; detail?: string }
}

/** One synchronous, best-effort, rotating append. Every writer below funnels through here, so the
 *  "never throw, never perturb the session" guarantee is stated once. */
function appendRecord(path: string, record: unknown): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true })
    try { if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`) } catch { /* first write */ }
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  } catch {
    // best-effort: never let observability perturb the session it is observing
  }
}

/** Build the daemon's own diagnostic writer. Unlike the codex sink this keeps `stderr`: for Claude
 *  that carries the CLI's actual error text (already credential-redacted and capped at 4 KB by the
 *  protocol), which IS the forensics — not a byte-count ping. Rotation bounds the cost. */
export function createClaudeBrokerDiagnosticWriter(
  path: string,
  meta: { daemonPid: number; generation: string },
  now: () => Date = () => new Date(),
): (diagnostic: ClaudeDiagnostic) => void {
  return (diagnostic) => {
    const record: ClaudeBrokerDiagnosticRecord = { at: now().toISOString(), ...meta, diagnostic }
    appendRecord(path, record)
  }
}

/** Build the daemon's exit-breadcrumb writer.
 *
 *  Called from inside every terminal path in claude-agent-broker.ts, with the process seconds (or
 *  microseconds — a signal handler) from gone. Synchronous for that reason, and best-effort for the
 *  reason every informational path in this subsystem is: a logging failure must never be what takes a
 *  session down. It is deliberately callable more than once — a signal arriving mid-`shutdown()` should
 *  leave BOTH marks, and a reader takes the newest. */
export function createClaudeBrokerExitWriter(
  path: string,
  meta: { daemonPid: number; generation: string },
  now: () => Date = () => new Date(),
): (reason: ClaudeBrokerExitReason, detail?: string) => void {
  return (reason, detail) => {
    const record: ClaudeBrokerExitRecord = {
      at: now().toISOString(),
      ...meta,
      exit: detail ? { reason, detail } : { reason },
    }
    appendRecord(path, record)
  }
}

/** The most recent exit this session's log records, or null when it has never named one.
 *
 *  The log is per SESSION, not per daemon, so a resumed thread's file can hold several deaths across
 *  generations — the newest is the one that just happened, and `generation` lets a caller confirm it
 *  describes the daemon it actually lost. Never gates anything: pure post-hoc attribution for what the
 *  bridge would otherwise see as an absent record and report as "the thread went quiet." */
export function readClaudeBrokerExit(stateDir: string, sessionId: string): ClaudeBrokerExitRecord | null {
  let newest: ClaudeBrokerExitRecord | null = null
  for (const path of [`${claudeBrokerDiagnosticLogPath(stateDir, sessionId)}.1`, claudeBrokerDiagnosticLogPath(stateDir, sessionId)]) {
    let text: string
    try { text = readFileSync(path, "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as Partial<ClaudeBrokerExitRecord>
        if (typeof parsed?.at !== "string" || typeof parsed.exit?.reason !== "string") continue
        newest = {
          at: parsed.at,
          daemonPid: typeof parsed.daemonPid === "number" ? parsed.daemonPid : 0,
          generation: typeof parsed.generation === "string" ? parsed.generation : "",
          exit: parsed.exit as ClaudeBrokerExitRecord["exit"],
        }
      } catch { /* truncated tail of a killed writer */ }
    }
  }
  return newest
}

/** One operator-facing line for a recorded death. `unknown` is itself informative — it means the
 *  daemon died without reaching any of its own exit paths (SIGKILL, OOM, a machine reboot). */
export function describeClaudeBrokerExit(record: ClaudeBrokerExitRecord | null): string {
  if (!record) return "the broker daemon is gone and left no exit record (killed outright, or it predates exit breadcrumbs)"
  const detail = record.exit.detail ? `: ${record.exit.detail}` : ""
  return `the broker daemon exited (${record.exit.reason}${detail}) at ${record.at}`
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
