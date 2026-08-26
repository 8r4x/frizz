import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname, networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireGlobalLaunchLock,
  pidIsAlive,
  resolveGitProjectIdentity,
  tryReservePort,
  type GitProjectIdentityScope,
} from "@frizz/server/project-identity";
import {
  defaultProcessPlatformAdapter,
  processGenerationIsStale,
  projectLaunchRecordHasGeneration,
  projectLaunchTokenProof,
  readProjectLaunchOwner,
  type ProjectLaunchOwnerRecord,
  type ProjectLaunchTarget,
  type ProcessPlatformAdapter,
} from "@frizz/server/project-launch";
import {
  ALL_INTERFACES_BIND_HOST,
  bindHostIsExposed,
  LOOPBACK_BIND_HOST,
  machineHostNames,
  normalizeAllowedHosts,
  normalizeBindHost,
  normalizePublicOrigin,
} from "@frizz/server/local-origin";
import { readBootProgress } from "@frizz/server/boot-progress";
import { frizzPaths, projectStateDir } from "@frizz/server/frizz-paths";
import {
  discoverProjectRoot,
  ensureProjectIdFile,
  hasProjectMarker,
  isExistingProjectRoot,
  isHomeDirectory,
  isNotAGitWorktree,
} from "@frizz/server/project-root";
import { defaultLogRoot, latestLogPath } from "@frizz/server/logging";
import { DEFAULT_PORT, fallbackPort, FRIZZ_ROUTE_PREFIX } from "@frizz/shared";
import { findByPath, listProjects } from "@frizz/server/project-registry";

export { acquireGlobalLaunchLock, pidIsAlive };

/**
 * Run project-local launch preparation before entering the machine-global port/start critical
 * section. Keeping this sequencing here makes it testable without starting a real supervisor.
 */
export async function prepareBeforeGlobalLaunchLock<T>(
  prepare: () => T | Promise<T>,
  acquire: () => Promise<() => void> = () => acquireGlobalLaunchLock()
): Promise<{ prepared: T; release: () => void }> {
  const prepared = await prepare();
  return { prepared, release: await acquire() };
}

export interface CliOptions {
  noApp: boolean;
  appMode: boolean;
  foreground: boolean;
  stop: boolean;
  status: boolean;
  help: boolean;
  /** Deliberately unsafe source/HMR control plane, never selected implicitly. */
  dev: boolean;
  /** Stream the full event feed to the terminal instead of the compact readout. */
  debug: boolean;
  port?: number;
  /** `--link`: ask the ALREADY-RUNNING board for a fresh single-use access link, then exit. */
  link: boolean;
  /** `--sessions`: list the devices holding a session on the already-running board, then exit. */
  sessions: boolean;
  /** `--sign-out <id|all>`: revoke one device's session, or every one of them. */
  signOut?: string;

}

export interface Workspace {
  root: string;
  id: string;
  stateDir: string;
  name: string;
  identityScope: GitProjectIdentityScope;
}

export interface LauncherStatus {
  pid: number;
  port: number;
  processStart?: string;
  publisherToken?: string;
  ownerToken?: string;
  state?: string;
  message?: string;
  childPid?: number;
  projectId?: string;
  projectDir?: string;
  artifactDigest?: string;
}

export interface FrizzHealth {
  ok: true;
  projectId: string;
  projectDir: string;
  bootId: string;
  ownerProof?: string;
}

export interface ExpectedFrizzHealth {
  projectId: string;
  projectDir: string;
  ownerProof?: string;
  /**
   * Ask a SPECIFIC project's health on a shared server: `/_frizz/nub/health`.
   *
   * One Frizz serves N projects, so "is Frizz on this port" and "is Frizz serving MY project on this
   * port" stopped being the same question. Probing the slug answers the second one.
   *
   * Asking does NOT open the project. The server answers this route out of its registry for a project
   * it has not activated (`registeredTenantHealth`), because a launcher deciding whether to join must
   * not have to wait out a cold tenant activation — when it did, the probe timed out and the launcher
   * started a rival server instead. Activation stays where it belongs: on the first real request.
   */
  slug?: string;
}

export const PORT_SCAN_COUNT = 100;
export const LAUNCH_TIMEOUT_MS = 30_000;
/**
 * Hard ceiling on a progress-tracked wait. Only reached by a boot that keeps reporting progress but
 * never becomes healthy — a pathological board, or a bug. Without it a wedged-but-chatty child would
 * hold the launcher forever.
 */
export const LAUNCH_HARD_TIMEOUT_MS = 10 * 60_000;
/** A first immutable artifact build can legitimately outlast the ordinary server-ready timeout. */
export const FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS = 120_000;

/**
 * The argv the durable launcher re-execs itself with on Update & Restart.
 *
 * Update & Restart replaces this launcher in place with the newly promoted artifact, and it rebuilds
 * the command line from scratch — so anything not named here is SILENTLY LOST across an update. That
 * bit a live board: it was launched with `up`, an update re-execed it as a plain `--port` launch, and
 * the board came back with its origin gate disarmed and no tunnel. The public hostname answered
 * "Forbidden", then "Cloudflare error 1033" once cloudflared went too, and nothing in the readout said
 * why — the successor genuinely did not know it was ever meant to be public.
 *
 * How the board is reached travels in the saved setup (~/.frizz/cloud.json), which the successor
 * reads for itself — so nothing about it needs to survive in argv any more.
 */
export function durableReexecArgs(options: { entry: string; port: number }): string[] {
  // No workspace argument: an internal launch reads its pinned project out of the environment
  // (`projectLaunchTargetFromEnvironment`), and never consults a path at all.
  return [
    options.entry,
    "--port",
    String(options.port),
  ];
}

/** Flags that decided how a board was reached. Retired 2026-08-25 for the R pane; see retiredFlagMessage. */
const RETIRED_NETWORK_FLAGS = ["--host", "--allowed-host", "--public-origin", "--cloud"];

function retiredFlagMessage(flag: string): string {
  return `${flag} was retired — how a board is reached is set up from the running board now: press R in its terminal to pick a frizz.sh name, a Cloudflare Tunnel, Tailscale or a proxy of your own. The choice is remembered, so a plain launch serves it.`;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const args = new Set(argv);
  let rawPort: string | undefined;
  let rawSignOut: string | undefined;
  const consumed = new Set<number>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (consumed.has(index)) continue;
    // The network flags are gone: how a board is reached is set up from the running board (press R)
    // and remembered, so a saved command never has to carry it. Name the replacement rather than
    // failing as an unknown option — these lived in scripts and shell history.
    const retired = arg === "up" ? "up" : RETIRED_NETWORK_FLAGS.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (retired) throw new Error(retiredFlagMessage(retired));
    if (arg === "--port") {
      rawPort = argv[++index];
      if (rawPort === undefined || rawPort.startsWith("-"))
        throw new Error("--port requires a value");
      consumed.add(index);
      continue;
    }
    if (arg.startsWith("--port=")) {
      rawPort = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--sign-out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-"))
        throw new Error("--sign-out requires a device id, or `all` to sign out every device");
      index++;
      consumed.add(index);
      rawSignOut = value;
      continue;
    }
    if (arg.startsWith("--sign-out=")) {
      rawSignOut = arg.slice("--sign-out=".length);
      if (!rawSignOut) throw new Error("--sign-out requires a device id, or `all` to sign out every device");
      continue;
    }
    if (arg.startsWith("-")) continue;
    // ONE SERVER SERVES EVERY PROJECT, so "which repository" is not a question a launch has. The
    // positional was a leftover from one-server-per-repo and it kept the wrong mental model alive:
    // `frizz /some/repo` reads as "serve that repo", when the server it starts serves all of them.
    // Refuse rather than ignore — someone with this in a script deserves to be told where it went.
    throw new Error(
      `unexpected argument: ${arg} — Frizz takes no repository path, because one server serves every project on this machine. cd into the directory you want and run it with no arguments.`
    );
  }
  let port: number | undefined;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`invalid --port value: ${rawPort}`);
  }
  const known = new Set([
    "--app",
    "--no-app",
    "--foreground",
    "--detach",
    "--stop",
    "--status",
    "--link",
    "--sessions",
    "--sign-out",
    "--help",
    "-h",
    "--dev",
    "--prod",
    "--port",
    "--debug",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (consumed.has(index)) continue;
    if (arg === "--port") {
      index++;
      continue;
    }
    if (arg === "--sign-out") {
      index++;
      continue;
    }
    if (arg.startsWith("--port=") || arg.startsWith("--sign-out=")) continue;
    if (!known.has(arg)) throw new Error(`unknown option: ${arg}`);
  }
  if (args.has("--detach"))
    throw new Error("--detach is no longer available; frizz-dev always runs in the foreground");
  if (args.has("--app") && args.has("--no-app"))
    throw new Error("choose either --app or --no-app");
  return {
    noApp: args.has("--no-app"),
    appMode: args.has("--app"),
    // Retain the option in the parsed shape for callers, but normal frizz-dev is always attached.
    foreground: true,
    stop: args.has("--stop"),
    link: args.has("--link"),
    sessions: args.has("--sessions"),
    ...(rawSignOut !== undefined ? { signOut: rawSignOut } : {}),
    status: args.has("--status"),
    help: args.has("--help") || args.has("-h"),
    dev: args.has("--dev"),
    debug: args.has("--debug"),
    port,
  };
}

/**
 * The board address as it should READ in the terminal.
 *
 * A bare origin gets its trailing slash, because `http://127.0.0.1:9494` alone looks truncated. The
 * two cases that slash is wrong for are the ones a launch outside a project produces: the grid is
 * already `/` and would print `//`, and an `?add=<dir>` offer would grow a slash INSIDE the query,
 * changing the directory the page is being asked about.
 */
export function boardAddress(url: string): string {
  return url.includes("?") || url.endsWith("/") ? url : `${url}/`;
}

export function helpText(command = "frizz-dev"): string {
  return `Frizz source launcher

Usage: ${command} [options]

Run it in the directory you want to work in. One server serves EVERY project on this machine,
each at its own /project/<name> URL, so a second run joins the one already going. Frizz serves a
verified immutable artifact, selecting or safely building one on first launch, then opens it in
your default browser; source edits never restart the shared board.

Options:
  --no-app               print the URL without opening a browser
  --foreground           accepted for compatibility; ${command} always runs in the foreground
  --dev                  explicitly use the unsafe source watcher and Vite/HMR, not an artifact
  --port <port>          request a fixed port for a new workspace server
  --link                 print a fresh single-use access link for the already-running board
  --sessions             list the devices holding a session on the already-running board
  --sign-out <id|all>    revoke one device's session, or every one of them
  --debug                stream the full event feed to the terminal instead of the compact readout
  --status               report this workspace's stable server and artifact
  --stop                 stop this workspace's UI supervisor (agents keep running)
  -h, --help             show this help


Commands:
  build                  build a new immutable candidate from the configured Frizz source checkout
  promote <digest>       explicitly select a verified candidate for this workspace
  restart                restart the currently promoted artifact without building

To reach the board from a phone or another machine, press R in the terminal running it: a short
walkthrough sets up a frizz.sh name, a Cloudflare Tunnel, Tailscale, or a proxy of your own, and
remembers the choice, so a plain launch serves it from then on. The board stays on loopback and
shows a single-use sign-in link as a QR; press L for a fresh one, or run --link from another shell.

An immutable artifact is the default. --dev is the only explicit unsafe source watcher/HMR mode.
`;
}

/**
 * What a `frizz` in THIS directory should actually do.
 *
 * RUNNING FRIZZ IN A REPOSITORY OPENS THAT REPOSITORY, minting `.frizz/.id` on the spot if it has
 * none. That is the whole command: `cd` somewhere and run it, and the board you get is the board for
 * where you are. Making adoption a confirmation step instead broke exactly that — running it in a new
 * checkout hosted on some OTHER project and landed on the grid, so the maintainer's `frizz-dev` in
 * `ccbroker` opened `frizz` (2026-08-11).
 *
 * What that confirmation step was actually protecting against is narrower, and both halves survive
 * here. $HOME is never adopted, because minting an id there writes a project into Frizz's own global
 * state root and every unmarked directory under home then resolves to it (see isHomeDirectory). And a
 * directory with no marker of its own — `~/Downloads`, a scratch folder, a typo — is a command in the
 * wrong terminal, not a project, so it is still only OFFERED. A repository is neither of those.
 *
 *  - `open`  — a directory Frizz knows, or one that IS a project (hasProjectMarker): its own board.
 *  - `offer` — an unmarked, unadopted directory: open the grid and let it ask. Nothing is written.
 *  - `grid`  — $HOME, which is never offered at all, because there is no version of this the
 *               operator wants.
 *
 * The last two still need a project to LAUNCH with, because a server is a process that has to serve
 * something; the most recently opened registered project is that host. With an empty registry there
 * is nothing to host and nothing to show, so the caller is told to adopt explicitly.
 */
export type LaunchIntent =
  | { kind: "open"; workspace: Workspace }
  | { kind: "offer"; workspace: Workspace; directory: string }
  | { kind: "grid"; workspace: Workspace }
  | { kind: "empty"; directory: string; reason: "home" | "unadopted" }

export function resolveLaunchIntent(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): LaunchIntent {
  const candidate = realpathSync(discoverProjectRoot(cwd, home))
  const known = isExistingProjectRoot(candidate) || findByPath(candidate, home) !== undefined
  // A directory Frizz already knows opens as itself — including one it knows only from the registry,
  // so forgetting to commit `.frizz/.id` never costs someone their board. So does a repository it has
  // never seen: that is the eager adoption above, and resolveWorkspace is what mints the id.
  if ((known || hasProjectMarker(candidate)) && !isHomeDirectory(candidate, home))
    return { kind: "open", workspace: resolveWorkspace(cwd, home, env) }

  const host = mostRecentProject(home, env)
  const reason = isHomeDirectory(candidate, home) ? "home" : "unadopted"
  if (!host) return { kind: "empty", directory: candidate, reason }
  return reason === "home"
    ? { kind: "grid", workspace: host }
    : { kind: "offer", workspace: host, directory: candidate }
}

/** The most recently opened project that still exists — the server's host when the cwd is not one. */
function mostRecentProject(home: string, env: NodeJS.ProcessEnv): Workspace | undefined {
  for (const entry of listProjects(home)) {
    if (entry.stale || isHomeDirectory(entry.path, home)) continue
    try {
      return resolveWorkspace(entry.path, home, env)
    } catch {
      // A project that will not resolve any more must not block the ones after it.
    }
  }
  return undefined
}

export function resolveWorkspace(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): Workspace {
  // A repository still gets its root from Git — that is what makes `frizz` in a sub-directory open the
  // repo's board. Outside one (including a non-colocated jj checkout, which has no `.git` at all, and
  // a machine with no `git` installed) the root comes from marker walk-up instead of the launch dying.
  let gitRoot: string | undefined;
  try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      // stderr is CAPTURED, not ignored: it is the only thing that distinguishes "no worktree here"
      // from "this repository is broken", and those two must not be handled the same way.
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // A broken REAL repository still fails closed — inventing a namespace for it would strand its
    // board. Only "there is no worktree here" falls through to marker discovery.
    if (!isNotAGitWorktree(error)) throw new Error("unable to resolve Git repository root");
    gitRoot = undefined;
  }
  const root0 = realpathSync(gitRoot ?? discoverProjectRoot(cwd, home));
  const identity = gitRoot ? resolveGitProjectIdentity(root0, home) : undefined;
  const root = identity?.root ?? root0;
  // The id lives at `.frizz/.id`; a repository's existing `git config frizz.id` seeds it, so an
  // established board keeps its exact id and nothing is ever removed from the old store.
  const id = ensureProjectIdFile(root, home, identity?.id);
  const stateDir = projectStateDir(id, home);
  mkdirSync(stateDir, { recursive: true });
  const target = {
    projectId: id,
    projectDir: root,
    stateDir,
    ...(identity?.scope === "worktree"
      ? { identityScope: "worktree" as const }
      : {}),
  };
  return {
    root,
    id,
    stateDir,
    name: basename(root),
    identityScope: identity?.scope ?? "repository",
  };
}

export function workspaceLaunchTarget(
  workspace: Workspace
): ProjectLaunchTarget {
  return {
    projectId: workspace.id,
    projectDir: workspace.root,
    stateDir: workspace.stateDir,
    ...(workspace.identityScope === "worktree"
      ? { identityScope: "worktree" as const }
      : {}),
  };
}

export function workspaceFromLaunchTarget(
  target: ProjectLaunchTarget,
  env: NodeJS.ProcessEnv = process.env
): Workspace {
  let root: string;
  try {
    root = realpathSync(target.projectDir);
  } catch {
    throw new Error("pinned Frizz workspace is no longer available");
  }
  if (root !== target.projectDir)
    throw new Error("pinned Frizz workspace path is not canonical");
  return {
    root,
    id: target.projectId,
    stateDir: target.stateDir,
    name: basename(root),
    identityScope:
      target.identityScope === "worktree" ? "worktree" : "repository",
  };
}

function parseStatusFile(
  path: string,
  authoritative?: ProjectLaunchOwnerRecord | null,
  expected?: ProjectLaunchTarget,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter
): LauncherStatus | null {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<LauncherStatus>;
    if (
      !Number.isInteger(value.pid) ||
      value.pid! <= 0 ||
      !Number.isInteger(value.port) ||
      value.port! < 1 ||
      value.port! > 65_535
    )
      return null;
    if (authoritative) {
      const generation = { pid: value.pid!, processStart: value.processStart! };
      if (
        typeof value.processStart !== "string" ||
        value.ownerToken !== authoritative.token ||
        value.projectId !== authoritative.projectId ||
        value.projectDir !== authoritative.projectDir ||
        (expected &&
          (value.projectId !== expected.projectId ||
            value.projectDir !== expected.projectDir)) ||
        !projectLaunchRecordHasGeneration(authoritative, generation) ||
        processGenerationIsStale(generation, adapter)
      )
        return null;
    } else if (typeof value.processStart === "string") {
      if (
        processGenerationIsStale(
          { pid: value.pid!, processStart: value.processStart },
          adapter
        )
      )
        return null;
    } else if (!pidIsAlive(value.pid)) return null; // read-only compatibility with pre-owner status
    return value as LauncherStatus;
  } catch {
    return null;
  }
}

export function liveWorkspaceOwner(
  stateDir: string,
  expected?: ProjectLaunchTarget,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter
): LauncherStatus | null {
  const authoritative = readProjectLaunchOwner(stateDir);
  if (
    authoritative &&
    expected &&
    (authoritative.projectId !== expected.projectId ||
      authoritative.projectDir !== expected.projectDir)
  )
    return null;
  if (authoritative?.state === "draining") return null;
  if (authoritative && processGenerationIsStale(authoritative, adapter))
    return null;
  // The supervisor is the durable owner; server.lock belongs to its disposable child.
  return (
    parseStatusFile(
      join(stateDir, "dev-supervisor.lock"),
      authoritative,
      expected,
      adapter
    ) ??
    parseStatusFile(
      join(stateDir, "server.lock"),
      authoritative,
      expected,
      adapter
    )
  );
}

// A config validation failure deliberately leaves the prior healthy child serving while the durable
// watcher waits for a corrective edit. Health alone therefore cannot make `frizz-dev --status` green: the
// supervisor lock is the authoritative signal that the newest generation needs attention.
export function supervisorNeedsAttention(
  owner: LauncherStatus | null
): boolean {
  return owner?.state === "failed" || owner?.state === "degraded";
}

export function readPreferredPort(stateDir: string): number | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(stateDir, "launcher.json"), "utf8")
    ) as { port?: unknown };
    return Number.isInteger(value.port) &&
      (value.port as number) > 0 &&
      (value.port as number) <= 65535
      ? (value.port as number)
      : undefined;
  } catch {
    return undefined;
  }
}

export function persistLauncher(
  workspace: Workspace,
  port: number,
  sourceDir: string
): void {
  writeFileSync(
    join(workspace.stateDir, "launcher.json"),
    JSON.stringify(
      {
        projectId: workspace.id,
        projectDir: workspace.root,
        port,
        sourceDir: realpathSync(sourceDir),
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

export const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
 * How long the JOIN probe waits, versus the second it takes to ask a server about itself.
 *
 * These are different questions and only one of them is cheap. "Is the server I started healthy yet"
 * is answered by a process with nothing else to do. "Is the Frizz already running on this machine
 * serving my project" is answered by a process that may be mid-prime for some other board, and its
 * event loop is genuinely busy for seconds at a time.
 *
 * Timing out the second question does not degrade — it starts a RIVAL SERVER, which is worse than any
 * wait: two Frizzes on one machine means two schedulers, and a board whose timers and recurring
 * prompts fire twice. A dead port fails instantly with ECONNREFUSED, so this patience is only ever
 * spent when something really is listening, which is exactly when we want to wait rather than race.
 */
export const JOIN_PROBE_TIMEOUT_MS = 15_000;

export async function probeFrizz(
  port: number,
  expected: ExpectedFrizzHealth,
  fetcher: typeof fetch = fetch,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS
): Promise<FrizzHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const scope = expected.slug ? `${FRIZZ_ROUTE_PREFIX}/${expected.slug}` : FRIZZ_ROUTE_PREFIX;
    const response = await fetcher(`http://127.0.0.1:${port}${scope}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const health = (await response.json()) as Partial<FrizzHealth>;
    if (
      health.ok !== true ||
      typeof health.projectId !== "string" ||
      typeof health.projectDir !== "string" ||
      typeof health.bootId !== "string"
    )
      return null;
    if (
      health.projectId !== expected.projectId ||
      health.projectDir !== expected.projectDir
    )
      return null;
    if (
      expected.ownerProof !== undefined &&
      health.ownerProof !== expected.ownerProof
    )
      return null;
    return health as FrizzHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestFrizzStop(
  port: number,
  expected: ExpectedFrizzHealth,
  ownerToken: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (!(await probeFrizz(port, expected, fetcher))) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  timeout.unref?.();
  try {
    const response = await fetcher(`http://127.0.0.1:${port}${FRIZZ_ROUTE_PREFIX}/control/stop`, {
      method: "POST",
      headers: { "x-frizz-launch-token": ownerToken },
      signal: controller.signal,
    });
    return response.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function expectedOwnerHealth(
  target: ProjectLaunchTarget,
  owner: ProjectLaunchOwnerRecord | null
): ExpectedFrizzHealth {
  return {
    projectId: target.projectId,
    projectDir: target.projectDir,
    ...(owner
      ? { ownerProof: projectLaunchTokenProof(target, owner.token) }
      : {}),
  };
}

/**
 * Probe on the SAME address the supervisor will bind. A port free on loopback can still be taken on
 * another interface, so probing 127.0.0.1 and then binding 0.0.0.0 hands the launcher a port that
 * fails at listen() time — after it has already reserved it machine-wide.
 */
export async function probeBindPort(
  port: number,
  host: string = LOOPBACK_BIND_HOST
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolveBind) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolveBind(error.code ?? "EADDRINUSE")
    );
    server.listen(port, host, () => server.close(() => resolveBind(undefined)));
  });
}

export async function canBindPort(
  port: number,
  host: string = LOOPBACK_BIND_HOST
): Promise<boolean> {
  return (await probeBindPort(port, host)) === undefined;
}

/**
 * The two bind failures need different advice, and a boolean cannot tell them apart.
 *
 * EADDRINUSE means something is LISTENING and the user can go find it. EACCES means an invisible
 * reservation — on Windows `netstat` shows the port free and bind() still fails, and SO_REUSEADDR
 * does not rescue you — so "already in use" sends people hunting a process that does not exist.
 */
export function portUnavailableMessage(port: number, code?: string): string {
  if (code === "EACCES" || code === "EPERM")
    return `port ${port} is reserved by the system, not held by a process (bind returned ${code}); on Windows list the reservations with: netsh int ipv4 show excludedportrange protocol=tcp`;
  return `port ${port} is already in use`;
}

export async function choosePort(
  explicit: number | undefined,
  preferred: number | undefined,
  available = canBindPort,
  base = DEFAULT_PORT
): Promise<number> {
  if (explicit !== undefined) {
    if (!(await available(explicit)))
      throw new Error(
        portUnavailableMessage(explicit, await probeBindPort(explicit))
      );
    return explicit;
  }
  for (const port of portCandidates(preferred, base)) {
    if (await available(port)) return port;
  }
  throw new Error(noFreePortMessage(base));
}

/**
 * The well-known port, then a JUMP, then a scan from where it landed.
 *
 * A `+1` scan does not work. Windows reservations come in contiguous 100-port blocks and the
 * reported unions contain unbroken runs of 2,400 ports, so scanning PORT_SCAN_COUNT candidates up
 * from the primary burns every one of them INSIDE THE SAME RESERVATION and then reports "no free
 * port" while tens of thousands are free. Jumping first puts the scan in a band the reservations do
 * not reach.
 *
 * Degrade, do not refuse: Vite and Jupyter both move to another port, Docker fails hard, and a local
 * tool that will not start because something unrelated holds a port is the worse of the two.
 *
 * THE WELL-KNOWN PORT COMES FIRST, ahead of the port this project last bound. A remembered port was
 * the right first choice when every project ran its own server — it kept that board's URL stable. One
 * server for the machine inverts it: the remembered port is a per-project answer to a machine-level
 * question, so whichever project you happened to launch from would decide the address, and every
 * pre-singleton `launcher.json` on this machine would keep dragging the singleton back to a port from
 * the era of many servers. It stays the SECOND candidate, so an old bookmark still resolves when the
 * well-known port is taken.
 */
function portCandidates(
  preferred: number | undefined,
  base = DEFAULT_PORT
): number[] {
  const fallback = fallbackPort(base);
  return [
    base,
    preferred,
    ...Array.from({ length: PORT_SCAN_COUNT }, (_, index) => fallback + index),
  ].filter((port): port is number => !!port && port <= 65535);
}

function noFreePortMessage(base = DEFAULT_PORT): string {
  const fallback = fallbackPort(base);
  return `no free Frizz port: ${base} is taken, and so is every port in ${fallback}-${
    fallback + PORT_SCAN_COUNT - 1
  }`;
}

export interface PortAllocation {
  port: number;
  /** Drops the machine-wide reservation. Idempotent. */
  release: () => void;
}

/**
 * Choose a port AND hold it machine-wide until the control plane is really listening on it.
 *
 * The reservation is taken BEFORE the bind probe, never after: the probe proves a port is free by
 * binding and CLOSING it, so two launchers scanning concurrently would otherwise both see the same
 * port free and both start on it. Reserving first makes the winner unambiguous — which is what lets a
 * caller release the machine-global launch lock as soon as allocation is done, instead of holding it
 * across the child's entire boot and serializing every other repository on this machine behind it.
 */
export async function allocatePort(
  explicit: number | undefined,
  preferred: number | undefined,
  options: {
    available?: (port: number) => Promise<boolean>;
    reserve?: (port: number) => (() => void) | undefined;
    /** Address the caller will actually bind; the probe has to match it. */
    host?: string;
    /** The well-known port to try first. `frizz-dev` has its own so it never fights the singleton. */
    base?: number;
  } = {}
): Promise<PortAllocation> {
  const host = options.host ?? LOOPBACK_BIND_HOST;
  const available = options.available ?? ((port: number) => canBindPort(port, host));
  const reserve = options.reserve ?? ((port: number) => tryReservePort(port));
  const claim = async (port: number): Promise<PortAllocation | undefined> => {
    const release = reserve(port);
    if (!release) return undefined;
    if (await available(port)) return { port, release };
    release();
    return undefined;
  };
  if (explicit !== undefined) {
    const allocated = await claim(explicit);
    if (!allocated)
      throw new Error(
        portUnavailableMessage(explicit, await probeBindPort(explicit, host))
      );
    return allocated;
  }
  for (const port of portCandidates(preferred, options.base)) {
    const allocated = await claim(port);
    if (allocated) return allocated;
  }
  throw new Error(noFreePortMessage(options.base));
}

export interface WaitForWorkspaceOptions {
  /**
   * The project state dir. When given, the wait tracks the control plane's published boot progress
   * (boot-progress.ts) and the flat `timeoutMs` becomes a STALL window rather than a total budget:
   * a boot that keeps reporting progress keeps its patience, up to `hardTimeoutMs`. Omit it to keep
   * the historical flat deadline exactly.
   */
  stateDir?: string;
  hardTimeoutMs?: number;
}

/**
 * Wait for the control plane on `port` to answer /_frizz/health as the expected owner.
 *
 * WHY THIS IS NOT A FLAT DEADLINE. A launcher spawns the control plane detached and cannot see inside
 * it, so a flat 30s budget silently conflates "something is wrong" with "this board is big and this
 * machine is busy" — and the maintainer's own board hit that every time, printing "Frizz did not become
 * healthy" while a perfectly healthy child kept booting behind it. Elapsed time is not evidence of
 * failure; a boot that has STOPPED MAKING PROGRESS is. So when the state dir is known, `timeoutMs` is
 * spent from the last observed progress step rather than from the start, and the failure message names
 * the phase the boot reached instead of only how long the launcher waited.
 */
export async function waitForWorkspace(
  port: number,
  expected: ExpectedFrizzHealth,
  timeoutMs = LAUNCH_TIMEOUT_MS,
  options: WaitForWorkspaceOptions = {}
): Promise<FrizzHealth> {
  const started = Date.now();
  const hardDeadline = started + (options.hardTimeoutMs ?? LAUNCH_HARD_TIMEOUT_MS);
  let stallDeadline = started + timeoutMs;
  let lastStep = -1;
  let lastPhase: string | undefined;
  for (;;) {
    const health = await probeFrizz(port, expected);
    if (health) return health;
    if (options.stateDir) {
      const progress = readBootProgress(options.stateDir);
      // Only a live publisher's ADVANCING counter buys patience. A leftover file from a dead boot has
      // no live pid; a stuck one stops advancing. Either way the stall window closes on schedule.
      if (progress && progress.step > lastStep && pidIsAlive(progress.pid)) {
        lastStep = progress.step;
        lastPhase = progress.phase;
        stallDeadline = Date.now() + timeoutMs;
      }
    }
    const now = Date.now();
    if (now >= stallDeadline || now >= hardDeadline) {
      const waited = Math.ceil((now - started) / 1000);
      throw new Error(
        lastPhase
          ? `Frizz did not become healthy on port ${port} after ${waited}s; its last reported boot step was "${lastPhase}" and it stopped making progress`
          : `Frizz did not become healthy on port ${port} within ${waited}s`
      );
    }
    await delay(150);
  }
}

export function sourceWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  // A durable artifact re-exec runs its deployed CLI from ~/.frizz/builds, not this checkout.
  // Preserve the original canonical checkout explicitly so Update & Restart continues to build
  // from the source the operator launched, rather than treating the artifact cache as source.
  return env.FRIZZ_SOURCE_DIR
    ? resolve(env.FRIZZ_SOURCE_DIR)
    : resolve(import.meta.dirname, "..");
}

export function sourceLabel(): string {
  return realpathSync(sourceWorkspaceDir());
}

/**
 * The tail of this workspace's most recent run log, for a failure message that can show what the
 * server was doing when it gave up.
 *
 * This used to read `<stateDir>/dev.log` — a file Frizz has never written since the detached
 * supervisor was removed — and had no callers, so the diagnostic it appeared to offer always came
 * back empty. It now reads the run log that `@frizz/server/logging` actually produces.
 */
export function logTail(stateDir: string, maxChars = 4000): string {
  try {
    const value = readFileSync(latestLogPath(defaultLogRoot(stateDir)), "utf8");
    return value.slice(-maxChars).trim();
  } catch {
    return "";
  }
}
