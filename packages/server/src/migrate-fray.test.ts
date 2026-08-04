import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { frizzPaths } from "./frizz-paths.ts"
import { migrateFrayGlobalRoots, migrateFrayProjectDir, migrateFrayProjectId } from "./migrate-fray.ts"
import { Database } from "./sqlite.ts"

type PlanOptions = { platform: NodeJS.Platform; home: string; env?: NodeJS.ProcessEnv }

/** Record the moves instead of touching a filesystem, so the platform matrix is testable anywhere. */
function planFor(present: string[], options: PlanOptions) {
  const set = new Set(present)
  const moved: Array<[string, string]> = []
  migrateFrayGlobalRoots({
    ...options,
    env: options.env ?? {},
    exists: (path) => set.has(path),
    rename: (from, to) => {
      set.delete(from)
      set.add(to)
      moved.push([from, to])
    },
    // Stubbed so a colliding pair cannot reach the real filesystem; `mergesFor` is what inspects it.
    merge: () => false,
  })
  return moved
}

/** The same plan, reporting the pairs FOLDED IN rather than renamed. */
function mergesFor(present: string[], options: PlanOptions) {
  const set = new Set(present)
  const merged: Array<[string, string]> = []
  migrateFrayGlobalRoots({
    ...options,
    env: options.env ?? {},
    exists: (path) => set.has(path),
    rename: () => {},
    merge: (from, to) => {
      merged.push([from, to])
      return true
    },
  })
  return merged
}

test("a legacy ~/.fray becomes ~/.frizz, and that is the only move a legacy install makes", () => {
  const moved = planFor(["/home/x/.fray"], { platform: "linux", home: "/home/x" })
  assert.deepEqual(moved, [["/home/x/.fray", "/home/x/.frizz"]])
})

test("a machine that never ran Fray is left completely alone", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    assert.deepEqual(planFor([], { platform, home: "/home/x" }), [], platform)
  }
})

// Frizz's own state always wins a collision. Anything else would let a stale fray tree clobber real
// threads — but the tree is FOLDED IN rather than skipped, because a fray-era process that is still
// running recreates `~/.fray` after the migration and keeps writing real state into it.
test("an existing frizz root is merged into, never renamed over", () => {
  const where = { platform: "linux" as const, home: "/home/x" }
  assert.deepEqual(planFor(["/home/x/.fray", "/home/x/.frizz"], where), [], "nothing is renamed")
  assert.deepEqual(mergesFor(["/home/x/.fray", "/home/x/.frizz"], where), [["/home/x/.fray", "/home/x/.frizz"]])
})

test("each platform's own roots are adopted", () => {
  assert.deepEqual(
    planFor(
      ["/Users/x/Library/Application Support/Fray", "/Users/x/Library/Caches/Fray"],
      { platform: "darwin", home: "/Users/x" },
    ),
    [
      ["/Users/x/Library/Application Support/Fray", "/Users/x/Library/Application Support/Frizz"],
      ["/Users/x/Library/Caches/Fray", "/Users/x/Library/Caches/Frizz"],
    ],
  )

  assert.deepEqual(
    planFor(
      ["/home/x/.local/share/fray", "/home/x/.local/state/fray", "/home/x/.cache/fray"],
      { platform: "linux", home: "/home/x" },
    ),
    [
      ["/home/x/.local/share/fray", "/home/x/.local/share/frizz"],
      ["/home/x/.local/state/fray", "/home/x/.local/state/frizz"],
      ["/home/x/.cache/fray", "/home/x/.cache/frizz"],
    ],
  )

  // Built with join() on both sides: a POSIX test host renders these with "/", a Windows one with
  // "\", and the module uses join() too — so the pair matches on either.
  const local = "C:\\Local"
  assert.deepEqual(
    planFor([join(local, "Fray")], { platform: "win32", home: "C:\\Users\\x", env: { LOCALAPPDATA: local } }),
    [[join(local, "Fray"), join(local, "Frizz")]],
  )
})

// An explicitly SET XDG variable wins in frizz-paths.ts on every platform, so its tree needs adopting
// even on macOS, where it sits alongside the Application Support one.
test("an explicit XDG tree is adopted too, on any platform", () => {
  const moved = planFor(["/xdg/data/fray"], {
    platform: "darwin",
    home: "/Users/x",
    env: { XDG_DATA_HOME: "/xdg/data" },
  })
  assert.deepEqual(moved, [["/xdg/data/fray", "/xdg/data/frizz"]])
})

test("a relative XDG value is ignored, exactly as frizz-paths ignores it", () => {
  assert.deepEqual(planFor(["relative/fray"], { platform: "linux", home: "/home/x", env: { XDG_DATA_HOME: "relative" } }), [])
})

test("a failed rename is swallowed so one unmovable tree cannot block boot", () => {
  const moved: Array<[string, string]> = []
  migrateFrayGlobalRoots({
    platform: "linux",
    home: "/home/x",
    env: {},
    exists: (path) => path === "/home/x/.fray" || path === "/home/x/.cache/fray",
    rename: (from, to) => {
      if (from === "/home/x/.fray") throw new Error("EXDEV")
      moved.push([from, to])
    },
  })
  assert.deepEqual(moved, [["/home/x/.cache/fray", "/home/x/.cache/frizz"]])
})

// The end the migration exists for: real bytes, and frizz-paths resolving onto them afterwards.
test("real threads survive the move and frizz-paths then resolves onto them", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-migrate-"))
  try {
    mkdirSync(join(home, ".fray", "projects", "p1"), { recursive: true })
    writeFileSync(join(home, ".fray", "projects", "p1", "ui.db"), "threads")

    assert.equal(frizzPaths({ home, platform: "linux", env: {} }).legacy, false, "no frizz root yet")

    const moved = migrateFrayGlobalRoots({ home, platform: "linux", env: {} })
    assert.equal(moved.length, 1)
    assert.equal(existsSync(join(home, ".fray")), false, "the old tree is gone, not copied")
    assert.equal(readFileSync(join(home, ".frizz", "projects", "p1", "ui.db"), "utf8"), "threads")

    const paths = frizzPaths({ home, platform: "linux", env: {} })
    assert.equal(paths.legacy, true, "the moved tree now reads as the legacy collapse root")
    assert.equal(paths.data, join(home, ".frizz"))

    // Idempotent: a second boot finds nothing to do.
    assert.deepEqual(migrateFrayGlobalRoots({ home, platform: "linux", env: {} }), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a project's .fray directory is adopted as .frizz, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-migrate-project-"))
  try {
    mkdirSync(join(dir, ".fray", "threads", "s1"), { recursive: true })
    writeFileSync(join(dir, ".fray", "threads", "s1", "scratch.md"), "# notes")

    assert.equal(migrateFrayProjectDir(dir), true)
    assert.equal(readFileSync(join(dir, ".frizz", "threads", "s1", "scratch.md"), "utf8"), "# notes")
    assert.equal(existsSync(join(dir, ".fray")), false)

    assert.equal(migrateFrayProjectDir(dir), false, "idempotent")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a project with no .fray at all is untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-migrate-project-none-"))
  try {
    assert.equal(migrateFrayProjectDir(dir), false)
    assert.equal(existsSync(join(dir, ".frizz")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// THE CASE THAT ACTUALLY HAPPENS. The worker plugin is served out of the repo, so a live worker's
// scratchpad hook writes `.frizz/threads/<sid>/.scratchpad-state.json` the moment the checkout is
// rebranded — while the server that dispatched it is still the old build writing to `.fray`. Skipping
// on "target exists" would strand every real scratchpad in `.fray` behind three bytes of bookkeeping.
test("a stub .frizz left by a live worker is merged into, not treated as a reason to give up", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-migrate-project-both-"))
  try {
    mkdirSync(join(dir, ".fray", "threads", "live"), { recursive: true })
    writeFileSync(join(dir, ".fray", "threads", "live", "scratch.md"), "# the real notes")
    writeFileSync(join(dir, ".fray", "threads", "live", ".scratchpad-state.json"), `{"old":true}`)
    mkdirSync(join(dir, ".fray", "threads", "archived"), { recursive: true })
    writeFileSync(join(dir, ".fray", "threads", "archived", "scratch.md"), "# older thread")
    mkdirSync(join(dir, ".fray", "plans"), { recursive: true })
    writeFileSync(join(dir, ".fray", "plans", "a.md"), "# plan")

    // What the live hook already wrote under the new name.
    mkdirSync(join(dir, ".frizz", "threads", "live"), { recursive: true })
    writeFileSync(join(dir, ".frizz", "threads", "live", ".scratchpad-state.json"), `{"new":true}`)

    assert.equal(migrateFrayProjectDir(dir), true)

    assert.equal(readFileSync(join(dir, ".frizz", "threads", "live", "scratch.md"), "utf8"), "# the real notes")
    assert.equal(readFileSync(join(dir, ".frizz", "threads", "archived", "scratch.md"), "utf8"), "# older thread")
    assert.equal(readFileSync(join(dir, ".frizz", "plans", "a.md"), "utf8"), "# plan")
    // Frizz's own copy wins the one genuine collision, and the fray one is never destroyed.
    assert.equal(readFileSync(join(dir, ".frizz", "threads", "live", ".scratchpad-state.json"), "utf8"), `{"new":true}`)
    assert.equal(readFileSync(join(dir, ".fray", "threads", "live", ".scratchpad-state.json"), "utf8"), `{"old":true}`)
    // Everything that did NOT collide is gone from the old tree.
    assert.equal(existsSync(join(dir, ".fray", "threads", "archived")), false)
    assert.equal(existsSync(join(dir, ".fray", "plans")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a fully redundant .fray is folded away completely", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-migrate-project-empty-"))
  try {
    mkdirSync(join(dir, ".fray", "threads"), { recursive: true })
    mkdirSync(join(dir, ".frizz", "threads"), { recursive: true })
    writeFileSync(join(dir, ".frizz", "threads", "keep"), "real")

    migrateFrayProjectDir(dir)
    assert.equal(readFileSync(join(dir, ".frizz", "threads", "keep"), "utf8"), "real")
    assert.equal(existsSync(join(dir, ".fray")), false, "nothing was left behind, so the old tree goes")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// dispatch.ts refuses a symlinked `.frizz` because it would redirect Frizz's writes outside the repo.
// Adopting a symlinked `.fray` into that name would smuggle the same thing past the check.
test("a symlinked .fray is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-migrate-symlink-"))
  try {
    mkdirSync(join(dir, "elsewhere"))
    symlinkSync(join(dir, "elsewhere"), join(dir, ".fray"))
    assert.equal(migrateFrayProjectDir(dir), false)
    assert.equal(existsSync(join(dir, ".frizz")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The other half of "still-running fray-era processes": the global root comes BACK. Renaming it away
// does not stop a server that resolved `~/.fray` at boot, so the tree reappears holding state written
// after the migration ran. This is the real sequence, replayed.
test("a ~/.fray recreated after the migration is folded in on the next open", () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-migrate-reappear-"))
  try {
    mkdirSync(join(home, ".fray", "projects", "p1"), { recursive: true })
    writeFileSync(join(home, ".fray", "projects", "p1", "ui.db"), "the board")
    assert.equal(migrateFrayGlobalRoots({ home, platform: "linux", env: {} }).length, 1)

    // A fray-era process that never noticed, writing on for the rest of its session.
    mkdirSync(join(home, ".fray", "projects", "p1", "claude-broker"), { recursive: true })
    writeFileSync(join(home, ".fray", "projects", "p1", "claude-broker", "t.log"), "diagnostics")
    writeFileSync(join(home, ".fray", "projects", "p1", "ui.db"), "a stale empty board")

    assert.deepEqual(migrateFrayGlobalRoots({ home, platform: "linux", env: {} }), [
      { from: join(home, ".fray"), to: join(home, ".frizz") },
    ])
    assert.equal(readFileSync(join(home, ".frizz", "projects", "p1", "claude-broker", "t.log"), "utf8"), "diagnostics")
    // The live board is NOT clobbered by the stale one the old process left behind.
    assert.equal(readFileSync(join(home, ".frizz", "projects", "p1", "ui.db"), "utf8"), "the board")
    assert.equal(readFileSync(join(home, ".fray", "projects", "p1", "ui.db"), "utf8"), "a stale empty board")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ─── the project id ───────────────────────────────────────────────────────── */

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

/** A real repository, because every path under test shells out to real `git config`. */
function repoIn(home: string, name = "repo"): string {
  const dir = join(home, name)
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q")
  return dir
}

function idIn(dir: string, key: string, scope: string[] = ["--local"]): string | undefined {
  try {
    return git(dir, "config", ...scope, "--get", key)
  } catch {
    return undefined
  }
}

/** A project state dir under `<home>/.frizz` (which frizzPaths collapses onto), holding `rows` threads. */
function seedBoard(home: string, id: string, rows: number): void {
  const dir = join(home, ".frizz", "projects", id)
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, "ui.db"))
  try {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)")
    for (let i = 0; i < rows; i++) db.prepare("INSERT INTO session (id) VALUES (?)").run(`s${i}`)
  } finally {
    db.close()
  }
}

const FRAY_ID = "029a30af-f126-40e3-b04c-d80e74e3e090"
const MINTED_ID = "95b232ee-eaba-4303-97cc-743944d0778c"

function withHome(name: string, run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), `frizz-migrate-${name}-`))
  // Make the legacy root exist so frizzPaths collapses onto it and projectStateDir is predictable
  // on every platform, not just the one running the suite.
  mkdirSync(join(home, ".frizz"), { recursive: true })
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("a fray-era repo keeps its board: fray.id becomes frizz.id", () => {
  withHome("id", (home) => {
    const dir = repoIn(home)
    git(dir, "config", "--local", "--add", "fray.id", FRAY_ID)
    seedBoard(home, FRAY_ID, 392)

    assert.deepEqual(migrateFrayProjectId(dir, { home }), [{ id: FRAY_ID }])
    assert.equal(idIn(dir, "frizz.id"), FRAY_ID)
    // The old pointer STAYS. It costs nothing, and it is the only thing that makes a board split off
    // by an older build recoverable later — which is exactly the repair below.
    assert.equal(idIn(dir, "fray.id"), FRAY_ID)

    assert.deepEqual(migrateFrayProjectId(dir, { home }), [], "idempotent")
    assert.equal(idIn(dir, "frizz.id"), FRAY_ID)
  })
})

test("a repo that never ran Fray is left alone", () => {
  withHome("id-none", (home) => {
    const dir = repoIn(home)
    assert.deepEqual(migrateFrayProjectId(dir, { home }), [])
    assert.equal(idIn(dir, "frizz.id"), undefined, "no id is invented; resolveGitProjectIdentity mints")
  })
})

// THE REGRESSION THIS EXISTS FOR. A build that migrated the trees but not the id opened a fray-era
// repo, found no `frizz.id`, minted one, and served an empty board beside 392 real threads.
test("a board split off by an earlier open is reunited with its threads", () => {
  withHome("id-repair", (home) => {
    const dir = repoIn(home)
    git(dir, "config", "--local", "--add", "fray.id", FRAY_ID)
    git(dir, "config", "--local", "--add", "frizz.id", MINTED_ID)
    seedBoard(home, FRAY_ID, 392)
    seedBoard(home, MINTED_ID, 0) // opened once, so it has a schema — and no threads

    assert.deepEqual(migrateFrayProjectId(dir, { home }), [{ id: FRAY_ID, replaced: MINTED_ID }])
    assert.equal(idIn(dir, "frizz.id"), FRAY_ID)
    assert.deepEqual(migrateFrayProjectId(dir, { home }), [], "and stays repaired")
  })
})

test("a minted project that never opened a board at all is displaced too", () => {
  withHome("id-repair-nodb", (home) => {
    const dir = repoIn(home)
    git(dir, "config", "--local", "--add", "fray.id", FRAY_ID)
    git(dir, "config", "--local", "--add", "frizz.id", MINTED_ID)
    seedBoard(home, FRAY_ID, 240)

    assert.deepEqual(migrateFrayProjectId(dir, { home }), [{ id: FRAY_ID, replaced: MINTED_ID }])
  })
})

// The other direction, and the one that must never be wrong: a frizz board with real threads on it is
// somebody's actual work. A stale `fray.id` beside it is not a reason to throw that away.
test("a frizz board that HAS threads is never displaced", () => {
  withHome("id-keep", (home) => {
    const dir = repoIn(home)
    git(dir, "config", "--local", "--add", "fray.id", FRAY_ID)
    git(dir, "config", "--local", "--add", "frizz.id", MINTED_ID)
    seedBoard(home, FRAY_ID, 392)
    seedBoard(home, MINTED_ID, 3)

    assert.deepEqual(migrateFrayProjectId(dir, { home }), [])
    assert.equal(idIn(dir, "frizz.id"), MINTED_ID)
  })
})

// An unreadable database is not an empty one. Guessing here would discard a board over a lock.
test("a frizz board that cannot be read counts as occupied", () => {
  withHome("id-unreadable", (home) => {
    const dir = repoIn(home)
    git(dir, "config", "--local", "--add", "fray.id", FRAY_ID)
    git(dir, "config", "--local", "--add", "frizz.id", MINTED_ID)
    mkdirSync(join(home, ".frizz", "projects", MINTED_ID), { recursive: true })
    writeFileSync(join(home, ".frizz", "projects", MINTED_ID, "ui.db"), "not a database")

    assert.deepEqual(migrateFrayProjectId(dir, { home }), [])
    assert.equal(idIn(dir, "frizz.id"), MINTED_ID)
  })
})

test("an id that is not exactly one UUID is never adopted", () => {
  withHome("id-invalid", (home) => {
    const dir = repoIn(home)
    git(dir, "config", "--local", "--add", "fray.id", "not-a-uuid")
    assert.deepEqual(migrateFrayProjectId(dir, { home }), [])
    assert.equal(idIn(dir, "frizz.id"), undefined)

    // Two values is a repo that is already broken; picking one would decide which board it keeps.
    const two = repoIn(home, "two")
    git(two, "config", "--local", "--add", "fray.id", FRAY_ID)
    git(two, "config", "--local", "--add", "fray.id", MINTED_ID)
    assert.deepEqual(migrateFrayProjectId(two, { home }), [])
    assert.equal(idIn(two, "frizz.id"), undefined)
  })
})

// A linked worktree keeps its own id in its own administrative directory, under the old brand's file
// name. Both halves have to arrive or resolvedIdentity() rejects the pair and mints anyway.
test("a linked worktree adopts both its repository id and its own", () => {
  withHome("id-worktree", (home) => {
    const dir = repoIn(home)
    git(dir, "config", "--local", "--add", "fray.id", FRAY_ID)
    writeFileSync(join(dir, "f.txt"), "x")
    git(dir, "-c", "user.email=t@e.co", "-c", "user.name=t", "add", "f.txt")
    git(dir, "-c", "user.email=t@e.co", "-c", "user.name=t", "commit", "-qm", "init")
    const linked = join(home, "linked")
    git(dir, "worktree", "add", "-q", "-b", "side", linked)

    const worktreeId = "7469477e-f97e-4739-83f1-46dcca5eba6f"
    const gitDir = git(linked, "rev-parse", "--absolute-git-dir")
    git(linked, "config", "--file", join(gitDir, "fray.config"), "--add", "fray.id", worktreeId)

    assert.deepEqual(migrateFrayProjectId(linked, { home }), [
      { id: FRAY_ID },
      { id: worktreeId, worktree: true },
    ])
    assert.equal(idIn(linked, "frizz.id"), FRAY_ID)
    assert.equal(idIn(linked, "frizz.id", ["--file", join(gitDir, "frizz.config")]), worktreeId)

    assert.deepEqual(migrateFrayProjectId(linked, { home }), [], "idempotent")
  })
})

test("a directory that is not a repository is not something to migrate", () => {
  withHome("id-nogit", (home) => {
    const dir = join(home, "plain")
    mkdirSync(dir, { recursive: true })
    assert.deepEqual(migrateFrayProjectId(dir, { home }), [])
  })
})
