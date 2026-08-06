import type { AppContext, ContextOptions } from "./context.ts"
import { projectContextCleanups } from "./context.ts"
import type { Project } from "./project.ts"
import { log as frizzLog } from "./logging.ts"

// ONE PROCESS, N PROJECTS.
//
// `startServer` used to build exactly one AppContext and tear it down at process exit. That is the
// assumption plans/singleton-frizz.md §4 item 2 calls out: there was no way to open a second project,
// and no way to close one without closing the server.
//
// This is the keyed map that replaces it — projectId → AppContext, with activate/deactivate. The
// AppContext itself needed no changes to get here: it is already a per-call object, documented as
// "derived once at boot and threaded through", with zero `process.chdir`, zero `process.env`
// mutation, and every module-level cache keyed by absolute path or genuinely machine-global.
//
// THE ERROR BOUNDARY LIVES HERE (§4 item 3). Per-subsystem guards are already good — tailer ticks,
// board rebuilds, `fs.watch` setup and transcript discovery are each individually caught. What was
// missing is a catch at the AppContext SEAM, so one project's corrupt `ui.db` or malformed `.frizz/`
// cannot take down every other project in a shared process. `activate` therefore reports and returns
// undefined rather than throwing: a project that will not open is one dead card, not an outage.

export interface TenantMapOptions {
  /** Injected so a test can build a context without the real one. Defaults to `createContext`. */
  createContext: (opts: ContextOptions) => AppContext | Promise<AppContext>
  /** Extra options every tenant's context is built with (claudeBin, codexBin, …). */
  contextOptions?: Omit<ContextOptions, "project">
  onError?: (project: Project, error: unknown) => void
}

export interface TenantMap {
  /** Open a project, or return the already-open one. `undefined` means it failed and was reported. */
  activate(project: Project): Promise<AppContext | undefined>
  get(projectId: string): AppContext | undefined
  /** Close one project's resources while every other project keeps serving. */
  deactivate(projectId: string): Promise<boolean>
  /** Every open project, in activation order. */
  active(): { project: Project; ctx: AppContext }[]
  closeAll(): Promise<void>
}

export function createTenantMap(options: TenantMapOptions): TenantMap {
  const open = new Map<string, { project: Project; ctx: AppContext }>()
  // An activation in flight, so two concurrent openings of one project build ONE context rather than
  // two racing SQLite handles onto the same file.
  const opening = new Map<string, Promise<AppContext | undefined>>()

  const report = (project: Project, error: unknown): void => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    frizzLog.error("tenants", `project ${project.name} (${project.id}) failed to open: ${detail}`)
    options.onError?.(project, error)
  }

  async function activate(project: Project): Promise<AppContext | undefined> {
    const already = open.get(project.id)
    if (already) return already.ctx
    const inFlight = opening.get(project.id)
    if (inFlight) return inFlight

    const attempt = (async () => {
      try {
        const ctx = await options.createContext({ ...options.contextOptions, project })
        open.set(project.id, { project, ctx })
        return ctx
      } catch (error) {
        // THE SEAM. createContext already rolls its own partial resources back; what must not happen
        // is the failure propagating out and ending a process that is serving other projects.
        report(project, error)
        return undefined
      } finally {
        opening.delete(project.id)
      }
    })()
    opening.set(project.id, attempt)
    return attempt
  }

  async function deactivate(projectId: string): Promise<boolean> {
    const entry = open.get(projectId)
    if (!entry) return false
    // Drop it from the map FIRST: a deactivation that fails half way must not leave a context
    // reachable that has already had its storage closed.
    open.delete(projectId)
    const cleanups = projectContextCleanups(() => entry.ctx)
    // The same order the process barrier uses, minus the transports the server owns.
    for (const [name, run] of [
      ["tailer", cleanups.tailer],
      ["login utility", cleanups.loginUtility],
      ["subscriptions", cleanups.subscriptions],
      ["scheduler", cleanups.scheduler],
      ["board", cleanups.board],
      ["Codex app-server bridge", cleanups.bridge],
      ["storage", cleanups.storage],
    ] as const) {
      try {
        await run()
      } catch (error) {
        // Keep going. A stuck subsystem must not strand the ones after it — storage above all, which
        // is the one whose handle actually has to be released.
        const detail = error instanceof Error ? error.message : String(error)
        frizzLog.error("tenants", `project ${entry.project.name}: ${name} did not close cleanly: ${detail}`)
      }
    }
    return true
  }

  return {
    activate,
    get: (projectId) => open.get(projectId)?.ctx,
    deactivate,
    active: () => [...open.values()],
    async closeAll() {
      for (const id of [...open.keys()]) await deactivate(id)
    },
  }
}
