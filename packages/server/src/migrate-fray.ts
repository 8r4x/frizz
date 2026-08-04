import { existsSync, lstatSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ONE-TIME MIGRATION OFF THE OLD `fray` NAME.
//
// Frizz used to be called Fray, and its state was named for it: `~/.fray` (or the platform roots
// `…/Fray`, `…/fray`) globally, and `.fray/` inside every project it touched. Nothing in Frizz reads
// those names any more — resolution lives in frizz-paths.ts and knows only about `frizz`. This module
// exists solely to MOVE a fray-era tree onto the new name the first time Frizz opens, so an install
// that predates the rename keeps its threads instead of silently starting empty.
//
// It is deliberately self-contained and duplicates the shape of frizz-paths.ts's root builders rather
// than parameterizing them by brand. That duplication is the point: DELETE THIS FILE and its two call
// sites once no machine has a fray-era tree left, and every trace of the old name goes with it. A
// brand switch threaded through the live resolver would never leave.
//
// Renaming is the whole migration. Nothing under these roots stores its own absolute path — project
// state dirs are derived from the root at runtime, and artifact manifests record only `sourceDir`
// (the repo) — so moving the tree moves everything that points into it.

/** A tree to adopt: `from` is the fray-era path, `to` is where Frizz will look for it. */
interface Move {
  from: string
  to: string
}

export interface MigrateFrayOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  exists?: (path: string) => boolean
  rename?: (from: string, to: string) => void
}

/** Mirrors frizz-paths.ts's `xdg()` — set AND absolute, or it does not count. */
function xdg(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) ? value : undefined
}

/**
 * Every (fray-era, frizz) root pair this platform could have, legacy first.
 *
 * The legacy pair leads because it is the collapse case: once `~/.frizz` exists, frizz-paths.ts
 * resolves ALL THREE roots onto it and the platform pairs below are moot. Ordering them this way
 * means a legacy install does exactly one rename.
 */
function movesFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): Move[] {
  const moves: Move[] = [{ from: join(home, ".fray"), to: join(home, ".frizz") }]

  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(env.USERPROFILE || home, "AppData", "Local")
    moves.push({ from: join(local, "Fray"), to: join(local, "Frizz") })
  } else if (platform === "darwin") {
    const support = join(home, "Library", "Application Support")
    moves.push({ from: join(support, "Fray"), to: join(support, "Frizz") })
    moves.push({ from: join(home, "Library", "Caches", "Fray"), to: join(home, "Library", "Caches", "Frizz") })
  } else {
    moves.push({ from: join(home, ".local", "share", "fray"), to: join(home, ".local", "share", "frizz") })
    moves.push({ from: join(home, ".local", "state", "fray"), to: join(home, ".local", "state", "frizz") })
    moves.push({ from: join(home, ".cache", "fray"), to: join(home, ".cache", "frizz") })
  }

  // An explicitly SET XDG variable wins on every platform in frizz-paths.ts, so its tree can exist
  // alongside the platform one and needs adopting too.
  for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const) {
    const base = xdg(env, name)
    if (base) moves.push({ from: join(base, "fray"), to: join(base, "frizz") })
  }
  return moves
}

/**
 * Adopt any fray-era global root, once.
 *
 * Skips a pair whenever the frizz-named tree already exists — Frizz's own state always wins, and a
 * machine that has already migrated does nothing but a few `existsSync` calls. Returns the moves it
 * actually made so a caller can log them.
 *
 * MUST run before anything resolves a root: `frizzRoots()` memoizes, so a process that resolved the
 * platform roots first would keep writing to the wrong tree for its whole life.
 */
export function migrateFrayGlobalRoots(options: MigrateFrayOptions = {}): Move[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  const rename = options.rename ?? renameSync

  const moved: Move[] = []
  for (const move of movesFor(env, platform, home)) {
    if (exists(move.to) || !exists(move.from)) continue
    try {
      rename(move.from, move.to)
      moved.push(move)
    } catch {
      // Another Frizz process racing us, or a cross-device tree. Either way the next boot retries,
      // and a half-migrated machine is not possible: rename is atomic.
    }
  }
  return moved
}

/**
 * Adopt a project's `.fray/` directory as `.frizz/`.
 *
 * Holds the thread scratchpads and plan files for every thread ever run in this repo, so a project
 * opened after the rename would otherwise show none of them. Only a real directory is adopted — a
 * symlinked `.fray` is refused for the same reason dispatch.ts refuses a symlinked `.frizz`: it would
 * let a repo redirect Frizz's writes outside itself.
 */
export function migrateFrayProjectDir(projectDir: string): boolean {
  const from = join(projectDir, ".fray")
  const to = join(projectDir, ".frizz")
  if (existsSync(to)) return false
  try {
    if (!lstatSync(from).isDirectory()) return false
    renameSync(from, to)
    return true
  } catch {
    return false
  }
}
