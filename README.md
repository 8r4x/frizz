<p align="center">
  <h1 align="center">🧵<br/>Fray</h1>
  <p align="center">A local web UI for running many coding agents at once.
    <br/>
    by <a href="https://x.com/colinhacks">@colinhacks</a>
  </p>
</p>
<br/>

<p align="center">
<a href="https://opensource.org/licenses/MIT" rel="nofollow"><img src="https://img.shields.io/github/license/colinhacks/fray" alt="License"></a>
<a href="https://www.npmjs.com/package/frayui" rel="nofollow"><img src="https://img.shields.io/npm/dw/frayui.svg" alt="npm"></a>
<a href="https://github.com/colinhacks/fray" rel="nofollow"><img src="https://img.shields.io/github/stars/colinhacks/fray" alt="stars"></a>
</p>

<p align="center">
  <img src="assets/board.png" alt="The Fray board: a queue of agent threads on the right, one card asking an answerable question with lettered options; on the left, a sidebar where a running thread has fanned out four sub-agents with live timers." width="100%">
</p>

## Fray is for you if you have any of these opinions

- **Terminal UIs are dated** and have fundamental limitations that are incompatible with good user experience.
- **Orchestrator-style apps** like [Conductor](https://conductor.build) and [T3 Code](https://github.com/pingdotgg/t3code) feel overly complex.
- **I'm tired of constantly switching between sessions** to check in on my agents' progress.

## Quickstart

```sh
cd /path/to/your/repo
npx frayui
```

That's the whole setup. It starts a localhost server and opens a browser tab — a dedicated workspace for that repo. **One tab per repo!**

Requires Node 26+, with `git` and `tmux` on your `PATH`, and at least one of the [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex) CLIs signed in. You don't need both. Codex threads need `codex` 0.146.0 or newer.

## Designed for parallelization

Instead of a sidebar full of tabs — one per session, each one something you have to remember to go check — you get a **unified queue**.

When an agent comes to rest needing you, a card is added to it. You can quickly evaluate what it has done since your last message and decide to answer its questions, steer it, snooze the card, or mark the session complete. You're continuously presented with a set of action items in one place, instead of constantly switching back and forth between sessions.

The queue is strict about what earns a card, which is what keeps it a real todo list. A thread resting only because *its own* helpers are still working isn't waiting on you, so it stays quiet until they're back. Nothing shows up just to be dismissed.

## Features

Fray is a browser tab, a queue, and the agent CLIs you already pay for. It brings no model of its own, automates none of your workflow, and keeps every opinion it does have in a text file you can edit.

- 🗂️ **A unified queue, not a tab strip.** Every agent that comes to rest needing you becomes a card. Work the queue top to bottom instead of polling ten terminals.
- 🔌 **Headless, and it outlives you.** Every thread's agent runs in its own detached background process. Close the tab, quit the browser, even stop Fray — the work keeps going, and relaunching reconnects to the session that's still running rather than replaying it from disk.
- 🤖 **Claude Code *and* Codex.** Pick the backend per thread and run both against the same repo at once. Fray drives the CLIs you already have installed and signed in.
- 😴 **Snooze.** Not everything needs an answer now. Park a card for an hour, until tomorrow morning, or until a date you pick — optionally with a follow-up prompt attached, so the thread wakes up already working on what you told it to do next.
- 🐙 **Built on the `gh` CLI.** If you're signed in, Fray uses it: browse your repo's issues and pull requests without leaving the composer and turn a selection of them into threads, and let a worker read issues, diffs, and CI on its own.
- 📝 **Fully promptmaxxed.** Fray automates none of what an orchestrator app usually automates — no worktrees, no branches, no dev server, no build integration, no workflow engine to fight with. Everything opinionated is a prompt you can edit.
- 🔒 **Local only.** No cloud, no account, no telemetry. The server binds `127.0.0.1` and its state lives in `~/.fray/`, never in your checkout.

### One dial

Everything opinionated is a **prompt**, and there is exactly **one** surface you edit — a `FRAY.md` at your repo root. Its contents are injected verbatim into every thread Fray dispatches, and they *override* Fray's own defaults.

```md
# Worker norms for this repo

## Git: land on local `main` — never open a pull request

This repo does NOT use pull requests. Work directly on `main`, or do messy work in a
worktree and merge it back yourself when it's done.
```

That's an excerpt from this repo's own [`FRAY.md`](FRAY.md), and it works: agents here land on local `main` and never open a PR. Whatever your repo's norms are — which gates to run before landing, how deep to review, your commit conventions — that's where they live.

It's read fresh on every dispatch, so an edit takes effect on your next thread. No restart, no rebuild, no setting to go find. Fray used to have an editable prompt preamble in Settings and it was retired in favour of this, so there is exactly one operator-authored surface to reason about.

### The worker plugin

Fray ships a small plugin — [`cc-worker/`](cc-worker) — that every dispatched Claude agent loads. It's what makes a worker behave like a worker instead of a chat session that happens to be running unattended. Your repo's own skills and config load right alongside it.

Three skills, loaded on demand rather than crammed into a system prompt:

| Skill | What it carries |
| --- | --- |
| [`fray:handoff`](cc-worker/skills/handoff) | How to end a turn: which kind of card to leave you — finished, waiting, or a question — and worked examples of each. |
| [`fray:waits`](cc-worker/skills/waits) | How to wait on something slow (a CI run, a release, a review) without either going silent or falsely claiming it's blocked on you. |
| [`fray:gh`](cc-worker/skills/gh) | The `gh` playbook, including a hard read-vs-write boundary: read issues, PRs, diffs, and CI freely; never comment, label, close, or merge unless you asked. |

Sixteen sub-agent profiles, one per model × effort pair — `fray:opus-high`, `fray:haiku`, and the rest of the grid. A worker splitting work across helpers picks each helper's brainpower deliberately. Fray blanks the inherited model so a child *must* choose, which is what stops a throwaway mechanical prong from quietly running at frontier rates.

Hooks that fix the failure modes unattended agents actually hit:

| Hook | What it prevents |
| --- | --- |
| Blocking dialogs | Nobody is at the keyboard, so a prompt waiting on a keypress would hang the thread forever. A worker's question becomes an answerable card instead. |
| Escaping background jobs | A `&` or `nohup` inside a shell call gets rejected — a process with no lifecycle id outlives its session with no way to wake anyone when it finishes. |
| Stalled tool approvals | A permission policy refuses the two genuinely catastrophic things, hands anything risky to you as an approve/deny card, and otherwise lets the work proceed rather than stalling overnight. |
| Lost reasoning | A summary keeps what the agent *did* while dropping *why*. One hook tells the summarizer what to preserve; another keeps a scratchpad current and splices it back in. |

### Waits that don't cost you a round trip

An agent that needs to wait — on CI, a pull request, a release — shouldn't hand the thread back to you just to be told "keep going." So it doesn't. A worker watches its own build to completion, and for longer waits it parks on a durable one that Fray's scheduler owns: a pull request wakes the thread on any new review, comment, or approval, and a timer wakes it at an instant, surviving restarts.

Only a wait that genuinely needs a *person* comes back to your queue.

## FAQ

**Does Fray run its own agent or model?**

No. It drives the Claude Code or Codex CLI already installed and signed in on your machine. Your subscription, your rate limits, your settings.

**Does anything leave my machine?**

Nothing from Fray. There's no account, no telemetry, and the server binds to `127.0.0.1`. The agents themselves talk to their providers, and `gh` talks to GitHub, but Fray is a local process looking at local files.

**What happens if I close the tab?**

Nothing. Each thread's agent runs in its own detached background process, independent of the browser *and* of Fray itself — you can stop Fray entirely and your agents keep working. Relaunch, and it reconnects to the sessions that are still running.

**Does it put junk in my repo?**

Barely. Dispatching a thread writes no thread file into your repo — the agent session *is* the thread. All Fray adds to your working tree is a `.fray/` directory holding a scratchpad per thread plus a couple of tiny hook state files. Everything durable lives outside your checkout in `~/.fray/projects/<id>/`, so you can delete `.fray/` and keep every thread and setting. Fray does not touch your `.gitignore`, so add `.fray/` yourself if you don't want it in `git status`.

**Do I have to use worktrees?**

No. Fray doesn't own your git workflow and won't create branches or worktrees behind your back. Tell your agents what you want in `FRAY.md`. If you do run Fray inside a linked worktree, it isolates that worktree's state from its siblings automatically.

**Can I run it on several repos at once?**

Yes — one server and one tab per repo, each fully isolated. There is deliberately no cross-repo board.

**What platforms does it run on?**

macOS and Linux. Windows isn't supported.

**How is this different from Conductor and friends?**

Those apps wrap your agents in their own workflow. Fray doesn't: it's a viewer and a queue over the CLIs you already run, with every piece of orchestration judgment sitting in editable text instead of inside the binary.

## Glossary

Fray has its own small vocabulary. Most of it names a feature, so this doubles as an index of the opinionated parts.

| Term | What it means |
| --- | --- |
| **Thread** | One effort, start to finish. Not a chat tab and not a branch. The session *is* the thread — there's no sidecar document to keep in sync, and dispatching doesn't write a file into your repo. |
| **Worker** | The agent driving a thread: a real Claude Code or Codex process, running as *you*, with your credentials and your CLI config. |
| **Backend** | Which CLI a thread runs on. Chosen per thread; both can run against the same repo at the same time. |
| **Profile** | A pinned model × effort pair, like `fray:opus-high`. A change applies at the thread's next resume, never mid-turn. |
| **Sub-agent** | A helper a worker dispatches for an independent prong of its own task. Fray binds each one back to its parent, so the fan-out is visible under the parent's card. |
| **Rested** | An agent that has ended its turn and is waiting on a human. A rested thread isn't idle, it's *your move*. |
| **The queue** | The single list of threads that need you. A thread only earns a card when it genuinely wants a human. |
| **Signal** | A worker doesn't just stop; it says *how* it's stopping, and Fray turns that into the card you see. Finished, waiting, or asking you something. |
| **Snooze** | Hide a card until later — an hour, tomorrow morning, or a date you pick — optionally with a follow-up prompt attached. |
| **Scratchpad** | A thread's durable working memory, readable under its **Doc** tab. Where a worker keeps what a summary would otherwise lose: the approach, the alternatives it rejected, the decisions you made and reversed. |
| **Registry** | The SQLite database holding your threads and settings. It lives outside your checkout, so your board survives a `git clean`. |
| **`FRAY.md`** | Your repo's worker norms, injected verbatim into every thread. The only dial. |

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the invariants, layout, and design decisions. Read it before changing anything.
- [`cc-worker/`](cc-worker) — the Claude Code plugin every dispatched agent loads.
- [`FRAY.md`](FRAY.md) — this repo's own worker norms, as a worked example of the one dial.

## License

MIT
