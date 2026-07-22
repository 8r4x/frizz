#!/usr/bin/env node
// @ts-check
// PreToolUse hook on Bash (fray-worker). HARD-STOP for `gh pr create` in a repo whose FRAY.md
// forbids pull requests. This is the tool-layer backstop behind FRAY.md's "NEVER open a pull
// request" rule: an agent's *instructions* can be stale (a long-lived session frozen before the
// rule landed, or a sub-agent that never received FRAY.md at all), but this hook reads the
// project's FRAY.md FRESH from disk on every call, so the CURRENT policy is what's enforced —
// regardless of what the agent believes. It covers the top-level worker AND every sub-agent it
// dispatches (both run under this plugin with FRAY_UI_THREAD inherited).
//
// SCOPING is the whole point: the cc-worker plugin is generic and also drives workers in repos that
// legitimately DO use PRs (nub, pullfrog, …). So this denies ONLY when the project's on-disk
// FRAY.md actually forbids PRs. No no-PR FRAY.md → allow, unchanged. That keeps the block precise:
// it fires exactly where the repo asked for it and nowhere else.
//
// GATE: inert unless FRAY_UI_THREAD is set. FAIL OPEN on any error — a broken hook must never halt
// work, and must never wedge a legitimate PR in a PR-using repo.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// A gh invocation that CREATES a pull request. `gh pr create` is the dominant path; the REST
// equivalent is a POST to a .../pulls endpoint (a bare `gh api .../pulls` is a read → left alone).
const PR_CREATE = /\bgh\s+pr\s+create\b/;
const GH_API_PULLS = /\bgh\s+api\b[^\n]*\/pulls(\/[^\s"']*)?(\s|$|["'])/;
const API_WRITE = /(^|\s)(-X\s*POST|--method\s*POST|-f\s|--field\s|-F\s|--raw-field\s|--input\s)/;

/** @param {string} cmd */
function createsPr(cmd) {
  if (PR_CREATE.test(cmd)) return true;
  if (GH_API_PULLS.test(cmd) && API_WRITE.test(cmd)) return true;
  return false;
}

// Read the project's FRAY.md fresh, walking up from cwd (covers a worktree checkout too, which
// carries its own FRAY.md). Returns true only when FRAY.md is present AND forbids PRs.
function frayForbidsPr() {
  let dir = process.cwd();
  for (let i = 0; i < 40; i++) {
    try {
      const body = readFileSync(join(dir, 'FRAY.md'), 'utf8');
      return /NEVER open a pull request/i.test(body) || /does NOT use pull requests/i.test(body);
    } catch {
      // no FRAY.md here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

try {
  if (!(process.env.FRAY_UI_THREAD ?? '').trim()) emit({}); // not a fray worker → allow

  const input = JSON.parse(readFileSync(0, 'utf8'));
  const cmd = input?.tool_input?.command;
  if (typeof cmd !== 'string' || !createsPr(cmd)) emit({}); // not a PR-creating command → allow
  if (!frayForbidsPr()) emit({}); // this repo doesn't forbid PRs → allow

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        "fray worker (hook-enforced from this repo's FRAY.md): this repo does NOT use pull requests — never run `gh pr create` (or the `gh api .../pulls` POST equivalent). Land the finished work on LOCAL `main` instead: work directly on `main`, or do isolated/messy work in a git worktree on a local branch (`git worktree add <dir> -b <slug>`) and, when it's done and you're confident, merge it back yourself (`git switch main && git merge <slug>`) and remove the worktree. Getting the change onto local `main` is your job — do not open, push, or stage a PR. If you believe this repo actually wants a PR, STOP and ask the human in a ```question block rather than forcing it.",
    },
  });
} catch {
  emit({}); // fail open
}
