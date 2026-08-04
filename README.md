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

Fray is for you if you have any of these opinions:

- **Terminal UIs are dated** and have fundamental limitations that are incompatible with good user experience.
- **Orchestrator-style apps** feel overly complex.
- **I'm tired of constantly switching between sessions** to check in on my agents' progress.

<h2 align="center">Getting started</h2>

1. Node 22.13+, or 23.4+ on the Node 23 line
2. Git
3. The [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex) CLI, signed in

Then run it inside any Git repo.

```sh
$ cd ~/taskly
$ npx frayui

  FRAY v0.1.6  ready in 4.0s

  ➜  Local:    http://127.0.0.1:4922/
  ➜  Project:  taskly — ~/taskly
  ➜  Logs:     ~/.fray/projects/979dae3c-fe15-4038-817e-11d0e7491959/logs/fray-2026-08-01T13-44-43-16931.log

  press ctrl-c to stop · run with --debug for the full event feed
```

A browser tab opens on that address — a dedicated workspace for this repo. **One tab per repo!** Runs on macOS, Linux, and Windows.

<p align="center">
  <img src="assets/board.png" alt="Fray running in a browser tab at 127.0.0.1:4921: a sidebar of threads on the left, and on the right a card where an agent is asking an answerable question with lettered options, above Snooze and Mark as done." width="100%">
</p>

<h2 align="center">A queue, not a sidebar</h2>

A sidebar of sessions makes every agent something you have to remember to go check. Fray gives you one queue instead.

When an agent comes to rest needing you, a card is added to it. You can quickly evaluate what it has done since your last message and decide to answer its questions, steer it, snooze the card, or mark the session complete. You're continuously presented with a set of action items in one place, instead of constantly switching back and forth between sessions.

The queue is strict about what earns a card, which is what keeps it a real todo list. A thread resting only because *its own* helpers are still working isn't waiting on you, so it stays quiet until they're back. Nothing shows up just to be dismissed.

<h2 align="center">Features</h2>

Fray is a browser tab, a queue, and the agent CLIs you already pay for. It brings no model of its own, automates none of your workflow, and keeps every opinion it does have in a text file you can edit.

- 🗂️ **A unified queue, not a tab strip.** Every agent that comes to rest needing you becomes a card. Work the queue top to bottom instead of polling ten terminals.
- 🔌 **Headless.** Every thread's agent runs in its own detached background process — no terminal to babysit, no window that has to stay open for work to continue.
- 🔁 **Resumable and quittable.** Close the tab, quit the browser, ctrl-c the server, reboot. Your threads are all still there when you come back, and Fray reconnects to the ones still running rather than replaying them from disk.
- 🤖 **Claude Code *and* Codex.** Pick the backend per thread and run both against the same repo at once. Fray drives the CLIs you already have installed and signed in.
- 😴 **Snooze.** Not everything needs an answer now. Park a card for an hour, until tomorrow morning, or until a date you pick — optionally with a follow-up prompt attached, so the thread wakes up already working on what you told it to do next.
- 🔄 **Recurring prompts.** Give a thread a prompt that repeats — every time it comes to rest, on a clock you set in minutes, or both. Good for "keep going until CI is green" without you re-asking. A scheduled one reaches the agent even mid-turn, so it can nudge a thread that never stops. Switch it off whenever, or let the agent say it's finished.
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

### Snooze

Park a card for an hour, until tomorrow morning, or until a date you pick. Attach a follow-up prompt and the thread wakes up already working on it.

<p align="center">
  <img src="assets/snooze.png" alt="The snooze menu open on a queue card, offering 1 hour, tomorrow at 9am, 1 day, 3 days, 1 week, and a custom time and prompt." width="100%">
</p>

### Recurring prompts

Give a thread a prompt that repeats. Send it every time the agent comes to rest, on a clock you set in minutes, or both — a scheduled send reaches the agent even mid-turn, without cutting off work in progress.

<p align="center">
  <img src="assets/recurring.png" alt="The recurring prompt panel: one prompt saying to keep going until the test suite is green, with both triggers switched on — every time it stops, and every 30 minutes." width="100%">
</p>

<h2 align="center">CLI</h2>

```sh
$ npx frayui --help

Fray production launcher

Usage: npx frayui [options] [repository]

Runs the npm-resolved immutable Fray package, then opens it in your default browser. Use fray-dev
only for a source checkout.

Options:
  --app                  use the legacy dedicated app window instead of a browser tab
  --no-app               print the URL without opening a browser
  --port <port>          request a fixed port for a new workspace server
  --host [address]       serve on a network address instead of loopback (bare --host means 0.0.0.0)
  --allowed-host <name>  with --host, also accept this DNS name as the board's address (repeatable)
  --public-origin <url>  serve behind a proxy/tunnel reachable at this exact origin
  --debug                stream the full event feed to the terminal instead of the compact readout
  -h, --help             show this help

Environment:
  FRAY_HOST              same as --host
  FRAY_ALLOWED_HOSTS     same as --allowed-host, comma separated
  FRAY_PUBLIC_ORIGIN     same as --public-origin

--host puts a board that can run shell commands as you on the network, and Fray has no login: anyone
who reaches the port controls it. Only do this on a network you trust. An IP address works as-is; to
reach the board by DNS name you must list that name with --allowed-host ("*" allows any).

--public-origin serves the board through a tunnel or reverse proxy without putting it on the LAN
at all — Fray stays on loopback and the tunnel dials it. Fray still has no login, so require
authentication at the proxy: with Cloudflare Access, that is the whole of your access control.
```

<h2 align="center">FAQ</h2>

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

Understand what you're turning on. Fray has no login: reaching the port *is* the authorization, and the board runs shell commands as you. Only do this on a network you trust, and prefer a tunnel (`ssh -L 4922:127.0.0.1:4922 you@box`, using the port Fray printed, the same on both ends) if you just want your own board from your own laptop — that needs no flag at all.

**Can I reach it from anywhere, not just my LAN?**

Yes — put it behind a tunnel and tell Fray the address the tunnel answers on, with `--public-origin`:

```sh
npx frayui --public-origin https://fray.example.com
cloudflared tunnel --url http://127.0.0.1:4922   # the port Fray printed
```

Fray stays bound to `127.0.0.1` — `--public-origin` is not `--host` and does not put anything on your LAN. The tunnel runs on the same machine and dials the loopback port, so the only way in is through the tunnel. That is also what makes this the *good* remote option rather than merely a working one: the tunnel terminates TLS, so the board is a real `https://` origin and therefore a secure context, which plain `--host` over a LAN IP is not. Copy buttons and desktop notifications work again, and it works on a phone.

The address you pass must be the exact origin your browser shows — scheme and host, no path. Fray accepts that one origin, and accepts `X-Forwarded-*` only on requests that actually arrived as it.

**This is the part that matters: Fray has no login, so whatever you put in front of the tunnel *is* your access control.** A bare tunnel publishes a shell-capable board to the open internet for anyone who has the URL. Require authentication at the proxy — with Cloudflare, that means a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) application over the hostname, with a policy allowing only your own email, created *before* the hostname resolves. Tailscale Serve is the same idea with device identity instead of SSO. Fray prints this warning on every launch that names a public origin, and it is not boilerplate.

**What platforms does it run on?**

macOS, Linux, and Windows. Windows support arrived in 0.1.6, once the last dependency that had no native Windows build was removed.

**How is this different from the other orchestrator apps?**

Those apps wrap your agents in their own workflow. Fray doesn't: it's a viewer and a queue over the CLIs you already run, with every piece of orchestration judgment sitting in editable text instead of inside the binary.

<h2 align="center">Glossary</h2>

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

<h2 align="center">Docs</h2>

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the invariants, layout, and design decisions. Read it before changing anything.
- [`FRAY.md`](FRAY.md) — this repo's own worker norms, as a worked example of the optional per-repo prompt.

<h2 align="center">License</h2>

MIT
