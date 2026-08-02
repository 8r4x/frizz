import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// WHERE FRAY'S MACHINE-GLOBAL STATE LIVES.
//
// `~/.fray` is not idiomatic anywhere: Linux has had the XDG base directories for a decade, Windows
// has LocalAppData, macOS has Application Support. But an existing install cannot be relocated — this
// tree reaches gigabytes (measured: 1.8 GB of promoted artifacts and 1.5 GB of browser profiles
// against 28 MB of actual thread state), agents hold live file descriptors into it, and the threads
// have no backup anywhere else. So: DETECT first, and only choose for a machine that has never run
// Fray.
//
//   1. `~/.fray` exists  -> use it for everything, unchanged, forever. Nobody migrates.
//   2. otherwise         -> the platform's idiomatic locations, XDG variables honored individually.
//
// The three roots exist because the content genuinely differs in kind, which is the whole point of
// the XDG split: `cache` is regenerable and safe to delete (artifacts, browser profiles, quota
// snapshots — the gigabytes), `data` is the threads and cannot be recovered, `state` is logs, locks
// and launch bookkeeping. On a legacy install all three collapse to `~/.fray` and every historical
// path stays byte-identical.
//
// There is deliberately NO `runtime` root. `$XDG_RUNTIME_DIR` would be the right home for sockets and
// locks, but it is unset on macOS and its only portable stand-in is `$TMPDIR`, which on Linux is
// SHARED BETWEEN USERS — a machine-global launch lock or port reservation there could collide with
// another account's. Those live in `state`, which is per-user by construction. Sockets already solve
// this for themselves: `claude-broker-host.ts` hashes them into `$TMPDIR` under a name unique per
// state directory, because a unix socket path cannot exceed 104 bytes on macOS.

export interface FrayPaths {
  /** Threads, attachments, project identity. Losing this loses the product. */
  data: string
  /** Logs and launch bookkeeping — persistent, reconstructible, not precious. */
  state: string
  /** Promoted artifacts, staged plugins, browser profiles, quota snapshots. Safe to delete. */
  cache: string
  /** True when an existing `~/.fray` was found and every root collapsed onto it. */
  legacy: boolean
}

export interface FrayPathOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  /** Injected so the whole resolution matrix is testable without touching a filesystem. */
  exists?: (path: string) => boolean
}

export const LEGACY_DIR_NAME = ".fray"

export function legacyFrayRoot(home = homedir()): string {
  return join(home, LEGACY_DIR_NAME)
}

/** An XDG variable counts only when it is SET and ABSOLUTE; the spec says to ignore relative values. */
function xdg(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) ? value : undefined
}

function windowsRoots(env: NodeJS.ProcessEnv, home: string): Omit<FrayPaths, "legacy"> {
  // Never Roaming: a multi-gigabyte artifact cache must not follow a user between machines, which is
  // exactly what %APPDATA% would do to it.
  const local = env.LOCALAPPDATA || join(env.USERPROFILE || home, "AppData", "Local")
  const base = join(local, "Fray")
  return {
    data: join(base, "Data"),
    state: join(base, "State"),
    cache: join(base, "Cache"),
  }
}

function darwinRoots(home: string): Omit<FrayPaths, "legacy"> {
  const support = join(home, "Library", "Application Support", "Fray")
  return {
    data: support,
    // macOS has no state directory concept; Application Support is where this belongs, and the log
    // files themselves already live under each project's own directory.
    state: support,
    cache: join(home, "Library", "Caches", "Fray"),
  }
}

function xdgRoots(env: NodeJS.ProcessEnv, home: string): Omit<FrayPaths, "legacy"> {
  return {
    data: join(xdg(env, "XDG_DATA_HOME") ?? join(home, ".local", "share"), "fray"),
    state: join(xdg(env, "XDG_STATE_HOME") ?? join(home, ".local", "state"), "fray"),
    cache: join(xdg(env, "XDG_CACHE_HOME") ?? join(home, ".cache"), "fray"),
  }
}

/**
 * Resolve Fray's global roots.
 *
 * An explicitly SET XDG variable wins on every platform, including macOS and Windows — a developer
 * who has configured XDG has asked for it and should get it. Everything else follows the platform.
 */
export function frayPaths(options: FrayPathOptions = {}): FrayPaths {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync

  const legacyRoot = legacyFrayRoot(home)
  if (exists(legacyRoot)) {
    return { data: legacyRoot, state: legacyRoot, cache: legacyRoot, legacy: true }
  }

  const explicit = {
    data: xdg(env, "XDG_DATA_HOME"),
    state: xdg(env, "XDG_STATE_HOME"),
    cache: xdg(env, "XDG_CACHE_HOME"),
  }
  const platformRoots = platform === "win32"
    ? windowsRoots(env, home)
    : platform === "darwin"
      ? darwinRoots(home)
      : xdgRoots(env, home)

  return {
    data: explicit.data ? join(explicit.data, "fray") : platformRoots.data,
    state: explicit.state ? join(explicit.state, "fray") : platformRoots.state,
    cache: explicit.cache ? join(explicit.cache, "fray") : platformRoots.cache,
    legacy: false,
  }
}

/**
 * The roots, resolved once per process.
 *
 * Deliberately cached: resolution stats the legacy directory, and a launch asks for these paths from
 * dozens of call sites. More importantly it must not CHANGE mid-process — a run that resolved
 * `~/.fray` at boot and something else later would split one project's state across two trees.
 */
let cached: FrayPaths | undefined
export function frayRoots(): FrayPaths {
  return (cached ??= frayPaths())
}

/** Test-only: drop the memo so a case can resolve under a different HOME or platform. */
export function resetFrayRoots(): void {
  cached = undefined
}

/** `<data>/projects/<id>` — a project's own directory, and the value of `stateDir` everywhere. */
export function projectStateDir(projectId: string, home?: string): string {
  return join(home ? frayPaths({ home }).data : frayRoots().data, "projects", projectId)
}
