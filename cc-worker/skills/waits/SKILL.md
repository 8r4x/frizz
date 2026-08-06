---
name: waits
description: How a frizz worker waits on something without going silent or falling out of the board's Active state (invoke as frizz:waits) — choosing between a wait-owning sub-agent, background Bash, native Monitor, and a durable timer fence; frizz's portable monitor scripts; and the CI/PR/release recipes. Load this when your effort needs to wait on CI, a release, a deploy, a merge, or another long-running condition.
---

# Waiting, without going silent

Your system prompt carries the one rule that decides the mechanism. This is the playbook.

## The rule

**Only a live dispatched sub-agent keeps a rested thread out of the human's queue.** A background
`Bash`/`Monitor` does not: `run_in_background` means "don't block my turn", and frizz cannot tell a CI
watcher that ends in minutes from a `vite` dev server that runs forever, so neither holds a rested
thread in Active.

| You will… | Use |
|---|---|
| REST until the condition is met (the usual CI / PR / release wait) | a **sub-agent** that owns the wait |
| KEEP WORKING alongside a process you launched (dev server, log tail) | `Bash` + `run_in_background: true` |
| stream events into the turn you are actively working in | `Monitor` |
| re-check at a named wall-clock instant, across a process exit | `timer:` awaiting fence |

Never fake a wait with `echo waiting`, repeated foreground sleeps, or an `awaiting` fence for CI, bots,
releases, or merge progression.

Never fake Claude's native background mechanism with shell job control (`cmd &`, `nohup … &`, or
`disown`). The child may survive after Bash returns, but it has no Claude task id, output-file
lifecycle, completion notification, or wake. Use `run_in_background: true` with the long command
itself in the foreground. Shell-level concurrency is only self-contained: explicitly `wait` for its
children or own cleanup with an EXIT trap before that Bash call returns.

## Choosing a monitor implementation

1. **Look for project-declared tooling first** — `AGENTS.md`, project skills, docs, package scripts.
   Prefer it only after validating its absolute command and its terminal event/exit semantics. Invalid
   declared tooling is a visible configuration error to report, not something to silently shadow. Never
   select a monitor merely by filename.
2. **Otherwise use frizz's portable Node scripts** in `monitors/` (zero-dep, NDJSON on stdout, they exit
   at a terminal verdict).
3. **Native `Monitor`** is the Claude adapter for a changing condition — a quiet
   `until ...; do sleep ...; done`, emitting one event per meaningful transition. `persistent: true`
   runs until `TaskStop` or session end.

## The sub-agent-owns-the-wait pattern

This is the prescribed way to wait while you rest. Dispatch with the plain Agent tool +
`run_in_background: true`, no `name` field. The child runs the watcher in **its own foreground** and
returns the verdict; you stay Active, and its return re-invokes you so you can act on the result.

Foreground Bash is timeout-capped at ~10 minutes, so for a longer wait the child must loop until its
terminal condition rather than issuing one long call. A helper must not hand back its final report
while its own watcher is still live — the wait IS its work.

Give the child, literally, in the prompt:

- the exact command to run and the terminal condition to stop on;
- the repo path and the thread's scratch-directory path;
- what to return: the verdict plus enough detail to act on a failure (job name, failing step, log tail);
- an instruction not to fix anything — it observes and reports; you decide.

## Recipes

**GitHub CI on a PR head.** `gh run watch <run-id> --exit-status` blocks to completion, or loop
`gh pr checks <n> --json name,state,link`. A partial `gh pr checks` rollup is **not** a green verdict:
also inspect the workflow runs for the exact PR head, and treat `ACTION_REQUIRED` fork gates as pending,
not passing.

**PR review activity.** Do not build a watcher — emit `awaiting` with `pr-watch: owner/repo#N` and frizz
polls it for you, waking on any new review, approval, or comment, bot or human. See `frizz:handoff`.

**A release or deploy.** Poll the artifact that proves it, not the pipeline that promises it — the
published version on the registry, the health endpoint, the deployed asset hash.

**Another long-running local process.** Read its output path with `Read` for diagnostics (`TaskOutput`
is deprecated). `TaskStop` is only for your own monitor after its terminal handoff — never to cut off a
sub-agent or a writer.

## Liveness caveats

Live tasks do not survive the Claude process or session ending. A durable `timer:` fence is the only
wait that survives a restart, so use it when the next meaningful check genuinely belongs at a later
instant rather than continuously monitored now.
