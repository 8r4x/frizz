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
   Code or Codex on it. Once §6 is honored, **this collapses into (2)**: nothing in a plain directory
   calls `git` at all, so serving (2) serves (3) for free.

My read: **(2), with (1) folded in.** They are one change, and (3) comes along with them.

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

To be clear about the location, because it looks like a new one and isn't:
`~/.fray/projects/<id>/` is **already** where a project's entire durable state lives — `ui.db`, the
logs, the launch owner, the artifact pointer. The README states it as the deal ("everything durable
lives outside your checkout in `~/.fray/projects/<id>/`, so you can delete `.fray/` and keep every
thread and setting"). `identity.json` is one small file beside the database it identifies, in a
directory that exists the moment the project does. Nothing new is written to the home directory.

Two of those files already record the project's path today — `tmux-socket-migration.json` carries
`projectDir` and so does `launcher.json` — so the check could read one of them instead of adding a
file. Not worth it: one is tmux-specific and would follow tmux out, the other is launch state whose
lifetime is a run, and identity deserves a record that means what it says.

No user action, no error, and a moved project still adopts its own id because the recorded path no
longer exists. `(dev, ino)` earns its place here rather than as a primary key: a same-volume `mv`
preserves a directory's inode while `cp -R` does not (measured on APFS — `mv` kept
`16777234:1026769676`, the copy did not), which is what distinguishes "the project moved" from "the
project was duplicated" when both end up at a path the record doesn't know.

The same record is also the recovery path when someone deletes `.fray/`: a directory whose path or
inode matches a known project rejoins its board instead of silently starting a new one. Today that
deletion is advertised as safe ("you can delete `.fray/` and keep every thread and setting"), and
this keeps the promise true.

### Prevention: offer to ignore it, at the moment it is created

**Decided: ask.** The first-run prompt (§4) offers to add `.fray/` to a `.gitignore` that already
exists. That is not an opinion about the user's version control — it is Fray asking what to do about
Fray's own footprint, at the one moment the question is in front of them.

Rejected alternative: a `.fray/.gitignore` containing a single `*`, which makes the directory
invisible to Git and ignores *itself*, so `git add -A` cannot commit any of it (verified: clean `git
status`, `check-ignore` reports both the id and the `.gitignore` as ignored). Strictly more reliable,
and it needs no existing `.gitignore` — but it is Fray deciding unilaterally what belongs in
someone's repository, silently, in a file they did not write. Asking is worse mechanically and better
on the principle, and the principle is the one being defended here.

The detection rule above stands either way: a user may decline, may have no `.gitignore`, or may
commit the directory deliberately.

## 4. Root discovery without `rev-parse --show-toplevel`

Property 4 is the subtle one, and it is where a lazy implementation makes users angry: with `cwd` as
the root, `npx frayui` in `~/proj` and in `~/proj/src` are two different boards with two different
thread histories, and nothing tells you why.

Walk up from cwd to `$HOME` (never past it, never to `/`), taking the first hit:

1. `.fray/fray.id` — an existing Fray project always wins (§3).
2. A repository marker: `.git`, and while we're here `.jj`, `.hg`, `.svn` (see §7).
3. A project marker: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `deno.json`,
   `composer.json`, `Gemfile`… — the same heuristic every editor already uses to pick a workspace root.
4. Otherwise **cwd**. The readout already prints the chosen root (`project: notes — ~/notes`), which
   is the whole disclosure needed — it is a statement of what Fray picked, not a remark about what
   the directory is or isn't.

Two guards worth building in from the start:

- **Never adopt `$HOME` itself** as a project root. A stray `~/package.json` would otherwise turn a
  user's entire home directory into one Fray project, with agents dispatched at it.
- **Confirm on first use, and say what will be written.** The prompt's job is not to ask permission
  in the abstract — it is to name the directory Fray is about to create, at the moment it would be
  created. The maintainer's copy, verbatim:

  ```
  Fray writes into a .fray directory to store session state. 
  This directory will be created automatically and added to .gitignore.
  Continue? [Y/n] >
  ```

  Skip it with `--yes`, and never ask again once `.fray/fray.id` exists.

  **One detail to settle:** line 2 states the `.gitignore` addition as fact, but the standing rule is
  to append only to a `.gitignore` that already exists — Fray creating one would be Fray deciding the
  user should have version control, which §6 rules out. So in a directory with no `.gitignore` the
  sentence is not true as written. Either drop that sentence in that case, or create the file. The
  copy above is exact for the common case; the no-`.gitignore` variant is the human's call.

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

## 6. What Fray deliberately does NOT do here

**Fray has no opinion about version control.** That is a product position, not an oversight, and it
is the one the README already makes: *"Fray adds no worktrees, no branches, no dev server, no build
integration, no workflow engine to fight with"* and *"Fray doesn't own your git workflow."* Running
outside a repository must not become the exception where Fray suddenly develops opinions.

So, concretely, none of these:

- **No `git init` offer.** Not a prompt, not a flag suggestion, not a hint in the readout. A user in a
  plain directory has either decided about version control or hasn't thought about it, and neither is
  Fray's business.
- **No warning that agents can't undo.** Nobody needs a localhost dashboard editorializing about
  their setup, and a notice nobody can action is just nagging.
- **No snapshots, no backups, no shadow anything.** See below.
- **No `.gitignore` writing** — already the standing promise, and it extends to not writing a
  `.gitignore` *inside* `.fray/` unless that is chosen on its own merits (§3), not as a safety measure.

The only thing that IS ours is the inverse: a worker prompt that assumes a repo when there isn't one.
`GIT_DISCIPLINE` (`workerPrompt.ts:200`) currently tells every agent to commit small and often and to
treat "landed" as a merge. Swapping it for `NO_VCS_DISCIPLINE` in a non-repo (§5) is **removing** an
opinion Fray holds, not adding one — which is exactly the direction this section argues for.

### Rejected: a hidden "shadow" repository

An earlier draft's headline idea was a bare repo at `~/.fray/projects/<id>/shadow.git`, driven with
`GIT_DIR`/`GIT_WORK_TREE` at the project, snapshotting every turn — version control the user never
sees. **Rejected, and it should stay rejected**, for reasons that outlive the opinionation argument:

- It copies the entire contents of a directory the user never offered into a store outside it. A
  `.env`, an `id_rsa`, a customer CSV sitting in a scratch folder all end up in `~/.fray`, and they
  **survive deleting the project**, because the shadow lives outside it. Fray's README promises its
  state lives outside your checkout; silently doing the reverse with your file *contents* is a
  different promise entirely.
- `GIT_DIR`/`GIT_WORK_TREE` are environment variables, and Fray's whole job is spawning agent
  processes that run `git`. Any leak into a worker's environment points that agent's commits at the
  shadow — or, in a directory that later becomes a real repo, silently mixes the two. That is a
  data-loss footgun, not an inconvenience.
- It grows without bound and without visibility, per turn, on a directory of unknown size.

The principle worth keeping from all of it: **Fray should never copy a user's files somewhere they
did not ask for, and should not become a backup system.**

### The consequence, stated plainly

An agent working in a directory with no version control can destroy work, and Fray will neither
prevent it nor mention it. That is the same deal a user already gets from running `claude` in that
directory themselves, which is the bar Fray holds itself to everywhere else: *"a thread behaves like
a Claude Code session you started yourself."* Document it once in the README's FAQ, where someone
looking for it will find it, and nowhere else.

One thing falls out of this: with the `git init` offer gone, **nothing in a plain directory wants the
`git` binary at all.** Ask (3) from the top of this document collapses into ask (2) rather than being
a separate project.

## 7. Adjacent, nearly free

Once identity is behind an interface rather than `git config`, other VCSs are a small increment, and
`jj` in particular is worth doing — jj users are disproportionately the "many agents at once" crowd
this product is for.

- **jj**: a colocated repo already has `.git`, so it works today by accident. A non-colocated one has
  only `.jj`; `jj config set --repo fray.id <uuid>` is the direct analogue of the git call.
- **hg / svn / fossil**: root markers for §4; identity falls through to `.fray/fray.id` (§3) like any
  other non-Git directory.

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
   `REQUIRED_EXECUTABLES` — outright, not to a soft probe, since §6 leaves nothing that wants it.
4. One FAQ line in the README about what a plain directory does and doesn't get. Nothing in the
   product (§6).
5. jj, if anyone asks.

Steps 1-3 are the feature; there is no separate safety workstream, by design.

## 9. What this does NOT do: Git stops being REQUIRED, not used

Worth stating flatly, because "drop `git` from `REQUIRED_EXECUTABLES`" reads like more than it is.
After all of the above, Fray launches and runs in any directory — but on a machine that has Git, in a
directory that is a repository, **almost nothing changes**:

| | in a Git repo | in a plain directory |
| --- | --- | --- |
| Project root | `rev-parse --show-toplevel`, as today | marker walk-up (§4) |
| Identity | `git config --local fray.id`, as today | `.fray/fray.id` (§3) |
| Worktree = its own board | yes, via `--git-dir`/`--git-common-dir` | n/a — no worktrees |
| GitHub picker, `pr-watch:` | yes | hidden; the fence keeps `human:`/`timer:` |
| Worker prompt | `GIT_DISCIPLINE` | `NO_VCS_DISCIPLINE` (§5) |
| Undo for a bad turn | whatever the user set up | whatever the user set up — Fray neither supplies nor mentions one (§6) |

**Existing repo projects keep using `git config --local fray.id`, and do not migrate.** Using the
file everywhere would be one less code path, but it would hand every existing user a new tracked file
in a directory many of them have never ignored — reintroducing the committed-id hazard for the
largest population, where today it is structurally impossible. The provider interface exists for
exactly this; two implementations is the point, not a compromise.

So the honest summary is: **in a repository Fray keeps using Git exactly as it does today, and in a
plain directory it does not call Git at all.** What goes away is the hard failure — `fray-dev must be
run inside a Git repository` — and the assumption that a project must be a repo. What does *not*
appear is any new opinion: no offer, no warning, no fallback version control. A repo is better
because Git is better, not because Fray rewards you for it.

## 10. What is in `~/.fray`, and what could be project-local

The question this document kept provoking — *why write to the home directory at all?* — deserves the
measurements rather than an argument. Taken from this machine, 35 projects:

| | where | size | could it be project-local? |
| --- | --- | --- | --- |
| `builds/` — promoted Fray artifacts | `~/.fray` | **1.8 GB**, 59 digests | **No.** One artifact serves every project; per-project means copying the runtime 35 times |
| `ports/`, the global launch lock | `~/.fray` | ~0 | **No.** Port allocation coordinates ACROSS projects; that is what makes it global |
| `quota-cache/` | `~/.fray` | 4 KB | **No.** Keyed by provider account, not by project |
| `projects/<id>/browser-profile` | `~/.fray` | **1.51 GB** | Technically yes, and obviously not — that is a Chrome profile per project, in someone's source tree |
| `projects/<id>/` everything else — `ui.db`, logs, attachments, daemon records, locks | `~/.fray` | **27.8 MB total**, ~800 KB per project | **Yes.** This is the part a reasonable person means by "session state" |
| daemon sockets | `$TMPDIR` | — | Already neither: hashed into `$TMPDIR` because a unix socket path cannot exceed 104 bytes on macOS (`claude-broker-host.ts:29`) |

So the split is: **two large caches and one cross-project coordinator that cannot move, a Chrome
profile nobody wants in their repo, and about 800 KB per project of actual session state that
genuinely could live in `.fray/`.**

Worth correcting an implication from earlier in this document: socket path length is *not* an
argument for `~/.fray`. Sockets already live in `$TMPDIR` under a 16-hex-char hash for exactly that
reason, and the record that points at them notes "long paths are fine here". The layout question is
about size, sharing and coordination — not about paths.

### If the 800 KB moved into `.fray/`

For, honestly:

- The project becomes self-contained. Move it, copy it to another machine, and its threads come with
  it — the same property that made the id belong there (§3).
- No orphaned state. Today, deleting a project directory leaves its state dir behind forever; there
  are 35 of them here, and no one can say which still have a directory on the other end.
- It answers this question permanently, which has non-trivial value for a tool asking people to trust
  it with a repo.

Against:

- **A live SQLite database in a synced directory is a corruption hazard.** Dropbox, iCloud Drive and
  OneDrive do not understand WAL files, and a scratch folder is exactly the kind of place that gets
  synced. `~/.fray` is not.
- It inverts a promise the README currently makes — "everything durable lives outside your checkout
  … you can delete `.fray/` and keep every thread and setting" — and that promise is load-bearing for
  the §3 recovery rule.
- `ui.db-wal`/`ui.db-shm` churn inside a working tree, which every `git status` and every file
  watcher in the user's editor will see. The `.gitignore` offer covers Git; it does not cover the
  watcher.

**Not a decision this document needs to make.** Gitless projects work identically either way, and the
`.fray/fray.id` file (§3) is settled regardless. Recorded here so the layout question is answered
with numbers next time it comes up, rather than re-litigated.

## Open questions for the human

None outstanding — §3 (identity), §4 (root discovery and the first-run prompt) and §6 (no opinions)
are all settled. The next move is step 1 of §8, which is independent of everything else here.
