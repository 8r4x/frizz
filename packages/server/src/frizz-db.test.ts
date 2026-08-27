import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { FRIZZ_DB_TABLES, frizzDatabaseLocation, frizzDatabasePath, openFrizzDatabase } from "./frizz-db.ts"
import Database from "./sqlite.ts"
import { createStorage } from "./storage.ts"
import { threadIdentityName } from "@frizz/shared"

// A pre-unification project file, in the shape the LAST per-project build left it — plus two of the
// older shapes the legacy stack has to bring forward first (a `tmux_name` column, a `fray-` thread
// name, the retired thread_watch with no expires_at). Written raw, because the code that used to
// write these files is gone: this is what was on the maintainer's disk on 2026-08-27.
function writeLegacyProject(home: string, projectId: string, slugs: string[]): string {
  const dir = join(home, ".frizz", "projects", projectId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "ui.db")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session (
      slug TEXT PRIMARY KEY, session_id TEXT NOT NULL, tmux_name TEXT NOT NULL, spawned_at TEXT NOT NULL,
      last_read_at TEXT, unread INTEGER NOT NULL DEFAULT 0, exited INTEGER NOT NULL DEFAULT 0,
      title TEXT, heartbeat_prompt TEXT, heartbeat_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE thread_watch (id TEXT PRIMARY KEY, thread_slug TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER);
    CREATE TABLE thread_timer (
      id TEXT PRIMARY KEY, thread_slug TEXT NOT NULL, prompt TEXT NOT NULL, fire_at INTEGER NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, settled_at INTEGER
    );
    CREATE TABLE wake_delivery (
      id TEXT PRIMARY KEY, thread_slug TEXT NOT NULL, session_id TEXT NOT NULL, fence_id TEXT NOT NULL,
      hint_key TEXT NOT NULL, message TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_at INTEGER, terminal_at INTEGER
    );
  `)
  for (const slug of slugs) {
    db.prepare("INSERT INTO session (slug, session_id, tmux_name, spawned_at, title, heartbeat_prompt, heartbeat_enabled) VALUES (?, ?, ?, ?, ?, ?, 1)")
      .run(slug, `sess-${projectId}-${slug}`, `fray-${slug}`, "2026-08-01T00:00:00.000Z", `Title of ${slug}`, "keep going")
    db.prepare("INSERT INTO thread_timer VALUES (?, ?, ?, ?, 'armed', 1, NULL)").run(`timer-${projectId}-${slug}`, slug, "ping", 9_999_999_999_999)
    db.prepare("INSERT INTO wake_delivery (id, thread_slug, session_id, fence_id, hint_key, message, reason, state, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'f', 'h', 'm', 'r', 'delivered', 1, 1, 1)")
      .run(`wake-${projectId}-${slug}`, slug, `sess-${projectId}-${slug}`)
  }
  db.prepare("INSERT INTO thread_watch VALUES ('w1', ?, 'pr', 'acme/app#1', 'fired', 1, 2)").run(slugs[0])
  db.prepare("INSERT INTO settings VALUES ('font', '\"mono\"')").run()
  db.close()
  return path
}

test("opening the unified database imports every legacy project file under its own id and retires it", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-db-"))
  const a = writeLegacyProject(home, "project-a", ["shared-slug", "only-in-a"])
  const b = writeLegacyProject(home, "project-b", ["shared-slug"])
  // A directory with no file is a project that never stored anything: skipped, not an error.
  mkdirSync(join(home, ".frizz", "projects", "project-empty"), { recursive: true })

  const opened = openFrizzDatabase({ home })
  try {
    assert.equal(opened.path, frizzDatabasePath(home))
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-a", "project-b"])
    assert.ok(opened.imported.every((i) => i.rows > 0))
    assert.equal(existsSync(a), false, "the legacy file is renamed once its rows are in")
    assert.ok(existsSync(`${a}.imported`), "…and kept, never deleted")
    assert.ok(existsSync(`${b}.imported`))

    const storageA = createStorage(opened.db, "project-a")
    const storageB = createStorage(opened.db, "project-b")
    assert.deepEqual(storageA.allSessions().map((r) => r.slug).sort(), ["only-in-a", "shared-slug"])
    assert.deepEqual(storageB.allSessions().map((r) => r.slug), ["shared-slug"])
    // The legacy stack ran before the copy: the rebrand rename, the column rename and the two-feature
    // merge all landed on the file first, so the unified row already has the current shape.
    const row = storageA.getSession("shared-slug")!
    assert.equal(row.thread_name, threadIdentityName("shared-slug"))
    assert.equal(row.session_id, "sess-project-a-shared-slug")
    assert.equal(row.recurring_prompt, "keep going")
    assert.equal(row.recurring_on_schedule, 1)
    assert.equal(storageB.getSession("shared-slug")!.session_id, "sess-project-b-shared-slug")
    assert.equal(storageA.getSetting("font"), "mono")
    assert.equal(storageB.listThreadTimers("shared-slug").length, 1)
    // The retired thread_watch (no expires_at) was dropped, not carried across into the new shape.
    assert.deepEqual(storageA.listThreadWatches("shared-slug"), [])
    assert.equal(
      opened.db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM wake_delivery WHERE project_id = ?").get("project-a")!.n,
      2,
    )
    storageA.close()
    storageB.close()
  } finally {
    opened.close()
  }

  // The second open finds nothing to import and every row is still there.
  const again = openFrizzDatabase({ home })
  try {
    assert.deepEqual(again.imported, [])
    const storageA = createStorage(again.db, "project-a")
    assert.equal(storageA.allSessions().length, 2)
    storageA.close()
  } finally {
    again.close()
  }
})

test("a legacy file that will not import is left in place and does not abort the open", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-db-bad-"))
  const good = writeLegacyProject(home, "project-good", ["fine"])
  const badDir = join(home, ".frizz", "projects", "project-bad")
  mkdirSync(badDir, { recursive: true })
  const bad = join(badDir, "ui.db")
  writeFileSync(bad, "this is not a sqlite file, and never was")

  const opened = openFrizzDatabase({ home })
  try {
    assert.deepEqual(opened.imported.map((i) => i.projectId), ["project-good"])
    assert.ok(existsSync(`${good}.imported`))
    assert.ok(existsSync(bad), "the unreadable file is left for the next boot, not renamed or deleted")
    assert.equal(existsSync(`${bad}.imported`), false)
  } finally {
    opened.close()
  }
})

test("purging a project deletes its rows in every table and nobody else's", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-db-purge-"))
  writeLegacyProject(home, "project-a", ["one"])
  writeLegacyProject(home, "project-b", ["one"])
  const opened = openFrizzDatabase({ home })
  try {
    opened.purgeProject("project-a")
    for (const table of FRIZZ_DB_TABLES) {
      const count = (projectId: string) =>
        opened.db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId)!.n
      assert.equal(count("project-a"), 0, `${table} still holds project-a rows`)
    }
    const storageB = createStorage(opened.db, "project-b")
    assert.equal(storageB.allSessions().length, 1)
    assert.equal(storageB.listThreadTimers("one").length, 1)
    storageB.close()
  } finally {
    opened.close()
  }
})

test("a context-owned private file works without the shared database and skips the legacy scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-db-private-"))
  const opened = openFrizzDatabase({ path: join(dir, "ui.db"), importLegacy: false })
  try {
    assert.deepEqual(opened.imported, [])
    const storage = createStorage(opened.db, "p")
    assert.deepEqual(storage.allSessions(), [])
    storage.close()
  } finally {
    opened.close()
  }
})

// THE RULE THAT KEEPS A TEST OFF THE REAL HOME. On 2026-08-27 a startServer test with a fake project
// under the real HOME imported the maintainer's fifty-four live project files and renamed them out from
// under the running server. The file's location is now derived from the launching project's state dir,
// and a state dir that is not `<root>/projects/<id>` gets a private file and no scan.
test("the database location follows the launch project's state dir, and a non-canonical one is private", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-db-location-"))
  assert.deepEqual(
    frizzDatabaseLocation({ stateDir: join(root, "projects", "abc") }),
    { path: join(root, "ui.db"), projectsDir: join(root, "projects") },
  )
  const stray = join(root, "some-test-state")
  assert.deepEqual(frizzDatabaseLocation({ stateDir: stray }), { path: join(stray, "ui.db"), projectsDir: undefined })

  // And a boot from such a state dir imports nothing even when a sibling directory looks like a project.
  mkdirSync(join(root, "other", "ui.db-not-a-project"), { recursive: true })
  writeFileSync(join(root, "other", "ui.db"), "")
  mkdirSync(stray, { recursive: true })
  const opened = openFrizzDatabase({ stateDir: stray })
  try {
    assert.deepEqual(opened.imported, [])
    assert.equal(opened.path, join(stray, "ui.db"))
    assert.ok(existsSync(join(root, "other", "ui.db")), "a stray sibling file is never touched")
  } finally {
    opened.close()
  }
})
