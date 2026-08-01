import { useEffect, useState } from "react"
import { getFraySupervisorStatus, isDevFrayBuild } from "../api/restart.ts"

// "Is Fray itself a development build?" — the one answer every dev-only affordance in the UI asks for.
//
// It is a RUNTIME question, not a build-time one, and that distinction is the whole reason this file
// exists. `import.meta.env.DEV` is a Vite compile-time constant that is true only under `vite dev`
// middleware; fray-dev's ordinary route builds an immutable artifact and serves the Vite PRODUCTION
// bundle, where Vite statically replaces it with `false` and drops the guarded code entirely. So a
// verb gated that way was absent from every build the maintainer actually ran — see
// components/RestartWorkerButton.tsx, which shipped invisible for exactly that reason. The launcher
// is the only thing that knows, and it reports it on the supervisor status.
//
// ONE request per page load, however many components ask: the probe is a module-level promise, and
// its resolved value is cached for every later caller (including components that mount afterwards).
// That matters because the caller is a thread-footer verb and the queue renders one footer per card.
//
// Deliberately NOT read off the valtio store that App's supervisor poll already fills: the standalone
// `/full` thread page renders INSTEAD of <App />, so that poll never runs there, and the verb would be
// missing on exactly one surface for no reason a reader could see.
let cached: boolean | null = null
let probe: Promise<boolean> | null = null

/** Test seam: drop the cached answer so a case can probe again. */
export function resetDevFrayBuildProbe(): void {
  cached = null
  probe = null
}

export function probeDevFrayBuild(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached)
  probe ??= getFraySupervisorStatus()
    .then((status) => {
      // `null` is NOT an answer — getFraySupervisorStatus folds an unreachable supervisor, a
      // non-protocol reply and a SPA HTML fallback all into it, and it never rejects. Read it as
      // "ask again", not as "production": the supervisor is legitimately unreachable while it
      // restarts, and caching that window as false would hide the verb for the rest of the page's
      // life. Report false meanwhile, because a dev-only affordance must never appear on no evidence.
      if (status === null) return false
      cached = isDevFrayBuild(status)
      return cached
    })
    .catch(() => false)
    .finally(() => { probe = null })
  return probe
}

/**
 * Starts false and flips true once the supervisor answers. A dev-only control therefore appears a
 * beat after first paint rather than being present in the initial HTML — the same shape as the
 * Restart Fray button in the status bar, and the correct bias: an affordance that must never show up
 * in a published Fray should render only once the server has affirmatively said "development build".
 */
export function useDevFrayBuild(): boolean {
  const [dev, setDev] = useState(cached === true)
  useEffect(() => {
    if (cached !== null) {
      setDev(cached)
      return
    }
    let active = true
    void probeDevFrayBuild().then((value) => { if (active) setDev(value) })
    return () => { active = false }
  }, [])
  return dev
}
