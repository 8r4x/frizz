import type { Project } from "./project.ts"
import { log as frizzLog } from "./logging.ts"

// ── OPENING EVERY REGISTERED PROJECT, IN THE BACKGROUND, AFTER BOOT ────────────────────────────────
//
// Tenants activate LAZILY: `routeToTenant` opens a project the first time a request addresses it, so
// a project nobody has visited since boot has no board. That is cheap and it was the right default —
// but the rail's badge is a BOARD FACT (`projectsQueueCounts` counts `queuedThread` rows off each open
// project's snapshot), so the consequence the operator actually experienced was having to click into
// every square before any of them would tell them how many threads were waiting (2026-08-26: "I
// currently need to click into every project before the badge shows up with the number of rested
// threads!"). A cue you have to visit each project to see is not a cue.
//
// So the server opens the rest of them itself, once, shortly after it starts serving. Three facts make
// that affordable rather than reckless, and they are the whole argument for doing it this way:
//
//   * THERE IS NO EVICTION. `deactivate` is called from shutdown and nowhere else, so a project stays
//     open for the life of the server once anything opens it. The operator visiting all their projects
//     — which is exactly what they are doing today — already reaches this steady state. Priming only
//     reaches it sooner, and without the clicking.
//   * THE COLD PRIME IS ALREADY BOUNDED. `tailer.start()` folds at most MAX_PRIME_ROWS_PER_TICK rows
//     inside PRIME_BUDGET_MS (tailer.ts) and hands the rest to later ticks, so activating a large board
//     costs ~200ms here instead of the 1.5-7.5s it cost before that bound existed.
//   * SCHEDULERS FOR EVERY REGISTERED PROJECT IS THE DESIGN, not a side effect. plans/singleton-frizz.md
//     §4 settles it: timers, `awaiting` wakes, snooze expiry, PR watches and limit auto-resume must not
//     go quiet for a project you are not looking at. Lazy activation left them dead until you opened it.
//
// The pass is SERIAL and spaced on purpose. Activations are cheap individually and the primes that
// follow them are not free — each priming tailer wants ~200ms every ~1.2s until its board is folded —
// so opening ten projects at once would hand the loop a burst nobody asked for while the operator is
// still waiting for the page they DID ask for. One at a time, a beat apart, gets the badges up within
// seconds and never spikes.
//
// It is best-effort throughout: a project that will not open is one missing badge, reported and stepped
// over, never a failed boot.

/** Wait before opening the first extra project, so the launching project's own board renders first. */
const PRIME_START_DELAY_MS = 3_000
/** …and between projects, so N cold primes stagger instead of stacking. */
const PRIME_GAP_MS = 1_500

/** The registry shape this needs — `listProjects()` entries, rail order. */
export interface PrimeCandidate {
  id: string
  path: string
  /** The directory is gone; `listProjects` derives it. Nothing to open. */
  stale: boolean
}

export interface TenantPrimeDeps {
  /** Every registered project, in the order the rail draws them. */
  list: () => readonly PrimeCandidate[]
  /** Already open here — the launching project, and anything a request has opened since. */
  isOpen: (projectId: string) => boolean
  /** Registry entry → Project WITHOUT re-resolving identity (projectFromRegistryEntry). */
  toProject: (entry: PrimeCandidate) => Project
  /**
   * The tenant map's `activate`. It reports its own failures and resolves `undefined` for them, so
   * this pass reads the result rather than catching — see tenants.ts, where the seam lives.
   */
  activate: (project: Project) => Promise<unknown>
  /**
   * The pid of another live Frizz already serving this project, if there is one (project-launch.ts).
   * Checked HERE as well as inside activation so the ordinary migration state — a per-project server
   * still running beside the singleton — logs one line per project instead of an error and a stack.
   */
  servedElsewhere?: (project: Project) => number | undefined
  /** Injected by tests; the default is the interruptible timer `stop()` cuts short. */
  delay?: (ms: number) => Promise<void>
  startDelayMs?: number
  gapMs?: number
  log?: (message: string) => void
}

export interface TenantPrimeResult {
  /** Project ids this pass opened. */
  opened: string[]
  /** Already open, stale, or served by another live Frizz. */
  skipped: string[]
  /** Tried and would not open — reported by the tenant seam, one dead card each. */
  failed: string[]
}

export interface TenantPrimeRun {
  /** Resolves when the pass finishes or is stopped. Never rejects. */
  done: Promise<TenantPrimeResult>
  /**
   * Stop before the next project. Shutdown calls this and then awaits `done`, so anything the pass
   * opened is in the tenant map BEFORE the map is drained — a project activated after that drain would
   * be a leaked SQLite handle and a tailer nothing ever stops.
   *
   * It cuts the wait between projects short, but it cannot interrupt an activation already in flight;
   * that one finishes and lands in the map, which is what makes the drain complete.
   */
  stop: () => void
}

export function startTenantPrime(deps: TenantPrimeDeps): TenantPrimeRun {
  const log = deps.log ?? ((message: string) => frizzLog.info("tenants", message))
  let stopped = false
  let interrupt: (() => void) | undefined

  const defaultDelay = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve()
      const finish = () => {
        clearTimeout(timer)
        interrupt = undefined
        resolve()
      }
      // Unref'd: a server with nothing else to do must still be able to exit while this is pending.
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      interrupt = finish
    })

  const delay = deps.delay ?? defaultDelay

  const run = async (): Promise<TenantPrimeResult> => {
    const result: TenantPrimeResult = { opened: [], skipped: [], failed: [] }
    await delay(deps.startDelayMs ?? PRIME_START_DELAY_MS)
    let first = true
    for (const entry of deps.list()) {
      if (stopped) break
      if (entry.stale || deps.isOpen(entry.id)) {
        result.skipped.push(entry.id)
        continue
      }
      let project: Project
      try {
        project = deps.toProject(entry)
      } catch (error) {
        result.failed.push(entry.id)
        log(`could not resolve ${entry.path} to prime it: ${detail(error)}`)
        continue
      }
      const other = deps.servedElsewhere?.(project)
      if (other !== undefined) {
        result.skipped.push(entry.id)
        log(`${project.name} is served by another Frizz (pid ${other}) — leaving it closed here`)
        continue
      }
      if (!first) await delay(deps.gapMs ?? PRIME_GAP_MS)
      first = false
      if (stopped) break
      try {
        if ((await deps.activate(project)) === undefined) result.failed.push(entry.id)
        else result.opened.push(entry.id)
      } catch (error) {
        // activate() is documented not to throw. Belt and braces: this pass is a floating promise, and
        // an unhandled rejection out of it would take down a server that is otherwise perfectly healthy.
        result.failed.push(entry.id)
        log(`priming ${project.name} threw: ${detail(error)}`)
      }
    }
    if (result.opened.length > 0) log(`opened ${result.opened.length} more project(s) so their queue badges are live`)
    return result
  }

  return {
    done: run().catch((error) => {
      log(`priming pass failed: ${detail(error)}`)
      return { opened: [], skipped: [], failed: [] }
    }),
    stop: () => {
      stopped = true
      interrupt?.()
    },
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
