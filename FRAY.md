# Worker norms for this repo

## Work independently, see it through

When you're given a task, own it end to end. Make the reasonable calls yourself and drive the work
all the way to completion — don't stop halfway to ask for direction the task already implies, and
don't hand back a plan where a finished change was asked for. Come back to the human only for
genuinely human-owned decisions (product/security posture, destructive or irreversible actions) or a
real blocker.

## Decide and proceed — signal the call, don't stall on it

When the task underspecifies something, your default is to DECIDE, not to ask. A reversible call
costs minutes to redo; a round-trip to the human costs hours — so the bar for stopping is high, and it
clears only when a wrong guess would be both costly and hard to undo.

- **Proceed on any call you can reverse, and on any call you hold with high confidence.** If it's
  derivable from the code, the conventions, or ordinary engineering judgment, it's yours — make it and
  keep moving rather than handing back a question you could have answered.
- **Give the human some indication of the approach you took, as you take it.** When you proceed on a
  judgment call, name the direction you chose (and the notable alternative you passed on) so they can
  course-correct early. A confident call the human can see is fine; a silent one they can't catch is not.
- **Reserve questions for the genuinely human-owned and irreversible** — product or security posture,
  destructive or irreversible actions, external-facing commitments, or a fork where a wrong pick is
  expensive to unwind. Those earn a round-trip; little else does.
- **Account for your decisions in the results summary.** Whenever you report back, explain the calls
  you made along the way — the assumptions, the forks you resolved, the alternatives you rejected — so
  the human reads your reasoning off the summary instead of reverse-engineering it from the diff.

## Verify end-to-end — test the whole, not the parts

Every change you land needs REAL end-to-end verification: exercise the actual behavior in the actual
runtime, the way it will really run, and observe the real outcome. This is non-negotiable.

- **Testing the real thing is the PRIMARY confidence mechanism — adversarial review is a supplement,
  never a substitute, and never a reason to reach for a reviewer instead of a test.** If a change CAN
  be exercised end-to-end, do THAT first; do not dispatch a self-review or a fresh-context reviewer as
  a headline step in place of actually running it. A review only reasons about the code; a test
  observes the runtime — and the runtime is the authority. When you catch yourself spinning up an
  adversarial review of something you could instead just run, STOP and run it. Reserve review for what
  you genuinely cannot execute yet (e.g. an unbuilt design), and even then treat its findings as
  hypotheses to VERIFY by testing — not as verification. A reviewed plan is not a tested change.
- Testing the pieces in isolation is NOT end-to-end. A passing unit test, a mock, a typecheck, or a
  hand-driven PROXY (e.g. invoking a CLI yourself with the flags the server *would* have passed, and
  concluding the server-spawned path works) proves the parts — not the whole. The seam between the
  parts is exactly where the bug lives. If a feature spawns/injects/renders something, drive the REAL
  spawned/injected/rendered thing and confirm the observable result: the tool actually shows up in a
  real worker's registry and is callable; the page actually renders in a real browser; the request
  actually succeeds against a real server. "I verified the components" is how a broken feature ships.
- If genuine end-to-end testing is truly infeasible, that does NOT lower the bar — it raises it. Do a
  rigorous ADVERSARIAL self-review: attack your own assumptions, enumerate every way the change could
  fail in the real runtime, and trace the full path yourself end to end. Then dispatch a fresh-context
  reviewer to do the same against your diff.
- Never present an isolated or proxy check as if it were end-to-end. In your handoff, state plainly
  what you actually exercised and what you could NOT, and why. "It should work" is not "it works" —
  do not claim a thing is verified or done when you have only verified a stand-in for it.

## Dial in the visuals yourself — "it renders" is not "it looks right"

For UI work, running the thing is only half the gate. The other half is JUDGING what you rendered, and
it is the half that keeps getting skipped — this section exists because the maintainer has had to say
"the alignment is off" one time too many on work that was otherwise finished and verified.

**Load the `visual-review` skill** the moment you place an icon, glyph, emoji, badge, chip, or counter
beside text, and before you call any new UI correct. It carries the ink-measurement routine, the
per-glyph numbers it produced, and the instrument bug that makes a naive baseline probe report ~3x the
real error. The two rules to internalize:

- **You are the first reviewer of your own screenshot.** Taking the shot is not reviewing the shot. Read
  it back and hunt for what is wrong with it — a glyph riding high or low, one mark visually heavier than
  its neighbours, something colliding or clipping at a narrow width. Capture at a scale where the detail
  is actually judgeable (a 40px component inside a 1400px frame cannot be reviewed). If you would not
  ship it to a design-conscious colleague without a caveat, fix the caveat instead of writing it.
- **Icon-beside-text alignment is an INK problem, and every glyph differs.** `items-center` centers a
  glyph's BOX on the flex line, but the eye aligns ink: a digit has no descender so its ink rides high,
  an SVG's ink sits wherever its path falls inside its viewBox, an emoji ignores your font size. One
  shared nudge therefore cannot fix a cluster — measure each glyph, correct each in `em` so it tracks
  the font size, then re-measure and confirm the residual is ~0. Leave sub-pixel offsets alone.

And when the pattern already exists in a real product — GitHub, Linear, this app's own components — go
measure the real one and mirror it rather than designing from taste. Reading the real DOM settles in one
call what two rounds of guessing will not.

## Git: land on local `main` — NEVER open a pull request

**This repo does NOT use pull requests. At all. Ever.** This section OVERRIDES fray's default
worktree/branch/PR discipline in full: wherever the base contract tells you to "open a PR and report
its URL," do the exact opposite — the finished work lands in this machine's local `main`, and it never
touches GitHub as a PR.

- **NEVER open a pull request. NEVER run `gh pr create` (or any equivalent — the GitHub UI, a push
  that opens a PR, anything).** Not for a typo, not for a one-line fix, not for a big feature — there
  is no size threshold and no exception. If you find yourself about to create a PR, STOP: in this repo
  that is always the wrong move. This is the single most-violated rule here — treat any impulse to
  "open a PR for review" as a bug in your own plan and correct it before acting.
- **Don't push a branch to the remote to stage a review either.** The remote plays no part in landing
  work. Reading GitHub (issues, PRs, CI) is fine; creating or pushing a PR is not.
- **The default is to work directly on `main` and commit there.** A small, self-contained change needs
  no branch and no worktree — edit, verify, commit on `main`, done.
- **Use a git worktree freely whenever you want isolation** — messy in-progress work, isolated and
  end-to-end testing, spinning up a disposable dev server, anything you'd rather keep off the shared
  tree. Create it on a local branch (`git worktree add <dir> -b <slug>`), do the work and the testing
  there, and commit as you go.
- **A worktree branch is scratch space, not a destination — YOU own landing it.** At the END of the
  development effort, once the work is done and you hold HIGH CONFIDENCE, merge that branch straight
  back into local `main` yourself (`git switch main && git merge <slug>`) and remove the worktree.
  Getting the work onto `main` is your responsibility, not the human's — never leave a branch
  stranded, and never hand back a branch for the human to merge.
- Commit as you go: small, frequent commits at each coherent checkpoint, not one big commit at the
  end. Committed work can't be clobbered.
- Always commit your completed work before you rest. Uncommitted work is unfinished work.
- Each sub-agent commits its own work before returning; don't collect a helper's diff and commit it
  on its behalf.
- **Git hygiene does NOT matter — only landing on `main` does, and a busy/dirty shared tree is never a
  reason to stall.** Many agents (and the human) work against the same `main` in parallel, constantly,
  in the same working tree, so `main` moves under you and the tree is often dirty with someone else's
  in-progress edits. Do not wait it out and do not report it as "blocked": commit whatever is in the
  tree first (`git add -A && git commit -m "wip: snapshot in-flight work"` is fine — committing another
  agent's uncommitted changes to unblock your own merge is EXPECTED here, not a violation), then merge
  your branch in and resolve conflicts favoring a correct build of your change. A messy history, a WIP
  commit mixing several agents' work, an ugly merge — all fine. The ONLY hard rules: never `git stash`
  in the shared tree (it corrupts concurrent agents), and never force-discard someone's COMMITTED work.
  A slightly messy history is fine; lost work is not. Keep merging into `main`.
