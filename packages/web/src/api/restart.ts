export interface RestartFrizzResult {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
}

export interface FrizzSupervisorStatus {
  protocol: 1
  state: "ready" | "restarting" | "failed"
  message?: string
  artifactDigest?: string
  /** Only frizz-dev's durable supervisor can safely build and promote a replacement artifact. */
  updateRestart?: boolean
  /**
   * Is a newer artifact actually available? Sent only by a launcher that can answer it (the registry
   * launcher, which knows its own version and the registry's latest). ABSENT means "cannot tell —
   * assume yes", which is right for frizz-dev, where an update rebuilds from source and is always
   * meaningful.
   */
  updateAvailable?: boolean
  /**
   * Is this Frizz a DEVELOPMENT build — launched from a source checkout by `frizz-dev` or `pnpm dev`,
   * rather than the published `frizz` bin? Sent only when true, so absent means "no".
   *
   * The client cannot answer this itself. `import.meta.env.DEV` is a Vite COMPILE-TIME constant, true
   * only under `vite dev` middleware — and frizz-dev's ordinary route builds an immutable artifact and
   * serves the Vite PRODUCTION bundle, where it is statically `false`. Gating a dev-only affordance on
   * it therefore eliminated that affordance from the build the maintainer runs all day. Only the
   * launcher knows, so it says so here.
   */
  dev?: boolean
}

/** Wakes the app-level status monitor immediately after a control action is accepted. */
export const FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT = "frizz:supervisor-status-wake"

/** Every supervisor that speaks the control protocol can restart its disposable application child. */
export function canRestart(status: FrizzSupervisorStatus | null): boolean {
  return status !== null
}

/**
 * Should this button offer to UPDATE rather than merely restart?
 *
 * Two conditions, and conflating them was a real shipped bug: `updateRestart` says the verb is WIRED
 * (legacy/static supervisors omit it, so their recovery endpoint is never surfaced as an update), while
 * `updateAvailable` says a newer artifact actually EXISTS. With only the first, a fully up-to-date
 * production Frizz still read "Update Frizz" and a click reinstalled its own version and restarted the
 * app for nothing — measured end-to-end against the published package.
 *
 * `updateAvailable` absent ⇒ treated as available, so frizz-dev (which can always rebuild from source,
 * and has no "already current" notion) is unchanged.
 */
export function canUpdateRestart(status: FrizzSupervisorStatus | null): boolean {
  return status?.updateRestart === true && status.updateAvailable !== false
}

/**
 * Is Frizz itself running as a development build? Deliberately strict: an unreachable supervisor, a
 * legacy one that predates the field, and a published Frizz all read the same — NOT a dev build — so a
 * dev-only verb can never appear for someone who merely installed Frizz.
 */
export function isDevFrizzBuild(status: FrizzSupervisorStatus | null): boolean {
  return status?.dev === true
}

export async function getFrizzSupervisorStatus(fetcher: typeof fetch = fetch): Promise<FrizzSupervisorStatus | null> {
  try {
    const response = await fetcher("/_frizz/control/status", { headers: { "cache-control": "no-store" } })
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null
    const status = await response.json() as Partial<FrizzSupervisorStatus>
    return status.protocol === 1 && (status.state === "ready" || status.state === "restarting" || status.state === "failed") ? status as FrizzSupervisorStatus : null
  } catch {
    return null
  }
}

async function requestFrizzRestartAction(path: "/_frizz/control/restart" | "/_frizz/control/update-restart", fetcher: typeof fetch): Promise<RestartFrizzResult> {
  const response = await fetcher(path, {
    method: "POST",
    headers: { "cache-control": "no-store" },
  })
  let result: RestartFrizzResult | undefined
  try {
    result = await response.json() as RestartFrizzResult
  } catch {
    // Keep the failure leg actionable even if an old/non-supervised server returned HTML.
  }
  if (!response.headers.get("content-type")?.includes("application/json") || !result || result.protocol !== 1 || (result.state !== "ready" && result.state !== "restarting" && result.state !== "failed")) {
    throw new Error("Frizz restart controls are unavailable for this server")
  }
  if (!response.ok) {
    throw new Error(result.message ?? `Restart request failed (${response.status})`)
  }
  if (result.state === "failed") throw new Error(result.message ?? "Frizz did not become ready")
  return result
}

/** Restarts the currently promoted artifact through any protocol-compatible supervisor. */
export function requestFrizzRestart(fetcher: typeof fetch = fetch): Promise<RestartFrizzResult> {
  return requestFrizzRestartAction("/_frizz/control/restart", fetcher)
}

/** Reaches the durable frizz-dev supervisor, never the disposable Frizz application child directly. */
export function requestFrizzUpdateRestart(fetcher: typeof fetch = fetch): Promise<RestartFrizzResult> {
  return requestFrizzRestartAction("/_frizz/control/update-restart", fetcher)
}
