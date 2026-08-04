import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { frizzPaths } from "./frizz-paths.ts"
import { migrateFrayGlobalRoots, migrateFrayProjectDir } from "./migrate-fray.ts"

/** Record the moves instead of touching a filesystem, so the platform matrix is testable anywhere. */
function planFor(present: string[], options: { platform: NodeJS.Platform; home: string; env?: NodeJS.ProcessEnv }) {
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
  })
  return moved
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

// Frizz's own state always wins. Anything else would let a stale fray tree clobber real threads.
test("an existing frizz root is never overwritten", () => {
  const moved = planFor(["/home/x/.fray", "/home/x/.frizz"], { platform: "linux", home: "/home/x" })
  assert.deepEqual(moved, [])
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

test("a project with no .fray, or one that already has .frizz, is untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-migrate-project-none-"))
  try {
    assert.equal(migrateFrayProjectDir(dir), false)

    mkdirSync(join(dir, ".fray"))
    mkdirSync(join(dir, ".frizz"))
    writeFileSync(join(dir, ".frizz", "keep"), "real")
    assert.equal(migrateFrayProjectDir(dir), false)
    assert.equal(readFileSync(join(dir, ".frizz", "keep"), "utf8"), "real")
    assert.equal(existsSync(join(dir, ".fray")), true, "the stale tree is left, never merged")
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
