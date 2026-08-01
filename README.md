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

## Fray is for you if you have any of these opinions

- **Terminal UIs are dated** and have fundamental limitations that are incompatible with good user experience.
- **Orchestrator-style apps** feel overly complex.
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

<p align="center">
  <img src="assets/board.png" alt="The Fray board: a queue of agent threads on the right, one card asking an answerable question with lettered options; on the left, a sidebar where a running thread has fanned out four sub-agents with live timers." width="100%">
</p>

When an agent comes to rest needing you, a card is added to it. You can quickly evaluate what it has done since your last message and decide to answer its questions, steer it, snooze the card, or mark the session complete. You're continuously presented with a set of action items in one place, instead of constantly switching back and forth between sessions.

The queue is strict about what earns a card, which is what keeps it a real todo list. A thread resting only because *its own* helpers are still working isn't waiting on you, so it stays quiet until they're back. Nothing shows up just to be dismissed.

## Features

Fray is a browser tab, a queue, and the agent CLIs you already pay for. It brings no model of its own, automates none of your workflow, and keeps every opinion it does have in a text file you can edit.

- 🗂️ **A unified queue, not a tab strip.** Every agent that comes to rest needing you becomes a card. Work the queue top to bottom instead of polling ten terminals.
- 🔌 **Headless, and it outlives you.** Every thread's agent runs in its own detached background process. Close the tab, quit the browser, even stop Fray — the work keeps going, and relaunching reconnects to the session that's still running rather than replaying it from disk.
- 🤖 **Claude Code *and* Codex.** Pick the backend per thread and run both against the same repo at once. Fray drives the CLIs you already have installed and signed in.
- 😴 **Snooze.** Not everything needs an answer now. Park a card for an hour, until tomorrow morning, or until a date you pick — optionally with a follow-up prompt attached, so the thread wakes up already working on what you told it to do next.
- 🐙 **GitHub integration.** Browse your repo's issues and pull requests without leaving the composer, and turn a selection of them into threads. Workers can read issues, diffs, and CI on their own.
- 👀 **Built-in CI and PR watchers.** A worker waiting on a build or a review doesn't hand the thread back to you to be told "keep going." It watches, and picks the work back up when the run goes green or a review lands.
- 📝 **No magic.** A thread behaves like a Claude Code session you started yourself. Fray adds no worktrees, no branches, no dev server, no build integration, no workflow engine to fight with.
- 🔒 **Local only.** No cloud, no account, no telemetry. The server binds `127.0.0.1` by default and its state lives in `~/.fray/`, never in your checkout.

### GitHub

Browse the repo's issues and pull requests from the composer, select any number of them, and each becomes its own thread.

<p align="center">
  <img src="assets/github.png" alt="The GitHub picker open over the composer, listing real open issues from colinhacks/zod with numbers, authors, and reaction counts; three are checked and a Start investigations button is enabled." width="100%">
</p>

Workers can also read issues, diffs, and CI on their own — but only read. A worker never comments, labels, closes, or merges unless you ask it to.

## FAQ

**Does Fray run its own agent or model?**

No. It drives the Claude Code or Codex CLI already installed and signed in on your machine. Your subscription, your rate limits, your settings.

**Does anything leave my machine?**

Nothing from Fray. There's no account, no telemetry, and the server binds to `127.0.0.1` unless you ask for otherwise with `--host`. The agents themselves talk to their providers, and `gh` talks to GitHub, but Fray is a local process looking at local files.

**What happens if I close the tab?**

Nothing. Each thread's agent runs in its own detached background process, independent of the browser *and* of Fray itself — you can stop Fray entirely and your agents keep working. Relaunch, and it reconnects to the sessions that are still running.

**Does it put junk in my repo?**

Barely. Dispatching a thread writes no thread file into your repo — the agent session *is* the thread. All Fray adds to your working tree is a `.fray/` directory holding a scratchpad per thread plus a couple of tiny hook state files. Everything durable lives outside your checkout in `~/.fray/projects/<id>/`, so you can delete `.fray/` and keep every thread and setting. Fray does not touch your `.gitignore`, so add `.fray/` yourself if you don't want it in `git status`.

**Do I have to use worktrees?**

No. Fray doesn't own your git workflow and won't create branches or worktrees behind your back. Tell your agents what you want in `FRAY.md`. If you do run Fray inside a linked worktree, it isolates that worktree's state from its siblings automatically.

**Can I run it on several repos at once?**

Yes — one server and one tab per repo, each fully isolated. There is deliberately no cross-repo board.

**Can I reach it from another machine?**

Yes, with `--host` — the flag every dev server has, and it means the same thing here:

```sh
npx frayui --host              # every interface, i.e. 0.0.0.0
npx frayui --host 192.168.1.5  # one interface
```

Fray prints the addresses to use and warns you as it starts. Reaching it by IP works as-is; reach it by name and you have to say so — `--host --allowed-host fray.local` — because an unlisted name is how DNS rebinding gets a browser to treat an attacker's page as same-origin with your board. `FRAY_HOST` and `FRAY_ALLOWED_HOSTS` do the same thing when the launch command lives in an image or a unit file.

Understand what you're turning on. Fray has no login: reaching the port *is* the authorization, and the board runs shell commands as you. Only do this on a network you trust, and prefer a tunnel (`ssh -L 5173:127.0.0.1:5173 you@box`) if you just want your own board from your own laptop — that needs no flag at all.

**What platforms does it run on?**

macOS and Linux. Windows isn't supported.

**How is this different from the other orchestrator apps?**

Those apps wrap your agents in their own workflow. Fray doesn't: it's a viewer and a queue over the CLIs you already run, with every piece of orchestration judgment sitting in editable text instead of inside the binary.

## Glossary

Fray has its own small vocabulary. Most of it names a feature, so this doubles as an index of the opinionated parts.

| Term | What it means |
| --- | --- |
| **Thread** | One effort, start to finish. Not a chat tab and not a branch. The session *is* the thread — there's no sidecar document to keep in sync, and dispatching doesn't write a file into your repo. |
| **Worker** | The agent driving a thread: a real Claude Code or Codex process, running as *you*, with your credentials and your CLI config. |
| **Sub-agent** | A helper a worker dispatches for an independent prong of its own task. Fray binds each one back to its parent, so the fan-out is visible under the parent's card. |
| **Rested** | An agent that has ended its turn and is waiting on a human. A rested thread isn't idle, it's *your move*. |
| **The queue** | The single list of threads that need you. A thread only earns a card when it genuinely wants a human. |
| **Snooze** | Hide a card until later — an hour, tomorrow morning, or a date you pick — optionally with a follow-up prompt attached. |
| **Scratchpad** | A thread's durable working memory, readable under its **Doc** tab. Where a worker keeps what a summary would otherwise lose: the approach, the alternatives it rejected, the decisions you made and reversed. |
| **`FRAY.md`** | An optional file at your repo root whose contents are injected into every thread, for when you want agents to follow your repo's own norms. |

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the invariants, layout, and design decisions. Read it before changing anything.
- [`FRAY.md`](FRAY.md) — this repo's own worker norms, as a worked example of the optional per-repo prompt.

## License

MIT
