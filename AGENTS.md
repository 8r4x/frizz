# No pull requests — land on local `main`

This repo does NOT use pull requests. Ever. NEVER run `gh pr create` (or the `gh api .../pulls` POST
equivalent, or the GitHub UI) — not for a typo, not for a big feature, no size threshold, no
exception. This binds EVERY agent that touches this repo: the top-level worker and every sub-agent it
dispatches. If you find yourself about to open a PR, STOP — in this repo that is always the wrong move.

Land finished work on this machine's local `main` instead: work directly on `main`, or do
isolated/messy work in a git worktree on a local branch (`git worktree add <dir> -b <slug>`) and, when
it's done and you're confident, merge it back yourself (`git switch main && git merge <slug>`) and
remove the worktree. Getting the change onto local `main` is your job — never push a branch to stage a
review and never hand back an unmerged branch. Reading GitHub (issues, PRs, CI) is fine; creating or
pushing a PR is not. (`FRAY.md` states this in full; it is repeated here because Codex re-reads
`AGENTS.md` fresh every session and sub-agents load it, whereas the fray worker contract can be frozen
at session start.)

Git hygiene does NOT matter here — the only thing that matters is getting your changes onto local
`main`. Many agents (and the human) work in parallel against the same repo constantly, so `main` moves
under you and the shared working tree is often dirty with someone else's in-progress edits. Do not let
that block you and do not wait it out: commit whatever is in the working tree first (an intermediate
`git add -A && git commit -m "wip: snapshot in-flight work"` is fine — committing another agent's
uncommitted changes to unblock your merge is EXPECTED, not a violation), then merge your branch in and
resolve conflicts favoring a correct build of your own change. A messy history, a WIP commit that mixes
several agents' work, an ugly merge — all fine. Never `git stash` in the shared tree (it corrupts
concurrent agents), never force-discard someone's committed work, and never stall a landing on "the
tree isn't clean." Keep merging into `main`.

## Committing out of a tree other agents are editing

**Default to `git commit -m "…" -- <paths>`.** The pathspec form commits the working-tree content of
exactly those paths on top of `HEAD` through a temp index git seeds for you, so a concurrent `git add`
by another agent cannot ride along and the shared index is left as you found it.

**Do NOT reach for `GIT_INDEX_FILE=/tmp/idx git add … && git commit`.** A temp index path that does not
exist yet starts EMPTY, not as a copy of `HEAD` — `git commit` then writes a tree holding only the
paths you added, recording *every other tracked file* as deleted. The working tree is untouched, so
nothing looks wrong until someone checks that commit out. This has cost real recovery cycles more than
once. If you genuinely need a private index (only to `git apply --cached` one hunk out of a file
another agent is also editing), run `git read-tree HEAD` immediately after setting the path.

Either way, **verify the tree right after committing**: `git ls-tree -r --name-only HEAD | wc -l`
should be roughly what it was before, not collapsed to the size of your change.

`scripts/githooks/pre-commit` backstops this — it refuses any commit that records files as deleted
while they still exist on disk, which a genuine `git rm` cannot trigger because that removes the file
from disk too. It is wired through `core.hooksPath`, which is LOCAL config, so in a fresh clone run:

```sh
git config core.hooksPath scripts/githooks
```

# Web UI completion rule

For any user-visible web UI change, work is not complete until end-to-end Chrome or Chromium QA has
exercised the affected workflow. Unit, typecheck, and build tests do not substitute for it. The handoff
must carry the inspected screenshots, console/page-error evidence, the optical-review result, and
explicit browser-cleanup confirmation. This does not apply to purely non-UI changes.

**Load the `adhoc-cdp` skill for how** — the isolated disposable stack, the headless screenshot paths
(Chrome DevTools MCP preferred, `scripts/shot.mjs` as the reliable background fallback), which states
and widths to capture, browser process hygiene (one owned instance per task; never a global close or a
broad `pkill`), and how to embed evidence so fray renders it inline.

# Visual alignment is the implementer's job, not a review someone else does

**Load the `visual-review` skill whenever you place an icon, glyph, emoji, badge, chip, or counter next
to text — and before you declare any new UI correct.** It carries the ink-measurement routine, the
per-glyph offsets it produced, and the instrument bug that makes a naive baseline probe report ~3x the
real error. Two non-negotiables from it:

- **You are the first reviewer of your own screenshot.** Capturing evidence is not reviewing evidence.
  Read the shot back and actively hunt for what is wrong with it — a glyph riding high, mismatched visual
  weight, a collision at a narrow width. Never hand over a screenshot you have not personally critiqued.
  Capture at a scale where the detail is judgeable; a 40px component inside a 1400px shot cannot be
  reviewed, and glancing at it counts for nothing.
- **Icon-beside-text alignment is an INK problem, and every glyph differs.** `items-center` centers a
  glyph's BOX on the flex line; the eye aligns ink. A digit has no descender, an SVG's ink sits wherever
  its path falls inside its viewBox, an emoji ignores your font size — so one shared nudge cannot fix a
  cluster. Measure each glyph, correct each in `em`, then re-measure and confirm the residual is ~0.

Do not ship "it renders" and wait to be told it looks wrong. If the pattern exists in a real product
(GitHub, Linear, this app's own components), measure the real one and mirror it instead of designing
from taste.

# Copy capitalization: sentence case, never title case

All user-visible copy uses SENTENCE case — capitalize only the first word and any proper nouns. This
covers button and menu labels, headings, section titles, toasts, and thread titles. Never Title-Case
Every Word (write "Confirm snooze", "Mark as done", "Fix queue focus" — not "Confirm Snooze", "Mark As
Done", "Fix Queue Focus"). Acronyms (PR, CI, API) keep their established casing. When an agent titles a
thread, the same rule applies.

**"Fray" is a proper noun — always capitalize it in prose.** The product is Fray; write "Fray
dispatches a worker", never "fray dispatches a worker". Lowercase survives only in literal
identifiers, where it is part of the name: `npx frayui`, `FRAY.md`, `.fray/`, `~/.fray/`,
`tmux -L fray`, the `fray`/`fray-update` CLIs, and the `fray:*` skill and sub-agent profile names.

# "Shipped" means merged into the primary branch

Never describe a created, opened, or pushed PR as "shipped." An open PR is implemented, pushed,
ready for review, or awaiting merge. Use "shipped" only after the change has actually been merged
into the repository's primary branch. This applies to progress updates, final handoffs, and signal-card
bullets.

# Project-local skills and tools are shared across agents

Any project-local skill or tool lives in ONE agent-neutral copy that every agent configuration
discovers — never a per-agent fork. Skills live canonically in `.agents/skills/<name>/` (Codex
discovers this path natively); `.claude/skills/<name>` is a relative symlink into that canonical copy
so Claude Code discovers the identical content. When adding a skill, create it under
`.agents/skills/` and add the symlink; verified end-to-end 2026-07-21 with `adhoc-cdp` (Claude lists
it through the symlink, `codex exec` resolves it at `.agents/skills/adhoc-cdp/SKILL.md`). Shared
tooling scripts follow the same rule: one copy in an agent-neutral location (e.g. `scripts/`),
referenced from skills — never duplicated into agent-specific config trees.

# Use Nub for the Node toolchain

Prefer Nub over direct `node`, `npm`, `npx`, `pnpm`, `yarn`, `tsx`, or `ts-node` commands. Run
JavaScript and TypeScript files with `nub <file>`, package scripts with `nub run <script>`, installed
CLIs with `nubx <tool>`, tests with `nub --test`, and installs with `nub install`. Nub transpiles
TypeScript but does not typecheck it, so keep `tsc --noEmit` and project typecheck gates separate.

# Agent completion invariant

Once spawned, an agent runs to its terminal return. Do not interrupt or cut off an active agent to
reduce churn, reclaim slots or quota, redirect work, respond to a user steer, contain live-server
instability, or hurry completion. Deliver new direction through the agent's message/follow-up path,
then reconcile obsolete or conflicting results after it returns. Mid-turn interruption can leave
partially applied edits, tests, and owned processes behind, making the resulting repository state
unsound. Isolate or restart only the affected unstable service; never stop a writer to stabilize it.
If an agent appears hung or continuing would be dangerous, use the interactive question path to ask the
user. The sole exception is an explicit user instruction that names the interruption.
