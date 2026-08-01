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

## 3. Identity without Git — three options

### A. A file in the project: `.fray/fray.id`  ← recommended

Fray already writes `.fray/` into the working tree (thread scratchpads, hook state — the README says
so), so this adds no new footprint and no new thing to explain.

- Property 1: our own atomic write. `tmux-socket.ts:239`'s `atomicJson` (open `wx` → fsync → rename →
  fsync dir) is exactly this, and `acquireNamedLaunchLockSync` re-keys from `commonGitDir` to the
  canonical directory with no structural change.
- Property 2: read after `realpathSync`, same as today.
- Property 3: **free** — the id travels with the directory because it's *in* it. Strictly better than
  a path-keyed registry.
- Property 4: needs a walk-up (§4).
- Cost: a user who deletes `.fray/` loses the mapping and gets a fresh board. Today that's advertised
  as safe ("you can delete `.fray/` and keep every thread and setting") — that promise would have to
  narrow, or be preserved by the alias index in option C.

### B. A registry in `~/.fray`: canonical path → id

Nothing lands in the user's directory at all.

- Property 3 **fails**: move or rename the folder and the board is orphaned. For a scratch folder —
  exactly the population this feature is for — renaming is routine.
- Property 1 needs the same lock work as A, so it saves nothing.
- Genuinely better only if writing to the project directory is unacceptable, which it isn't, since we
  already do.

### C. A + a `~/.fray/aliases` index

Write `.fray/fray.id`, and also record `canonical path → id` centrally. The file wins when present;
the index recovers a project whose `.fray/` was deleted, and detects a *copied* directory (same id at
two paths — which is the non-git twin of the duplicate-`fray.id` case the tmux socket resolver already
fails closed on, `tmux-socket.ts:399`).

Strictly more capable than A, and strictly more code. **Start at A, keep the index in mind for the
copy-detection case**, which is the only failure mode that silently corrupts state rather than merely
losing it.

## 4. Root discovery without `rev-parse --show-toplevel`

Property 4 is the subtle one, and it is where a lazy implementation makes users angry: with `cwd` as
the root, `npx frayui` in `~/proj` and in `~/proj/src` are two different boards with two different
thread histories, and nothing tells you why.

Walk up from cwd to `$HOME` (never past it, never to `/`), taking the first hit:

1. `.fray/fray.id` — an existing Fray project always wins.
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
- **hg / svn / fossil**: root markers for §4; identity can just use the `.fray/fray.id` file.

Shape: a `ProjectIdentityProvider` with `detect(dir)`, `readId`, `createId`, `scope` — the git
implementation being the existing code moved behind it, and the file implementation being the
fallback that always matches.

## 8. Suggested order

1. `NO_VCS_DISCIPLINE` in the worker prompt + honest degradation of the GitHub surface. Ships value to
   ask (1) immediately and touches no identity code.
2. Identity provider interface; move today's git code behind it unchanged (no behavior change, all
   existing tests must still pass — including the concurrent-first-run one).
3. `.fray/fray.id` file provider + the walk-up root discovery, with the `$HOME` guard and the
   first-use confirmation. Drop `git` from `REQUIRED_EXECUTABLES` at this point — but keep probing
   for it, because §6 wants it.
4. The safety story: offer `git init`, else shadow repo.
5. jj, if anyone asks.

Steps 1-3 are the feature. Step 4 is what makes it responsible to advertise.

## Open questions for the human

- Which ask are we serving — (1), (2), or (3)? The answer changes whether the `git` binary stays a
  dependency, and (3) is the only one that forecloses the shadow repo.
- Is a per-turn shadow repo interesting as a feature for *repo* users too (a real "what did this
  agent change" diff, and a restore point that doesn't touch their index)? If yes, it's worth
  building first and letting gitless fall out of it.
