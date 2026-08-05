import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"
import { acquireNamedLaunchLockSync, validateProjectId } from "./project-identity.ts"

// WHAT A PROJECT IS, WITHOUT ASKING GIT.
//
// Frizz used to define a project as a Git repository: the root came from `rev-parse --show-toplevel`
// and the id from `git config --local frizz.id`. That made Git a hard requirement to LAUNCH, which
// contradicts the product's own position — Frizz has no opinion about version control — and locked
// out anyone on jj (a non-colocated repo has no `.git` at all), hg, or nothing.
//
// So the id lives in the project instead, at `.frizz/.id`, beside the scratchpads Frizz already
// writes there. Two of the four properties `git config` was buying (project-identity.ts) come free
// that way: a directory that MOVES keeps its id because the id moved with it, and an alias resolves
// to the same id because it resolves to the same directory. The other two — atomic creation under a
// race, and sub-directory equivalence — are re-earned here, by the same named lock the Git path uses
// and by the walk-up below.
//
// THE ONE HAZARD, AND WHY IT IS NOT ONE. Unlike `git config --local`, a file in the working tree can
// be committed, and two clones of that repo on one machine would then share an id. `.frizz/.gitignore`
// containing `*` removes that outright: the directory ignores ITSELF and everything under it, so
// `git add -A` cannot stage any of it (verified in a repo with no top-level .gitignore at all —
// `git status --porcelain` is empty and `check-ignore` reports the id and the .gitignore as ignored).
// Writing it is not an opinion about the user's version control, it is the ordinary convention for a
// tool's own scratch directory: `.venv/.gitignore` and `.swc/.gitignore` are exactly this file.

const FRIZZ_DIR = ".frizz"
const ID_FILE = ".id"
const SELF_IGNORE = ".gitignore"

/** Any of these makes a directory the project root. A Frizz project wins over the VCS it sits in. */
const REPO_MARKERS = [".git", ".jj", ".hg", ".svn"]
const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "deno.json",
  "deno.jsonc",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Makefile",
]

export function projectIdPath(root: string): string {
  return join(root, FRIZZ_DIR, ID_FILE)
}

/** The id recorded in this exact directory, or undefined. A malformed file is refused, never guessed at. */
export function readProjectIdFile(root: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(projectIdPath(root), "utf8")
  } catch {
    return undefined
  }
  try {
    return validateProjectId(raw.trim())
  } catch {
    throw new Error(`${projectIdPath(root)} is invalid; expected exactly one UUID`)
  }
}

/**
 * Record `id` for `root`, atomically, and make the directory ignore itself on the way.
 *
 * open(wx) → fsync → rename is the same shape project-launch.ts uses: a reader either sees the old
 * file or the complete new one, never a half-written id.
 */
export function writeProjectIdFile(root: string, id: string): string {
  const dir = join(root, FRIZZ_DIR)
  mkdirSync(dir, { recursive: true })
  // Written before the id, so the id is never briefly visible to `git add -A`.
  const ignore = join(dir, SELF_IGNORE)
  if (!existsSync(ignore)) {
    try { writeFileSync(ignore, "*\n", { flag: "wx" }) } catch { /* raced; a `*` is a `*` */ }
  }

  const path = projectIdPath(root)
  const temp = join(dir, `.${ID_FILE}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, "wx", 0o600)
    writeFileSync(fd, `${id}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
  return id
}

/** Keyed on the canonical root rather than a common git dir, which a plain directory does not have. */
export function projectRootLockName(root: string): string {
  return `identity-path-${createHash("sha256").update(root).digest("hex")}.lock`
}

/**
 * The project's durable id, minting one only if the project has never had it.
 *
 * `seed` is the id an existing store already committed to — today that is `git config frizz.id`, so a
 * repository that predates this file ADOPTS its own id rather than being handed a new one and losing
 * its board. Nothing is ever removed from the old store: it stays readable, and stays the answer if
 * this file is deleted.
 *
 * The lock is what makes two `frizz` processes starting at once commit exactly ONE id — the property
 * `git config`'s own lock used to provide, and the one a bare "write if missing" would lose.
 */
export function ensureProjectIdFile(root: string, home = homedir(), seed?: string): string {
  const existing = readProjectIdFile(root)
  if (existing) return existing
  const release = acquireNamedLaunchLockSync(home, projectRootLockName(root))
  try {
    const raced = readProjectIdFile(root)
    if (raced) return raced
    return writeProjectIdFile(root, seed ? validateProjectId(seed) : randomUUID())
  } finally {
    release()
  }
}

/**
 * Does this error mean "there is simply no Git worktree here", as opposed to "a real repository is
 * broken"?
 *
 * The distinction is the whole safety property. A malformed config or unsafe ownership means a
 * repository we could not READ, and inventing a fresh namespace for it would strand every thread on
 * its board — so those still fail closed. Not-a-repository, a bare repository, and `git` not being
 * installed at all genuinely mean there is nothing to read, and now fall through to marker walk-up.
 */
export function isNotAGitWorktree(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === "ENOENT" || code === "EACCES") return true // no `git` on this machine
  if (!error || typeof error !== "object" || !("stderr" in error)) return false
  const stderr = String((error as { stderr?: unknown }).stderr)
  return /not a git repository/iu.test(stderr) || /must be run in a work ?tree/iu.test(stderr)
}

function hasAny(dir: string, names: readonly string[]): boolean {
  return names.some((name) => existsSync(join(dir, name)))
}

/**
 * The project root for `cwd`, without running `git`.
 *
 * Walks UP, because sub-directory equivalence is the property a naive "just use cwd" loses and the
 * one users notice: `frizz` in `~/proj` and in `~/proj/src` must open the same board, not two boards
 * with two thread histories and nothing explaining why.
 *
 * Stops at `$HOME` and never returns it. A stray `~/package.json` would otherwise make a user's whole
 * home directory one project, with agents dispatched at it.
 */
export function discoverProjectRoot(cwd = process.cwd(), home = homedir()): string {
  let dir: string
  try {
    dir = resolve(cwd)
  } catch {
    return resolve(cwd)
  }
  const stop = resolve(home)
  const filesystemRoot = parse(dir).root

  for (let at = dir; ; at = dirname(at)) {
    // Never adopt the home directory itself, and never climb past it.
    if (at === stop || at === filesystemRoot) break
    // An existing Frizz project wins over the VCS or manifest it happens to sit in.
    if (existsSync(projectIdPath(at))) return at
    if (hasAny(at, REPO_MARKERS)) return at
    if (hasAny(at, PROJECT_MARKERS)) return at
    if (dirname(at) === at) break
  }
  return dir
}
