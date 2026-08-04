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

- **Browser-blocked ports.** Chromium's `kRestrictedPorts` (`net/base/port_util.cc`) and Firefox's `gBadPortList` (`netwerk/base/nsIOService.cpp`) were read at source. Both block a similar ~80-entry set topping out at `6000` (X11), `6566`, `6665-6669`, `6679`, `6697` (IRC), `10080` (Amanda). Nothing between 1024 and 6000 except `1719`, `1720`, `1723`, `2049`, `3659`, `4045`, `4190`, `5060`, `5061`.
- **Ephemeral ranges.** Windows default is **49152-65535** (Microsoft Learn, KB929851 — changed from 1025-5000 at Vista). macOS is **49152-65535** (`sysctl net.inet.ip.portrange.hifirst` on this machine). Linux default is **32768-60999**. ⇒ **the band clean on all three is 1024-32767**, which rules out the IANA Dynamic/Private range (49152+) despite it being the "correct" range for unregistered use. This is why every popular dev tool sits in the registered range.
- **Windows Hyper-V/WSL is the spoiler.** HNS reserves semi-random port blocks at boot for NAT forwarding; [microsoft/WSL#5514](https://github.com/microsoft/WSL/issues/5514) shows 100-port exclusion blocks spanning roughly **2164-5618** on one machine, and some reservations do not even appear in `netsh interface ipv4 show excludedportrange`. **No fixed port in the low range is reliably bindable on a Windows box with WSL or Hyper-V enabled.** This is a constraint on the *fallback*, not on the choice: whatever port is picked, Fray must degrade gracefully and say what it did.

### Recommendation: **3729** — F‑R‑A‑Y on a phone keypad

`http://localhost:3729` · F=3, R=7, A=2, Y=9. It explains itself in one line of README and it is the only candidate with a real mnemonic.

- In the safe **1024-32767** band; outside every default ephemeral range.
- On **neither** browser's blocked list.
- IANA: registered as `fksp-audit` ("Fireking Audit Port"), an individual's 2003 vendor registration. Assigned on paper, dead in practice — nothing ships on it.
- Free on this machine right now, as are all the alternates.

**Runners-up:**

| Port | Case for | Case against |
| --- | --- | --- |
| **4917** | Already Fray's `DEFAULT_PORT` (`packages/shared/src/index.ts:2111`) and already the base of its 100-port scan. Genuinely **absent from the IANA registry**. Zero migration. | Unmemorable — fails the brief's one subjective criterion. |
| **4242** | Very memorable, IANA-unassigned. | Genuinely occupied in practice: Posit Package Manager's default HTTP port, Orthanc's default DICOM port, a folk-favorite "just pick something" port. |
| **5959 / 6565 / 4994** | Rhythmic, IANA-unassigned (from a full sweep of 1024-32767 for unassigned repdigit/ABAB/palindrome ports). | Arbitrary — no connection to Fray, so no better than 4917 on memorability once the novelty wears off. |

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

## 7. Open questions for the human

- **Architecture A or B** (§4) — recommendation is B.
- **The port** (§5) — recommendation is 3729.
- **Do background projects keep running?** (§3) Under B this is a genuine choice rather than a constraint: always-on for every registered project (today's behavior, N processes), on-demand only (cheapest, but wakes and PR watches go quiet for closed projects), or a per-project toggle defaulting to on-demand.
