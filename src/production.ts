#!/usr/bin/env node
// The registry launcher is intentionally separate from index.ts. `fray-dev` follows mutable
// checkout source; `fray` runs the package that npm resolved and never turns an npx cache into a
// deployment directory.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchApp, launchBrowserTab } from "./browser.ts";
import { Readout, tildePath } from "./readout.ts";
import {
  appendCrashRecord,
  attachTerminalMirror,
  createLogger,
  logEnvironment,
  runLogPath,
  setAmbientLogger,
  type Logger,
} from "@fray-ui/server/logging";
import {
  acquireGlobalLaunchLock,
  allocatePort,
  EXPOSED_WARNING,
  PUBLIC_ORIGIN_WARNING,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  networkUrls,
  parseCliArgs,
  probeFray,
  readPreferredPort,
  resolveBindSelection,
  resolveWorkspace,
  waitForWorkspace,
  workspaceFromLaunchTarget,
  workspaceLaunchTarget,
  type CliOptions,
  type Workspace,
} from "./launcher.ts";
import {
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
} from "@fray-ui/server/project-launch";
import { createSupervisorShutdownHandler, startDevSupervisor } from "@fray-ui/server/dev-supervisor";
import { handoffToRegistrySuccessor, npmRegistryReleaseAdapter, planRegistryUpdate, PRODUCTION_REEXEC_FLAG } from "./production-update.ts";
import {
  assertLaunchPrerequisites,
  assertRequiredExecutables,
  ensureNativeHelperPermissions,
} from "./preflight.ts";

const PACKAGE_NAME = process.env.FRAY_REGISTRY_PACKAGE ?? "frayui";

/**
 * The version THIS bundle actually is, read from the package.json it ships inside.
 *
 * It used to be `process.env.npm_package_version ?? "0.0.1"`, and npm sets that variable only for
 * lifecycle scripts — NOT when a bin runs through the npx shim, which is how every real user starts
 * Fray. So the launcher reported itself as `0.0.1` forever. Measured end-to-end against the published
 * package: a genuine 0.1.1 install served `artifactDigest: "npm:frayui@0.0.1"`, and still served
 * `0.0.1` after updating itself to 0.1.2.
 *
 * That is not cosmetic. `planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, …)` compares this against
 * the registry's latest, so a permanent `0.0.1` makes every version look newer: the "already current"
 * branch below is unreachable, and Update Fray reinstalls-and-restarts even when nothing is stale.
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
  console.error(`fray: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
};

const options: CliOptions = (() => {
  try { return parseCliArgs(args); } catch (error) { return fail(error); }
})();
if (options.help) {
  console.log(
    `Fray production launcher

Usage: npx ${PACKAGE_NAME} [options] [repository]

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
authentication at the proxy: with Cloudflare Access, that is the whole of your access control.`,
  );
  process.exit(0);
}
if (options.dev || rawArgs.includes("--prod")) fail("--dev and --prod are not available from the registry launcher");

const bind = (() => {
  try { return resolveBindSelection(options, process.env); } catch (error) { return fail(error); }
})();

const workspace: Workspace = (() => {
  try {
  // BEFORE the workspace is resolved, because resolving it already shells out to `git` and to `tmux`
  // and opens this project's database — so a machine missing a tool, or running a Node the database
  // cannot survive, learns it here by name instead of from whichever internal step tripped over it
  // first. The Node floor matters most: on an unsupported release SQLite does not misbehave, it
  // SEGFAULTS, and a segfault mid-boot is indistinguishable from Fray being broken.
  //
  // `--stop` and `--status` skip the Node floor deliberately: they only read a status file and signal
  // a process, both of which work on any runtime, and they are how someone shuts down a board after
  // switching to a Node that cannot run one.
  if (!reexec) {
    if (options.stop || options.status) assertRequiredExecutables();
    else assertLaunchPrerequisites();
  }
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  if (reexec) {
    if (!pinned) throw new Error("registry successor is missing its pinned project identity");
    return workspaceFromLaunchTarget(pinned);
  }
  return resolveWorkspace(options.repoPath);
  } catch (error) { return fail(error); }
})();
process.chdir(workspace.root);
// Every launch leaves a complete record on disk, so a crash is never silent. The forked control-plane
// child appends to this same file rather than writing to the terminal the readout is repainting.
const logger: Logger = setAmbientLogger(
  process.env.FRAY_LOG_FILE
    ? createLogger({ file: process.env.FRAY_LOG_FILE, owner: false })
    : createLogger({ file: runLogPath(workspace.stateDir) }),
);
const readout = reexec || process.env.FRAY_PRODUCTION_SUPERVISOR === "1"
  ? undefined
  : new Readout({ debug: options.debug, version: PACKAGE_VERSION });
attachTerminalMirror(logger, options.debug || process.env.FRAY_DEBUG === "1");
readout?.plan([
  { key: "server", label: "Server" },
  { key: "browser", label: options.noApp ? "Address" : "Browser" },
]);
readout?.begin("server", "starting");
logger.info("launcher", `frayui ${PACKAGE_VERSION} starting for ${workspace.root}`);
const target = workspaceLaunchTarget(workspace);
const expected = expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir));

async function existingPort(): Promise<number | undefined> {
  const owner = liveWorkspaceOwner(workspace.stateDir, target);
  const ports = [owner?.port, readPreferredPort(workspace.stateDir)].filter((value): value is number => !!value);
  for (const port of new Set(ports)) if (await probeFray(port, expected)) return port;
  return undefined;
}

/**
 * Hand the operator the running board. This is deliberately the SAME contract as the source
 * launcher's openOrPrint (index.ts): a plain launch opens the default browser, `--app` opens the
 * dedicated app window, `--no-app` prints the URL and nothing else, and a browser that refuses to
 * open degrades to the URL instead of failing the launch.
 *
 * It printed the URL and stopped there from the day this file was written, so `npx frayui` never
 * opened anything while `fray-dev` always did — the whole divergence the operator hit.
 */
async function openOrPrint(port: number, reused: boolean): Promise<void> {
  const url = `http://127.0.0.1:${port}`;
  logger.info("launcher", `${reused ? "reusing" : "started"} Fray at ${url}`);
  readout?.settle("server", "done", reused ? `already running on port ${port}` : `port ${port}`);
  let browser: string | undefined;
  if (!options.noApp) {
    readout?.begin("browser", options.appMode ? "requesting app window" : "requesting default browser");
    try {
      if (options.appMode) {
        await launchApp(url, { dataPath: join(workspace.stateDir, "browser-profile") });
        browser = reused ? "focused the Fray app window" : "opened the Fray app window";
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
  const network = reused ? [] : networkUrls(port, bind.host);
  const publicOrigin = reused ? undefined : bind.publicOrigin;
  const warnings = [
    ...(network.length > 0 ? [EXPOSED_WARNING] : []),
    ...(publicOrigin ? [PUBLIC_ORIGIN_WARNING] : []),
  ];
  if (!readout) {
    console.log(`${reused ? "reusing" : "started"} Fray ${PACKAGE_VERSION} for ${workspace.root}`);
    console.log(url);
    for (const address of network) console.log(address);
    if (publicOrigin) console.log(publicOrigin);
    for (const warning of warnings) console.log(warning);
    return;
  }
  const home = homedir();
  readout.ready(
    [
      { label: "Local", value: `${url}/`, accent: true },
      ...network.map((address) => ({ label: "Network", value: `${address}/`, accent: true })),
      ...(publicOrigin ? [{ label: "Public", value: `${publicOrigin}/`, accent: true }] : []),
      { label: "Project", value: `${workspace.name} — ${tildePath(workspace.root, home)}` },
      ...(logger.file ? [{ label: "Logs", value: tildePath(logger.file, home) }] : []),
    ],
    reused
      ? // This launch owns nothing and exits immediately, so ctrl-c would not stop what it reopened.
        "reopened the server already running for this project · stop it from the terminal that started it"
      : options.debug
        ? undefined
        : "press ctrl-c to stop · run with --debug for the full event feed",
    {
      ...(reused ? { status: `already running on port ${port}` } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
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
      FRAY_PRODUCTION_SUPERVISOR: "1",
      ...logEnvironment(logger, options.debug ? "debug" : "info"),
      ...(options.debug ? { FRAY_DEBUG: "1" } : {}),
    },
    target,
    owner.token,
  );
  const webDist = join(import.meta.dirname, "..", "web-dist");
  // The registry package runs directly from what it ships, so it carries its own runtime closure
  // (staged by scripts/prepare-package.mjs). The server SHELLS OUT to the board parser and every
  // dispatched worker loads the plugin, so both must be pointed at the bundled copies — the
  // monorepo-relative default in server/src/fray.ts resolves to a non-existent node_modules/board path.
  const runtimeDir = join(import.meta.dirname, "..", "runtime");
  const scriptsDir = join(runtimeDir, "board");
  const workerPluginDir = join(runtimeDir, "cc-worker");
  // The published package runs as an esbuild bundle (dist/frayui.js); the server child and the
  // detached daemon are emitted as sibling bundles in the same dist/ by scripts/build-package.mjs.
  // Resolve the child beside this bundle rather than from @fray-ui/server (whose .ts cannot run
  // under node_modules). In a source checkout this launcher is never executed — fray-dev uses index.ts.
  const childEntry = fileURLToPath(new URL("./dev-child.js", import.meta.url));
  let plannedUpdate: Awaited<ReturnType<typeof planRegistryUpdate>> | undefined;

  // Whether the registry actually has something newer, refreshed on a timer and READ FROM CACHE.
  // The status endpoint is polled by every open tab, so it must never reach the network; and the
  // answer only changes when someone publishes, so a slow cadence is plenty. Starts optimistic
  // (`true`) so the button keeps its current appearance until the first probe lands — the operator
  // never sees it flip from Restart to Update a second after load.
  let updateAvailable = true;
  const refreshUpdateAvailable = async (): Promise<void> => {
    try {
      updateAvailable = (await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter)) !== null;
    } catch {
      // A registry we cannot reach is not evidence that we are current. Leave the last known answer.
    }
  };
  void refreshUpdateAvailable();
  const updateAvailablePoll = setInterval(() => void refreshUpdateAvailable(), 30 * 60 * 1000);
  updateAvailablePoll.unref();

  const supervisor = await startDevSupervisor({
    port,
    host: bind.host,
    allowedHosts: bind.allowedHosts,
      ...(bind.publicOrigin ? { publicOrigin: bind.publicOrigin } : {}),
    cwd: workspace.root,
    stateDir: workspace.stateDir,
    launchTarget: target,
    launchOwnerToken: owner.token,
    env,
    watch: false,
    childEntry,
    childEnvironment: () => ({ FRAY_STABLE_WEB_DIST: webDist, FRAY_STABLE_ARTIFACT: `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}`, FRAY_SCRIPTS_DIR: scriptsDir, FRAY_WORKER_PLUGIN_DIR: workerPluginDir }),
    updateAvailable: () => updateAvailable,
    updateRestart: async () => {
      try {
        const plan = await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter);
        if (!plan) { updateAvailable = false; return { state: "failed" as const, message: `Fray ${PACKAGE_VERSION} is already current` }; }
        plannedUpdate = plan;
        // npm only writes its own cache. The healthy supervisor is deliberately left up until the
        // server has drained its child and proxy immediately before durableReexec below.
        return { state: "ready" as const, message: `Fray ${plan.latestVersion} will start in a new npm execution cache` };
      } catch (error) {
        return { state: "failed" as const, message: error instanceof Error ? error.message : String(error) };
      }
    },
    durableReexec: async () => {
      const plan = plannedUpdate ?? await planRegistryUpdate(PACKAGE_NAME, PACKAGE_VERSION, npmRegistryReleaseAdapter);
      if (!plan) throw new Error("Fray is already current");
      handoffToRegistrySuccessor(plan, { port, projectDir: workspace.root, cwd: workspace.root, env }, npmRegistryReleaseAdapter);
      // The successor adopts the same tokenized project lease. SQLite, tmux and provider sessions
      // are keyed project resources, so neither process copies, deletes, nor recreates them.
      process.exit(0);
    },
  });
  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => owner.release(),
    exit: (code) => {
      logger.info("launcher", `stopped with code ${code}`);
      const suffix = logger.file ? `\n  log: ${tildePath(logger.file, homedir())}` : "";
      process.stdout.write(
        code === 0
          ? `\n  Fray stopped. Agent sessions in tmux keep running.${suffix}\n\n`
          : `\n  Fray stopped with errors (exit ${code}).${suffix}\n\n`,
      );
      process.exit(code);
    },
    error: (line) => logger.error("supervisor", line.startsWith("[fray-ui] ") ? line.slice(10) : line),
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void supervisor.stopRequested.then(stop);
  await supervisor.firstBoot;
  return await new Promise<never>(() => {});
}

try {
  if (process.env.FRAY_PRODUCTION_SUPERVISOR === "1" || reexec) {
    if (!options.port) throw new Error("internal registry supervisor launch is missing --port");
    const token = projectLaunchOwnerTokenFromEnvironment(process.env);
    if (!token) throw new Error("registry supervisor launch is missing project ownership");
    await runSupervisor(options.port, token);
  }
  const existing = await existingPort();
  if (existing) { await openOrPrint(existing, true); process.exit(0); }
  const claim = tryAcquireProjectLaunchOwner(target, "launcher");
  if (claim.kind !== "acquired") throw new Error("Fray is starting for this project; retry shortly");
  let release: (() => void) | undefined = await acquireGlobalLaunchLock();
  let portReservation: (() => void) | undefined;
  try {
    const allocation = await allocatePort(options.port, readPreferredPort(workspace.stateDir), { host: bind.host });
    const port = allocation.port;
    portReservation = allocation.release;
    // The supervisor owns the rest of this process's life (runSupervisor never returns), so start it
    // WITHOUT awaiting and race it against health. Awaiting it directly is what made everything below
    // unreachable: parseCliArgs pins `foreground` to true, so the old `if (options.foreground) await
    // runSupervisor(...)` always won and a cold `npx frayui` never printed its URL, never opened a
    // browser, and never released the lock it took — the detached-spawn branch that used to follow was
    // dead code the day parseCliArgs stopped honouring --detach.
    const running = runSupervisor(port, claim.lease.token);
    // Allocation is the only machine-shared step, so the machine-global lock ends HERE — the port
    // reservation above, not this lock, keeps `port` ours until the child listens. Holding it across
    // the progress-tracked wait below meant one cold `npx frayui` could sit on it for minutes while
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
    await openOrPrint(port, false);
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
