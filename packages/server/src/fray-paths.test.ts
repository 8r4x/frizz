import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { frayPaths, legacyFrayRoot, projectStateDir } from "./fray-paths.ts"

const never = () => false

// The property the whole module exists to protect: an installed Fray never moves. This tree reaches
// gigabytes, detached daemons hold descriptors into it, and the threads have no second copy.
test("an existing ~/.fray keeps every root, on every platform, whatever XDG says", () => {
  const base = mkdtempSync(join(tmpdir(), "fray-paths-legacy-"))
  try {
    mkdirSync(legacyFrayRoot(base))
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const paths = frayPaths({
        home: base,
        platform,
        env: { XDG_DATA_HOME: "/xdg", XDG_CACHE_HOME: "/xdg", LOCALAPPDATA: "C:\\Local" },
      })
      assert.equal(paths.legacy, true, platform)
      assert.equal(paths.data, join(base, ".fray"), platform)
      assert.equal(paths.state, join(base, ".fray"), platform)
      assert.equal(paths.cache, join(base, ".fray"), platform)
    }
    assert.equal(projectStateDir("p1", base), join(base, ".fray", "projects", "p1"))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("a machine that has never run Fray gets the platform's own locations", () => {
  const linux = frayPaths({ home: "/home/x", platform: "linux", env: {}, exists: never })
  assert.deepEqual(
    { data: linux.data, state: linux.state, cache: linux.cache, legacy: linux.legacy },
    {
      data: "/home/x/.local/share/fray",
      state: "/home/x/.local/state/fray",
      cache: "/home/x/.cache/fray",
      legacy: false,
    },
  )

  const mac = frayPaths({ home: "/Users/x", platform: "darwin", env: {}, exists: never })
  assert.equal(mac.data, "/Users/x/Library/Application Support/Fray")
  assert.equal(mac.cache, "/Users/x/Library/Caches/Fray")
})

test("a set XDG variable wins on every platform, and each one moves only its own root", () => {
  const partial = frayPaths({
    home: "/Users/x",
    platform: "darwin",
    env: { XDG_CACHE_HOME: "/c" },
    exists: never,
  })
  assert.equal(partial.cache, join("/c", "fray"), "the variable that was set moves")
  assert.equal(partial.data, "/Users/x/Library/Application Support/Fray", "the others do not")

  const all = frayPaths({
    home: "/home/x",
    platform: "linux",
    env: { XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s", XDG_CACHE_HOME: "/c" },
    exists: never,
  })
  assert.deepEqual([all.data, all.state, all.cache], [join("/d", "fray"), join("/s", "fray"), join("/c", "fray")])
})

// The spec says a relative XDG value is invalid and must be ignored, which matters here because a
// relative root would resolve against whatever cwd a daemon happened to inherit.
test("a relative or empty XDG value is ignored rather than resolved against the cwd", () => {
  for (const value of ["relative/share", "", "   "]) {
    const paths = frayPaths({ home: "/home/x", platform: "linux", env: { XDG_DATA_HOME: value }, exists: never })
    assert.equal(paths.data, "/home/x/.local/share/fray", JSON.stringify(value))
  }
})

test("Windows uses Local, never Roaming — a multi-gigabyte cache must not follow the user", () => {
  const paths = frayPaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
    exists: never,
  })
  for (const root of [paths.data, paths.state, paths.cache]) {
    assert.match(root, /AppData[\\/]Local[\\/]Fray/)
    assert.doesNotMatch(root, /Roaming/)
  }

  // A stripped environment still has to land somewhere sane rather than at the filesystem root.
  const bare = frayPaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\x" },
    exists: never,
  })
  assert.match(bare.data, /Users[\\/]x[\\/]AppData[\\/]Local[\\/]Fray/)
})
