# One Frizz per machine — project grid, path routing, one port

Design review, 2026-08-04. Prompted by: *"switch frizz over to be a singleton, so only a single version of it runs on each computer… top-level interface be a grid of project cards… `localhost:NNNN/frizz`, `localhost:NNNN/nub`… converge on a single port."*

**Verdict: the direction is right and cheaper than it looks. The routing and naming are easy; the real work is a project registry that does not exist, and making one process hold N projects without the tailer eating the event loop.**

**Decided by the maintainer, 2026-08-04 — not open questions:**

- **One unified process.** Not a front door proxying to per-project servers. This is a big refactor and that is accepted.
- **Frizz runs from real root repo directories only.** A worktree is not a project. Worktree management is something the *agent* does inside a project, with prompting; Frizz has no special handling and needs none.
- **Registration is automatic and silent.** Running the CLI inside a directory registers that path as a project with no approval step.
- **The port is `6767`.** Chosen for memorability over robustness, knowingly — see §5 for what it costs and the fallback that has to change because of it.

---

## 1. Naming: the rule matters, the collision *rate* does not

I originally measured slug collisions across 324 checkouts and reported repo-name-first at 34% versus directory-basename at 15%. **That was the wrong population** — it counted linked worktrees, which are never Frizz projects. Corrected, over root checkouts only (a linked worktree has `.git` as a *file*, a real checkout has it as a *directory*):

| slug rule | distinct slugs | colliding names | root checkouts affected |
| --- | --- | --- | --- |
| **directory basename** | 276 | 20 | 48 |
| **repo name (git remote)** | 239 | 24 | 89 |

304 real root checkouts, 18 linked worktrees. The direction survives — repo-name still collides roughly twice as much, now driven by same-remote clones (`dpcweb` ×25, `zod` ×9, `scratch` ×8) rather than by worktrees.

**But at the real scale this does not carry an argument.** Frizz runs from three or four directories, growing to maybe a few dozen. At that size a collision is an edge case, not a rate — and for a root clone the repo name and the directory basename are usually the same string anyway. The original instinct ("repo name, then directory name") is fine. Prefer the **directory basename** on the tiebreak, for two small reasons: it needs no git remote (so it works for the gitless case), and it is the name already in your shell prompt.

What actually matters is that collisions are handled *correctly* when they happen, not that they are rare.

### The rule to ship

Derive **once at registration**, persist, allow rename. Never re-derive on boot — a directory rename must not silently change a URL.

1. `slug = slugify(basename(realpath(dir)))` — reuse `slugify` from `packages/shared/src/thread-slug.ts`, which already produces exactly the `^[a-z0-9][a-z0-9-]*$` shape a path segment wants.
2. If the basename is **generic** (`app`, `src`, `web`, `www`, `main`, `repo`, `code`, `server`, `client`, `packages`, `site`, `scratch`, `tmp`, `test`), qualify with the parent: `pullfrog/app` → `pullfrog-app`. This is a live case — `~/Documents/pullfrog/app` is in the registry today, and `app` is the single most likely real collision at small scale.
3. On collision, **the incumbent always keeps its slug** — a URL must never change under someone who bookmarked it. Qualify the newcomer, first match wins: `<remote-owner>-<base>` (`colinhacks-zod`) → `<parent-dir>-<base>` → `<base>-2`, `-3`, …
4. Lowercase-normalize. On a case-insensitive filesystem two paths differing only in case are already the same project after `realpath`.
5. Renaming is a first-class registry field from day one. It costs nothing to add now and it is the escape hatch for every rule above.

The derivation is order-dependent (whoever registers first gets the short name), so slugs are **not reproducible across machines** and nothing may treat one as a stable cross-machine identifier. The `projectId` UUID stays the real key; the slug is a display and URL alias.

### Reserve a namespace, or a repo named `settings` will break the app

Project slugs would share the top-level path namespace with the app's own routes. Today the client already hardcodes `/rpc`, `/events`, `/ws`, `/term/<slug>`, `/attach`, `/local-image`, `/local-visualization`, `/_frizz/control/*`, plus root-absolute `/assets/…`, `/favicon*.png`, `/manifest.webmanifest`.

`_frizz` is already the convention (`packages/web/src/api/restart.ts:69`). **Formalize it: everything Frizz itself serves moves under `/_frizz/`, and every other top-level segment is a project slug.** Then the deny-list is one word plus the static asset names, instead of a growing list that breaks whenever a route is added.

Two traps that follow:

- **Trailing slash.** `/<slug>` and `/<slug>/` resolve relative URLs differently. Assets are root-absolute today (`packages/web/vite.config.ts` sets no `base`), so this is survivable — but pick one form and redirect the other, rather than serving both.
- **`isFrizzRoute`** (`packages/web/src/lib/markdownTargets.ts:29-32`) hardcodes the in-app route set. Under a prefix, every in-app link would look like a *filesystem path* to the sanitizer and render as a disabled local-file chip. Silent, and easy to miss.

---

## 2. There is no project registry — this is the largest hidden work item

A grid of project cards needs a list of projects. **That list does not exist.**

- `~/.frizz/projects/` holds **42** project directories on this machine.
- Only **6** contain a `launcher.json` (the only file recording `projectDir`). **33 have no on-disk record of which repo they belong to at all.**
- `ui.db` has no column for the project directory — its tables are exactly `session` and `settings`.
- Two of the six recoverable paths point at dead `/private/tmp/` repos.

The mapping today runs repo → id (`git config --local frizz.id`). There is **no reverse index**, no listing function anywhere in `packages/server/src` or `packages/web/src`, and no "open another repo" flow.

**The primitive is already designed**, in [`plans/gitless-projects.md`](gitless-projects.md) §3: `~/.frizz/projects/<id>/identity.json` recording the minted path plus `(dev, ino)`, with a duplicate-checkout self-heal rule and a move-vs-copy distinction (`mv` preserves the inode on APFS, `cp -R` does not). That plan's §4 also specifies marker walk-up root discovery for non-repo directories — which is the *only* code path that would make "then the name of the directory" meaningful, since `src/launcher.ts:406-410` currently hard-fails outside a Git repo. **These two efforts should land together;** the singleton needs `identity.json`, and gitless needs somewhere to show a non-repo project.

Beyond the index, a grid needs a lifecycle nobody has had to think about while each project only ever saw itself:

- **Recency ordering** and search — 42 cards today, 324 candidate checkouts.
- **Staleness** — the path is gone; offer removal rather than showing a dead card.
- **Hide / archive** — throwaway `/tmp` repos should not be permanent fixtures.
- **No worktree cards.** Projects are real root checkouts; a linked worktree (`.git` as a file) is never registered, so the grid stays at the handful of directories you actually launch from.

---

## 3. The real cost is not routing — it is projects nobody is looking at

Routing is cheap. The web router is 110 hand-rolled lines (`packages/web/src/lib/router.ts`); `currentPath()`/`applyPath()` are the only URL readers/writers, and `main.tsx:59` already branches the root render on pathname, so a `<ProjectGrid/>` is a third shell beside the existing `<App/>` and `<StandaloneThreadPage/>`. Server-side, `mountRouter(app, "/rpc", …)` already takes the prefix as an argument.

The server is also far more multi-tenant-ready than `ARCHITECTURE.md`'s "no cross-repo anything" invariant implies. `AppContext` is a per-call object explicitly documented as *"derived once at boot and threaded through the AppContext — no module reads cwd on its own"* (`packages/server/src/project.ts:13-14`). There are **zero** `process.chdir` calls, **zero** `process.env` mutations, and two `process.cwd()` calls, both defaulted parameters already overridden in production. Every module-level cache is keyed by absolute path or is genuinely machine-global. Broker sockets, `FRIZZ_PERM_DIR`, and interaction-journal reads are already project-namespaced — the journal even filters foreign `projectId`s with a comment saying why.

**What actually bites:**

- **The tailer's duty cycle.** `tickWithBudget` runs *synchronously on the event loop* (`packages/server/src/tailer.ts:3991-4009`), and the self-scheduling design bounds it at ~50% duty cycle **per tailer instance, with no cross-instance arbiter** (`:4010-4032`). Two tailers each claim 50%. This machine has 42 registered projects and 775 session rows. **Lazy activation is therefore mandatory, not an optimization.**
- **…and lazy activation has a product consequence.** Timers, `awaiting` wakes, limit auto-resume, snooze expiry, PR watches, and completion notifications are all "always on because that repo's server is running." If a singleton only activates the project you are viewing, **all of that stops for every project you are not viewing.** There is no existing mechanism for "run the scheduler for a project whose UI is closed." This is the single biggest functional consequence of the design and it is a product decision, not an implementation detail.
- **Blast radius.** `dev-child.ts:19-25` exits the process on any `uncaughtException`. Today that kills one repo's UI; in one shared process it kills all 42. Per-subsystem guards are good (tailer ticks, board rebuilds, transcript discovery are all individually caught) but there is no error boundary at the `AppContext` seam.
- **One artifact for the whole machine.** Artifact *storage* is already machine-global and content-addressed (`~/.frizz/builds`, 87 digests here), but *selection* is per-project via `<stateDir>/stable.json` — and **8 projects are promoted to 8 distinct digests right now**, because each is keyed to the frizz source checkout it was launched from. A singleton collapses this to one, which also collapses per-project "Update & Restart" and per-project rollback. For `npx frizz` users that is a simplification; for this repo's own dogfooding it is a real loss.
- **Two OS users.** The port reservation lock is documented "machine-wide" (`src/launcher.ts:672`) but lives under `~/.frizz`, so it is **per-user** — deliberately, because `pidIsAlive` treats `EPERM` as ALIVE and another account's stale lock would read as permanently held. TCP ports are not per-user. Two users launching concurrently both reserve the port, both probe it free, and the loser fails at `listen()`. The 100-port scan hides this today; a fixed port turns it into a hard failure.
- **`frizz-dev` vs published `frizz`.** Both would want the same fixed port on this machine. They need distinct defaults or a takeover protocol.
- **`--status` / `--stop` semantics invert.** Both mean "this workspace" today. Under a singleton, `--stop` from repo A stops repo B's board too.

### Same origin: mostly benign, with two real edges

Today each project is a distinct origin (distinct port). One port means one origin.

Benign: the only localStorage keys are `frizz.prefs.v1`, `frizz-font`, `frizz.debugScroll` — all view preferences that are arguably per-machine anyway. `frizz-drafts:v1` and `frizz-thread-tab:*` are *already* keyed by `projectDir` internally, and `threadTabState.ts:40-42` carries a comment explicitly anticipating this scenario. No IndexedDB, no cookies, no service worker, no `BroadcastChannel`.

Two things do break:

- **Desktop notifications collapse.** `new Notification(title, { tag: event.slug })` (`packages/web/src/api/board-stream.ts:78`) uses the bare thread slug as the browser's replace-key. Two projects with a thread called `fix-queue-focus` would collapse into one notification, and the click handler runs `openThread` in whichever tab fired it. Needs `tag: project + slug`.
- **`font` is per-project on the server but per-origin on the client** (`lib/font.ts:28` mirrors it to localStorage for the pre-paint FOUC guard). That is a latent inconsistency today; a singleton makes it visible as the previous project's font flashing on load. `font`, `notifications`, and `localFileOpener` are per-machine concepts currently stored per-project and should move.

The **security** delta is smaller than it first appears but not zero. A fixed, well-known port does *not* meaningfully weaken CSRF: `packages/server/src/local-origin.ts` already requires an exact `Host` + `Origin` match and never trusts `X-Forwarded-*`, so a malicious page's `fetch` fails on Origin regardless of whether the port was guessable. What *is* lost is origin isolation *between projects* — markdown rendered from agent output in project A would execute in the same origin as project B's control plane, which can dispatch agents. Frizz sanitizes markdown, so this is a raised stake rather than a new hole, but it should be a stated tradeoff rather than an accident.

**Subdomains (`frizz.localhost:PORT`) would restore per-project origins — and are dead on arrival: Safari does not resolve `*.localhost`.** Chrome, Firefox and Edge do; Safari on macOS never implemented it. Wildcard-DNS services like `nip.io` would work but require a network round-trip, which is unacceptable for a local-first tool that must work offline.

---

## 4. One unified process — decided

One node process holds N `AppContext`s keyed by project, routed by path prefix. A front door proxying to per-project child servers was considered and **rejected**: it would have reused `RestartSupervisorProxy` and dodged the hard items below, but it keeps N processes alive, keeps N divergent artifacts, and leaves the cross-project queue to be assembled over a wire instead of read out of one heap. The unified process is the thing worth building even though it is the bigger refactor.

What it buys, beyond the stated goals: the machine-global timers currently duplicated per project — the quota refresh (`context.ts:498-505`, per *account*, not per project) and the orphan reaper (`:514-516`, which already reaps the whole machine) — collapse to one each. That is a straight simplification, and today's duplication is pure waste.

### The four things that must be solved

1. **A cross-process tailer budget.** `tickWithBudget` runs synchronously on the event loop (`tailer.ts:3991-4009`) and the self-scheduling design bounds it at ~50% duty cycle **per tailer instance, with no cross-instance arbiter** (`:4010-4032`). Two tailers each claim 50%. Either one shared scheduler round-robins all tailers under a single budget, or the tailers move to `worker_threads`, or only active projects tail. **Riskiest single item — worth an experiment before the design is fixed**, since the saturation claim is read from the scheduling logic and its own over-budget warning, not measured.
2. **Per-project activate/deactivate lifecycle.** `startServer` builds one `AppContext` and tears it down at process exit. Making it a keyed, ref-counted, restartable resource means reworking two shutdown barriers (`index.ts:408-453`, `context.ts:247-274`) and the ownership fence (`index.ts:457-514`) from process lifetime to tenant lifetime. They are well-tested but deeply assume one-shot.
3. **A per-project error boundary.** `dev-child.ts:19-25` exits the process on any `uncaughtException`. Per-subsystem guards are already good — tailer ticks, board rebuilds, `fs.watch` setup and transcript discovery are each individually caught, and the tailer's guard carries a comment saying its absence *used* to take down the whole server. What is missing is a catch at the `AppContext` seam so one project's corrupt `ui.db` or malformed `.frizz/` cannot abort every other project.
4. **Per-project broker env.** `context.ts:604` spreads the entire `process.env` into every broker fork. That env is project-pinned today via `FRIZZ_LAUNCH_*`; in a unified process those values would be wrong or absent, and project A's broker would inherit whatever the singleton was launched with.

Everything else is mechanical: prefix the routes (`mountRouter` already takes the prefix as an argument), fix the `isApiUrl` allowlist (`index.ts:182-184` — a prefixed request that misses it silently returns the SPA shell with a 200, which is a blank page rather than an error), resize the three CAP-16 caches that would thrash across projects, and pass `installSignalHandlers: false` for all but the owning context.

**On background projects (the §3 consequence): decided by the same logic.** Lazy activation is forced by item 1, but it does not have to be all-or-nothing. Split it: a project's **scheduler** — timers, `awaiting` wakes, snooze expiry, PR watches, limit auto-resume — is cheap and stays on for every registered project; its **tailer and file watcher**, which are the expensive parts, activate only for projects with a live viewer. That keeps the promise that matters (nothing goes quiet while you are not looking) without paying 42 tailers' duty cycle. The grid's card badges come from the board parser reading `.frizz/` directly, which cold-parses in ~100ms and needs no watcher at all.

### Alternatives considered and rejected

- **Front door + per-project processes** — see above.
- **Query param (`/?project=nub`)** — what `code-server` actually does. Sidesteps the reserved-namespace and trailing-slash problems entirely, and is cheaper because `api/rpc.ts` and `api/socket.ts` build from `location.origin`. Rejected: the pretty URL is the point, and the namespace problem is solved by one reserved prefix.
- **Subdomains** — real origin isolation. Rejected: Safari does not resolve `*.localhost`.
- **Opaque short id (`/p/7f3a`)** — kills collisions dead. Rejected: unmemorable, which defeats the purpose.

---

## 4b. Launching: the CLI registers silently and opens the right project

Running the CLI inside a directory must be a one-step, no-prompt path to that project's board:

1. Resolve the directory to its canonical root (`realpath`, then the repo root; for the gitless case, the marker walk-up from [`plans/gitless-projects.md`](gitless-projects.md) §4).
2. Look that path up in the registry. **If it is unknown, register it immediately — no approval, no prompt, no "add this project?" step.** A path the user just ran the CLI inside is authorization enough; asking would be a dialog whose only sensible answer is yes.
3. Health-check the machine's Frizz. If it is up, do not start anything — just open `http://localhost:<port>/<slug>`. If it is down, start it, then open.
4. Print the URL either way.

Two consequences worth calling out because they invert today's behavior:

- **`--stop` and Ctrl-C change meaning.** Both are per-workspace today (`src/index.ts:602-747`); under a singleton they stop the machine's Frizz and every project's board with it. They need to either grow a scope or refuse to stop a server other projects are using.
- **`/health` becomes a list.** It currently returns one `{projectId, projectDir, bootId, ownerProof}` and `probeFrizz` rejects any mismatch (`src/launcher.ts:593-630`) — a good guarantee that a fixed port can never silently serve the wrong project. Preserve it by having the probe assert the *machine* identity and then confirm the specific project is registered, rather than dropping the check.

---

## 5. The port

### Constraints, verified

- **Browser-blocked ports.** Chromium's `kRestrictedPorts` (`net/base/port_util.cc`) and Firefox's `gBadPortList` (`netwerk/base/nsIOService.cpp`) were read at source. The union is 83 ports and **the highest is `10080`** (Amanda) — so anything above 10080 is clear of browser blocking entirely. One caveat: Chromium's `kRestrictAbusePortsOnLocalhost` is `ENABLED_BY_DEFAULT` and its contents come from a server-side Finch config rather than source, so Chrome retains the ability to block additional *localhost* ports at any time. No port is permanently guaranteed; this is one more reason the fallback is not optional.
- **Ephemeral ranges.** Windows default is **49152-65535** (Microsoft Learn, KB929851 — changed from 1025-5000 at Vista). macOS is **49152-65535** (`sysctl net.inet.ip.portrange.hifirst` on this machine; note `rapportd` has already taken exactly 49152 here). Linux default is **32768-60999** (kernel.org IP Sysctl, `ip_local_port_range`). ⇒ **never hard-code above 32767**, which rules out the IANA Dynamic/Private range (49152+) despite it being the "correct" range for unregistered use.
- **Windows Hyper-V/WSL is the spoiler, and it reaches down into the 3000s.** HNS reserves 100-port blocks at boot for NAT forwarding. The `netsh` dump in [microsoft/WSL#5514](https://github.com/microsoft/WSL/issues/5514) was **read at source via `gh api`** and contains, verbatim, blocks including `3699-3798`, `4214-4313`, `4714-4813`, `4914-5013`, `5014-5113` and on up to `6880-6979`; [microsoft/WSL#5306](https://github.com/microsoft/WSL/issues/5306) independently reports blocks spanning **4294-9783**. A reserved port is not *listening*, so `netstat` shows it free and `bind()` still fails with WSAEACCES/10013 — and Microsoft documents that `SO_REUSEADDR` does not rescue you. The blocks move between reboots.

  The mechanism (community consensus, **not** Microsoft-documented) is that these land low only when the machine's dynamic port range has been reset to ~1024 from its 49152 default. So on a stock Windows box the 3000s are fine; on a clobbered one the entire 2164-9783 span is a minefield — which also takes out Next.js's 3000, Vite's 5173, Postgres's 5432 and adb's 5037. The whole dev ecosystem is exposed to this and mitigates it with fallback, not with port choice.

### Shape: four-digit ABAB

Maintainer preference, and it is the right call — a repeating two-digit pair is the most typeable, most memorable shape available, and five-digit numbers are not worth the marginal safety. Constraint set applied: IANA-unassigned on TCP, not on either browser's blocklist (all clear — the highest blocked port anywhere is 10080), not inside any Hyper-V block reported in [WSL#5514](https://github.com/microsoft/WSL/issues/5514), and not a known dev-tool default from a ~60-tool survey.

**Only nine four-digit ABAB ports survive all four filters:**

`5656` · `5858` · `7373` · `8484` · `8585` · `9393` · `9494` · `9696` · `9797`

All nine are free on this machine. Every other ABAB in 1024-9999 is IANA-assigned, inside a reported Hyper-V block, or both — the whole `2020`-`4747` run is gone, and `9090` (Prometheus) and `8080` never made it.

Those nine were the technically-cleanest set. `9797` was the recommendation — the only survivor above the highest Hyper-V block anyone has reported (~9783 in [WSL#5306](https://github.com/microsoft/WSL/issues/5306)), unassigned on TCP *and* UDP. It remains the natural **fallback** target (see below). `8484` should be avoided in any case — it is MapleStory's port.

*On the "trojan" hits for these ports:* SEO port-lookup sites print "known security risks, trojans" boilerplate for essentially every port number. That is not signal. The genuine cases look different — `13337` is a documented default for Empire C2, CrackMapExec and gophish, and `23232` is Backdoor.Berbew — and none of the nine is one of those.

### DECIDED: `6767`

`http://localhost:6767`. Chosen for memorability, with its costs understood and accepted:

- IANA-registered to `bmc-perf-agent` (BMC Performance Agent, an enterprise monitoring product). Squatting a dead registration, not a live one.
- Inside a Hyper-V exclusion block reported in WSL#5514.

Both are exactly the posture Vite (`5173`, inside `5014-5618`) and Next.js (`3000`, inside `2164-3363`) already ship with, and the exposure only materializes on a Windows box whose dynamic port range has been reset from its 49152 default. `6969` was the same trade (`acmsoda`, same block); `7777`/`8888`/`1337` are IANA `cbt`/`ddi-tcp-1`/`menandmice-dns`, and 8888 is Jupyter's.

### The fallback has to change, and this is not optional

**A `+1` scan from 6767 does not work.** The reported Hyper-V reservations are 100-port blocks and they run contiguously. `6767` sits inside `6680-6779`, which is part of an unbroken reserved run of **`6380-6979`** — so escaping upward by increment takes **213 attempts**, more than the launcher's current 100-port scan (`PORT_SCAN_COUNT = 100`, `src/launcher.ts:112`). On a machine where 6767 is reserved, today's fallback would burn all 100 candidates *inside the same reservation* and then fail with "no free port" while thousands were free.

So the fallback must **jump out of the block, not walk through it**:

1. Try `6767`.
2. On `EADDRINUSE`/`EACCES`, jump straight to `9797` — above every reported block, and already vetted clean against IANA, both browser blocklists and the dev-tool survey.
3. Only then scan incrementally from there.
4. Print the URL actually bound, every time.

Distinguish the two errors in the message: `EADDRINUSE` means something else is listening and the user can go find it; `EACCES`/WSAEACCES on Windows means an invisible reservation, where `netstat` will show the port free and the honest advice is `netsh int ipv4 show excludedportrange protocol=tcp`. Those need different text — a "port in use" message for a reserved port sends people hunting for a process that does not exist.

**Rejected from the earlier draft:** `3729` (F-R-A-Y on a keypad, but inside `3699-3798` and IANA `fksp-audit`), `4917` (Frizz's current default, inside `4914-5013`, and unmemorable), `4242` (inside `4214-4313`; also Posit Package Manager and Orthanc), and the five-digit safe-band picks `13729`/`24729` — correct on every technical axis and rightly rejected as unmemorable, which was the whole brief.

### Two things the fallback keeps

Degrade, do not refuse. Vite and Jupyter both move to another port; Docker fails hard. A local tool that will not start because something unrelated holds a port is worse than one that prints a different URL — the jump-then-scan above is the same policy, just correct about *where* to jump.

And keep the identity handshake exactly as it is. `/health` returns `ownerProof` = `sha256("frizz-project-launch-v2\0" ‖ projectId ‖ projectDir ‖ token)`, and `probeFrizz` rejects any mismatch (`src/launcher.ts:593-630`). That is what guarantees a well-known port can never *silently* serve the wrong thing — it fails to start instead, which is the right failure. `--port` and `FRIZZ_PORT` stay explicit-or-fail, with no scan.

---

## 6. Suggested order

1. **`identity.json` + a project registry.** The reverse index from [`plans/gitless-projects.md`](gitless-projects.md) §3, plus backfill for the 33 orphaned state dirs and staleness detection. Nothing else can start without this.
2. **Slug derivation + rename**, per §1. Registry field, not a boot-time derivation.
3. **Move app routes under `/_frizz/`**, freeing the top-level namespace. Fix `isFrizzRoute` (`markdownTargets.ts:29-32`) in the same change.
4. **Multi-tenant the server** — a keyed `AppContext` map with activate/deactivate, the four hard items from §4, and the `AppContext`-seam error boundary. Do the tailer-budget experiment first; it is the one that can invalidate the shape.
5. **Client base-path awareness** — the ~11 hardcoded absolute paths, plus `currentPath()`/`applyPath()`.
6. **The grid** as a third root shell at `main.tsx:59`.
7. **Adopt the port**, and split `frizz-dev` onto its own default so source and published installs coexist.
8. **Move `font` / `notifications` / `localFileOpener`** to machine-level settings; fix the notification `tag` collision.

### Fold in while you are here: three un-namespaced `/tmp` directories

Pre-existing and orthogonal to the singleton, but they are the same shared-resource bug class as the two-OS-users hazard in §3, and they already collide today between two Frizz installs for *one* user. On macOS `$TMPDIR` is a per-user `/var/folders/…` path so these are latent; **on Linux `$TMPDIR` is normally unset, so all three land in a world-shared `/tmp`.**

- `tmpdir()/frizz-worker-logs/<slug>.stall.log` (`packages/server/src/tailer.ts:132,3555`) — the filename is a **bare thread slug**, no project or user component. Two projects with a thread named `fix-auth` overwrite each other's stall log, which contains up to 4000 chars of captured agent output. The write is `try`/`catch`-wrapped, so it fails silently.
- `tmpdir()/frizz-tool-images` (`packages/server/src/transcript.ts:1064`) — filenames are id-hashed and the temp-file publish is pid-safe, but `pruneScreenshotCache` (`:1086-1101`) `readdirSync`s the whole directory and unlinks the oldest past 200 entries, so **one install's prune deletes another's cached screenshots**. This one collides on every platform, including macOS.
- `tmpdir()/frizz-sysprompts/<sessionId>.md` (`packages/server/src/session-files.ts:5`, written at `dispatch.ts:497-501`) — filenames are UUIDs so content cannot collide, but the *directory* can: on Linux the first OS user creates it at their umask, and a second user's `writeFileSync` then fails EACCES. That write is **not** wrapped in try/catch, so every dispatch for the second user throws. These files are agent system prompts.

The fix is the one already used correctly for the broker sockets — hash the state dir into the directory name (`packages/server/src/frizz-paths.ts:44-52` documents exactly this rationale: "two accounts cannot collide even in a shared `/tmp`").

## 7. No open questions

Everything is decided: unified process, real root repos only (no worktrees), silent auto-registration, port `6767`, and — as a consequence of the unified process — schedulers stay on for every registered project while tailers and watchers activate on view (§4).

The one thing to settle with an experiment rather than a decision is **item 1 of §4**: whether N tailers genuinely saturate the event loop. That claim is read from the scheduling logic and its own over-budget warning, not measured, and it is the assumption the whole activation design rests on. Run it before writing the lifecycle code.
