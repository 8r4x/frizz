<p align="center">
  <h1 align="center">🧵<br/><code>fray</code></h1>
  <p align="center">A local dashboard for running many coding agents at once.
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

## What is fray?

Run one agent and you babysit a terminal. Run ten and you lose track of which ones are working, which
are stuck, and which are waiting on you.

fray is a web UI that runs on your machine, scoped to one repo. You describe a task, fray dispatches a
real [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex)
session to drive it, and every session shows up as a thread you can watch, steer, answer, or drop into
a live terminal. Threads that need you sort to the top; the rest get out of the way.

There is no cloud, no account, and no agent of its own — fray is a window onto the CLIs you already
have installed.

## Quickstart

Requires **Node 26+**, `tmux`, and the [Claude Code](https://claude.com/claude-code) or
[Codex](https://developers.openai.com/codex) CLI signed in.

```sh
cd /path/to/your/repo
npx frayui
```

That's the whole setup. It opens a browser tab, and one server runs per repo.

## How it works

- **One thread, one effort.** Each thread owns a single top-level agent session in a detached `tmux`
  session, so closing the tab never kills the work. `tmux -L fray attach` is always there if you want
  the raw terminal.
- **Agents signal, they don't just stop.** A worker ends its turn with a fenced ` ```done `,
  ` ```awaiting `, or ` ```question ` block. fray renders those as cards — a question becomes
  answerable choices, an `awaiting pr-watch:` parks the thread and wakes it when the PR moves.
- **Nothing is hidden in the app.** All the orchestration judgment lives in text you can edit: the
  **dispatch preamble** in Settings, and a **`FRAY.md`** at your repo root whose contents are injected
  into every worker and override fray's defaults.
- **State stays out of your repo.** Unread counts, settings, and the session registry live in
  `~/.fray/projects/<id>/ui.db`.

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the invariants, layout, and design decisions. Read it before
  changing anything.
- [`cc-worker/`](cc-worker) — the Claude Code plugin every dispatched agent loads.
- [`board/`](board) — the zero-dep `.fray/` board parser the server shells out to.

## License

MIT
