export interface RestartFrayResult {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
}

export interface FraySupervisorStatus {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
  artifactDigest?: string
  /** Only fray-dev's durable supervisor can safely build and promote a replacement artifact. */
  updateRestart?: boolean
  /**
   * Is a newer artifact actually available? Sent only by a launcher that can answer it (the registry
   * launcher, which knows its own version and the registry's latest). ABSENT means "cannot tell —
   * assume yes", which is right for fray-dev, where an update rebuilds from source and is always
   * meaningful.
   */
  updateAvailable?: boolean
}

/** Wakes the app-level status monitor immediately after a control action is accepted. */
export const FRAY_SUPERVISOR_STATUS_WAKE_EVENT = "fray:supervisor-status-wake"

/** Every supervisor that speaks the control protocol can restart its disposable application child. */
export function canRestart(status: FraySupervisorStatus | null): boolean {
  return status !== null
}

/**
 * Should this button offer to UPDATE rather than merely restart?
 *
 * Two conditions, and conflating them was a real shipped bug: `updateRestart` says the verb is WIRED
 * (legacy/static supervisors omit it, so their recovery endpoint is never surfaced as an update), while
 * `updateAvailable` says a newer artifact actually EXISTS. With only the first, a fully up-to-date
 * production Fray still read "Update Fray" and a click reinstalled its own version and restarted the
 * app for nothing — measured end-to-end against the published package.
 *
 * `updateAvailable` absent ⇒ treated as available, so fray-dev (which can always rebuild from source,
 * and has no "already current" notion) is unchanged.
 */
export function canUpdateRestart(status: FraySupervisorStatus | null): boolean {
  return status?.updateRestart === true && status.updateAvailable !== false
}

export async function getFraySupervisorStatus(fetcher: typeof fetch = fetch): Promise<FraySupervisorStatus | null> {
  try {
    const response = await fetcher("/_fray/control/status", { headers: { "cache-control": "no-store" } })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null
    const status = await response.json() as Partial<FraySupervisorStatus>
    return status.protocol === 1 && (status.state === "ready" || status.state === "restarting" || status.state === "failed") ? status as FraySupervisorStatus : null
  } catch {
    return null
  }
}

async function requestFrayRestartAction(path: "/_fray/control/restart" | "/_fray/control/update-restart", fetcher: typeof fetch): Promise<RestartFrayResult> {
  const response = await fetcher(path, {
    method: "POST",
    headers: { "cache-control": "no-store" },
  })
  let result: RestartFrayResult | undefined
  try {
    result = await response.json() as RestartFrayResult
  } catch {
    // Keep the failure leg actionable even if an old/non-supervised server returned HTML.
  }
  if (!response.headers.get("content-type")?.includes("application/json") || !result || result.protocol !== 1 || (result.state !== "ready" && result.state !== "restarting" && result.state !== "failed")) {
    throw new Error("Fray restart controls are unavailable for this server")
  }
  if (!response.ok) {
    throw new Error(result.message ?? `Restart request failed (${response.status})`)
  }
  if (result.state === "failed") throw new Error(result.message ?? "Fray did not become ready")
  return result
}

/** Restarts the currently promoted artifact through any protocol-compatible supervisor. */
export function requestFrayRestart(fetcher: typeof fetch = fetch): Promise<RestartFrayResult> {
  return requestFrayRestartAction("/_fray/control/restart", fetcher)
}

/** Reaches the durable fray-dev supervisor, never the disposable Fray application child directly. */
export function requestFrayUpdateRestart(fetcher: typeof fetch = fetch): Promise<RestartFrayResult> {
  return requestFrayRestartAction("/_fray/control/update-restart", fetcher)
}
