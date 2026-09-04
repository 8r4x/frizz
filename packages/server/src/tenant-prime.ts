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
// The pass is SERIAL, and the pacing is MEASURED rather than guessed. It shipped with a flat 3s head
// start and a flat 1.5s between projects, which put the last square of an 11-project rail 18 seconds
// after boot — and the maintainer rightly asked what the holdup was. Measured on an 11-project stack
// (seven empty, two ~30-thread boards, one 800-thread board with 9.4MB of transcripts), cold tail
// cache:
//
//     empty 11-17ms · 29 threads 37ms · 35 threads 41ms · 800 threads 220ms · TEN PROJECTS: 390ms
//
// The whole pass was 390ms of work behind 16,500ms of waiting. So the delays below are what it costs to
// stay POLITE, and nothing else: one activation is the atomic block (11-220ms, the top end being
// tailer.start's PRIME_BUDGET_MS ceiling), and the pause after it hands the loop back so a request that
// arrived mid-pass is served now rather than after the remaining squares.
//
// The gap TRACKS THE LAST ACTIVATION, the way the tailer's own scheduleTick tracks its last tick: an
// empty project costs a 25ms pause, a big one earns a breather its own size, and nothing pathological
// can hold the pass open for more than PRIME_MAX_GAP_MS. That 50% duty ceiling is also what phases the
// freshly started tailers apart, which the flat gap was really for.
//
// THE 11-220ms FIGURES ABOVE ARE THE 2026-08 MEASUREMENT AND NO LONGER DESCRIBE THIS MACHINE. Twelve
// projects on the maintainer's 2026-09-02 boot took 111-1000ms each, and the pass ran for 18.5s of wall
// clock against 5.7s of summed activation — the difference being the tailer and everything else
// contending for the same loop. See PRIME_MAX_GAP_MS for what that broke and what was done about it.
// The deeper cost is upstream: `tailer.start()`'s first tick does per-row work BEFORE its budget check
// (one SQLite retiredOps query per row, plus a stat per transcript), so a big board's activation is not
// bounded by PRIME_BUDGET_MS the way the third bullet above assumes. Pacing politely around that is a
// mitigation; making the prime itself bounded is the fix, and it is not done here.

/**
 * A head start for the launching project, whose board is the page the operator is actually waiting for.
 * Long enough to matter on first paint, far too short to be a wait anyone sees.
 */
const PRIME_START_DELAY_MS = 250
/** Floor on the pause between projects: even a 13ms activation yields the loop for a beat. */
const PRIME_MIN_GAP_MS = 25
/**
 * …and the ceiling, so one slow activation cannot pace the whole rail.
 *
 * IT WAS 250ms, AND THAT SILENTLY STOPPED MEANING A 50% DUTY CYCLE. The figure was chosen against the
 * 11-220ms activations measured above, where clamping at 250 never bound anything. Activations are no
 * longer that cheap: the maintainer's own boot log of 2026-09-02 opened twelve projects at 111, 156,
 * 187, 237, 315, 349, 459, 545, 677, 706, 985 and 1000ms. At the old ceiling a 1000ms activation earned
 * a 250ms breather — an 80% duty cycle, not 50% — and the loop stayed saturated for the whole pass. The
 * board RPC measured a 1.19s mean and a 5.60s max while priming ran, against 10ms and 427ms with it off.
 * That is the "long time to load initially": the page the operator is staring at waits behind the
 * squares they are not looking at.
 *
 * 1500ms clears the slowest activation on that log with headroom, so the ratio below is honoured for
 * every project actually observed, while still bounding a pathological one. The pass takes longer in
 * wall-clock and that is the correct trade — the LAUNCHING project is already open and served before
 * this starts, so what the extra seconds buy is a responsive UI while the other badges fill in.
 */
const PRIME_MAX_GAP_MS = 1_500

/** The pause after an activation that took `tookMs` — a 50% duty cycle, clamped at both ends. */
function gapAfter(tookMs: number): number {
  return Math.min(PRIME_MAX_GAP_MS, Math.max(PRIME_MIN_GAP_MS, tookMs))
}

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
  /** Injected by tests, so a timing assertion is not a race against a loaded runner. */
  monotonicNow?: () => number
  /** Injected by tests; the default is the interruptible timer `stop()` cuts short. */
  delay?: (ms: number) => Promise<void>
  startDelayMs?: number
  /** Pins the pause between projects; the default TRACKS the last activation (see gapAfter). */
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
  /** How long each of `opened` took, in ms, same order. Logged, and what the pacing is tuned against. */
  tookMs: number[]
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
    const result: TenantPrimeResult = { opened: [], skipped: [], failed: [], tookMs: [] }
    await delay(deps.startDelayMs ?? PRIME_START_DELAY_MS)
    // How long the PREVIOUS activation took, which is the pause the next one waits. Undefined until the
    // first project is open — so a run of skips (already-open, stale, served elsewhere) costs nothing.
    let lastTookMs: number | undefined
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
      if (lastTookMs !== undefined) await delay(deps.gapMs ?? gapAfter(lastTookMs))
      if (stopped) break
      try {
        const startedAt = deps.monotonicNow?.() ?? performance.now()
        const opened = await deps.activate(project)
        const tookMs = Math.round((deps.monotonicNow?.() ?? performance.now()) - startedAt)
        lastTookMs = tookMs
        if (opened === undefined) result.failed.push(entry.id)
        else {
          result.opened.push(entry.id)
          result.tookMs.push(tookMs)
          log(`opened ${project.name} in ${tookMs}ms`)
        }
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
      return { opened: [], skipped: [], failed: [], tookMs: [] }
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
