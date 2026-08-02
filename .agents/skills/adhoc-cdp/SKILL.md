---
name: adhoc-cdp
description: Ad hoc runtime verification for fray-ui — boot a fully-ISOLATED disposable stack and drive the REAL app (screenshots, console, network) headless in the background, plus focused real-subsystem harnesses for backend behavior the browser can't reach. Load this when your fray-ui change is one you need to SEE work before claiming done — a new or restructured surface, anything judged by eye, behavior you can't predict from the code alone, or anything large or uncertain (the worker RUNTIME RELEASE GATE calls for exactly this). A small, certain fix pinned by a test at the right level does not need a stack boot.
version: 0.1.0
metadata:
  internal: true
---

# fray:adhoc-cdp — drive the real app, don't guess

When a change is one you need to SEE, this is the fast, repeatable loop for it: a throwaway stack that
touches nothing real, driven headless so you can screenshot and inspect it in the background while you
keep working. Reach for it whenever a browser is what would actually settle the question — a new or
restructured surface, anything you have to judge by eye, live/timing/restart behavior you cannot predict
from the code, a bug whose fix no test pins where it lives, or anything large or cross-cutting. Booting
it is cheap; being wrong in front of the maintainer is not.

**It is not a tax on every diff.** A targeted fix in code you have read, pinned by a test at the right
level and with a blast radius you can name, is verified without a stack — say what you verified and how,
and move on. Judge which one you have; both directions are real failures.

Two layers, use both as the change demands:
1. **The isolated stack + browser** — for anything with a UI or HTTP surface.
2. **A focused real-subsystem harness** — for backend behavior the browser can't reach (tmux, SQLite,
   scheduler, resume/wake paths). Spin the REAL resource, assert the REAL function.

---

## 1. The isolated disposable stack

`scripts/adhoc-stack.mjs` boots a complete fray-ui instance sandboxed on every axis so it can never
touch the maintainer's live instance, real `~/.fray` SQLite, or real worker tmux:

- `HOME` → a fresh temp dir (the SQLite DB + `server.lock` live in an empty `~/.fray` there)
- `FRAY_TMUX_SOCKET` → a unique socket (spawned worker tmux never collides with real sockets)
- `PORT` → a unique high port (never fights the dev server on 5175)
- `FRAY_WAKERS_OFF=1` → scheduler OFF by default; pass `--wakers` to arm it when testing wake delivery

Boot it in the **background** (never foreground — it stays up until killed) and read back its URL:

```bash
# from ui/ — run in the background, REDIRECT to a file, then read the json line for the url + home
nub scripts/adhoc-stack.mjs --port=4930 > /tmp/stack.log 2>&1
# → {"url":"http://127.0.0.1:4930/","port":4930,"home":"…","socket":"…","project":"…","wakers":false}
```

**Never pipe it through `head`/`sed`/`grep` to read that line.** The stack keeps logging (every Vite HMR
update, and the shared tree is edited constantly), so the reader exits, the pipe closes, and the next
write kills the server with SIGPIPE — minutes later, mid-verification, looking like an unrelated crash.
Redirect to a file and poll the file. Take `home` AND `socket` from that json: the socket carries a PID
suffix (`fray-adhoc-4930-84193`), so guessing `fray-adhoc-4930` seeds your fixture panes onto a socket
the server isn't watching.

Flags: `--port=N`, `--project=/abs/dir` (defaults to the fray repo — a gh-authed repo with an empty board
under the temp HOME), `--wakers` (arm the scheduler), `--keep` (don't delete the temp HOME on exit).

**Cleanup:** send SIGTERM/SIGINT (kill the background Bash task) — it deletes the temp HOME automatically.
Always kill it before you come to rest; never rest on a running stack.

**A SERVER change needs a RESTART; only the web hot-reloads.** Vite HMR covers `packages/web`, so a
component edit is live on the next reload — but the server modules (`transcript.ts`, the tailer, the RPC
router) were loaded once at boot, so an edit there is invisible until you restart the stack. The failure
is silent and reads as "my fix didn't work": the page renders the OLD projection and your assertion fails
against code you already corrected. If a server-side assertion fails and the code plainly says otherwise,
restart before debugging.

**Removing an injected style: hold the handle.** `page.addStyleTag()` returns an ElementHandle — remove
THAT (`await tag.evaluate((el) => el.remove())`). Never sweep `querySelectorAll("style")` matching on text
content: in dev Vite injects the entire app CSS as a `<style>`, so a predicate like "contains
`.fray-todo-row` and `nowrap`" matches the whole stylesheet and deletes it. The page then renders
unstyled and every geometry assertion after it fails for a reason that has nothing to do with your change.

---

## 2. Driving the app — headless, with screenshots

> ## NEVER put a browser window on the maintainer's screen
>
> You share this desktop with a human who is working. A verification run must be **invisible**: headless,
> on a throwaway profile, leaving no window and no tab behind. Popping a visible Chrome is the single
> most disruptive thing this skill can do, and it is never necessary — `shot.mjs` does everything the
> gate requires without ever drawing a pixel. If you catch yourself about to launch a headful browser,
> that is the bug.
>
> This is not a style note. It was a real, repeated complaint (maintainer 2026-07-28: *"it keeps opening
> tabs in my actual real Chrome"*), and the cause was this file recommending the MCP first — see below.

### Default, and the one you should almost always use: `scripts/shot.mjs` (puppeteer)
`shot.mjs` launches its **own isolated headless Chrome** every run — a fresh `puppeteer_dev_chrome_profile-*`
temp dir, no shared profile, no collision, no window. It works in the background unconditionally and cannot
disturb the maintainer. It screenshots and runs an in-page `evaluate` in one shot, and prints any
page/console errors. This is the workhorse for "prove it renders", responsive checks, and optical review.

### Chrome DevTools MCP — richer, but only because this repo forces it headless
The MCP gives you a real a11y tree and interaction primitives (`new_page` → `navigate_page` →
`take_snapshot` / `take_screenshot` / `list_console_messages` / `list_network_requests` / `click` / `fill` /
`evaluate_script`). Reach for it when you genuinely need to *drive* the page rather than photograph it.

> **Why it is second, and why it used to be a menace.** `chrome-devtools-mcp` ships two hostile defaults:
> `headless` defaults to **false** (`cli-options.js`) so it opens a **visible window on the maintainer's
> desktop**, and `isolated` defaults to **false** (`index.js`) so every agent shares one persistent profile
> at `~/.cache/chrome-devtools-mcp/chrome-profile`. Shared-profile collisions then fail every `new_page`
> with *"The browser is already running … Use --isolated"*.
>
> This repo pins both off in `.mcp.json` (`--headless --isolated`) and disables the argument-less plugin
> build in `.claude/settings.json`, because `enabledPlugins` accepts no flags and so can only ever run
> headful. **Do not re-enable that plugin, and do not launch `chrome-devtools-mcp` by hand without both
> flags.** If the MCP is unavailable or collides anyway, fall straight to `shot.mjs` — don't fight it.

```bash
# screenshot + assert board state (the eval's completion value prints as json)
node scripts/shot.mjs "http://127.0.0.1:4930/" .adhoc-shots/board-desktop.png \
  "({title: document.title, threads: document.querySelectorAll('[data-thread-slug]').length})" \
  --w=1440 --h=900 --wait=2500

# narrow viewport for responsive/overflow checks
node scripts/shot.mjs "http://127.0.0.1:4930/" .adhoc-shots/board-narrow.png "" --w=420 --h=880

# a complex in-page routine (occlusion/alignment/optical-center) from a file
node scripts/shot.mjs "$URL" out.png @/tmp/routine.js
```

Always: capture **desktop + narrow** widths, read the screenshots back, and check the `PAGE ERRORS:` line
— a clean render with console errors is not a pass. Exercise the relevant active/idle/error/restart states,
not just first paint.

### Seeding real state
An empty board proves the shell renders but not much else. To exercise real flows, drive the app's own RPC
surface or the UI itself (type a task in the composer via `shot.mjs`'s evaluate / CDP `fill`)
so the state is created the way production creates it — never hand-write rows into the sandbox SQLite.

**Use `scripts/lib/rpc-client.mjs`. Never hand-roll `fetch` against `/rpc`.** Two details are easy to
get wrong, and both fail SILENTLY — you get a plausible wrong answer instead of an error, which is how a
harness ends up "proving" something it never tested:
- **queries are `GET /rpc/<name>?input=<json>`, mutations are `POST /rpc/<name>`.** POSTing a query does
  not throw; it 404s, and reads back as "no data" (this is what made a verify run report an empty board).
- **every response is `{result}` or `{error}` — never the payload bare.** Reading `body.slug` off the
  envelope yields `undefined` for a call that actually SUCCEEDED.

```js
import { createRpcClient } from "./lib/rpc-client.mjs"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
const { slug, sessionId } = await api.mutate("dispatch", { prompt: "…", backend: "codex" })
const board = await api.query("board")            // unwrapped result; throws RpcError on {error}
```

The client also sets the loopback `Origin` header, without which any write 403s.

**Dispatching a REAL Claude worker won't work under the temp HOME** — `rpc/dispatch` fails
`AUTH_REQUIRED:claude`. The reason is worth knowing, because it decides the workaround: the macOS login
keychain lives at `$HOME/Library/Keychains`, so redirecting HOME hides the `Claude Code-credentials`
item from `security find-generic-password` even though it is a USER-scoped credential. Seeding it into
the temp HOME (copying the blob, symlinking `~/Library/Keychains`) is blocked by the permission classifier.

**When you need a real broker worker, keep the real HOME and isolate the PROJECT instead:**
`--home=$HOME --project=/tmp/<throwaway-git-repo>`. HOME stays real (keychain works, so `dispatch`
succeeds and a genuine broker session streams SDK events), while the throwaway project dir gets its own
project id, its own `~/.fray/projects/<id>/` state, its own tmux socket and its own port — so it never
touches a board you care about. `--home` implies `--keep`, so clean up after yourself: kill the stack by
exact PID, kill the leftover `claude` broker processes (find them by their `FRAY_STATE_DIR=<that project
id>` in `ps`), then `rm -rf ~/.fray/projects/<id> <throwaway-repo> ~/.claude/projects/<cwd-slug>`.
Verified 2026-07-30 driving a real background-dispatch-then-rest worker end to end this way. Do NOT
write settings through this stack — `~/.fray/ui.db` settings are global and shared with the real boards.

For transcript/board/telemetry flows that don't need a live provider, **simulate a worker** instead —
the tailer only needs three things, all inside the sandbox:
1. a JSONL at `<tempHome>/.claude/projects/<cwd-slug>/<sessionId>.jsonl` you append records to
   (copy real record shapes: `user` / `assistant` (+`stop_reason`) / `queue-operation` / `queued_command`
   attachment — `transcript.ts` + `tailer.ts` document what each field drives);
2. a live dummy pane on the sandbox socket: `tmux -L <stack-socket> new-session -d -s fray-<slug> "sleep 7200"`;
3. one `session` row in the sandbox DB (`sqlite3 <tempHome>/.fray/projects/*/ui.db "INSERT INTO session
   (slug, session_id, tmux_name, spawned_at, title, backend, model, effort, permission_mode) VALUES (…)"`).
   This is the sanctioned exception to "never hand-write rows": the row is the fixture, and appending
   records then exercises the REAL tailer → board → push → render pipeline end-to-end (turn state flips
   on the records exactly as with a live worker).

---

## 3. Focused real-subsystem harnesses (backend behavior)

Browser QA can't reach tmux sockets, the resume/wake path, SQLite migrations, or the scheduler. For those,
write a small `Nub` harness that spins the **real** resource and asserts the **real** function — mocks prove
nothing about tmux. Pattern (`scripts/verify-legacy-wake.mjs` is a worked example for the legacy-socket
wake fix):

```
import { execFileSync } from "node:child_process"
import { theFixedFunction } from "../packages/server/src/<module>.ts"
// 1. create the real precondition (a real tmux pane on a real socket, a real sqlite db, …)
// 2. call the real function
// 3. PASS/FAIL each assertion to stdout; process.exit(1) on any failure
// 4. tear the real resource down in finally
```

Include **negative controls** (an identity-mismatch case that must still be rejected), not just the happy
path — that's what proves a widened code path didn't weaken a safety check. A good harness catches your own
bugs: `verify-legacy-wake.mjs` caught a trailing-quote boundary bug in a matcher on its first run because it
used the production argv form instead of a hand-quoted string. Replicate production faithfully.

---

## 3b. Browser process hygiene — you share this machine

Other agents run QA concurrently against the same machine. Everything you start, you own by exact
identity, and you clean up only YOUR identity.

- **One browser instance per task, not per screenshot.** Reuse a single uniquely named owned session /
  target / harness instance for every desktop and narrow check in the task.
- **Arrange cleanup before launch** — a `finally`, a shell `trap`, or equivalent — so an interrupted or
  failed QA pass still tears down. Verify the exact owned session/target and its helper-process tree are
  gone before you rest.
- **NEVER use a global close, and never a broad `pkill -f`.** `close_all_pages`, a bare
  `pkill -f chrome`, or killing by name will take out another agent's live QA and dev servers. Kill by
  the exact PID / session id you created.
- Never leave a Chrome DevTools MCP helper, `agent-browser` daemon, puppeteer browser, or
  Chrome/Chromium helper process running after the task that started it.

Optical review is part of the pass, not a follow-up: icons beside text must be optically vertically
centered, and placement, truncation, and wrapping must be checked by looking at the screenshot — box
model numbers alone are not a pass.

**This skill gets you the shot; the `visual-review` skill tells you how to JUDGE it — load that one too
for any UI change.** It carries the ink-measurement routine for icon-beside-text alignment (every glyph
is off by a different amount, so one shared nudge cannot fix a cluster), the sign convention, and the
flex-item baseline-probe bug that inflates a real 1.2px error into a plausible-looking 3.5px one.

---

## 4. Before you rest

- Kill every background stack you booted (temp HOME auto-cleans on SIGTERM).
- Put the **decisive** screenshots (not bulk) into your handoff with **markdown image syntax**
  — `![meaningful alt](/abs/path.png)` — NOT `SendUserFile` (that pushes a file as a deliverable; it is
  not inline handoff evidence). The fray chat renders a local image only when its real path sits under a
  `/local-image` **trusted root**: `ctx.project.dir`, `os.tmpdir()`, `~/Screenshots`, or the project's
  `attachments/` dir. `.adhoc-shots/` (where `shot.mjs` writes by default) is gitignored and under NONE of
  those, so `![](.adhoc-shots/…)` 403s and renders broken. So: `--out` the shot to (or `cp` the decisive
  one into) `os.tmpdir()` and embed THAT absolute path. Keep a concise textual finding + process-cleanup note.
- If a gate was skipped (MCP unavailable, a state you couldn't reach), say so plainly — don't imply coverage
  you didn't have.
