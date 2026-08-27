import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import Database from "./sqlite.ts"
import { CODEX_APP_SERVER_TABLES, ensureCodexAppServerSchema } from "./backend/codex-app-server.ts"
import { frizzPaths, frizzRoots } from "./frizz-paths.ts"
import { INTERACTION_TABLES, ensureInteractionSchema } from "./interaction-store.ts"
import { migrateLegacyProjectDatabase } from "./legacy-project-db.ts"
import { log as frizzLog } from "./logging.ts"
import { STORAGE_TABLES, ensureStorageSchema } from "./storage.ts"
import { TAIL_STATE_TABLES, ensureTailStateSchema } from "./tail-cache.ts"
import { WAKE_DELIVERY_TABLES, ensureWakeDeliverySchema } from "./wake-store.ts"

// ONE DATABASE FOR THE MACHINE — `<data>/ui.db` (2026-08-27).
//
// Frizz kept one SQLite file per project, `<data>/projects/<id>/ui.db`, from the day it stored
// anything: each server served one repo and owned that repo's file. The singleton (one server, every
// project — see ARCHITECTURE.md) kept the files and opened all of them, which is how a bad migration
// on 2026-08-27 could leave seven of fifty-four unopenable at once, with the launch project among
// them and the restart aborted. The maintainer's call was that the per-project file was a vestige of
// the one-server-per-repo era and should go. This module is the one file that replaced them: opened
// ONCE per process at boot, handed to every tenant, and closed after the last tenant.
//
// THE IMPORT. On every open, each `<data>/projects/<id>/ui.db` still on disk is brought up to the
// legacy stack's final shape (legacy-project-db.ts), ATTACHed, copied table by table into this file
// under that project's id, and renamed to `ui.db.imported` — never deleted, so the pre-unification
// state is one rename away for as long as the operator keeps the directory. Idempotent twice over:
// every copy is INSERT OR IGNORE against the unified keys, so a crash between the commit and the
// rename re-imports nothing on the next boot, and the rename is what makes the next boot skip the
// file at all. A file that will not import is logged and LEFT IN PLACE, to be retried next boot;
// it never aborts the open, because the other fifty-three projects were fine.
//
// The column list is the INTERSECTION of the two tables' columns, minus project_id, which the copy
// supplies. A column the legacy stack never grew is left at the unified default; a column the unified
// schema retired (the codex meta `singleton`, the pre-merge heartbeat_* pair) is simply not copied.

export interface FrizzDatabase {
  readonly db: Database
  readonly path: string
  /** Every legacy file imported on this open, by project id, with the rows copied. */
  readonly imported: { projectId: string; rows: number }[]
  /** Delete every row a project has in every table — the database half of removing a project. */
  purgeProject(projectId: string): void
  close(): void
}

export interface OpenFrizzDatabaseOptions {
  /**
   * THE LAUNCHING PROJECT'S STATE DIR, and the way production names the file: `<data>/projects/<id>`
   * puts it at `<data>/ui.db`, beside the projects it imports. Derived rather than defaulted from
   * `homedir()` for the reason frizz-paths.ts gives for the server address — and re-learned here the
   * hard way (2026-08-27): a `startServer` test with a fake project and the real HOME imported all
   * fifty-four of the maintainer's project files into `~/.frizz/ui.db` and renamed them out from
   * under the live server. A state dir that is NOT `<root>/projects/<id>` (a test's temp dir) gets a
   * PRIVATE file inside it and no legacy scan at all.
   */
  stateDir?: string
  /** A sandbox home whose data root holds the file — frizz-db.test.ts. Ignored when stateDir is set. */
  home?: string
  /** Override the file itself — tests and the sandbox stacks. `home` still decides the legacy scan. */
  path?: string
  /** Skip the legacy scan entirely (a throwaway file with no projects directory to read). */
  importLegacy?: boolean
}

/** Every table that lives in the unified file, in the order the import copies them. */
export const FRIZZ_DB_TABLES: readonly string[] = [
  ...STORAGE_TABLES,
  ...WAKE_DELIVERY_TABLES,
  ...TAIL_STATE_TABLES,
  ...CODEX_APP_SERVER_TABLES,
  ...INTERACTION_TABLES,
]

/** Where the file lives and which directory the legacy scan reads — see OpenFrizzDatabaseOptions. */
export function frizzDatabaseLocation(options: Pick<OpenFrizzDatabaseOptions, "stateDir" | "home" | "path">): { path: string; projectsDir: string | undefined } {
  if (options.stateDir !== undefined) {
    const projectsDir = dirname(options.stateDir)
    if (basename(projectsDir) === "projects") {
      return { path: options.path ?? join(dirname(projectsDir), "ui.db"), projectsDir }
    }
    return { path: options.path ?? join(options.stateDir, "ui.db"), projectsDir: undefined }
  }
  const data = options.home ? frizzPaths({ home: options.home }).data : frizzRoots().data
  return { path: options.path ?? join(data, "ui.db"), projectsDir: join(data, "projects") }
}

export function frizzDatabasePath(home?: string): string {
  return frizzDatabaseLocation({ home }).path
}

/** Every schema owner's DDL, idempotent, in one place — the importer needs all of it up front. */
export function ensureFrizzSchema(db: Database): void {
  ensureStorageSchema(db)
  ensureWakeDeliverySchema(db)
  ensureTailStateSchema(db)
  ensureCodexAppServerSchema(db)
  ensureInteractionSchema(db)
}

export function openFrizzDatabase(options: OpenFrizzDatabaseOptions = {}): FrizzDatabase {
  const { path, projectsDir } = frizzDatabaseLocation(options)
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma("busy_timeout = 5000")
  db.pragma("journal_mode = WAL")
  ensureFrizzSchema(db)

  const imported: { projectId: string; rows: number }[] = []
  if (options.importLegacy !== false && projectsDir !== undefined) {
    for (const projectId of legacyProjectIds(projectsDir)) {
      const legacyPath = join(projectsDir, projectId, "ui.db")
      try {
        const rows = importLegacyProject(db, projectId, legacyPath)
        imported.push({ projectId, rows })
        frizzLog.info("frizz-db", `imported ${projectId} (${rows} rows) from ${legacyPath}`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        frizzLog.error("frizz-db", `${projectId}: could not import ${legacyPath}, left in place for the next boot: ${detail}`)
      }
    }
  }

  const purge = db.transaction((projectId: string) => {
    for (const table of FRIZZ_DB_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId)
    }
  })

  let closed = false
  return {
    db,
    path,
    imported,
    purgeProject: (projectId) => purge.immediate(projectId),
    close: () => {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

function legacyProjectIds(projectsDir: string): string[] {
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir)
    .filter((name) => {
      const file = join(projectsDir, name, "ui.db")
      try {
        return statSync(file).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

function tableColumns(db: Database, schema: string, table: string): string[] {
  return db.prepare<[], { name: string }>(`PRAGMA ${schema}.table_info(${table})`).all().map((c) => c.name)
}

/**
 * Copy one legacy file's rows in, then retire the file. Returns the rows copied.
 *
 * The legacy stack runs FIRST, on the file's own connection, and that connection closes before the
 * ATTACH: closing checkpoints the WAL, so the attached read sees every committed row and leaves no
 * `-wal`/`-shm` sidecar behind to rename.
 */
function importLegacyProject(db: Database, projectId: string, legacyPath: string): number {
  const legacy = new Database(legacyPath)
  try {
    legacy.pragma("busy_timeout = 5000")
    migrateLegacyProjectDatabase(legacy)
  } finally {
    legacy.close()
  }
  db.prepare("ATTACH DATABASE ? AS legacy").run(legacyPath)
  let rows = 0
  try {
    const legacyTables = new Set(
      db.prepare<[], { name: string }>("SELECT name FROM legacy.sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    )
    const copy = db.transaction(() => {
      for (const table of FRIZZ_DB_TABLES) {
        if (!legacyTables.has(table)) continue
        const target = new Set(tableColumns(db, "main", table))
        const columns = tableColumns(db, "legacy", table).filter((c) => c !== "project_id" && target.has(c))
        if (columns.length === 0) continue
        const list = columns.map((c) => `"${c}"`).join(", ")
        rows += db.prepare(
          `INSERT OR IGNORE INTO main."${table}" (project_id, ${list}) SELECT ?, ${list} FROM legacy."${table}"`,
        ).run(projectId).changes
      }
    })
    copy.immediate()
  } finally {
    db.exec("DETACH DATABASE legacy")
  }
  renameSync(legacyPath, `${legacyPath}.imported`)
  return rows
}
