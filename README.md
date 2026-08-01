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

- **Terminal UIs are dated** and have fundamental limitations that are incompatible with good user
  experience.
- **Orchestrator-style apps** like [Conductor](https://conductor.build) and
  [T3 Code](https://github.com/pingdotgg/t3code) feel overly complex.
- **I'm tired of constantly switching between sessions** to check in on my agents' progress.
- **My orchestration logic should be plain text I can edit**, not judgment buried inside an app.
- **I don't want another cloud service.** I already pay for the agents; I just want to see them.

## What it is

Fray solves all of these in one fell swoop. It's a web UI over your agents. Just run `npx frayui`
inside any repo. It starts a localhost server and opens it up in a browser tab. That tab is a
dedicated workspace for your repo. **One tab per repo!**

Fray has no agent of its own. It drives the [Claude Code](https://claude.com/claude-code) and
[Codex](https://developers.openai.com/codex) CLIs you already have installed and signed in — it's a
window onto them, not a replacement for them.

## Quickstart

Requires **Node 26+**, `git` and `tmux` on your `PATH`, and at least one of the
[Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex) CLIs
signed in. You don't need both — a thread is only blocked if the provider *it* targets is signed out.
Codex threads need `codex` 0.146.0 or newer.

```sh
cd /path/to/your/repo
npx frayui
```

That's the whole setup.

## Every rested session is a todo

Fray is designed for parallel work. Instead of a sidebar full of tabs — one per session, each one
something you have to remember to go check — you get a **unified queue**.

When an agent comes to rest needing you, a card is added to your queue. You can quickly evaluate what
it has done since your last message and decide to answer its questions, steer it, snooze the card, or
mark the session complete. This way you're continuously presented with a set of action items in a
single dedicated UI, instead of needing to constantly switch back and forth between sessions.

The queue is strict about what earns a card, which is what keeps it a real todo list. A thread that's
resting only because *its own* sub-agents are still working isn't waiting on you, so it doesn't card
until they come back. Nothing shows up to be dismissed.

Agents don't just stop, either — they end a turn with a fenced ` ```done `, ` ```awaiting `, or
` ```question ` block, and Fray renders those as cards. A question becomes answerable choice chips. An
`awaiting pr-watch:` parks the thread and wakes it when the PR moves.

## Highlights

- 🧵 **One tab per repo.** One server, scoped to one repo, launched from its root. No cross-repo
  anything, no workspace picker, no tab soup.
- 🗂️ **A unified queue, not a tab strip.** Every agent that comes to rest needing you becomes a card.
  Work the queue top to bottom — oldest or newest first, your choice — instead of polling ten
  terminals.
- ❓ **Questions you can actually answer.** A worker's ` ```question ` block renders as lettered choice
  chips; your picks compose back into one follow-up.
- 😴 **Snooze, steer, or mark done.** Triage a card in one click. Snoozed cards come back; done ones
  don't.
- 🔌 **Headless, and it outlives you.** Every thread's agent runs in its own detached background
  process — Claude through the Claude Agent SDK, Codex through `codex app-server`. Close the tab, quit
  the browser, even stop Fray: the work keeps going, and relaunching reconnects to the session that's
  still running rather than replaying it from disk.
- 🤖 **Claude Code *and* Codex.** Pick the backend per thread; run both side by side on the same repo.
- 🚪 **An escape hatch, always.** One click copies the command to reach any thread from your own
  terminal — an attach line while it's live, a provider `resume` line once it isn't. Fray is a view
  onto your agents, not a cage around them.
- 🎛️ **Per-thread model and effort.** Dispatch a thread on Opus at high effort, or Haiku for the
  mechanical stuff, and change your mind later — a new pick takes effect on the thread's next resume.
- 🌲 **Sub-agents are visible.** A worker's fan-out shows up under its queue card, and you can open
  any child's transcript. On Claude threads you can also steer or stop a child without touching its
  parent.
- ↩️ **Take a message back.** Click a follow-up you've already sent but the agent hasn't picked up yet
  and it returns to your composer. (Claude threads — Codex has no queue to retract from.)
- ⏱️ **Snooze with a bump.** A snooze can carry a follow-up prompt, so the thread doesn't just
  reappear at 9am — it wakes up already working on what you told it to do next.
- 📋 **Plans are first-class.** A plan a worker writes to `.fray/plans/` gets its own sidebar section
  and a reader — and an **Implement this** button that opens a new thread seeded with it, so a design
  doc turns into the next piece of work instead of dying in a transcript.
- 🐙 **Dispatch straight from GitHub.** Sign into `gh` and a GitHub icon appears in the composer:
  browse the repo's issues and PRs, shift-click a range, and fan out up to 20 agents in one shot. The
  prompt each one gets is a template you can edit in Settings.
- ⏰ **Machine waits wake themselves.** A thread parked on a PR or a timer resumes on its own instead
  of sitting in your queue. CI doesn't even get that far — a worker watches its own build rather than
  handing it back to you.
- 🔔 **Desktop notifications.** When the window is hidden and something needs you, you hear about it.
- 📱 **Drive a thread from your phone.** Claude threads register with Claude's remote control, so a
  phone icon on the card opens that live session in [claude.ai/code](https://claude.ai/code) or the
  Claude mobile app.
- 📊 **Quota at a glance.** See how much of your plan's limits you've burned before you fan out ten
  more agents.
- 📎 **Paste and drop attachments.** Drag, paste, or pick an image or file on any composer. It's stored
  outside your repo and handed to the agent as a path, so both backends just read it.
- 🔗 **File paths are clickable.** A path an agent mentions opens in Cursor, VS Code, or your system
  editor — your pick in Settings. Threads can link to each other, too.
- 🪄 **No magic.** Fray does nothing clever around worktrees, branches, dev servers, or build
  commands. It doesn't wrap your toolchain, and it has no opinion about your git workflow that you
  didn't write down yourself.
- 📝 **Fully promptmaxxed.** Everything opinionated is a prompt you can edit, in plain text. Drop a
  **`FRAY.md`** at your repo root and its contents are injected into every thread Fray dispatches —
  that's the entire extension mechanism, and the only one. Want agents to use worktrees, run your test
  gate, never open a PR? Write it down; there is no setting to go find.
- 🔒 **Local only.** No cloud, no account, no telemetry. The server binds `127.0.0.1`, and UI state
  lives in `~/.fray/`, never in your checkout.

## Features

Beyond the UI, Fray ships a small plugin — [`cc-worker/`](cc-worker) — that every dispatched agent
loads. It's the part that makes a worker behave like a worker instead of a chat session that happens
to be running unattended.

If a term below is unfamiliar, the [glossary](#glossary) defines the whole vocabulary.

### Prompts, not settings

Fray is fully promptmaxxed. It deliberately automates none of the things an orchestrator app usually
automates: it will not create a worktree for you, will not cut a branch, will not run your dev server,
will not detect your test command, and will not integrate with your build. There is no workflow engine
in here to fight with.

Everything opinionated is a **prompt**, and there is exactly **one** surface you edit: a `FRAY.md` at
your repo root.

Its contents are injected verbatim into every thread Fray dispatches, and they *override* Fray's own
defaults. That's where your repo's norms live — whether agents should use worktrees, which gates to
run before landing, how deep to review, your commit conventions, whether you use pull requests at all.
This repo's own [`FRAY.md`](FRAY.md) is a working example: it tells every agent to land on local
`main` and never open a PR, and they don't.

It's read fresh on every dispatch, so an edit takes effect on your next thread — no restart, no
rebuild. (Keep it under 64 KB; the injected text is truncated at 12,000 characters.)

There is deliberately no second dial. Fray used to have an editable prompt preamble in Settings and it
was retired in favour of `FRAY.md`, so there is exactly one operator-authored surface to reason
about — a file, in your repo, in version control, that you can diff and review like any other.

### Skills

Every Claude worker gets three skills, loaded on demand rather than crammed into its system prompt:

| Skill | What it carries |
| --- | --- |
| [`fray:handoff`](cc-worker/skills/handoff) | The full end-of-turn signal reference — every `awaiting` hint kind, the `question` fence tags (`danger` for the irreversible, `multi` for select-several triage), `done` formatting, and worked examples of each. |
| [`fray:waits`](cc-worker/skills/waits) | How to wait on CI, a PR, a deploy, or a merge without going silent or dropping off the board — choosing between a wait-owning sub-agent, background Bash, a native monitor, and a durable timer. |
| [`fray:gh`](cc-worker/skills/gh) | The `gh` CLI playbook, including a hard read-vs-write boundary: a worker reads issues, PRs, diffs, and CI freely, and never comments, labels, closes, or merges unless you asked. |

Your repo's own skills load right alongside these — Fray adds to the agent you already configured
rather than replacing it.

### Sub-agent profiles

Fray registers sixteen pinned **model × effort** sub-agent profiles — `fray:opus-high`,
`fray:sonnet-medium`, `fray:haiku`, and the rest of the grid. A worker fans out by dispatching the
exact cell the prong deserves: Haiku for scripted mechanical harvest, Opus at high effort for the fix
that lands. Fray deliberately blanks the inherited model and effort so a child *must* pick — otherwise
an unpinned helper silently runs at its parent's tier, which is how a throwaway mechanical prong ends
up billed at frontier rates.

### Hooks

The plugin wires a handful of hooks that fix the failure modes unattended agents actually hit:

- **Escaping background jobs are refused.** A `&`, `nohup`, or `disown` inside a Bash call gets
  rejected — a process with no lifecycle id can outlive its session and there's no way to wake anyone
  when it finishes.
- **Blocking dialogs never strand a worker.** Nobody is at the keyboard, so a prompt that waits for a
  keypress would hang the thread forever. A worker's question is instead surfaced as an answerable
  card in your queue, and the "approve my plan?" dialog is refused in favour of writing the plan down
  and asking you a normal question.
- **Tool approvals get decided, not parked.** A permission policy refuses the two genuinely
  catastrophic things outright — a recursive force-delete of `/` or your home directory, and writing
  straight to a raw disk — hands anything genuinely risky to you as an approve/deny card, and
  otherwise lets the work proceed rather than stalling overnight on a prompt.
- **Reasoning survives compaction.** A long session eventually gets summarized, and a summary keeps
  what the agent *did* while dropping *why*. So one hook tells the summarizer what to preserve, and
  another keeps a per-thread scratchpad current and splices it back in afterwards — the worker resumes
  knowing which approaches it already rejected instead of rediscovering them.
- **Sub-agents are bound to their thread.** Dispatch and completion hooks tie each child back to the
  parent card, which is how the UI can show you the fan-out at all.

### Tools

- **`spawn_thread`** — an MCP tool that lets a worker open a brand-new top-level thread on your board,
  with its own card, session, and scratchpad, for work that deserves to be tracked separately.
- **[Portable monitors](monitors)** — dependency-free `ci-watch`, `review-watch`, and `github-watch`
  NDJSON watchers. They need only Node and a logged-in `gh`, and they never read or print a token. A
  worker uses one to sit on a PR until its CI finishes or a review lands, which keeps the thread
  genuinely working instead of parked on your queue.

### Claude and Codex aren't identical

Worth knowing before you pick a backend. Both get the same worker contract, the same `FRAY.md`
injection, and the same tools — but the plugin above is a Claude Code mechanism, so a **Codex** worker
gets no skills and no sub-agent profiles, and only the background-job and scratchpad hooks. Steering
or stopping an individual sub-agent, and taking back a sent message, are Claude-only for the same
reason: Codex runs its children inside its own process and exposes no way to address one.

## FAQ

**Does Fray run its own agent or model?**

No. It drives the Claude Code or Codex CLI already installed and signed in on your machine. Your
subscription, your rate limits, your settings.

**Does anything leave my machine?**

Nothing from Fray. There's no account, no telemetry, and the server binds to `127.0.0.1`. The agents
themselves obviously talk to their providers, and `gh` talks to GitHub — but Fray is a local process
looking at local files.

**What happens if I close the tab?**

Nothing. Each thread's agent runs in its own detached background process, independent of the browser
*and* of Fray itself — you can stop Fray entirely and your agents keep working. Relaunch, and it
reconnects to the sessions that are still running.

**Does it put junk in my repo?**

Barely, and none of it matters. Dispatching a thread writes no thread file into your repo — the agent
session *is* the thread. All Fray adds to your working tree is a `.fray/` directory holding a
scratchpad per thread plus a couple of tiny hook state files; any plans your agents write land in
`.fray/plans/`. Everything durable — the session registry, your settings, logs — lives outside your
checkout in `~/.fray/projects/<id>/`, so you can delete `.fray/` and keep every thread and setting.
Note that Fray does **not** touch your `.gitignore`; if you don't want `.fray/` showing up in
`git status`, add it yourself. The one file Fray ever asks you to *commit* is an optional `FRAY.md`.

**What is `FRAY.md`?**

An optional file at your repo root. Its contents are injected into every worker Fray dispatches and
override Fray's own defaults, so your repo's norms — test gates, git workflow, review depth, whether
you use PRs at all — are the ones that win. It's the main dial, and it's just markdown.

**Do I have to use worktrees?**

No. Fray doesn't own your git workflow — it won't create branches or worktrees behind your back. Tell
your agents what you want in `FRAY.md`. (If you do run Fray *in* a linked worktree, it isolates that
worktree's state from its siblings automatically.)

**Can I run it on several repos at once?**

Yes — one server and one tab per repo, each fully isolated. There is deliberately no cross-repo board.

**What platforms does it run on?**

macOS and Linux. It needs Node 26+ with `git` and `tmux` on your `PATH`, and refuses to start without
them. Windows isn't supported.

**How is this different from Conductor and friends?**

Those apps wrap your agents in their own workflow. Fray doesn't: it's a viewer and a queue over the
CLIs you already run, with every piece of orchestration judgment sitting in editable text instead of
inside the binary.

## Glossary

Fray has its own small vocabulary. It's short, and most of it names a feature — so this doubles as an
index of the opinionated parts.

### The unit of work

**Thread** — one effort, start to finish. Not a chat tab and not a branch: a thread is a task you
handed to an agent, plus everything that happened to it since. **The session *is* the thread** —
there's no sidecar document to keep in sync, and dispatching doesn't write a file into your repo. One
thread owns exactly one top-level agent session, and you'll run many at once.

**Worker** — the agent driving a thread: a real Claude Code or Codex process, running as *you*, with
your credentials and your CLI config.

**Backend** — which CLI a thread runs on, Claude Code or Codex. Chosen per thread; both can run
against the same repo at the same time.

**Profile** — a pinned **model × effort** pair, like `fray:opus-high` or `fray:haiku`. Set it per
thread (a change applies at the thread's next resume, never mid-turn), and dispatch sub-agents into a
specific cell so a mechanical prong doesn't get billed at frontier rates.

**Sub-agent** — a helper a worker dispatches for an independent prong of its own task. Fray binds
each one back to its parent thread, so the fan-out is visible under the parent's card and you can read
any child's transcript. On Claude threads you can steer or stop a child, too.

### Coming to rest

**Rested** — an agent that has ended its turn and is waiting on a human. The important word in Fray:
a rested thread isn't idle, it's *your move*.

**The queue** — the single list of threads that need you. Every rested session is a todo, and this is
the todo list. No per-session tabs to poll; you work top to bottom, oldest-first or newest-first. A
thread only earns a card when it genuinely wants a human — one that's merely waiting on its own
sub-agents stays quiet until they're back.

**Signal fence** — how a worker ends a turn: a fenced code block naming what state it's leaving the
thread in. Fray parses it and renders the card. There are three.

**`done`** — the effort's real work landed. The thread files itself away as a completion card. It's a
strong claim, deliberately: an open pull request isn't `done`, a plan headed for an implementation
isn't `done`.

**`awaiting`** — a durable wait that Fray's scheduler owns. `pr-watch:` resumes the thread on any new
review, comment, or approval. `timer:` resumes it at an instant, across restarts. `human:` parks it in
a dimmed held band because only a person can unblock it. CI and merges deliberately don't go here —
those are automatable, so the worker stays active and watches them itself.

**`question`** — the worker needs a decision. A trailing lettered option list is parsed into choice
chips; your picks compose back into one follow-up message. Tag it `danger` for the irreversible or
`multi` for select-several triage.

**Snooze** — hide a card until later, when the answer isn't "now" but isn't "never" either. An hour,
tomorrow morning, a week, or a date you pick — and you can attach a follow-up prompt so the thread
wakes up already working on it. You can also hide a card until the thread's sub-agents report back.

### What you can edit

**`FRAY.md`** — your repo's worker norms, injected verbatim into every thread and overriding Fray's
defaults. The only dial. See [Prompts, not settings](#prompts-not-settings).

**Scratchpad** — a thread's durable working memory, at `.fray/threads/<session-id>/scratch.md`, and
readable in the UI under the thread's **Doc** tab (threads have two: Chat and Doc). It's where a
worker keeps what a summary would otherwise lose: the approach, the alternatives it rejected, the
decisions you made and reversed. Hooks nudge the worker to keep it current and re-inject it when the
conversation gets compacted, so it's the answer to "why did it do that?" three hours later.

### Built-in skills

Every Claude worker can load three, on demand:

**`fray:handoff`** — the full end-of-turn signal reference: every `awaiting` hint kind, the `question`
fence tags, `done` formatting, worked examples.

**`fray:waits`** — how to wait on CI, a PR, a deploy, or a merge without going silent or falling off
the board. Picks between a wait-owning sub-agent, background shell, a monitor, and a durable timer.

**`fray:gh`** — the `gh` CLI playbook, including a hard read-vs-write boundary: read issues, PRs,
diffs, and CI freely; never comment, label, close, or merge unless you asked for it.

Your repo's own skills load right alongside these.

### Under the hood

**Registry** — the SQLite database at `~/.fray/projects/<project-id>/ui.db` that holds your threads,
their status, titles, unread counts, and settings. It lives outside your checkout, so your repo stays
clean and your board survives a `git clean`.

**`spawn_thread`** — an MCP tool that lets a worker open a brand-new top-level thread on your board,
with its own card, session, and scratchpad, for work that deserves separate tracking.

**Monitors** — dependency-free [`ci-watch`, `review-watch`, and `github-watch`](monitors) NDJSON
watchers. Node and a logged-in `gh`, nothing else; they never read or print a token.

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the invariants, layout, and design decisions. Read it before
  changing anything.
- [`cc-worker/`](cc-worker) — the Claude Code plugin every dispatched agent loads.
- [`FRAY.md`](FRAY.md) — this repo's own worker norms, as a worked example of the one dial.

## License

MIT
