import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { frizzPaths, legacyFrizzRoot, projectStateDir, serverAddressPathForStateDir } from "./frizz-paths.ts"

const never = () => false

// The property the whole module exists to protect: an installed Frizz never moves. This tree reaches
// gigabytes, detached daemons hold descriptors into it, and the threads have no second copy.
test("an existing ~/.frizz keeps every root, on every platform, whatever XDG says", () => {
  const base = mkdtempSync(join(tmpdir(), "frizz-paths-legacy-"))
  try {
    mkdirSync(legacyFrizzRoot(base))
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const paths = frizzPaths({
        home: base,
        platform,
        env: { XDG_DATA_HOME: "/xdg", XDG_CACHE_HOME: "/xdg", LOCALAPPDATA: "C:\\Local" },
      })
      assert.equal(paths.legacy, true, platform)
      assert.equal(paths.data, join(base, ".frizz"), platform)
      assert.equal(paths.state, join(base, ".frizz"), platform)
      assert.equal(paths.cache, join(base, ".frizz"), platform)
    }
    assert.equal(projectStateDir("p1", base), join(base, ".frizz", "projects", "p1"))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// Every expectation below is SPELLED WITH join(), never with a literal "/a/b/c". These cases pin the
// platform BRANCH, which is injected, while the separator is the HOST's — so a POSIX literal is a
// second, accidental assertion that the suite is running on POSIX, and on Windows the same correct
// branch answers `\home\x\.local\share\frizz`. join() states the branch and nothing else.
test("a machine that has never run Frizz gets the platform's own locations", () => {
  const linux = frizzPaths({ home: "/home/x", platform: "linux", env: {}, exists: never })
  assert.deepEqual(
    { data: linux.data, state: linux.state, cache: linux.cache, legacy: linux.legacy },
    {
      data: join("/home/x", ".local", "share", "frizz"),
      state: join("/home/x", ".local", "state", "frizz"),
      cache: join("/home/x", ".cache", "frizz"),
      legacy: false,
    },
  )

  const mac = frizzPaths({ home: "/Users/x", platform: "darwin", env: {}, exists: never })
  assert.equal(mac.data, join("/Users/x", "Library", "Application Support", "Frizz"))
  assert.equal(mac.cache, join("/Users/x", "Library", "Caches", "Frizz"))
})

test("a set XDG variable wins on every platform, and each one moves only its own root", () => {
  const partial = frizzPaths({
    home: "/Users/x",
    platform: "darwin",
    env: { XDG_CACHE_HOME: "/c" },
    exists: never,
  })
  assert.equal(partial.cache, join("/c", "frizz"), "the variable that was set moves")
  assert.equal(partial.data, join("/Users/x", "Library", "Application Support", "Frizz"), "the others do not")

  const all = frizzPaths({
    home: "/home/x",
    platform: "linux",
    env: { XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s", XDG_CACHE_HOME: "/c" },
    exists: never,
  })
  assert.deepEqual([all.data, all.state, all.cache], [join("/d", "frizz"), join("/s", "frizz"), join("/c", "frizz")])
})

// The spec says a relative XDG value is invalid and must be ignored, which matters here because a
// relative root would resolve against whatever cwd a daemon happened to inherit.
test("a relative or empty XDG value is ignored rather than resolved against the cwd", () => {
  for (const value of ["relative/share", "", "   "]) {
    const paths = frizzPaths({ home: "/home/x", platform: "linux", env: { XDG_DATA_HOME: value }, exists: never })
    assert.equal(paths.data, join("/home/x", ".local", "share", "frizz"), JSON.stringify(value))
  }
})

test("Windows uses Local, never Roaming — a multi-gigabyte cache must not follow the user", () => {
  const paths = frizzPaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
    exists: never,
  })
  for (const root of [paths.data, paths.state, paths.cache]) {
    assert.match(root, /AppData[\\/]Local[\\/]Frizz/)
    assert.doesNotMatch(root, /Roaming/)
  }

  // A stripped environment still has to land somewhere sane rather than at the filesystem root.
  const bare = frizzPaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\x" },
    exists: never,
  })
  assert.match(bare.data, /Users[\\/]x[\\/]AppData[\\/]Local[\\/]Frizz/)
})

// A SANDBOX HAS TO STAY SANDBOXED ON WIN32 TOO, and %LOCALAPPDATA% is what used to break that:
// `frizzPaths({ home })` is the ONE mechanism every sandbox here has (projectStateDir, registryPath,
// machineConfigPath, serverAddressPath, stablePluginPath), and on Windows all of them collapsed onto
// the live account's single `%LOCALAPPDATA%\Frizz` tree whatever home they were handed — a suite run
// rewrote the operator's own settings.json and registry (first Windows suite run, 2026-08-24). The
// variable describes the PROCESS's home, so it is honored only when it sits under the home in hand.
test("on win32 the home in hand outranks a %LOCALAPPDATA% belonging to another tree", () => {
  const inherited = { LOCALAPPDATA: "C:\\Users\\nub\\AppData\\Local", USERPROFILE: "C:\\Users\\nub" }
  const sandbox = (home: string) => frizzPaths({ home, platform: "win32", env: inherited, exists: never })
  const a = sandbox("C:\\tmp\\a\\home")
  const b = sandbox("C:\\tmp\\b\\home")
  for (const [label, paths, home] of [["a", a, "a"], ["b", b, "b"]] as const) {
    for (const root of [paths.data, paths.state, paths.cache]) {
      assert.match(root, new RegExp(`^C:[\\\\/]tmp[\\\\/]${home}[\\\\/]home[\\\\/]AppData[\\\\/]Local[\\\\/]Frizz`), label)
    }
  }
  assert.notEqual(a.data, b.data, "two sandboxes are two trees, not one shared one")

  // The converse, and the reason the test is containment rather than "was a home passed": a real
  // account's %LOCALAPPDATA% is still used VERBATIM, matched the way Windows itself matches a path —
  // without case. The value below differs from `join(home, "AppData", "Local")` only in case, so an
  // answer spelled like the home would prove the variable had been thrown away.
  const real = frizzPaths({
    home: "C:\\Users\\x",
    platform: "win32",
    env: { LOCALAPPDATA: "c:\\users\\x\\AppData\\Local" },
    exists: never,
  })
  assert.equal(real.data, join("c:\\users\\x\\AppData\\Local", "Frizz", "Data"))
})

// THE ADDRESS AND THE STATE DIR MUST AGREE, and the agreement is `../..` — the exact derivation the
// worker shim performs on FRIZZ_STATE_DIR (cc-worker/bin/frizz-mcp.mjs). If these two ever disagree, a
// worker looks for the machine address somewhere the server never writes it, and the failure is a tool
// that silently cannot find its server.
//
// The second assertion is the one with teeth: deriving the address from `homedir()` instead let a TEST
// RUN publish and then retire the real machine's `~/.frizz/server.lock`, out from under a live server
// (2026-08-08). Anything sandboxed must stay sandboxed.
test("the machine server address is ../.. from a project state dir, in whatever root that is", () => {
  // Asserted as a RELATIONSHIP, not a spelling: the root differs by platform and by whether a legacy
  // `~/.frizz` exists, and what must hold everywhere is that the address sits beside `projects/`.
  for (const base of ["/home/x", "/tmp/sandbox-home"]) {
    const stateDir = projectStateDir("p1", base)
    assert.equal(serverAddressPathForStateDir(stateDir), join(dirname(dirname(stateDir)), "server.lock"))
    assert.equal(dirname(dirname(stateDir)), dirname(dirname(projectStateDir("p2", base))), "one root, whatever the project")
  }
  // And the sandbox one must never resolve into the real machine's root — the leak that let a test run
  // retire `~/.frizz/server.lock` out from under a live server (2026-08-08).
  // join() with one argument is just normalization, and that is the point: on win32 the sandbox home
  // spells itself `\tmp\sandbox-home`, so a literal prefix would fail an address that never escaped.
  const sandboxed = serverAddressPathForStateDir(projectStateDir("p1", "/tmp/sandbox-home"))
  assert.ok(sandboxed.startsWith(join("/tmp/sandbox-home")), `sandboxed address escaped: ${sandboxed}`)
})
