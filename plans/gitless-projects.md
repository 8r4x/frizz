# Running Fray without Git

Brainstorm, 2026-08-01. Prompted by "a lot of people don't use Git" after `npx frayui` was found to
hard-fail outside a repository.

## First: separate three different asks

They need very different work, and only one of them is hard.

1. **"I don't use Git *workflows*"** — no branches, no PRs, no worktrees. **Already supported.** The
   README promises it ("Fray adds no worktrees, no branches"), and nothing in the launcher creates
   one. The one thing that contradicts the promise is the worker prompt: `GIT_DISCIPLINE`
   (`packages/server/src/workerPrompt.ts:200`) tells every dispatched agent to commit small and often,
   to work from `git worktree add`, and to treat "landed" as a merge. A user who just wants edits in
   their folder gets an agent narrating a git workflow at them. Cheap to fix — see §5.
2. **"My project directory isn't a repository"** — a scratch folder, a Downloads dir, a Dropbox
   folder of scripts, an Obsidian vault, a `~/site` someone `scp`s. **This is the real blocker** and
   the rest of this document is about it.
3. **"`git` isn't installed on my machine"** — genuinely rare on a machine that already has Claude
   Code or Codex on it, and it forecloses the most attractive design in §4. Worth treating as
   explicitly out of scope until someone actually reports it.

Deciding which of these we're serving changes the answer completely. My read: **(2) with (1) folded
in**, and keep depending on the `git` *binary*.

## 1. What actually depends on Git today

| Use | Where | Hard? |
| --- | --- | --- |
| Project root = repo root | `src/launcher.ts:363`, `packages/server/src/project.ts:60` | **Hard** — the launcher throws `fray-dev must be run inside a Git repository` |
| Project identity (`fray.id`) | `project-identity.ts:458` writes `git config --local --add fray.id <uuid>` | **Hard** — the id keys `~/.fray/projects/<id>/`, the SQLite DB, logs, scratchpads, and the tmux socket name |
| Worktree scope | `project-identity.ts:382` (`--git-dir` vs `--git-common-dir`), private `fray.config` at `:395` | Hard, but **moot** for a non-repo directory |
| `owner/repo` label | `project.ts:135` (`git remote get-url origin`) | Soft — already `?? name` |
| GitHub picker / PR watch | `github.ts:49` (`gh repo view`) | Soft — already returns `null`, never throws |
| Artifact source stamp | `src/artifacts.ts:241` (`rev-parse HEAD`) | Soft — already `try/catch` |
| Worker git advice | `workerPrompt.ts:200` | Soft — one entry in a section array (`:733`) |

So the surface is small: **root discovery and identity**. Everything else already degrades, which is
a good sign that gitless was half-anticipated.

## 2. The four properties `git config` is buying us

Any replacement has to match these or it's a regression, not a port. This is the real spec:

1. **Atomic creation under a race.** Two `npx frayui` processes starting at once must commit exactly
   one id. Today: Git's own config lock, plus `acquireNamedLaunchLockSync` keyed on the common git dir
   (`project-identity.ts:350`). There is a test for it — "simultaneous first-run CLI processes commit
   one project identity".
2. **Alias-independence.** `/Users/me/proj` and a symlink to it are one project. Today: `realpathSync`
   on the root, then reading the same config.
3. **Move-survival.** Rename or move the checkout and the board keeps its threads, because nothing is
   keyed on the path.
4. **Sub-directory equivalence.** `cd src/components && npx frayui` opens the *project's* board, not a
   new one. Today: `rev-parse --show-toplevel` from anywhere inside the tree.

(3) and (4) are the ones a naive "hash the cwd" design silently loses.

## 3. Identity without Git — `.fray/fray.id`, cross-checked against `~/.fray`

**Decided: the id is a file in the project, at `.fray/fray.id`.** Fray already writes `.fray/` into
the working tree on first dispatch (thread scratchpads, hook state), so this adds no new footprint
and nothing new to explain, and whether that directory is ignored is the user's call — the README
already tells them to add `.fray/` to `.gitignore` themselves.

It also wins the properties outright. §2's move-survival and alias-independence are **free**, because
the id lives *inside* the thing being moved; a path-keyed lookup has to work to recover what a file
gets by construction. Atomic creation reuses `tmux-socket.ts:239`'s `atomicJson` (open `wx` → fsync →
rename → fsync dir) under `acquireNamedLaunchLockSync` (`project-identity.ts:323`), re-keyed from
`commonGitDir` to a hash of the canonical path — the existing mechanism, so the
concurrent-first-launch test keeps its guarantee.

### The one hazard, and the rule that removes it

Unlike `git config --local`, a file in the tree **can be committed** — and then two clones of that
repo *on one machine* resolve to the same project id at two different paths. That is exactly the
duplicate-`fray.id` condition `validateFullSocket` fails closed on (`tmux-socket.ts:399`): the second
checkout would die with the "unknown or foreign ownership" error this whole thread started from.

Don't rely on the user's `.gitignore` to prevent it — detect it, and self-heal:

> On resolve, read `.fray/fray.id`. Cross-check it against `~/.fray/projects/<id>/identity.json`,
> which records the path (plus `dev`/`ino`) this id was minted for. If that record names a
> **different path that still exists**, this is a second checkout of a shared id: mint a new id for
> this directory, rewrite `.fray/fray.id`, and carry on. Otherwise adopt the id and refresh the
> record.

No user action, no error, and a moved project still adopts its own id because the recorded path no
longer exists. `(dev, ino)` earns its place here rather than as a primary key: a same-volume `mv`
preserves a directory's inode while `cp -R` does not (measured on APFS — `mv` kept
`16777234:1026769676`, the copy did not), which is what distinguishes "the project moved" from "the
project was duplicated" when both end up at a path the record doesn't know.

The same record is also the recovery path when someone deletes `.fray/`: a directory whose path or
inode matches a known project rejoins its board instead of silently starting a new one. Today that
deletion is advertised as safe ("you can delete `.fray/` and keep every thread and setting"), and
this keeps the promise true.

### Optional prevention: let `.fray/` ignore itself

A `.fray/.gitignore` containing a single `*` makes the whole directory invisible to Git —
verified: `git status` is clean, `git check-ignore` reports `.fray/fray.id` ignored, and the
`.gitignore` ignores *itself*, so `git add -A` cannot commit any of it. It touches only Fray's own
directory, never the user's root `.gitignore`.

Cheap, and it makes the hazard above nearly unreachable. It is a behavior change for existing users
(`.fray/` currently shows up in `git status` until they ignore it themselves, which the README tells
them to do), so it is the human's call, not a detail to slip in. The detection rule above stands
either way, because a user may deliberately commit the directory.

## 4. Root discovery without `rev-parse --show-toplevel`

Property 4 is the subtle one, and it is where a lazy implementation makes users angry: with `cwd` as
the root, `npx frayui` in `~/proj` and in `~/proj/src` are two different boards with two different
thread histories, and nothing tells you why.

Walk up from cwd to `$HOME` (never past it, never to `/`), taking the first hit:

1. `.fray/fray.id` — an existing Fray project always wins (§3).
2. A repository marker: `.git`, and while we're here `.jj`, `.hg`, `.svn` (see §7).
3. A project marker: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `deno.json`,
   `composer.json`, `Gemfile`… — the same heuristic every editor already uses to pick a workspace root.
4. Otherwise **cwd**, and say so in the readout: `project: notes (no repository — using this folder)`.

Two guards worth building in from the start:

- **Never adopt `$HOME` itself** as a project root. A stray `~/package.json` would otherwise turn a
  user's entire home directory into one Fray project, with agents dispatched at it.
- **Confirm on first use.** A one-line prompt in the readout — "no repository here; create a Fray
  project for `~/notes`? [Y/n]" — costs one keystroke and prevents every accidental-root complaint.
  Skip it with `--yes`, and never ask again once `.fray/fray.id` exists.

## 5. The worker prompt

`GIT_DISCIPLINE` is one element of the section array at `workerPrompt.ts:733`, so this is a swap, not
a refactor: pass the project's VCS scope into `loadWorkerPrompt` and select `GIT_DISCIPLINE` or a new
`NO_VCS_DISCIPLINE`.

The replacement block has real content, not just an absence:

- There is no commit to be your undo. Read a file before you overwrite it; prefer additive edits.
- "Landed" means the change is on disk and you have run it — there is no branch, merge, or PR ladder,
  so `done` means verified working, and never mention commits or PRs to this human.
- The `awaiting` fence keeps `human:` and `timer:`; `pr-watch:` is unavailable.

Also make `frayConfigBlock` and the queue's own copy stop assuming a repo — and note the FAQ already
says "Fray doesn't own your git workflow", which becomes true rather than aspirational.

## 6. The thing that makes this genuinely risky

**Fray's entire product is unattended agents rewriting your files. In a repo, `git checkout` is the
undo. In a plain folder there is none.** A bad turn at 2am is unrecoverable, and the user who most
needs that safety net — someone who doesn't use version control — is exactly the one who won't have
made a copy.

So gitless mode should ship *with* a safety story, not as a bare capability. Options, best first:

1. **A shadow repository the user never sees.** `git init` a bare repo at
   `~/.fray/projects/<id>/shadow.git` and drive it with `GIT_DIR`/`GIT_WORK_TREE` pointed at the
   project, committing a snapshot before each dispatch and each turn. The user's directory stays
   pristine — no `.git`, no staged files, no `git status` noise — and they get per-turn restore
   points plus a real diff view of what an agent changed. This is the strongest answer to ask (2)
   *and* a feature for existing repo users, and it keeps the `git` binary dependency, which is why
   ask (3) is worth refusing.
2. **Offer `git init`.** "This folder isn't a repository. Initialize one? [Y/n]" — one keystroke, and
   the user gets real version control they can use later. Honest, tiny, and the right default for
   someone who simply never got around to it. Weak for someone who actively doesn't want a `.git`.
3. **Copy-on-write snapshots** into `~/.fray/projects/<id>/snapshots/`. No git dependency at all, but
   we'd be rebuilding content-addressed storage badly. Only interesting if ask (3) becomes real.
4. **Just warn.** Cheapest, and the option to take only if we're deliberately serving people who have
   decided they don't want restore points.

(1) and (2) compose: offer `git init`, and if declined, fall back to the shadow repo.

## 7. Adjacent, nearly free

Once identity is behind an interface rather than `git config`, other VCSs are a small increment, and
`jj` in particular is worth doing — jj users are disproportionately the "many agents at once" crowd
this product is for.

- **jj**: a colocated repo already has `.git`, so it works today by accident. A non-colocated one has
  only `.jj`; `jj config set --repo fray.id <uuid>` is the direct analogue of the git call.
- **hg / svn / fossil**: root markers for §4; identity falls through to the §3 lookup like any other
  non-Git directory.

Shape: a `ProjectIdentityProvider` with `detect(dir)`, `readId`, `createId`, `scope` — the git
implementation being the existing code moved behind it, and the file implementation being the
fallback that always matches.

## 8. Suggested order

1. `NO_VCS_DISCIPLINE` in the worker prompt + honest degradation of the GitHub surface. Ships value to
   ask (1) immediately and touches no identity code.
2. Identity provider interface; move today's git code behind it unchanged (no behavior change, all
   existing tests must still pass — including the concurrent-first-run one).
3. The `.fray/fray.id` provider plus its `~/.fray/projects/<id>/identity.json` cross-check, and the
   walk-up root discovery with the `$HOME` guard and the first-use confirmation. Drop `git` from
   `REQUIRED_EXECUTABLES` at this point, but keep probing for it, because §6 wants it.
4. The safety story: offer `git init`, else shadow repo.
5. jj, if anyone asks.

Steps 1-3 are the feature. Step 4 is what makes it responsible to advertise.

## Open questions for the human

- Which ask are we serving — (1), (2), or (3)? The answer changes whether the `git` binary stays a
  dependency, and (3) is the only one that forecloses the shadow repo.
- Is a per-turn shadow repo interesting as a feature for *repo* users too (a real "what did this
  agent change" diff, and a restore point that doesn't touch their index)? If yes, it's worth
  building first and letting gitless fall out of it.
