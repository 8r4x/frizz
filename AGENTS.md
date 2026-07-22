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
at session start. A `deny-pr` PreToolUse hook also blocks `gh pr create` at the tool layer.)

# Web UI completion rule

For any user-visible web UI change, work is not complete until end-to-end Chrome or Chromium QA has exercised the affected workflow. Prefer Chrome DevTools MCP when it is available to the current provider. If it is unavailable or unsuitable, use `agent-browser` or this repository's Puppeteer harness as an explicit fallback; each path must produce the same real-browser evidence. Capture and inspect multiple screenshots covering the meaningful states: before and after, desktop and relevant narrow/mobile widths, plus open menus, drawers, hover, selected, loading, or error states when applicable. Check the browser console and page errors, and inspect visual results optically—not only by box-model measurements. Icons beside text must be optically vertically centered, and placement, truncation, and wrapping must be verified.

Unit, typecheck, and build tests do not substitute for this visual Chrome QA. The final handoff must include paths to the inspected screenshot evidence. This rule does not apply to purely non-UI changes.

# Browser process hygiene

Browser cleanup is a mandatory part of end-to-end QA. Reuse one uniquely named owned browser session, target, or harness instance for all desktop and narrow/mobile checks in a task; do not create a new browser instance per screenshot or assertion. Every task that starts a browser must arrange cleanup in a `finally`/shell `trap` or equivalent path before launch, including on QA failure or interruption. Before returning, verify that its exact owned session/target or harness instance and its owned browser/helper-process tree are gone.

Chrome DevTools MCP is the preferred QA tool when available. Never leave a Chrome DevTools MCP helper, `agent-browser` daemon, Puppeteer browser, or Chrome/Chromium helper process running after the task that created it. Do not use global browser/session/target close operations while another agent may be performing active QA; each agent owns and cleans up only its exact session, target, or process tree. A UI handoff is incomplete unless it includes screenshot paths, console/page-error evidence, optical-review results, and explicit browser-cleanup confirmation.

# Copy capitalization: sentence case, never title case

All user-visible copy uses SENTENCE case — capitalize only the first word and any proper nouns. This
covers button and menu labels, headings, section titles, toasts, and thread titles. Never Title-Case
Every Word (write "Confirm snooze", "Mark as done", "Fix queue focus" — not "Confirm Snooze", "Mark As
Done", "Fix Queue Focus"). Acronyms (PR, CI, API) keep their established casing. When an agent titles a
thread, the same rule applies.

# Project-local skills and tools are shared across agents

Any project-local skill or tool lives in ONE agent-neutral copy that every agent configuration
discovers — never a per-agent fork. Skills live canonically in `.agents/skills/<name>/` (Codex
discovers this path natively); `.claude/skills/<name>` is a relative symlink into that canonical copy
so Claude Code discovers the identical content. When adding a skill, create it under
`.agents/skills/` and add the symlink; verified end-to-end 2026-07-21 with `adhoc-cdp` (Claude lists
it through the symlink, `codex exec` resolves it at `.agents/skills/adhoc-cdp/SKILL.md`). Shared
tooling scripts follow the same rule: one copy in an agent-neutral location (e.g. `ui/scripts/`),
referenced from skills — never duplicated into agent-specific config trees.

# Agent completion invariant

Once spawned, an agent runs to its terminal return. Do not interrupt or cut off an active agent to
reduce churn, reclaim slots or quota, redirect work, respond to a user steer, contain live-server
instability, or hurry completion. Deliver new direction through the agent's message/follow-up path,
then reconcile obsolete or conflicting results after it returns. Mid-turn interruption can leave
partially applied edits, tests, and owned processes behind, making the resulting repository state
unsound. Isolate or restart only the affected unstable service; never stop a writer to stabilize it.
If an agent appears hung or continuing would be dangerous, use the interactive question path to ask the
user. The sole exception is an explicit user instruction that names the interruption.
