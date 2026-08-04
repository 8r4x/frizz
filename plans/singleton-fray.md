# One Fray per machine — project grid, path routing, one port

Design review, 2026-08-04. Prompted by: *"switch fray over to be a singleton, so only a single version of it runs on each computer… top-level interface be a grid of project cards… `localhost:NNNN/fray`, `localhost:NNNN/nub`… converge on a single port."*

**Verdict: the direction is right and cheaper than it looks. Three things in the proposal as stated are wrong or missing, and one of them is load-bearing.** The naming default is backwards; there is no project registry to build a grid from; and the biggest cost is not routing but deciding what happens to a project nobody is looking at.

---

## 1. The naming rule is backwards — measured, not argued

The proposal: *"use the name of the repo by default, then the name of the directory."*

Measured on this machine over **324 git checkouts** under `~/Documents` + `~/.cache/fray-worktrees` (find `.git`, slugify the basename, read `remote.origin.url` for the repo name):

| slug rule | distinct slugs | colliding names | checkouts affected |
| --- | --- | --- | --- |
| **directory basename** | 296 | 20 | **48 (15%)** |
| **repo name (git remote)** | 242 | 28 | **110 (34%)** |

Worst repo-name collisions: `dpcweb` ×25, `zod` ×12, `fray` ×11, `scratch` ×8. Worst directory-basename collisions: `scratch` ×5, `app` ×4, then `colinhacks`/`bun`/`opencode` ×3.

The cause is structural, not incidental: **every worktree of a repo shares the repo's name.** `git worktree list` in this checkout alone reports **12 worktrees of `fray`** — `fray`, `fray-codex`, `fray-frizz`, `fray-monorepo`, `fray-pty`, `fray-quota-fix`, `fray-threaddoc`, two under `fray-wt/`, two under `~/.cache/fray-worktrees/`, one under `.claude/worktrees/`. Repo-name-first collapses all twelve to `fray`. Fray's own conventions tell agents to create worktrees freely, so this is the *common* case here, not the tail.

**Use the directory basename.** Repo name is a poor default and a fine *fallback* when the basename is generic.

### The rule I'd ship

Derive **once at registration**, persist, allow rename. Never re-derive on boot — a directory rename must not silently change a URL.

1. `slug = slugify(basename(realpath(dir)))` — reuse `slugify` from `packages/shared/src/thread-slug.ts`, which already produces exactly the `^[a-z0-9][a-z0-9-]*$` shape a path segment wants.
2. If the basename is **generic** (`app`, `src`, `web`, `www`, `main`, `repo`, `code`, `server`, `client`, `packages`, `site`, `scratch`, `tmp`, `test`), qualify with the parent: `pullfrog/app` → `pullfrog-app`. This is a live case — `~/Documents/pullfrog/app` is in the registry today.
3. If the directory is a **linked worktree** and the basename doesn't already start with the main checkout's basename, prefix it: `~/.cache/fray-worktrees/steer-reliability` → `fray-steer-reliability`. This groups worktrees next to their repo in the grid instead of scattering them.
4. On collision, **the incumbent always keeps its slug** — a URL must never change under someone who bookmarked it. Qualify the newcomer, first match wins: `<remote-owner>-<base>` (`colinhacks-zod`) → `<parent-dir>-<base>` → `<base>-2`, `-3`, …
5. Lowercase-normalize. On a case-insensitive filesystem two paths differing only in case are already the same project after `realpath`.
6. Renaming is a first-class registry field from day one. It costs nothing to add now and it is the escape hatch for every rule above.

Note that the derivation is order-dependent (whoever registers first gets the short name). For a local, per-machine, renameable tool that is fine — but it means slugs are **not reproducible across machines**, so nothing may treat a slug as a stable cross-machine identifier. The `projectId` UUID stays the real key; the slug is a display/URL alias.

### Reserve a namespace, or a repo named `settings` will break the app

Project slugs would share the top-level path namespace with the app's own routes. Today the client already hardcodes `/rpc`, `/events`, `/ws`, `/term/<slug>`, `/attach`, `/local-image`, `/local-visualization`, `/_fray/control/*`, plus root-absolute `/assets/…`, `/favicon*.png`, `/manifest.webmanifest`.

`_fray` is already the convention (`packages/web/src/api/restart.ts:69`). **Formalize it: everything Fray itself serves moves under `/_fray/`, and every other top-level segment is a project slug.** Then the deny-list is one word plus the static asset names, instead of a growing list that breaks whenever a route is added.

Two traps that follow:

- **Trailing slash.** `/<slug>` and `/<slug>/` resolve relative URLs differently. Assets are root-absolute today (`packages/web/vite.config.ts` sets no `base`), so this is survivable — but pick one form and redirect the other, rather than serving both.
- **`isFrayRoute`** (`packages/web/src/lib/markdownTargets.ts:29-32`) hardcodes the in-app route set. Under a prefix, every in-app link would look like a *filesystem path* to the sanitizer and render as a disabled local-file chip. Silent, and easy to miss.

---

## 2. There is no project registry — this is the largest hidden work item

A grid of project cards needs a list of projects. **That list does not exist.**

- `~/.fray/projects/` holds **42** project directories on this machine.
- Only **6** contain a `launcher.json` (the only file recording `projectDir`). **33 have no on-disk record of which repo they belong to at all.**
- `ui.db` has no column for the project directory — its tables are exactly `session` and `settings`.
- Two of the six recoverable paths point at dead `/private/tmp/` repos.

The mapping today runs repo → id (`git config --local fray.id`). There is **no reverse index**, no listing function anywhere in `packages/server/src` or `packages/web/src`, and no "open another repo" flow.

**The primitive is already designed**, in [`plans/gitless-projects.md`](gitless-projects.md) §3: `~/.fray/projects/<id>/identity.json` recording the minted path plus `(dev, ino)`, with a duplicate-checkout self-heal rule and a move-vs-copy distinction (`mv` preserves the inode on APFS, `cp -R` does not). That plan's §4 also specifies marker walk-up root discovery for non-repo directories — which is the *only* code path that would make "then the name of the directory" meaningful, since `src/launcher.ts:406-410` currently hard-fails outside a Git repo. **These two efforts should land together;** the singleton needs `identity.json`, and gitless needs somewhere to show a non-repo project.

Beyond the index, a grid needs a lifecycle nobody has had to think about while each project only ever saw itself:

- **Recency ordering** and search — 42 cards today, 324 candidate checkouts.
- **Staleness** — the path is gone; offer removal rather than showing a dead card.
- **Hide / archive** — throwaway `/tmp` repos should not be permanent fixtures.
- **Grouping worktrees under their main checkout** — otherwise 12 `fray-*` cards dominate the grid.

---

## 3. The real cost is not routing — it is projects nobody is looking at

Routing is cheap. The web router is 110 hand-rolled lines (`packages/web/src/lib/router.ts`); `currentPath()`/`applyPath()` are the only URL readers/writers, and `main.tsx:59` already branches the root render on pathname, so a `<ProjectGrid/>` is a third shell beside the existing `<App/>` and `<StandaloneThreadPage/>`. Server-side, `mountRouter(app, "/rpc", …)` already takes the prefix as an argument.

The server is also far more multi-tenant-ready than `ARCHITECTURE.md`'s "no cross-repo anything" invariant implies. `AppContext` is a per-call object explicitly documented as *"derived once at boot and threaded through the AppContext — no module reads cwd on its own"* (`packages/server/src/project.ts:13-14`). There are **zero** `process.chdir` calls, **zero** `process.env` mutations, and two `process.cwd()` calls, both defaulted parameters already overridden in production. Every module-level cache is keyed by absolute path or is genuinely machine-global. Broker sockets, `FRAY_PERM_DIR`, and interaction-journal reads are already project-namespaced — the journal even filters foreign `projectId`s with a comment saying why.

**What actually bites:**

- **The tailer's duty cycle.** `tickWithBudget` runs *synchronously on the event loop* (`packages/server/src/tailer.ts:3991-4009`), and the self-scheduling design bounds it at ~50% duty cycle **per tailer instance, with no cross-instance arbiter** (`:4010-4032`). Two tailers each claim 50%. This machine has 42 registered projects and 775 session rows. **Lazy activation is therefore mandatory, not an optimization.**
- **…and lazy activation has a product consequence.** Timers, `awaiting` wakes, limit auto-resume, snooze expiry, PR watches, and completion notifications are all "always on because that repo's server is running." If a singleton only activates the project you are viewing, **all of that stops for every project you are not viewing.** There is no existing mechanism for "run the scheduler for a project whose UI is closed." This is the single biggest functional consequence of the design and it is a product decision, not an implementation detail.
- **Blast radius.** `dev-child.ts:19-25` exits the process on any `uncaughtException`. Today that kills one repo's UI; in one shared process it kills all 42. Per-subsystem guards are good (tailer ticks, board rebuilds, transcript discovery are all individually caught) but there is no error boundary at the `AppContext` seam.
- **One artifact for the whole machine.** Artifact *storage* is already machine-global and content-addressed (`~/.fray/builds`, 87 digests here), but *selection* is per-project via `<stateDir>/stable.json` — and **8 projects are promoted to 8 distinct digests right now**, because each is keyed to the fray source checkout it was launched from. A singleton collapses this to one, which also collapses per-project "Update & Restart" and per-project rollback. For `npx frayui` users that is a simplification; for this repo's own dogfooding it is a real loss.
- **Two OS users.** The port reservation lock is documented "machine-wide" (`src/launcher.ts:672`) but lives under `~/.fray`, so it is **per-user** — deliberately, because `pidIsAlive` treats `EPERM` as ALIVE and another account's stale lock would read as permanently held. TCP ports are not per-user. Two users launching concurrently both reserve the port, both probe it free, and the loser fails at `listen()`. The 100-port scan hides this today; a fixed port turns it into a hard failure.
- **`fray-dev` vs published `frayui`.** Both would want the same fixed port on this machine. They need distinct defaults or a takeover protocol.
- **`--status` / `--stop` semantics invert.** Both mean "this workspace" today. Under a singleton, `--stop` from repo A stops repo B's board too.

### Same origin: mostly benign, with two real edges

Today each project is a distinct origin (distinct port). One port means one origin.

Benign: the only localStorage keys are `fray.prefs.v1`, `fray-font`, `fray.debugScroll` — all view preferences that are arguably per-machine anyway. `fray-drafts:v1` and `fray-thread-tab:*` are *already* keyed by `projectDir` internally, and `threadTabState.ts:40-42` carries a comment explicitly anticipating this scenario. No IndexedDB, no cookies, no service worker, no `BroadcastChannel`.

Two things do break:

- **Desktop notifications collapse.** `new Notification(title, { tag: event.slug })` (`packages/web/src/api/board-stream.ts:78`) uses the bare thread slug as the browser's replace-key. Two projects with a thread called `fix-queue-focus` would collapse into one notification, and the click handler runs `openThread` in whichever tab fired it. Needs `tag: project + slug`.
- **`font` is per-project on the server but per-origin on the client** (`lib/font.ts:28` mirrors it to localStorage for the pre-paint FOUC guard). That is a latent inconsistency today; a singleton makes it visible as the previous project's font flashing on load. `font`, `notifications`, and `localFileOpener` are per-machine concepts currently stored per-project and should move.

The **security** delta is smaller than it first appears but not zero. A fixed, well-known port does *not* meaningfully weaken CSRF: `packages/server/src/local-origin.ts` already requires an exact `Host` + `Origin` match and never trusts `X-Forwarded-*`, so a malicious page's `fetch` fails on Origin regardless of whether the port was guessable. What *is* lost is origin isolation *between projects* — markdown rendered from agent output in project A would execute in the same origin as project B's control plane, which can dispatch agents. Fray sanitizes markdown, so this is a raised stake rather than a new hole, but it should be a stated tradeoff rather than an accident.

**Subdomains (`fray.localhost:PORT`) would restore per-project origins — and are dead on arrival: Safari does not resolve `*.localhost`.** Chrome, Firefox and Edge do; Safari on macOS never implemented it. Wildcard-DNS services like `nip.io` would work but require a network round-trip, which is unacceptable for a local-first tool that must work offline.

---

## 4. Two architectures — and the cheaper one is already written

### A. One process, multi-tenant (the literal reading of "singleton")

One node process holds N `AppContext`s keyed by project, routed by path prefix.

Pros: simplest deployment story; a genuinely cross-project queue is trivial because all the data is in one heap; the machine-global timers that are currently duplicated 42× (quota refresh, orphan reaper) collapse to one, which is a real simplification.

Cons: needs *all four* hard items — a cross-project tailer budget, per-project activate/deactivate lifecycle, a per-project error boundary, and per-project broker env (`context.ts:604` currently spreads the whole `process.env` into every broker fork). Touches ~12-15 server files, with the genuinely hard work concentrated in `tailer.ts`, `index.ts` and `context.ts` — three of the most carefully-tuned files in the repo.

### B. One front door, N per-project processes (recommended)

A single machine-level process owns the fixed port, the project registry, and the grid. Opening `/nub` spawns (or reuses) that project's server on an ephemeral port and proxies to it, stripping the prefix.

**The proxy already exists and is in production.** `RestartSupervisorProxy` (`packages/server/src/restart-supervisor.ts`) holds a durable public port and forwards to a disposable private child: HTTP with `path: req.url` verbatim (`:360`), Host/Origin rewritten to the child's private authority (`:93-94`), forwarded-`*` stripped (`:98`), a hand-rolled WebSocket upgrade line (`:398`) with an explicit comment about why `Connection: Upgrade` must survive, and a recovery page when the child is down. Generalizing it from one child to a `slug → childPort` map is a small change to shipped, tested code.

Pros:

- **Avoids all four hard items.** Crash isolation, lifecycle, tailer budget and broker env are unchanged because each project is still its own process, exactly as today.
- **Lazy activation is automatic** — a project boots when opened.
- **Background projects can keep running** if the user wants, because each one is independently startable. This is the escape hatch for §3's biggest consequence.
- **Per-project artifact selection survives**, so per-project Update & Restart and rollback keep working.
- Touches roughly four places: the proxy, the supervisor, the launcher, and the web base-URL sites.

Cons: N node processes' RSS when many projects are warm (but that is today's status quo, not a regression); one extra loopback hop per request (already paid in production by the restart supervisor); the grid needs project status without booting children — which is fine, because the board parser is zero-dep and cold-parses in ~100ms, so the front door can read `.fray/` directly for card badges and never touch a child server.

**Recommendation: B.** It delivers every user-visible goal in the proposal — one port, one URL, a grid, subpaths — while leaving the parts of the server that are hard to get right exactly as they are.

### Alternatives considered and rejected

- **Query param (`/?project=nub`)** — what `code-server` actually does. Sidesteps the reserved-namespace and trailing-slash problems entirely, and is cheaper because `api/rpc.ts` and `api/socket.ts` build from `location.origin`. Rejected: the proposal's pretty URL is the point, and the namespace problem is solved by one reserved prefix.
- **Subdomains** — real origin isolation. Rejected: Safari.
- **Opaque short id (`/p/7f3a`)** — kills collisions dead. Rejected: unmemorable, which defeats the purpose.
- **Redirect hub** (fixed port 302s to the project's own port) — preserves per-project origins *and* crash isolation, and is the cheapest thing on this list. Rejected as the default because the address bar then shows the ugly port, so bookmarks land back on an unstable number. Worth keeping in the back pocket if per-project origin isolation ever becomes a hard requirement.

---

## 5. The port

### Constraints, verified

- **Browser-blocked ports.** Chromium's `kRestrictedPorts` (`net/base/port_util.cc`) and Firefox's `gBadPortList` (`netwerk/base/nsIOService.cpp`) were read at source. The union is 83 ports and **the highest is `10080`** (Amanda) — so anything above 10080 is clear of browser blocking entirely. One caveat: Chromium's `kRestrictAbusePortsOnLocalhost` is `ENABLED_BY_DEFAULT` and its contents come from a server-side Finch config rather than source, so Chrome retains the ability to block additional *localhost* ports at any time. No port is permanently guaranteed; this is one more reason the fallback is not optional.
- **Ephemeral ranges.** Windows default is **49152-65535** (Microsoft Learn, KB929851 — changed from 1025-5000 at Vista). macOS is **49152-65535** (`sysctl net.inet.ip.portrange.hifirst` on this machine; note `rapportd` has already taken exactly 49152 here). Linux default is **32768-60999** (kernel.org IP Sysctl, `ip_local_port_range`). ⇒ **never hard-code above 32767**, which rules out the IANA Dynamic/Private range (49152+) despite it being the "correct" range for unregistered use.
- **Windows Hyper-V/WSL is the spoiler, and it reaches down into the 3000s.** HNS reserves 100-port blocks at boot for NAT forwarding. The `netsh` dump in [microsoft/WSL#5514](https://github.com/microsoft/WSL/issues/5514) was **read at source via `gh api`** and contains, verbatim, blocks including `3699-3798`, `4214-4313`, `4714-4813`, `4914-5013`, `5014-5113` and on up to `6880-6979`; [microsoft/WSL#5306](https://github.com/microsoft/WSL/issues/5306) independently reports blocks spanning **4294-9783**. A reserved port is not *listening*, so `netstat` shows it free and `bind()` still fails with WSAEACCES/10013 — and Microsoft documents that `SO_REUSEADDR` does not rescue you. The blocks move between reboots.

  The mechanism (community consensus, **not** Microsoft-documented) is that these land low only when the machine's dynamic port range has been reset to ~1024 from its 49152 default. So on a stock Windows box the 3000s are fine; on a clobbered one the entire 2164-9783 span is a minefield — which also takes out Next.js's 3000, Vite's 5173, Postgres's 5432 and adb's 5037. The whole dev ecosystem is exposed to this and mitigates it with fallback, not with port choice.

### The safe band is 10081-32767

Above every browser-blocked port (max 10080), above every Hyper-V block anyone has reported (max ~9783), below Linux's ephemeral floor (32768), below macOS/Windows' (49152). Nothing on any of the three OSes allocates from it automatically. The cost is that it forces five digits.

### Recommendation: **13729** — "1‑FRAY", like a phone number

`http://localhost:13729` · F=3, R=7, A=2, Y=9 on a phone keypad, with the leading `1` that a dialled number carries anyway. It keeps the only mnemonic worth having while landing inside the safe band.

- **Not in the IANA registry at all** — genuinely unassigned, not squatting on someone's record.
- Above 10080, so clear of every browser blocklist.
- Outside all three OS ephemeral ranges and above every reported Hyper-V exclusion block.
- Free on this machine.

**Rejected, and why — all three of the obvious four-digit picks are inside verified exclusion blocks:**

| Port | Case for | Killed by |
| --- | --- | --- |
| **3729** | F-R-A-Y exactly; shorter. | Inside `3699-3798` in the WSL#5514 dump. Also IANA-assigned (`fksp-audit`, a dead 2003 vendor registration). |
| **4917** | Already Fray's `DEFAULT_PORT` (`packages/shared/src/index.ts:2111`) and the base of its 100-port scan; absent from the IANA registry; zero migration. | Inside `4914-5013`. Also unmemorable, failing the brief's one subjective criterion. |
| **4242** | Very memorable, IANA-unassigned. | Inside `4214-4313`. Also genuinely occupied: Posit Package Manager's default HTTP port and Orthanc's default DICOM port. |
| **24729** | Clean on every axis; in the safe band. | No mnemonic — arbitrary, so no better than 4917 once novelty fades. A reasonable pick if `13729` is disliked. |

Note the safe band is a *risk reduction*, not a guarantee: WSL#5306's reported span reaches 9783, and nothing prevents a future reservation landing higher. The band buys margin, and the fallback covers the rest.

### Fallback behavior

Keep the existing scan, re-based on the new default, and **say what happened**. Vite and Jupyter both increment to the next free port; Docker fails hard. Increment — a local dev tool that refuses to start because something unrelated holds a port is worse than one that prints a different URL. The launcher's `/health` identity handshake (`ownerProof` = `sha256("fray-project-launch-v2\0" ‖ projectId ‖ projectDir ‖ token)`, checked in `src/launcher.ts:593-630`) already guarantees a fixed port can never *silently* serve the wrong thing — it fails to start instead, which is the correct failure. Keep `--port` and `FRAY_PORT` as explicit-or-fail.

---

## 6. Suggested order

1. **`identity.json` + a project registry.** The reverse index from [`plans/gitless-projects.md`](gitless-projects.md) §3, plus backfill for the 33 orphaned state dirs and staleness detection. Nothing else can start without this.
2. **Slug derivation + rename**, per §1. Registry field, not a boot-time derivation.
3. **Move app routes under `/_fray/`**, freeing the top-level namespace. Fix `isFrayRoute` (`markdownTargets.ts:29-32`) in the same change.
4. **Generalize `RestartSupervisorProxy`** to a machine-level front door with a `slug → childPort` map.
5. **Client base-path awareness** — the ~11 hardcoded absolute paths, plus `currentPath()`/`applyPath()`.
6. **The grid** as a third root shell at `main.tsx:59`.
7. **Adopt the port**, and split `fray-dev` onto its own default so source and published installs coexist.
8. **Move `font` / `notifications` / `localFileOpener`** to machine-level settings; fix the notification `tag` collision.

### Fold in while you are here: three un-namespaced `/tmp` directories

Pre-existing and orthogonal to the singleton, but they are the same shared-resource bug class as the two-OS-users hazard in §3, and they already collide today between two Fray installs for *one* user. On macOS `$TMPDIR` is a per-user `/var/folders/…` path so these are latent; **on Linux `$TMPDIR` is normally unset, so all three land in a world-shared `/tmp`.**

- `tmpdir()/fray-worker-logs/<slug>.stall.log` (`packages/server/src/tailer.ts:132,3555`) — the filename is a **bare thread slug**, no project or user component. Two projects with a thread named `fix-auth` overwrite each other's stall log, which contains up to 4000 chars of captured agent output. The write is `try`/`catch`-wrapped, so it fails silently.
- `tmpdir()/fray-tool-images` (`packages/server/src/transcript.ts:1064`) — filenames are id-hashed and the temp-file publish is pid-safe, but `pruneScreenshotCache` (`:1086-1101`) `readdirSync`s the whole directory and unlinks the oldest past 200 entries, so **one install's prune deletes another's cached screenshots**. This one collides on every platform, including macOS.
- `tmpdir()/fray-sysprompts/<sessionId>.md` (`packages/server/src/session-files.ts:5`, written at `dispatch.ts:497-501`) — filenames are UUIDs so content cannot collide, but the *directory* can: on Linux the first OS user creates it at their umask, and a second user's `writeFileSync` then fails EACCES. That write is **not** wrapped in try/catch, so every dispatch for the second user throws. These files are agent system prompts.

The fix is the one already used correctly for the broker sockets — hash the state dir into the directory name (`packages/server/src/fray-paths.ts:44-52` documents exactly this rationale: "two accounts cannot collide even in a shared `/tmp`").

## 7. Open questions for the human

- **Architecture A or B** (§4) — recommendation is B.
- **The port** (§5) — recommendation is 13729 ("1‑FRAY"). Five digits is the price of clearing the band where Windows Hyper‑V has actually been observed to reserve ports; the shorter `3729` sits inside a verified exclusion block.
- **Do background projects keep running?** (§3) Under B this is a genuine choice rather than a constraint: always-on for every registered project (today's behavior, N processes), on-demand only (cheapest, but wakes and PR watches go quiet for closed projects), or a per-project toggle defaulting to on-demand.
