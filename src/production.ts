#!/usr/bin/env node
import { bindHostIsExposed } from "@frizz/server/local-origin";
// The registry launcher is intentionally separate from index.ts. `frizz-dev` follows mutable
// checkout source; `frizz` runs the package that npm resolved and never turns an npx cache into a
// deployment directory.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchApp, launchBrowserTab } from "./browser.ts";
import { fileSessionDirectory, loadOrCreateSessionKey } from "@frizz/server/access-codes";
import { renderQrLines } from "@frizz/server/qr";
import { listSessions, signOutSession } from "./sessions-cli.ts";
import { SUPERVISOR_ACCESS_CODE_PATH } from "@frizz/server/restart-supervisor";
import { createAccessPane, type AccessPane } from "./access-pane.ts";
import { installPaneHost, type PaneHost } from "./pane-host.ts";
import { createRemoteController, type RemoteController } from "./remote-controller.ts";
import { probeCloudflared, probeGithub, probeTailscale } from "./remote-detect.ts";
import { createRemotePane } from "./remote-pane.ts";
import { LOOPBACK_BIND_HOST } from "@frizz/server/local-origin";
import {
  establishCloudConfig,
} from "./cloud.ts";
import { Readout, renderSupervisorActivity, tildePath } from "./readout.ts";
import {
  appendCrashRecord,
  attachTerminalMirror,
  createLogger,
  logEnvironment,
  runLogPath,
  setAmbientLogger,
  type Logger,
} from "@frizz/server/logging";
import {
  acquireGlobalLaunchLock,
  allocatePort,
  boardAddress,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  cleanupSandbox,
  parseCliArgs,
  prepareSandbox,
  probeFrizz,
  readPreferredPort,
  resolveLaunchIntent,
  waitForWorkspace,
  workspaceFromLaunchTarget,
  workspaceLaunchTarget,
  type CliOptions,
  type LaunchIntent,
  type Workspace,
} from "./launcher.ts";
import {
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
} from "@frizz/server/project-launch";
import { createSupervisorShutdownHandler, startDevSupervisor } from "@frizz/server/dev-supervisor";
import { handoffToRegistrySuccessor, npmRegistryReleaseAdapter, planRegistryUpdate, PRODUCTION_REEXEC_FLAG } from "./production-update.ts";
import {
  assertLaunchPrerequisites,
  assertRequiredExecutables,
  ensureNativeHelperPermissions,
} from "./preflight.ts";
import { DEFAULT_PORT, fallbackPort } from "@frizz/shared";
import { registerProject } from "@frizz/server/project-registry";
import { resolveProjectLabel } from "@frizz/server/project-identity";

const PACKAGE_NAME = process.env.FRIZZ_REGISTRY_PACKAGE ?? "frizz";

/**
 * The version THIS bundle actually is, read from the package.json it ships inside.
 *
 * It used to be `process.env.npm_package_version ?? "0.0.1"`, and npm sets that variable only for
 * lifecycle scripts — NOT when a bin runs through the npx shim, which is how every real user starts
 * Frizz. So the launcher reported itself as `0.0.1` forever. Measured end-to-end against the published
 * package: a genuine 0.1.1 install served `artifactDigest: "npm:frizz@0.0.1"`, and still served
 * `0.0.1` after updating itself to 0.1.2.
 *
 * That is not cosmetic. `planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, …)` compares this against
 * the registry's latest, so a permanent `0.0.1` makes every version look newer: the "already current"
 * branch below is unreachable, and Update Frizz reinstalls-and-restarts even when nothing is stale.
 *
 * `import.meta.dirname` is the bundle's own directory (`<package>/dist`), the same base `webDist` and
 * `runtimeDir` resolve from below — so this reads the package.json that was published alongside it.
 * The env var stays as a fallback for anyone launching through a lifecycle script.
 */
function resolvePackageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.trim()) return manifest.version.trim();
  } catch {
    // Fall through — a launcher that cannot read its own manifest must still boot.
  }
  return process.env.npm_package_version ?? "0.0.1";
}

const PACKAGE_VERSION = resolvePackageVersion();
const rawArgs = process.argv.slice(2);
const reexec = rawArgs.includes(PRODUCTION_REEXEC_FLAG);
const args = rawArgs.filter((arg) => arg !== PRODUCTION_REEXEC_FLAG);
const fail = (error: unknown): never => {
  console.error(`frizz: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
};

const options: CliOptions = (() => {
  try { return parseCliArgs(args); } catch (error) { return fail(error); }
})();
if (options.help) {
  console.log(
    `Frizz production launcher

Usage: npx ${PACKAGE_NAME} [options]

Run it in the directory you want to work in. One server serves EVERY project on this machine,
each at its own /project/<name> URL, so a second run joins the one already going. Runs the
npm-resolved immutable Frizz package, then opens it in your default browser. Use frizz-dev only
for a source checkout.

Options:
  --no-app               print the URL without opening a browser
  --port <port>          request a fixed port for a new workspace server
  --sandbox              a disposable Frizz to try things in: throwaway home and project, its
                         own port, deleted when this terminal closes; credentials (gh,
                         cloudflared, Claude, Codex, the machine's frizz.sh key) are shared
  --link                 print a fresh single-use access link for the running board
  --sessions             list the devices signed in to the running board
  --sign-out <id|all>    sign one device out, or every one of them
  --debug                stream the full event feed to the terminal instead of the compact readout
  -h, --help             show this help


To reach the board from a phone or another machine, press R in the terminal running it: a short
walkthrough sets up a frizz.sh name, a Cloudflare Tunnel, Tailscale, or a proxy of your own, and
remembers the choice, so a plain launch serves it from then on. The board stays on loopback and
shows a single-use sign-in link as a QR; press L for a fresh one, or run --link from another shell.`,
  );
  process.exit(0);
}
if (options.dev || rawArgs.includes("--prod")) fail("--dev and --prod are not available from the registry launcher");

// Before ANYTHING reads the home directory: the sandbox swaps $HOME for a throwaway, so every piece
// of state after this line — registry, lock, logs, session key, cloud.json — is a disposable copy.
const sandbox = options.sandbox ? prepareSandbox() : null;
if (sandbox) process.on("exit", () => cleanupSandbox(sandbox.home));

/** How this board is reached from outside — the saved setup, the transport, the origin. Built once the supervisor listens. */
let remote: RemoteController | null = null;
/** The keyboard: L for a link, R for the remote-access walkthrough. Held so shutdown can restore the shell. */
let paneHost: PaneHost | null = null;
let accessPane: AccessPane | null = null;
/** The single-use link this launch minted, read by the readout below. */
let activeAccessLink: { url: string } | null = null;

let launchIntent: LaunchIntent | undefined;
const workspace: Workspace = (() => {
  try {
  // BEFORE the workspace is resolved, because resolving it opens this project's database — so a
  // machine running a Node the database cannot survive learns it here by name instead of from whichever
  // internal step tripped over it first. The Node floor is effectively the whole check now: on an
  // unsupported release SQLite does not misbehave, it SEGFAULTS, and a segfault mid-boot is
  // indistinguishable from Frizz being broken. The executables list beside it is empty — nothing shells
  // out to `git` or `tmux` any more (see preflight.ts).
  //
  // `--stop` and `--status` skip the Node floor deliberately: they only read a status file and signal
  // a process, both of which work on any runtime, and they are how someone shuts down a board after
  // switching to a Node that cannot run one.
  if (!reexec) {
    if (options.stop || options.status) assertRequiredExecutables();
    else assertLaunchPrerequisites();
  }
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  if (reexec || process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1") {
    if (!pinned) throw new Error("registry successor is missing its pinned project identity");
    return workspaceFromLaunchTarget(pinned);
  }
  // ONE launch policy for both launchers. This called resolveWorkspace directly, which adopts
  // whatever directory it is handed — so `frizz` in $HOME minted a project id inside Frizz's own
  // `~/.frizz` state root, the failure frizz-dev was fixed for in 95d81bd and this file was not.
  // A repository still opens as itself and is still adopted on sight; see resolveLaunchIntent.
  const intent = resolveLaunchIntent();
  if (intent.kind === "empty")
    throw new Error(
      intent.reason === "home"
        ? "frizz cannot open your home directory as a project, and there is no other project to show yet. cd into a repository and run frizz there."
        : `${intent.directory} is not a Frizz project yet, and there is no other project to show. Run frizz inside a repository, or add this one from the projects page once a board is open.`,
    );
  launchIntent = intent;
  return intent.workspace;
  } catch (error) { return fail(error); }
})();
process.chdir(workspace.root);
if (options.sessions || options.signOut !== undefined) {
  // Reads and writes the RUNNING board's session directory, so there is nothing useful to say when
  // no board is up — starting one here would create an empty directory and answer a different question.
  const running = liveWorkspaceOwner(workspace.stateDir, workspaceLaunchTarget(workspace));
  if (!running?.port) {
    console.error("frizz: no board is running for this workspace");
    process.exit(1);
  }
  if (options.signOut !== undefined) await signOutSession(running.port, options.signOut);
  await listSessions(running.port);
}
if (options.link) {
  // Mint from the RUNNING board rather than starting one — the same query frizz-dev answers
  // (src/index.ts): the answer for a board running detached or in someone else's terminal, where
  // the interactive QR pane cannot install.
  const running = liveWorkspaceOwner(workspace.stateDir, workspaceLaunchTarget(workspace));
  if (!running?.port) {
    console.error("frizz: no board is running for this workspace");
    process.exit(1);
  }
  const response = await fetch(`http://127.0.0.1:${running.port}${SUPERVISOR_ACCESS_CODE_PATH}`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${running.port}` },
  }).catch(() => undefined);
  if (!response?.ok) {
    const detail = response ? (await response.json().catch(() => undefined))?.error : undefined;
    console.error(`frizz: ${detail ?? "could not mint an access link"}`);
    process.exit(1);
  }
  const { url } = (await response.json()) as { url: string };
  // The QR first: the whole point of a link is to reach a phone, and nobody types forty characters.
  if (process.stdout.isTTY) for (const row of renderQrLines(url)) console.log(`  ${row}`);
  console.log(process.stdout.isTTY ? `\n  ${url}` : url);
  process.exit(0);
}
// Every launch leaves a complete record on disk, so a crash is never silent. The forked control-plane
// child appends to this same file rather than writing to the terminal the readout is repainting.
const logger: Logger = setAmbientLogger(
  process.env.FRIZZ_LOG_FILE
    ? createLogger({ file: process.env.FRIZZ_LOG_FILE, owner: false })
    : createLogger({ file: runLogPath(workspace.stateDir) }),
);
const readout = reexec || process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1"
  ? undefined
  : new Readout({ debug: options.debug, version: PACKAGE_VERSION });
attachTerminalMirror(logger, options.debug || process.env.FRIZZ_DEBUG === "1");
readout?.plan([
  { key: "server", label: "Server" },
  { key: "browser", label: options.noApp ? "Address" : "Browser" },
]);
readout?.begin("server", "starting");
logger.info("launcher", `frizz ${PACKAGE_VERSION} starting for ${workspace.root}`);
const target = workspaceLaunchTarget(workspace);
const expected = expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir));

async function existingPort(): Promise<number | undefined> {
  const owner = liveWorkspaceOwner(workspace.stateDir, target);
  const ports = [owner?.port, readPreferredPort(workspace.stateDir)].filter((value): value is number => !!value);
  for (const port of new Set(ports)) if (await probeFrizz(port, expected)) return port;
  return undefined;
}

/**
 * A Frizz already running on this machine, serving THIS project under its own slug.
 *
 * The singleton's payoff at the CLI: a second `frizz` in another repository is a client, not a
 * server. It registers the project (which is what mints the slug), then asks the machine's Frizz for
 * that project's health — a request which, by activating the tenant, is also what opens it.
 *
 * The identity check is the launcher's own handshake minus the owner proof. That proof is keyed to a
 * launch LEASE and a client holds none; what a client needs to know is that this port serves ITS
 * project id from ITS directory, and that is exactly what the id and dir already answer. The proof
 * still guards the case it was written for — a launcher adopting the supervisor it believes it owns.
 *
 * A COPIED checkout (`cp -R`, so two directories claim one id) is deliberately not joined here: the
 * registry refuses the duplicate, and the re-mint belongs to resolveProject, which does it properly.
 */
/**
 * This project's URL segment, registering it if the machine has not seen it before.
 *
 * `/` is the project GRID now, so a board — including the one we are about to launch — lives at
 * `/<slug>`. Both the join path and the launch path want the same answer, and registration is
 * idempotent: an id already in the registry keeps the slug it was given.
 */
function ownSlug(): string | undefined {
  try {
    return registerProject(
      { dir: workspace.root, id: target.projectId, remoteOwner: resolveProjectLabel(workspace.root)?.split("/")[0] },
      homedir(),
    ).entry?.slug;
  } catch {
    // The registry is an INDEX. If it cannot be written, opening the board unprefixed still works.
    return undefined;
  }
}

let cachedSlugPath: string | undefined;
/**
 * Where to land: this project's board, the grid, or the grid with a directory to ask about.
 *
 * `?add=` is a REQUEST, not a registration — nothing on disk changes until the operator confirms on
 * the page, which is the only reason an unmarked directory is safe to point the launcher at at all.
 */
function slugPath(): string {
  if (cachedSlugPath === undefined) {
    if (launchIntent?.kind === "grid") cachedSlugPath = "/";
    else if (launchIntent?.kind === "offer") cachedSlugPath = `/?add=${encodeURIComponent(launchIntent.directory)}`;
    else {
      const slug = ownSlug();
      cachedSlugPath = slug ? `/project/${slug}` : "";
    }
  }
  return cachedSlugPath;
}

async function joinRunningFrizz(): Promise<{ port: number; slug: string } | undefined> {
  const slug = ownSlug();
  if (!slug) return undefined;
  // The well-known port, then the one the fallback jumps to. A server that had to scan past both is
  // rare enough to be worth a second server rather than a slow probe on every cold start.
  for (const port of new Set([DEFAULT_PORT, fallbackPort(DEFAULT_PORT)])) {
    if (await probeFrizz(port, { projectId: target.projectId, projectDir: target.projectDir, slug }))
      return { port, slug };
  }
  return undefined;
}

/**
 * Hand the operator the running board. This is deliberately the SAME contract as the source
 * launcher's openOrPrint (index.ts): a plain launch opens the default browser, `--app` opens the
 * dedicated app window, `--no-app` prints the URL and nothing else, and a browser that refuses to
 * open degrades to the URL instead of failing the launch.
 *
 * It printed the URL and stopped there from the day this file was written, so `npx frizz` never
 * opened anything while `frizz-dev` always did — the whole divergence the operator hit.
 */
async function openOrPrint(port: number, reused: boolean, path = ""): Promise<void> {
  const url = `http://127.0.0.1:${port}${path}`;
  logger.info("launcher", `${reused ? "reusing" : "started"} Frizz at ${url}`);
  readout?.settle("server", "done", reused ? `already running on port ${port}` : `port ${port}`);
  let browser: string | undefined;
  if (!options.noApp) {
    readout?.begin("browser", options.appMode ? "requesting app window" : "requesting default browser");
    try {
      if (options.appMode) {
        await launchApp(url, { dataPath: join(workspace.stateDir, "browser-profile") });
        browser = reused ? "focused the Frizz app window" : "opened the Frizz app window";
      } else {
        await launchBrowserTab(url);
        browser = "opened in your default browser";
      }
      logger.info("launcher", browser);
    } catch (error) {
      browser = `could not open the ${options.appMode ? "app window" : "default browser"} — open the address above`;
      logger.warn("launcher", `${browser}: ${error instanceof Error ? error.message : error}`);
    }
    readout?.settle("browser", "done", browser);
  } else {
    readout?.settle("browser", "done", url);
  }
  // A reuse did not choose this server's bind address or its proxy origin, so it must not claim either.
  const publicOrigin = reused ? undefined : remote?.origin();
  const warnings: string[] = [];
  if (sandbox) warnings.push(`Sandbox: everything here is throwaway (${sandbox.home}) and is deleted when this terminal closes.`);
  if (!readout) {
    console.log(`${reused ? "reusing" : "started"} Frizz ${PACKAGE_VERSION} for ${workspace.root}`);
    console.log(url);
    if (publicOrigin) console.log(activeAccessLink?.url ?? `${publicOrigin}/`);
    for (const warning of warnings) console.log(warning);
    return;
  }
  const home = homedir();
  readout.ready(
    [
      { label: "Local", value: boardAddress(url), accent: true },
      ...(publicOrigin ? [{ label: "Public", value: activeAccessLink?.url ?? `${publicOrigin}/`, accent: true }] : []),
      { label: "Project", value: `${workspace.name} — ${tildePath(workspace.root, home)}` },
      ...(logger.file ? [{ label: "Logs", value: tildePath(logger.file, home) }] : []),
    ],
    reused
      ? // This launch owns nothing and exits immediately, so ctrl-c would not stop what it reopened.
        "reopened the server already running for this project · stop it from the terminal that started it"
      : options.debug
        ? undefined
        : publicOrigin
          ? "press L for a fresh sign-in link · R to change how this board is reached · ctrl-c to stop"
          : "press R to reach this board from a phone or another machine · ctrl-c to stop",
    {
      ...(reused ? { status: `already running on port ${port}` } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      ...(activeAccessLink && !reused ? { qr: renderQrLines(activeAccessLink.url) } : {}),
    },
  );
}

async function runSupervisor(port: number, token: string): Promise<never> {
  assertLaunchPrerequisites();
  // Registry installs may have skipped node-pty's post-install; repair it before anything spawns a pty.
  ensureNativeHelperPermissions();
  const owner = adoptProjectLaunchOwner(target, token, "supervisor");
  const env = projectLaunchEnvironment(
    {
      ...process.env,
      FRIZZ_PRODUCTION_SUPERVISOR: "1",
      ...logEnvironment(logger, options.debug ? "debug" : "info"),
      ...(options.debug ? { FRIZZ_DEBUG: "1" } : {}),
    },
    target,
    owner.token,
  );
  const webDist = join(import.meta.dirname, "..", "web-dist");
  // The registry package runs directly from what it ships, so it carries its own runtime closure
  // (staged by scripts/prepare-package.mjs). The server SHELLS OUT to the board parser and every
  // dispatched worker loads the plugin, so both must be pointed at the bundled copies — the
  // monorepo-relative default in server/src/frizz.ts resolves to a non-existent node_modules/board path.
  const runtimeDir = join(import.meta.dirname, "..", "runtime");
  const scriptsDir = join(runtimeDir, "board");
  const workerPluginDir = join(runtimeDir, "cc-worker");
  // The published package runs as an esbuild bundle (dist/frizz.js); the server child and the
  // detached daemon are emitted as sibling bundles in the same dist/ by scripts/build-package.mjs.
  // Resolve the child beside this bundle rather than from @frizz/server (whose .ts cannot run
  // under node_modules). In a source checkout this launcher is never executed — frizz-dev uses index.ts.
  const childEntry = fileURLToPath(new URL("./dev-child.js", import.meta.url));
  let plannedUpdate: Awaited<ReturnType<typeof planRegistryUpdate>> | undefined;

  // Whether the registry actually has something newer, refreshed on a timer and READ FROM CACHE.
  // The status endpoint is polled by every open tab, so it must never reach the network; and the
  // answer only changes when someone publishes, so a slow cadence is plenty. Starts optimistic
  // (`true`) so the button keeps its current appearance until the first probe lands — the operator
  // never sees it flip from Restart to Update a second after load.
  let updateAvailable = true;
  // The newer version the last successful probe saw, so the status endpoint can NAME the update it is
  // advertising. Deliberately not seeded optimistically like the boolean above: a number we have not
  // observed would be a lie, so until the registry answers the client gets its generic update copy.
  let updateVersion: string | undefined;
  const refreshUpdateAvailable = async (): Promise<void> => {
    try {
      const plan = await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter);
      updateAvailable = plan !== null;
      updateVersion = plan?.latestVersion;
    } catch {
      // A registry we cannot reach is not evidence that we are current. Leave the last known answer.
    }
  };
  void refreshUpdateAvailable();
  const updateAvailablePoll = setInterval(() => void refreshUpdateAvailable(), 30 * 60 * 1000);
  updateAvailablePoll.unref();

  const supervisor = await startDevSupervisor({
    port,
    host: LOOPBACK_BIND_HOST,
    allowedHosts: [],
      // A spent code repaints the open QR pane as stale, so nobody photographs a dead link.
      onCodeConsumed: () => accessPane?.markConsumed(),
    // Persisted beside the project's other state, so a restart does not sign every device out.
    // Always, not only when public: the origin can be switched on later (press R), and a phone signed
    // in through one name stays signed in through the next.
    sessionKey: loadOrCreateSessionKey(workspace.stateDir),
    sessionDirectory: fileSessionDirectory(workspace.stateDir),
    cwd: workspace.root,
    stateDir: workspace.stateDir,
    launchTarget: target,
    launchOwnerToken: owner.token,
    env,
    watch: false,
    childEntry,
    childEnvironment: () => ({ FRIZZ_STABLE_WEB_DIST: webDist, FRIZZ_STABLE_ARTIFACT: `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}`, FRIZZ_SCRIPTS_DIR: scriptsDir, FRIZZ_WORKER_PLUGIN_DIR: workerPluginDir }),
    updateAvailable: () => updateAvailable,
    version: PACKAGE_VERSION,
    updateVersion: () => updateVersion,
    // The terminal that owns the board says so when the board goes down and comes back. Everything
    // here is triggered from a browser tab or by a crash, so without this the foreground process is
    // the last place to learn what happened to it.
    onActivity: (event) => renderSupervisorActivity(readout, event),
    updateRestart: async () => {
      try {
        const plan = await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter);
        if (!plan) { updateAvailable = false; updateVersion = undefined; return { state: "failed" as const, message: `Frizz ${PACKAGE_VERSION} is already current` }; }
        plannedUpdate = plan;
        updateVersion = plan.latestVersion;
        // npm only writes its own cache. The healthy supervisor is deliberately left up until the
        // server has drained its child and proxy immediately before durableReexec below.
        return { state: "ready" as const, message: `Frizz ${plan.latestVersion} will start in a new npm execution cache` };
      } catch (error) {
        return { state: "failed" as const, message: error instanceof Error ? error.message : String(error) };
      }
    },
    durableReexec: async () => {
      const plan = plannedUpdate ?? await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter);
      if (!plan) throw new Error("Frizz is already current");
      handoffToRegistrySuccessor(plan, { port, projectDir: workspace.root, cwd: workspace.root, env }, npmRegistryReleaseAdapter);
      // This exit is the ONE that has to explain itself. The successor npm resolved is detached with
      // its stdio closed, so this terminal is not handed to it — the process simply ends, the shell
      // prompt returns, and the board is still serving from a PID this window can no longer signal.
      // Said plainly, that is an update; unsaid, it is indistinguishable from Frizz dying.
      readout?.notice("done", "Updated", `Frizz ${plan.latestVersion} is taking over on port ${port}`);
      readout?.note(`\n  Frizz ${plan.latestVersion} now runs in the background — ctrl-c here no longer reaches it. Stop it with ${PACKAGE_NAME} --stop.\n`);
      // The successor adopts the same tokenized project lease. SQLite and provider sessions are
      // keyed project resources, so neither process copies, deletes, nor recreates them.
      process.exit(0);
    },
  });
  // The first single-use link, minted now that the board can redeem it. The old `?frizz_token=` this
  // replaced was a STANDING secret: it never expired and never rotated, so anything that saw it once
  // — a screenshot, scrollback, a chat log — kept working forever.
  remote = createRemoteController({ host: supervisor, port, log: logger, say: (message) => console.error(`frizz: ${message}`) });
  try {
    await remote.serveSaved();
  } catch (error) {
    // A saved setup that cannot come up must not take the board down with it: the board still serves
    // loopback, the readout says so, and R offers the setup again.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("remote", message);
    console.error(`frizz: the saved remote setup could not start: ${message}`);
  }
  activeAccessLink = remote.origin() ? supervisor.issueAccessLink() : null;

  // "Press L for a fresh link" — the only way to reissue without restarting. Null when stdout is not
  // a terminal, which leaves the plain records path untouched.
  accessPane = createAccessPane({ issue: () => supervisor.issueAccessLink() });
  const remotePane = createRemotePane({
    port,
    current: () => remote?.current() ?? null,
    apply: (next, applyOptions) => remote!.apply(next, applyOptions),
    claim: (name) => establishCloudConfig(name, port),
    issueLink: () => supervisor.issueAccessLink(),
    probes: { github: probeGithub, cloudflared: probeCloudflared, tailscale: probeTailscale },
    onChanged: (config) => logger.info("remote", config ? `reached at https://${config.hostname}` : "loopback only"),
    sandbox: sandbox !== null,
  });
  paneHost = installPaneHost({ bindings: { l: accessPane, L: accessPane, r: remotePane, R: remotePane } });

  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => owner.release(),
    // Acknowledge the first signal on the spot; the drain that follows is bounded but not instant.
    onStop: () => {
      logger.info("launcher", "stop signal received; draining the control plane");
      readout?.notice("progress", "Stopping", "draining the control plane — press ctrl-c again to force");
    },
    exit: (code) => {
      logger.info("launcher", `stopped with code ${code}`);
      // Before the farewell, or the operator's shell is left in raw mode echoing nothing.
      paneHost?.dispose();
      // Down with the board: a surviving cloudflared keeps the hostname resolving to a 530.
      remote?.stop();
      const suffix = logger.file ? `\n  log: ${tildePath(logger.file, homedir())}` : "";
      process.stdout.write(
        code === 0
          ? `\n  Frizz stopped. Running agents keep going — they are detached daemons.${suffix}\n\n`
          : `\n  Frizz stopped with errors (exit ${code}).${suffix}\n\n`,
      );
      process.exit(code);
    },
    error: (line) => logger.error("supervisor", line.startsWith("[frizz] ") ? line.slice(10) : line),
  });
  // SIGHUP is what closing a terminal sends, and Node's default action for it is to die on the spot —
  // so without this the launcher was killed WITHOUT running `stop`, and the control-plane child (which
  // sits in its own process group, so the tty never signals it directly) was orphaned still holding the
  // port. That is the whole reason an "always foreground" board could outlive its terminal and need
  // `--stop` to reach. Verified on a live board: launcher pgid 31700, child pgid 31704, same tty.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  void supervisor.stopRequested.then(stop);
  await supervisor.firstBoot;
  return await new Promise<never>(() => {});
}

try {
  if (process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1" || reexec) {
    if (!options.port) throw new Error("internal registry supervisor launch is missing --port");
    const token = projectLaunchOwnerTokenFromEnvironment(process.env);
    if (!token) throw new Error("registry supervisor launch is missing project ownership");
    await runSupervisor(options.port, token);
  }
  const existing = await existingPort();
  if (existing) {
    await openOrPrint(existing, true, slugPath());
    process.exit(0);
  }
  // slugPath(), not the joined slug: that slug names the project this launch is HOSTED on, which is
  // the project to open only when the intent is `open`. A `grid`/`offer` launch rides on the most
  // recent project and must still land on the grid rather than opening someone else's board.
  const joined = await joinRunningFrizz();
  if (joined) { await openOrPrint(joined.port, true, slugPath()); process.exit(0); }
  const claim = tryAcquireProjectLaunchOwner(target, "launcher");
  if (claim.kind !== "acquired") throw new Error("Frizz is starting for this project; retry shortly");
  let release: (() => void) | undefined = await acquireGlobalLaunchLock();
  let portReservation: (() => void) | undefined;
  try {
    const allocation = await allocatePort(options.port, readPreferredPort(workspace.stateDir), { host: LOOPBACK_BIND_HOST });
    const port = allocation.port;
    portReservation = allocation.release;
    // The supervisor owns the rest of this process's life (runSupervisor never returns), so start it
    // WITHOUT awaiting and race it against health. Awaiting it directly is what made everything below
    // unreachable: parseCliArgs pins `foreground` to true, so the old `if (options.foreground) await
    // runSupervisor(...)` always won and a cold `npx frizz` never printed its URL, never opened a
    // browser, and never released the lock it took — the detached-spawn branch that used to follow was
    // dead code the day parseCliArgs stopped honouring --detach.
    const running = runSupervisor(port, claim.lease.token);
    // Allocation is the only machine-shared step, so the machine-global lock ends HERE — the port
    // reservation above, not this lock, keeps `port` ours until the child listens. Holding it across
    // the progress-tracked wait below meant one cold `npx frizz` could sit on it for minutes while
    // every other repository's launcher gave up after a far shorter budget.
    release();
    release = undefined;
    // Progress-tracked: a boot that keeps reporting steps keeps the launcher's patience, so a large
    // board on a busy machine is no longer indistinguishable from a wedge. See waitForWorkspace.
    // `running` stays in the race so a supervisor that dies while booting reports immediately.
    await Promise.race([
      waitForWorkspace(
        port,
        expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir)),
        undefined,
        { stateDir: workspace.stateDir },
      ),
      running,
    ]);
    // The child is listening now, so the port defends itself. The reservation must NOT span the
    // foreground server lifetime, or a stopped-but-unreleased claim would push this repository's next
    // launch off its remembered port.
    portReservation();
    portReservation = undefined;
    await openOrPrint(port, false, slugPath());
    await running;
  } finally { release?.(); portReservation?.(); claim.lease.release(); }
} catch (error) {
  logger.error("launcher", `startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (readout) {
    const where = readout.activeStep();
    readout.fail(
      `${where ? `${where.label.toLowerCase()}: ` : ""}${error instanceof Error ? error.message : String(error)}`,
      logger.file ?? undefined,
    );
    process.exit(1);
  }
  fail(error);
}
