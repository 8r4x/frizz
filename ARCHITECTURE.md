# frizz architecture (read this before touching any package)

frizz is a workspace-scoped orchestration surface: a localhost server + web client (a browser tab by
default) showing a sidebar of threads and, for the selected thread, a live embedded agent terminal.
The UI has ZERO intelligence: all orchestration wisdom lives in the user-editable dispatch preamble
(settings), in the repo's own `FRIZZ.md`, and in the worker plugin (`cc-worker/`). The original plan:
`plans/standalone-ui.md`.

## Repo layout

**The repo root IS the published `frizz` package** — root `package.json` is the manifest, `src/` is
the launcher, `npm publish` runs from the root, and the root `README.md` is the npmjs.com page.

| Path | What it is |
| --- | --- |
| [`src/`](src/) | The `frizz` launcher itself — artifact build/promote/verify, port + lock, browser launch. |
| [`packages/`](packages/) | The app workspace — `shared`, `rpc`, `server`, `web` (see **Packages** below). |
| [`board/`](board/) | The zero-dep `.frizz/` board parser + thread writer. The server SHELLS OUT to it; never re-implement it. |
| [`cc-worker/`](cc-worker/) | The Claude Code plugin every dispatched agent loads: worker contract seed, sub-agent profiles, hooks. |
| [`monitors/`](monitors/) | Portable CI/PR/review watchers, synced into `cc-worker/skills/gh/scripts/`. |
| [`scripts/`](scripts/) | Packaging (`prepare-package.mjs`, `build-*.mjs`) + dev tooling (`seed-*`, `verify-*`, `shot.mjs`). |

`board/` used to be `cc/scripts/frizz/` — `cc/` was the Claude Code **plugin** port back when frizz
itself shipped as an agent plugin rather than an app. The plugin is retired; the parser is not.

## Developing frizz

```sh
nub install
nub run frizz-dev:install     # one-time: ~/.local/bin/frizz-dev -> this checkout's launcher source
```

Then from any Git repo: `frizz-dev` (foreground; Ctrl-C stops only that workspace's server).
`frizz-dev /path/to/repo` selects a repository, `--no-app` prints the URL instead of opening a browser,
`--app` opts into the legacy dedicated window, `--status` reports workspace/port/supervisor PID, and
`--stop` stops the UI server while agent processes survive. `frizz-dev:check` verifies the shim
without changing it; `frizz-dev:uninstall` removes only that owned shim. Use
`FRIZZ_BIN_DIR=/another/bin` to install elsewhere.

### Readout and logs

A TTY launch repaints a step list while booting and settles into a static block naming the address,
the project, and this run's log. It repaints only during the boot — once that block prints, nothing
touches the cursor again, so a stray write can never land on a live region.

Every process writes the complete feed to `<stateDir>/logs/frizz-<timestamp>-<pid>.log`, one file per
run, with `logs/latest.log` pointing at the newest. The launcher passes that path down in
`FRIZZ_LOG_FILE`, so the supervisor and the forked control-plane child append to the SAME file — they
share the file, not a writer, and O_APPEND makes each short write atomic. That is what lets the child
stay silent on a terminal the launcher is repainting without losing anything it had to say.
Retention keeps 20 runs and nothing older than 14 days; a single file stops at 32 MB.
`FRIZZ_LOG_PATH` overrides the location (a directory or an exact `.log` file).

`--debug` streams that same feed to the terminal instead of the compact readout, in every process at
once — the launcher sets `FRIZZ_DEBUG` in the child environment, since the child never sees the
command line. Ctrl-C and a failed boot both print the log path.

Gates: `pnpm run typecheck` and `pnpm test`. CI (`.github/workflows/ci.yml`) runs only the checks that
need no install or provider CLI; the full suite is local-only by design.

## Invariants

- **Workspace-scoped.** One server per repo, launched from the repo root. It watches only that
  repo's `.frizz/` and only the matching `~/.claude/projects/<cwd-slug>/` session logs. No
  cross-repo anything.
- **Frizz files are the source of truth for thread status.** The server imports the board logic
  from `../../board/*.mjs` (zero-dep, plain node) — NEVER duplicate the parser. Writes
  to thread files go through the same code paths as `frizz-update` (import `thread-update.mjs`
  helpers), never hand-rolled markdown edits.
- **Session JSONL (`~/.claude/projects/<slug>/<session-id>.jsonl`) is telemetry only** —
  liveness, previews. Parse defensively; on schema surprise degrade to "unknown", never crash,
  never let correctness depend on it.
- **Agents are headless processes frizz owns over a pipe**, spawned with a pinned
  `--session-id <uuid>`: a Claude thread runs in the session BROKER (a detached daemon holding one
  Agent SDK session, reached over a unix socket or, on Windows, a named pipe), and a Codex thread in
  the app-server. There is no multiplexer and no pane — `/term/:slug` now serves exactly one thing,
  a provider sign-in attempt, whose pty the login utility owns and shares across every viewing tab.
- **Full-snapshot SSE.** The single `/events` SSE channel pushes `{type:"board", board}` full
  snapshots (see `@frizz/shared` `ServerEvent`). No diff protocol.
- **Permission prompts come from a MARKER, not from JSONL.** Even under `--permission-mode auto` a
  worker can pause on a permission request with NO transcript signal (the last record stays assistant
  + `stop_reason:"tool_use"`), so the cc-worker hook writes a marker into `FRIZZ_PERM_DIR` naming what
  is waiting and the tailer reads that. (It used to fall back to capturing the tmux pane and matching
  the TUI's modal chrome by regex; there are no panes, and a broker thread's approvals arrive as typed
  permission requests over the control channel.) The `perm-prompt` runtime rides the board snapshot
  with no notify and no unread — the sidebar's attention sort surfaces it.
- **Human questions are ```question fenced blocks in the worker's final pre-rest message** — the
  message is the medium; there is deliberately NO question tool, sidecar file, or RPC (two earlier
  designs — a blocking MCP tool and a frizz-ask CLI + .questions/ sidecars — were built and
  rejected: fragile timeouts / redundant state; the user chose fences). The block body is plain
  markdown; a TRAILING `- A. …` option list + optional `Recommendation:` line are convention-parsed
  into choice chips (web/src/lib/questionBlocks.ts). A go/no-go is just a two-option question — the
  old ` ```question approval ` gate (one Approve button that sent on click) was dropped 2026-07-26;
  its token now degrades to a plain question so legacy transcripts still render.
  Answers compose into one follow-up numbered by ORIGINAL block position ("Answers:\n2. …"), a ONE-block ask included — the numbering is what the renderer keys on to card the reply up instead of dropping it into a flat bubble. The
  contract lives in packages/server/src/workerPrompt.ts + cc-worker's SKILL/deny-ask hook — keep all three aligned.

## Packages

- `shared` — zod schemas + types + constants. THE contract; read `src/index.ts` first.
- `rpc` — typed query/mutation/stream over Hono (lifted from gent, unchanged). Server defines a
  `Router` in `server/src/router.ts`; web imports `type AppRouter` from it for the typed client.
- `server` — Hono app on 127.0.0.1 (default port in shared): rpc mounts at `/rpc`, SSE at
  `/events`, terminal WebSocket at `/term/:slug` (`ws` package), static web assets in prod, Vite
  middleware in dev (`src/dev.ts`). Subsystems: `bus.ts` (EventEmitter → SSE), `board.ts`
  (.frizz watcher + read model), `sessions.ts` (SQLite registry via better-sqlite3),
  `tailer.ts` (JSONL), `dispatch.ts` (thread file create + prompt compose + spawn),
  `settings.ts`.
- `web` — React 19 + Vite 8 + Tailwind v4 + valtio + TanStack Query + xterm.js.

Plus root `src/` — the `frizz` launcher (NOT a workspace package): canonicalize cwd's Git root,
health-check/reuse its detached supervisor, atomically allocate/persist an isolated port, then open the
URL. Locks and logs live under `~/.frizz/projects/<id>/`; `src/browser.ts` is vendored from Gluon via
gent. See **CLI launcher** below.

## CLI launcher

Two entry points, deliberately distinct:

- **`npx frizz`** (published package) runs directly from what it ships. `prepare-package.mjs`
  stages the full runtime closure at prepack: `web-dist/` (built client), `runtime/board/` (the board
  parser the server shells out to), and `runtime/cc-worker/` (the worker plugin dispatch loads).
  `production.ts` points `FRIZZ_SCRIPTS_DIR` / `FRIZZ_WORKER_PLUGIN_DIR` at those. `runtime/` MUST
  mirror the repo root, because cc-worker's shims reach back relatively (`../../board`).
- **`frizz-dev`** (`nub run frizz-dev:install`) is source-backed at launch only: the shim holds an
  absolute pointer to this checkout's CLI entrypoint. On each fresh launch it selects a
  verified immutable artifact matching the current source fingerprint, reuses an identical global one,
  or builds and promotes one. **The running server never watches the checkout and never runs HMR** —
  edits do nothing until you stop frizz and relaunch.

State is keyed by a stable checkout UUID: an ordinary worktree keeps it in `git config --local frizz.id`,
each linked worktree in its private Git admin dir, so siblings stay isolated. Canonical real paths make
a checkout opened through a symlink reuse the same instance. (That UUID also keyed a per-project tmux
socket once; there is no multiplexer any more, so the project id and state dir are the whole identity.)

### Browser launch modes

The default launch makes one standard OS request to open the localhost URL in the default browser; the
browser decides which window receives it. frizz does not scan, reuse, focus, or privately address tabs.

`--app` preserves the legacy dedicated/chromeless window as an explicit opt-in. On macOS that window
gets its own Dock name and icon: on first opt-in launch the launcher silently installs the frizz PWA
into the project's browser profile over CDP (`--remote-debugging-pipe` → `PWA.install` +
`PWA.changeAppUserSettings(displayMode: standalone)`; windowless, ~3-4s, once per machine). Chrome then
generates a real app-shim bundle at `~/Applications/Chrome Apps.localized/frizz.app` and every launch
goes through it. Why it works this way (all verified empirically on Chrome 150 / macOS):

- A plain `--app=` window is owned by the Chrome browser process — the Dock shows "Google Chrome", no
  launch flag changes it, and a hand-rolled `.app` that `exec`s Chrome loses its identity the moment
  Chrome's Cocoa startup re-registers the process. Chrome's generated app-shim is the only mechanism
  that yields an own Dock identity.
- The CDP `PWA.*` domain is only exposed on `--remote-debugging-pipe` connections (port-based
  websocket clients lack `AllowUnsafeOperations`), and a CDP install defaults the app to open-in-a-tab
  — `changeAppUserSettings(displayMode: "standalone")` is the required second half.
- Shim detection is stateless: scan shim `Info.plist`s for `CrAppModeShortcutURL` == the launch URL and
  `CrAppModeUserDataDir` under the project profile. (Chrome's generated app id is NOT a reproducible
  hash of the URL — don't try.)

Failure at any opt-in app step falls back silently to a plain `--app` window.
`packages/web/public/favicon.svg` is the canonical artwork; `nub scripts/generate-icons.mjs`
regenerates its six tracked PNG derivatives (`--check` detects drift, `--refresh-app-icons` refreshes
ICNS in idle shims). *Windows/Linux Dock branding is an unwired TODO:* Windows would set an
`AppUserModelID` on a generated `.lnk`; Linux (X11) would pass `--class=frizz` + a `.desktop` file whose
`StartupWMClass` matches.

### Running against a repo outside this monorepo

Set `FRIZZ_SCRIPTS_DIR` to the board parser directory and `FRIZZ_WORKER_PLUGIN_DIR` to the `cc-worker`
plugin directory. The published package does this for you.

## Conventions

- TypeScript run directly by Node in a source checkout (type stripping) — no build step for
  server/cli; Vite builds web. The published package ships compiled JS instead (a dependency under
  `node_modules` cannot be type stripped), so a consumer's Node floor is `engines`, not this one.
- ESM everywhere, `type: "module"`.
- Comments sparse and dense: design/invariant/provenance only.
- Tests: `node --test`, colocated `*.test.ts`, minimal + contract-shaped.
- Known gotcha: node-pty prebuilds lose the exec bit on `spawn-helper` (npm/pnpm strip it) —
  the server package postinstall re-chmods it. PTY code cannot run inside a sandboxed shell.
- UI state (unread, lastReadAt, session registry, settings) lives in
  `~/.frizz/projects/<projectId>/ui.db` (SQLite). An ordinary/main worktree's UUID remains the repo's
  `.git/config` key `frizz.id`; a linked worktree stores its own UUID at
  `<worktree-gitdir>/frizz.config`, preserving ordinary state while isolating sibling DB and lock
  namespaces. NEVER store UI state in the checkout's `.frizz/`.
- **Sidebar design philosophy (2026-07-09, maintainer-directed — don't regress it).** A FLOATING
  left column: NO background, NO border, NO clipping on the column itself (the New-thread pill's
  hover-scale must never clip; only the section LIST is a scroll container). Vertically centered in
  the viewport (sticky full-height wrapper; the inner column grows fit-content to
  `max-h-[calc(100vh-96px)]` — symmetric 48px margins — and scrolls internally only past that cap;
  horizontal overflow impossible by width discipline: min-w-0 everywhere + break-words titles).
  Width scales `clamp(240px, 30vw, 600px)`; it and the 720px workpane sit as a centered pair with
  one fixed 40px gutter, and the workpane itself vertically centers while shorter than the viewport
  (`my-auto`). THREE collapsible sections keyed on STATUS (`web/src/groups.ts` `sectionOf`): Active
  (active/blocked/needs-human, expanded), Plans (planning/planned — the design-phase statuses ARE
  the plans; collapsed), Inactive (done/dismissed/archived; collapsed; rows carry a status chip).
  Rows order by most-recent USER interaction (`orderByInteraction` — agent churn never reorders).
  Titles WRAP, never truncate. ONE derived indicator per row (spinner running, blue ● needs-action,
  clock/dashed-circle machine-waits, faint · idle); a petite-caps PLAN tag marks a doc with a
  `## Plan` section (derived `hasPlan`). ENTIRELY MOUSE-DRIVEN — no arrow-walk, no chevron, no focus
  machine (all deleted): a row click opens the thread's drawer (chat; the frizz DOC composite for a
  never-spawned thread — `store.openThread`), and the remaining keyboard is ⌘K/⌘I + Esc
  unwinding overlays then drawers. A ZERO-thread board (brand-new user) hides the sidebar entirely
  and centers the dispatch prompt as the whole screen.

## Experimental Codex app-server bridge foundation

- Disabled by default. `FRIZZ_CODEX_APP_SERVER_BRIDGE=1` constructs a lazy internal bridge; it does
  not change dispatch defaults or `backendFor`. The generic scoped interaction
  cards can reflect bridge-owned journal rows, but no default user flow creates those rows.
- The bridge can start new sessions and resume only native thread ids in its own SQLite ownership
  table. Existing/default/TUI Codex sessions are never imported or migrated.
- The protocol gate accepts exactly installed Codex `0.144.1`, audited from generated protocol plus
  immutable source tag `rust-v0.144.1` (`44918ea10c0f99151c6710411b4322c2f5c96bea`), over child stdio
  JSONL after `initialize` / `initialized`. Upgrades require a new exact source/protocol audit,
  fingerprint, fixtures, and diagnostic expectation; semver ranges are never accepted. It rejects
  versioned `jsonrpc` envelopes, bounds and serializes inbound records, and never retains stderr text.
  No PTY or terminal scraping.
- The child receives an explicit minimal environment, not `process.env`: executable/runtime/home,
  locale/temp, OS credential-store plumbing, proxy/custom-CA settings, and only the audited built-in
  Codex/OpenAI auth/provider variables. Frizz, GitHub, Anthropic, AWS, Node injection, and arbitrary
  `CODEX_*`/`OPENAI_*` values are excluded. Arbitrary custom-provider `env_key` support remains out of
  scope until it can be derived and approved without forwarding unrelated secrets.
- Provider responses are durably claimed once, but the interaction journal remains pending until
  Codex emits `serverRequest/resolved`. A disconnect never blindly replays an unknown send; a newly
  witnessed matching server request is required. Session/turn ownership, provider RPC ids, and
  response acknowledgements remain connection-epoch and project-session scoped. Secret user-input
  delivery fails closed until a secure transient escrow exists.
- Exact response semantics are intentionally narrow: additional permissions expose turn/session
  grants plus deny (the server treats an empty granted profile as no grant), while
  `request_user_input` exposes only answer. That protocol has no decline/cancel response; cancelling
  work belongs to a separate future `turn/interrupt` control, not a fabricated interaction choice.
- Registry replacement/deletion atomically cancels old delivery rows and detaches the exact native
  binding before a lifecycle hook removes it and terminates the child. Bridge disconnect/close
  detaches active bindings, and action authority requires a live connection plus the exact active
  binding/epoch. Ordinary TUI sessions have no matching binding and are untouched.
- Scoped interaction reads expose only a provider-neutral delivery effect. `awaiting-user` is the
  sole provider-backed state that enables controls; durable `queued`/`sent` projects as noninteractive
  “Sending to runtime…” across remounts and restarts, and a missing bridge projects as
  `reconnect-required`. Transport ids, provider context/responses, and secret values never cross this
  RPC boundary. The board retains pending thread visibility but removes queued/sent work from Needs
  You until a genuinely actionable request exists.
- Dispatch selection remains intentionally deferred. Do not enable this flag as a user-facing default
  until dedicated turn-interrupt UX, secure secret-answer delivery, custom-provider environment
  policy, independent review, and real end-to-end live-thread validation are complete.
