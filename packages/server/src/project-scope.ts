import type Database from "./sqlite.ts"
import { namedParameters, type Statement } from "./sqlite.ts"

// ONE DATABASE, EVERY PROJECT — the seam that keeps a project's rows its own (2026-08-27).
//
// Frizz kept one SQLite file per project until this landed: `~/.frizz/projects/<id>/ui.db`, fifty-four
// of them on the maintainer's machine, each carrying its own copy of every table and its own unversioned
// migration state. A bad migration (the retired thread_watch table coming back with a new shape) left
// seven of them unopenable at once and the launch project among them, which aborted a restart; the
// maintainer's verdict was that the per-project file was a vestige of the one-server-per-repo era and
// should go. So every table now carries `project_id`, one file holds every project, and this module is
// how a tenant addresses only its own rows without every call site learning that.
//
// A ProjectScope wraps the SHARED connection for ONE project. Its `prepare` REFUSES a statement that
// does not name `@project_id` — at prepare time, so a forgotten scope fails the first test that builds
// the storage rather than silently reading another project's thread — and the Statement it returns
// binds the project id itself: merged into a named bag, or supplied as a bag ahead of positional values
// (sqlite.ts binds both). Call sites keep their existing arguments.
//
// WHAT THE ASSERTION CANNOT SEE: a subquery. `WHERE slug = @slug AND NOT EXISTS (SELECT 1 FROM session
// WHERE slug = @slug)` names @project_id nowhere and would be refused; the same statement with the
// outer WHERE scoped and the inner one not would pass, and the inner one would then see every project.
// storage.test.ts's cross-project isolation case is the net for that — every method is run against one
// project with an identical twin in another, and the twin's rows are compared before and after.
//
// `writes` counts every `run()` through this scope. It is what storage.ts's memoised whole-table read
// invalidates on instead of `total_changes()`: the connection is shared, so that counter moves for
// every project's writes and would re-read this project's rows whenever ANY project wrote. A write to
// this project's rows can only come through this scope (or through a raw `db.exec`, which the boot
// repairs are — and they run before any cache exists), so the count is exact for the one connection.

export interface ProjectScope {
  readonly projectId: string
  /** The shared connection. Raw access — a statement prepared here is NOT scoped; prefer `prepare`. */
  readonly db: Database
  /** A statement bound to this project. Throws unless `sql` names `@project_id`. The first type
   *  parameter is the caller's own bindings, spelled the way Database.prepare spells them. */
  prepare<BindParameters extends any[] | object = any[], Row = any>(sql: string): Statement<Row>
  /** How many `run()` calls this scope has made — see the note above. */
  writes(): number
}

function isBag(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Date)
  )
}

export function scopeDatabase(db: Database, projectId: string): ProjectScope {
  if (typeof projectId !== "string" || projectId.length === 0) throw new Error("a project scope needs a project id")
  let writes = 0
  const bind = (params: any[]): any[] =>
    params.length >= 1 && isBag(params[0])
      ? [{ ...(params[0] as Record<string, unknown>), project_id: projectId }, ...params.slice(1)]
      : [{ project_id: projectId }, ...params]
  return {
    projectId,
    db,
    prepare<BindParameters extends any[] | object = any[], Row = any>(sql: string): Statement<Row> {
      if (!namedParameters(sql).includes("project_id")) {
        throw new Error(`unscoped statement prepared through a project scope: ${sql.trim().slice(0, 120)}`)
      }
      const statement = db.prepare<any[], Row>(sql)
      return {
        run: (...params: any[]) => {
          writes++
          return statement.run(...bind(params))
        },
        get: (...params: any[]) => statement.get(...bind(params)),
        all: (...params: any[]) => statement.all(...bind(params)),
      }
    },
    writes: () => writes,
  }
}
