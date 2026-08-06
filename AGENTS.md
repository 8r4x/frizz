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
pushing a PR is not. (`FRIZZ.md` states this in full; it is repeated here because Codex re-reads
`AGENTS.md` fresh every session and sub-agents load it, whereas the frizz worker contract can be frozen
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

# Web UI completion rule — proportionate, not reflexive

Browser QA is for the changes where a browser is what actually settles the question, not for every diff
that happens to touch a `.tsx` file. Judge the change in front of you.

**Drive it in Chrome, and carry the evidence in your handoff** (inspected screenshots, console/page-error
check, the optical-review result, explicit browser-cleanup confirmation) when the change is: a new or
restructured surface, layout or interaction flow; anything judged OPTICALLY — spacing, alignment, colour,
truncation, a glyph beside text; behaviour you cannot predict from the code alone (live state, timing,
streaming, restart/recovery, a seam between processes); a fix no test pins where the bug actually lives;
or anything large, cross-cutting, or that you are unsure of.

**Skip it for the small and the certain** — a targeted fix in code you have read, pinned by a test at the
right level, with a blast radius you can name; docs, comments, types, provably mechanical edits; and
anything with no browser surface at all (prove that in its own real runtime). Then say plainly in the
handoff what you verified and how, so the maintainer can weigh the call. Confidence is earned, never
asserted: "it should work" is not confidence, a green unit test over a stubbed seam is not either, and
you never describe something as driven or verified when it was not.

**Load the `adhoc-cdp` skill for how** — the isolated disposable stack, the headless screenshot paths
(Chrome DevTools MCP preferred, `scripts/shot.mjs` as the reliable background fallback), which states
and widths to capture, browser process hygiene (one owned instance per task; never a global close or a
broad `pkill`), and how to embed evidence so frizz renders it inline.

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

**And load the `optical-spacing` skill whenever you set or judge the spacing of a ROW of controls** —
an icon strip, a button rail, a footer of mixed glyphs and pills. The same law sideways: `gap` spaces
boxes, so a bare glyph in a hover square and a bordered pill on one uniform `gap` drew ink distances
from 5.78px to 20.50px on a single strip. It carries the ink-gap instrument (this repo's copy is
`scripts/ink-gaps.mjs`), the negative-margin fix, and the pen-width rule for matching perceived weight
— which no colour token can fix. It is a GLOBAL skill, not one of this repo's, so it needs no entry in
`.agents/skills/`.

## Every UI change gets an OPTICAL SPACING PASS before you call it done — no exceptions, no threshold

Any time you implement or touch any UI, measure the spacing the eye actually reads before you hand it over. This is not conditional on the change looking like an "icon strip", and not something to reach for only when someone complains. It is the last step of implementing UI, the same way running the tests is the last step of implementing logic.

- **Two marks on one line ARE a row.** A label and its chevron. A gerund and its elapsed clock. A badge beside a title. If you can name two things sitting side by side, the skill applies — that is the reading that keeps getting missed, because "row of controls" sounds like a toolbar and a disclosure row does not.
- **A `gap` is not a distance.** It spaces BOXES, and small glyphs are mostly empty box. Lucide's chevron paints 4.67 of its 14 box px, a third of dead space per side — so `gap-1` beside its label and `gap-2` before its clock drew **9.06px and 13.00px** of ink where the CSS claimed 4 and 8, and the chevron floated equidistant between the two instead of reading as the label's handle (maintainer 2026-08-05: *"Fix the fucking optical spacing on that chevron"*). Nothing in the CSS looks wrong; you only see it by measuring the pixels.
- **Run the instrument, both axes.** `scripts/ink-gaps.mjs` for horizontal ink gaps, the `visual-review` ink routine for vertical ink-vs-cap-band. One caveat that will bite: once a negative margin makes boxes overlap, `ink-gaps.mjs` unions the NEIGHBOUR's ink into the mark and reports nonsense — switch to geometry then (an SVG child's `getBoundingClientRect` IS its ink box; canvas `actualBoundingBox*` gives a string's ink edges).
- **Then look at it, cropped, at dsf 6–8.** The numbers say whether the gap is what you set; only the picture says whether what you set is right. Both failures happened here in one sitting: shipping 9.06px because the CSS said 4, then over-collapsing to 4.4px because the trim was correct and the target was not.
- **Put the corrections in ONE place with the readings in the comment,** not per call site. Three chevrons in one column each placed by hand had drifted into two vertical offsets, two tones, and a horizontal rhythm nobody had ever measured. They are measurements, not taste — the next reader has to know to re-measure rather than re-guess.

Do not ship "it renders" and wait to be told it looks wrong. If the pattern exists in a real product
(GitHub, Linear, this app's own components), measure the real one and mirror it instead of designing
from taste.

# Copy capitalization: sentence case, never title case

All user-visible copy uses SENTENCE case — capitalize only the first word and any proper nouns. This
covers button and menu labels, headings, section titles, toasts, and thread titles. Never Title-Case
Every Word (write "Confirm snooze", "Mark as done", "Fix queue focus" — not "Confirm Snooze", "Mark As
Done", "Fix Queue Focus"). Acronyms (PR, CI, API) keep their established casing. When an agent titles a
thread, the same rule applies.

**"Frizz" is a proper noun — always capitalize it in prose.** The product is Frizz; write "Frizz
dispatches a worker", never "frizz dispatches a worker". Lowercase survives only in literal
identifiers, where it is part of the name: `npx frizz`, `FRIZZ.md`, `.frizz/`, `~/.frizz/`,
`frizz-<slug>` session names, the `frizz`/`frizz-update` CLIs, and the `frizz:*` skill and sub-agent profile names.

# Board nomenclature: "active" means SPINNING, and nothing else

The sidebar's row groups have names the maintainer uses precisely (2026-08-05: *"when I say active, I'm only referring to the things that are currently spinning; the things beneath that, I would refer to as rested, or just items in the queue"*). Use them in code, comments, copy and when reporting back:

- **Active** — only the rows currently spinning, above the rule. Never carries a queue card.
- **Rested** — everything below that rule; the same set as **"the queue"** / "items in the queue", one row per card.
- **Held** — the dimmed, labeled park band (a `human:` gate, a future `timer:`, a wall-clock snooze, an auto-resumed limit pause).
- **Done** — the collapsed archived section.

The trap is that `groups.ts` `sectionOf` returns `"active"` for Active AND Rested rows alike — that key names the `<section>` holding both bands, not the maintainer's word. `partitionActive` splits it (`.running` = Active, `.rested` = Rested), and `inActiveBand` is the one predicate that means Active exactly. Full detail, including why the archived key is `"inactive"` while its label reads Done, in `ARCHITECTURE.md` § Board nomenclature.

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

**A GLOBAL skill takes the identical shape one level up**: canonical in `~/.agents/skills/<name>/`,
with relative symlinks at `~/.claude/skills/<name>` and `~/.codex/skills/<name>` (both `../../.agents/…`
— `~/.codex/skills` is two levels deep, not one, and getting that wrong yields a dangling link that
still `ls`es fine). A global skill must BUNDLE any script it needs beside its `SKILL.md`; it cannot
reach into a repo's `scripts/`. And a skill belongs in exactly one scope — never a project copy AND a
global copy of the same name, or they drift and the agent lists it twice.

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
