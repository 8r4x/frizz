import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { projectStateDir } from "./frizz-paths.ts"
import { Database } from "./sqlite.ts"

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
// Renaming is MOST of the migration. Nothing under these roots stores its own absolute path — project
// state dirs are derived from the root at runtime, and artifact manifests record only `sourceDir`
// (the repo) — so moving the tree moves everything that points into it.
//
// The exception, and the one thing a rename cannot carry, is WHICH state directory a repo owns. That
// pointer lives in the repo's own Git config (`fray.id`, now `frizz.id`), outside every tree above.
// See migrateFrayProjectId.
//
// EVERY STEP HERE IS IDEMPOTENT AND RE-RUNNABLE, and that is load-bearing rather than tidy: the fray
// era does not end cleanly. Fray-era processes keep running — and keep writing `~/.fray` and `.fray/`
// — for as long as their session lasts, so a tree this migration already adopted can be sitting there
// again minutes later. Each step therefore folds in what it finds instead of declaring itself done,
// and none of them can destroy state by running twice.

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
  merge?: (from: string, to: string) => boolean
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
 * Adopt any fray-era global root.
 *
 * A plain rename when the frizz-named tree is absent. When BOTH exist the fray one is FOLDED IN, not
 * skipped — Frizz's own state still wins every collision (see `mergeInto`), but a tree that reappears
 * after the first migration must not be stranded. It does reappear: a fray-era server or worker that
 * was already running keeps writing `~/.fray` for the rest of its life, so the root can be back within
 * minutes of being adopted, holding real state written since. (Observed on the author's machine: broker
 * diagnostics for four live boards under a `~/.fray` recreated after the migration had run.) A skip
 * there would orphan all of it, permanently — nothing else ever looks at that path again.
 *
 * Returns the roots it actually took something from, so a caller can log them.
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
  const merge = options.merge ?? mergeInto

  const moved: Move[] = []
  for (const move of movesFor(env, platform, home)) {
    if (!exists(move.from)) continue
    try {
      if (exists(move.to)) {
        if (merge(move.from, move.to)) moved.push(move)
        continue
      }
      rename(move.from, move.to)
      moved.push(move)
    } catch {
      // Another Frizz process racing us, or a cross-device tree. Either way the next boot retries,
      // and a half-migrated machine is not possible: rename is atomic, and a merge only ever moves
      // entries the destination does not already have.
    }
  }
  return moved
}

/**
 * Fold `from` into `to`, entry by entry, without overwriting anything already there.
 *
 * Frizz's own copy always wins a collision and the fray one is left exactly where it is — this
 * migration never destroys a file it cannot prove is redundant. `from` therefore survives whenever
 * something collided, which is the honest outcome: it still holds content.
 */
function mergeInto(from: string, to: string): boolean {
  let moved = false
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (!existsSync(dst)) {
      renameSync(src, dst)
      moved = true
      continue
    }
    // Two directories of the same name are the common case (`threads/`, then a live thread's own
    // `<session-id>/`), and only their leaves actually conflict.
    if (entry.isDirectory() && lstatSync(dst).isDirectory() && mergeInto(src, dst)) moved = true
  }
  try { rmdirSync(from) } catch { /* something collided and stayed behind; leaving it is the point */ }
  return moved
}

/**
 * Adopt a project's `.fray/` directory as `.frizz/`.
 *
 * Holds the thread scratchpads and plan files for every thread ever run in this repo, so a project
 * opened after the rename would otherwise show none of them. Only a real directory is adopted — a
 * symlinked `.fray` is refused for the same reason dispatch.ts refuses a symlinked `.frizz`: it would
 * let a repo redirect Frizz's writes outside itself.
 *
 * BOTH DIRECTORIES CAN EXIST, and declining in that case would be the bug. The worker plugin is
 * served to Claude straight out of the repo, so its hooks pick up a rebranded checkout IMMEDIATELY —
 * while the server that dispatched those workers is still the old build, still writing to `.fray`.
 * Every repo with a live thread therefore ends up with a stub `.frizz` holding nothing but scratchpad
 * bookkeeping, sitting next to the real tree. A skip there would strand every scratchpad in `.fray`,
 * which is precisely the data this function exists to carry across. (Observed on the author's own
 * repo mid-rebrand: 3 stub thread dirs against 425 real ones.)
 */
export function migrateFrayProjectDir(projectDir: string): boolean {
  const from = join(projectDir, ".fray")
  const to = join(projectDir, ".frizz")
  try {
    if (!lstatSync(from).isDirectory()) return false
    if (!existsSync(to)) {
      renameSync(from, to)
      return true
    }
    return lstatSync(to).isDirectory() ? mergeInto(from, to) : false
  } catch {
    return false
  }
}

/** Mirrors project-identity.ts. Anything that is not exactly one UUID is not something to adopt. */
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const LEGACY_KEY = "fray.id"
const CURRENT_KEY = "frizz.id"

/** One Git config to read the id out of: the repo's own `--local`, or a linked worktree's `--file`. */
type Scope = string[]

function readId(dir: string, scope: Scope, key: string): string | undefined {
  let output: string
  try {
    output = execFileSync("git", ["config", ...scope, "--get-all", key], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    // Exit 1 is "unset", which is the ordinary case on both keys. Anything else — no Git, unreadable
    // config, not a repo — is equally not something to adopt, and guessing past it would be worse.
    return undefined
  }
  const values = output.replace(/\r?\n$/u, "").split(/\r?\n/u).filter((value) => value.length > 0)
  // Exactly one, exactly a UUID: the same bar readProjectIdConfig() holds the live key to. A repo
  // carrying two ids is already broken, and picking one of them would decide which board it keeps.
  if (values.length !== 1) return undefined
  const id = (values[0] ?? "").trim()
  return PROJECT_ID_RE.test(id) ? id : undefined
}

function writeId(dir: string, scope: Scope, id: string): boolean {
  try {
    // `--replace-all` because the repair case has an existing value to displace, and because a config
    // that somehow holds two would otherwise stay unreadable to readProjectIdConfig() forever.
    execFileSync("git", ["config", ...scope, "--replace-all", CURRENT_KEY, id], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
    })
  } catch {
    return false
  }
  return readId(dir, scope, CURRENT_KEY) === id // mandatory reread: never report a write we cannot see
}

/**
 * Has this project id ever actually held a board?
 *
 * The question the REPAIR turns on, answered conservatively. Only a project that is provably unused —
 * no database at all, or a `session` table with no rows — may be displaced. A database that cannot be
 * read (locked, corrupt, a schema this build does not know) counts as OCCUPIED, so the one outcome
 * this function will never produce is discarding a board it merely failed to understand.
 */
function hasBoard(id: string, home: string | undefined): boolean {
  const db = join(projectStateDir(id, home), "ui.db")
  if (!existsSync(db)) return false
  let sql: Database | undefined
  try {
    sql = new Database(db, { readonly: true })
    const row = sql.prepare<[], { n: number }>("select count(*) as n from session").get()
    return Number(row?.n ?? 0) > 0
  } catch {
    return true
  } finally {
    try {
      sql?.close()
    } catch {
      /* nothing left to do about it, and the answer above is already correct */
    }
  }
}

/** The private config a LINKED worktree keeps its own id in; absent for an ordinary checkout. */
function linkedWorktreeScopes(dir: string): { legacy: Scope; current: Scope } | undefined {
  const gitPath = (flag: "--git-dir" | "--git-common-dir"): string | undefined => {
    try {
      const raw = execFileSync("git", ["rev-parse", flag], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      return realpathSync(resolve(dir, raw))
    } catch {
      return undefined
    }
  }
  const gitDir = gitPath("--git-dir")
  const commonGitDir = gitPath("--git-common-dir")
  // Equal means an ordinary/main worktree, whose id is the repository-local one and nothing else.
  if (!gitDir || !commonGitDir || gitDir === commonGitDir) return undefined
  return {
    legacy: ["--file", join(gitDir, "fray.config")],
    current: ["--file", join(gitDir, "frizz.config")],
  }
}

/** What one adoption did, for logging. */
export interface ProjectIdAdoption {
  /** The fray-era id now serving this checkout. */
  id: string
  /** The minted id it displaced — set only when this run REPAIRED an already-split board. */
  replaced?: string
  /** True when this is a linked worktree's private id rather than the repository's. */
  worktree?: boolean
}

function adopt(dir: string, legacy: Scope, current: Scope, home: string | undefined): ProjectIdAdoption | undefined {
  const legacyId = readId(dir, legacy, LEGACY_KEY)
  if (!legacyId) return undefined
  const currentId = readId(dir, current, CURRENT_KEY)
  if (currentId === legacyId) return undefined // already adopted: the idempotent no-op
  if (currentId && hasBoard(currentId, home)) return undefined // a real frizz board; never displace it
  if (!writeId(dir, current, legacyId)) return undefined
  return currentId ? { id: legacyId, replaced: currentId } : { id: legacyId }
}

/**
 * Adopt a repo's fray-era project id — WHICH state directory holds this checkout's board.
 *
 * That pointer lives in the repo's own Git config, so it is the one piece of fray-era state that sits
 * outside every tree the renames above move, and the one thing a migration that only moved trees left
 * behind. `resolveGitProjectIdentity` reads `frizz.id` and MINTS A NEW UUID when it finds none, so the
 * first frizz open of a fray-era repo did not fail loudly — it quietly created a second, empty project
 * beside the real one and served that. The threads were never touched; nothing was pointing at them.
 *
 * MUST run before `resolveGitProjectIdentity`, which is the call that mints.
 *
 * REPAIR. `frizz.id` already being set is not proof the migration happened — on any machine that
 * opened a fray-era repo before this function existed, it is proof of the opposite. So an existing
 * `frizz.id` is displaced when, and only when, the project it names has never held a board (see
 * `hasBoard`) while `fray.id` names one that has. This is safe to re-run precisely because the
 * migration never deletes `fray.id`: the old pointer staying put is what makes a repo diagnosable
 * later, and is the only reason boards split off by the first buggy open can still be reunited.
 * (Four of the author's own boards were, this way — 392, 240, 82 and 4 threads.)
 *
 * Handles a linked worktree too, whose id lives in its own `<gitdir>/fray.config` → `frizz.config`.
 */
export function migrateFrayProjectId(
  projectDir: string,
  { home }: { home?: string } = {},
): ProjectIdAdoption[] {
  const adopted: ProjectIdAdoption[] = []
  const repository = adopt(projectDir, ["--local"], ["--local"], home)
  if (repository) adopted.push(repository)

  const worktree = linkedWorktreeScopes(projectDir)
  if (worktree) {
    const own = adopt(projectDir, worktree.legacy, worktree.current, home)
    // A linked worktree needs BOTH ids present or resolvedIdentity() rejects the pair and mints a new
    // one anyway, so the repository-level adoption above is not optional here — it is the other half.
    if (own) adopted.push({ ...own, worktree: true })
  }
  return adopted
}
