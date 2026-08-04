import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
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
  normalizeAllowedHosts,
  normalizeBindHost,
  normalizePublicOrigin,
} from "@frizz/server/local-origin";
import { readBootProgress } from "@frizz/server/boot-progress";
import { frizzPaths, projectStateDir } from "@frizz/server/frizz-paths";
import { defaultLogRoot, latestLogPath } from "@frizz/server/logging";
import { DEFAULT_PORT } from "@frizz/shared";

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
  /**
   * Bind address for the public port. Absent means Frizz's loopback default; a bare `--host` means
   * every interface. Only ever an IP literal — see normalizeBindHost.
   */
  host?: string;
  /** `--allowed-host` values: DNS names a browser may use once the port is off loopback. */
  allowedHosts: string[];
  /** `--public-origin`: the serialized origin of a reverse proxy or tunnel fronting this board. */
  publicOrigin?: string;
  /** Optional Git repository to serve. Defaults to the caller's current directory. */
  repoPath?: string;
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
 * Does the token after a bare `--host` belong to it?
 *
 * `--host` takes an optional value, and the launcher also takes a positional repository path, so
 * `frizz-dev --host ~/code/app` is genuinely ambiguous to a naive "next token wins" parser — it would
 * bind nothing and lose the repo. Every legal value here is an IP literal, so recognising one settles
 * it without a guess: anything else is the operator's repository and `--host` stands for every interface.
 */
function looksLikeBindHost(value: string | undefined): boolean {
  if (value === undefined || value.startsWith("-")) return false;
  try {
    normalizeBindHost(value);
    return true;
  } catch {
    return false;
  }
}

export function parseCliArgs(argv: string[]): CliOptions {
  const args = new Set(argv);
  let rawPort: string | undefined;
  let rawHost: string | undefined;
  let rawPublicOrigin: string | undefined;
  const rawAllowedHosts: string[] = [];
  let repoPath: string | undefined;
  const consumed = new Set<number>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (consumed.has(index)) continue;
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
    if (arg === "--host") {
      if (looksLikeBindHost(argv[index + 1])) {
        rawHost = argv[++index];
        consumed.add(index);
      } else {
        rawHost = ALL_INTERFACES_BIND_HOST;
      }
      continue;
    }
    if (arg.startsWith("--host=")) {
      rawHost = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--allowed-host") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-"))
        throw new Error("--allowed-host requires a value");
      consumed.add(index);
      rawAllowedHosts.push(value);
      continue;
    }
    if (arg.startsWith("--allowed-host=")) {
      rawAllowedHosts.push(arg.slice("--allowed-host=".length));
      continue;
    }
    if (arg === "--public-origin") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-"))
        throw new Error("--public-origin requires a value");
      consumed.add(index);
      rawPublicOrigin = value;
      continue;
    }
    if (arg.startsWith("--public-origin=")) {
      rawPublicOrigin = arg.slice("--public-origin=".length);
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (repoPath !== undefined)
      throw new Error("provide at most one repository path");
    repoPath = arg;
  }
  let port: number | undefined;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`invalid --port value: ${rawPort}`);
  }
  const host = rawHost === undefined ? undefined : normalizeBindHost(rawHost);
  const known = new Set([
    "--app",
    "--no-app",
    "--foreground",
    "--detach",
    "--stop",
    "--status",
    "--help",
    "-h",
    "--dev",
    "--prod",
    "--port",
    "--host",
    "--allowed-host",
    "--public-origin",
    "--debug",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (consumed.has(index)) continue;
    if (arg === "--port") {
      index++;
      continue;
    }
    if (arg.startsWith("--port=") || arg.startsWith("--host=") || arg.startsWith("--allowed-host=") || arg.startsWith("--public-origin=")) continue;
    if (!arg.startsWith("-") && arg === repoPath) continue;
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
    status: args.has("--status"),
    help: args.has("--help") || args.has("-h"),
    dev: args.has("--dev"),
    debug: args.has("--debug"),
    port,
    host,
    allowedHosts: normalizeAllowedHosts(rawAllowedHosts),
    ...(rawPublicOrigin === undefined ? {} : { publicOrigin: normalizePublicOrigin(rawPublicOrigin) }),
    repoPath,
  };
}

/**
 * Printed whenever `--host` actually puts the board on a network.
 *
 * Frizz has no login: reaching the port IS the authorization, and the board runs shell commands as the
 * operator. Saying "exposed" alone would understate that by a lot.
 */
export const EXPOSED_WARNING =
  "Anyone who can reach this address can run commands on this machine as you. Frizz has no login — only do this on a network you trust.";

/**
 * Printed whenever `--public-origin` puts the board behind a proxy the operator named.
 *
 * A tunnel usually terminates on the public internet, which is a different and much larger blast
 * radius than a LAN. Frizz still has no login of its own, so the authenticator in front is not an
 * optional hardening step — it is the entire access control, and saying so is the point of this line.
 */
export const PUBLIC_ORIGIN_WARNING =
  "Frizz has no login of its own, so whatever sits in front of this origin IS the access control. Require authentication there (Cloudflare Access, Tailscale) — an unauthenticated tunnel lets anyone with the URL run commands on this machine as you.";

export interface BindSelection {
  /** Address the public port binds. Always a literal address `listen()` accepts. */
  host: string;
  /** True when that address is reachable from another machine. */
  exposed: boolean;
  /** DNS names accepted as this server's browser authority while exposed. */
  allowedHosts: string[];
  /** Serialized origin of a proxy/tunnel fronting the board, or undefined when none was declared. */
  publicOrigin?: string;
}

/**
 * Merge `--host` / `--allowed-host` with `FRIZZ_HOST` / `FRIZZ_ALLOWED_HOSTS`, flags winning.
 *
 * The environment variables exist because the people who want this run Frizz from a container or a
 * remote box where the launch command is baked into an image or a systemd unit and adding a flag is
 * the awkward part.
 */
export function resolveBindSelection(
  options: Pick<CliOptions, "host" | "allowedHosts" | "publicOrigin">,
  env: NodeJS.ProcessEnv = process.env
): BindSelection {
  const fromEnv = env.FRIZZ_HOST?.trim();
  const host = options.host ?? (fromEnv ? normalizeBindHost(fromEnv) : LOOPBACK_BIND_HOST);
  const allowedHosts = normalizeAllowedHosts([
    ...options.allowedHosts,
    ...(env.FRIZZ_ALLOWED_HOSTS ? [env.FRIZZ_ALLOWED_HOSTS] : []),
  ]);
  // Deliberately independent of `host`: a tunnel runs on this machine and dials the loopback port, so
  // the whole point of naming one is reaching the board from anywhere WITHOUT also putting it on the LAN.
  const publicOriginRaw = options.publicOrigin ?? env.FRIZZ_PUBLIC_ORIGIN?.trim();
  const publicOrigin = publicOriginRaw ? normalizePublicOrigin(publicOriginRaw) : undefined;
  return { host, exposed: bindHostIsExposed(host), allowedHosts, ...(publicOrigin ? { publicOrigin } : {}) };
}

/**
 * The addresses another machine can use to reach an exposed board, for the readout.
 *
 * A wildcard bind is the common case and reports nothing useful by itself, so enumerate the real
 * interfaces the way every dev server does. Loopback and link-local IPv6 are dropped: the first is
 * already printed as the local URL and the second needs a zone id no one will type.
 */
export function networkUrls(
  port: number,
  host: string,
  interfaces: () => NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]> = networkInterfaces
): string[] {
  if (!bindHostIsExposed(host)) return [];
  const wildcard = host === ALL_INTERFACES_BIND_HOST || host === "::";
  const urls: string[] = [];
  const push = (address: string, family: string) => {
    if (address.startsWith("fe80:")) return;
    urls.push(family === "IPv6" ? `http://[${address}]:${port}` : `http://${address}:${port}`);
  };
  if (!wildcard) {
    push(host, host.includes(":") ? "IPv6" : "IPv4");
    return urls;
  }
  for (const entries of Object.values(interfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (host === ALL_INTERFACES_BIND_HOST && entry.family !== "IPv4") continue;
      push(entry.address, entry.family);
    }
  }
  return urls;
}

export function helpText(command = "frizz-dev"): string {
  return `Frizz source launcher

Usage: ${command} [options] [repository]

Run from any Git repository, or pass an explicit repository path. Frizz serves a verified immutable
artifact for that workspace, selecting or safely building one on first launch, then opens it in your
default browser; source edits never restart the shared board.

Options:
  --app                  use the legacy dedicated app window instead of a browser tab
  --no-app               print the URL without opening a browser
  --foreground           accepted for compatibility; ${command} always runs in the foreground
  --dev                  explicitly use the unsafe source watcher and Vite/HMR, not an artifact
  --port <port>          request a fixed port for a new workspace server
  --host [address]       serve on a network address instead of loopback (bare --host means 0.0.0.0)
  --allowed-host <name>  with --host, also accept this DNS name as the board's address (repeatable)
  --public-origin <url>  serve behind a proxy/tunnel reachable at this exact origin
  --debug                stream the full event feed to the terminal instead of the compact readout
  --status               report this workspace's stable server and artifact
  --stop                 stop this workspace's UI supervisor (agents keep running)
  -h, --help             show this help

Environment:
  FRIZZ_HOST              same as --host
  FRIZZ_ALLOWED_HOSTS     same as --allowed-host, comma separated
  FRIZZ_PUBLIC_ORIGIN     same as --public-origin

Commands:
  build                  build a new immutable candidate from the configured Frizz source checkout
  promote <digest>       explicitly select a verified candidate for this workspace
  restart                restart the currently promoted artifact without building

--host puts a board that can run shell commands as you on the network, and Frizz has no login: anyone
who reaches the port controls it. Only do this on a network you trust. An IP address works as-is; to
reach the board by DNS name you must list that name with --allowed-host ("*" allows any).

--public-origin serves the board through a tunnel or reverse proxy without putting it on the LAN
at all — Frizz stays on loopback and the tunnel dials it. Frizz still has no login, so require
authentication at the proxy: with Cloudflare Access, that is the whole of your access control.

An immutable artifact is the default. --dev is the only explicit unsafe source watcher/HMR mode.
`;
}

export function resolveWorkspace(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env
): Workspace {
  let gitRoot: string;
  try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `frizz-dev must be run inside a Git repository (cwd: ${cwd})`
    );
  }
  const identity = resolveGitProjectIdentity(realpathSync(gitRoot), home);
  const root = identity.root;
  const id = identity.id;
  const stateDir = projectStateDir(id, home);
  mkdirSync(stateDir, { recursive: true });
  const target = {
    projectId: id,
    projectDir: root,
    stateDir,
    ...(identity.scope === "worktree"
      ? { identityScope: "worktree" as const }
      : {}),
  };
  return {
    root,
    id,
    stateDir,
    name: basename(root),
    identityScope: identity.scope,
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

export async function probeFrizz(
  port: number,
  expected: ExpectedFrizzHealth,
  fetcher: typeof fetch = fetch
): Promise<FrizzHealth | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  timeout.unref?.();
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/health`, {
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
    const response = await fetcher(`http://127.0.0.1:${port}/control/stop`, {
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
export async function canBindPort(
  port: number,
  host: string = LOOPBACK_BIND_HOST
): Promise<boolean> {
  const bind = (candidate: number) =>
    new Promise<boolean>((resolveBind) => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolveBind(false));
      server.listen(candidate, host, () => server.close(() => resolveBind(true)));
    });
  return bind(port);
}

export async function choosePort(
  explicit: number | undefined,
  preferred: number | undefined,
  available = canBindPort
): Promise<number> {
  if (explicit !== undefined) {
    if (!(await available(explicit)))
      throw new Error(`port ${explicit} is already in use`);
    return explicit;
  }
  for (const port of portCandidates(preferred)) {
    if (await available(port)) return port;
  }
  throw new Error(noFreePortMessage());
}

function portCandidates(preferred: number | undefined): number[] {
  return [
    preferred,
    ...Array.from(
      { length: PORT_SCAN_COUNT },
      (_, index) => DEFAULT_PORT + index
    ),
  ].filter((port): port is number => !!port && port <= 65535);
}

function noFreePortMessage(): string {
  return `no free Frizz development port found in ${DEFAULT_PORT}-${
    DEFAULT_PORT + PORT_SCAN_COUNT - 1
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
    if (!allocated) throw new Error(`port ${explicit} is already in use`);
    return allocated;
  }
  for (const port of portCandidates(preferred)) {
    const allocated = await claim(port);
    if (allocated) return allocated;
  }
  throw new Error(noFreePortMessage());
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
 * Wait for the control plane on `port` to answer /health as the expected owner.
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
