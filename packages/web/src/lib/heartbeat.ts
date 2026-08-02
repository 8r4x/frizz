// Formatting for a worker's recurring wake. The interval arrives in SECONDS (that is the unit the
// worker chooses in `mcp__fray__heartbeat`), and every surface that names it — the rail tooltip, the
// lifecycle footer's pause/play control — renders it the same way through here.

/** "15 min" / "2 hr" / "90s". Whole units only: a heartbeat lands at the thread's next REST, so a
 * cadence printed to the second would promise a precision the delivery does not have. */
export function formatHeartbeatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  // One decimal only when it changes the reading: "1.5 hr" is useful, "2.0 hr" is noise.
  const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
  return `${rendered} hr`
}
