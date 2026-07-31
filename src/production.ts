#!/usr/bin/env node
// The registry launcher is intentionally separate from index.ts. `fray-dev` follows mutable
// checkout source; `fray` runs the package that npm resolved and never turns an npx cache into a
// deployment directory.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchApp, launchBrowserTab } from "./browser.ts";
import {
  acquireGlobalLaunchLock,
  choosePort,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  parseCliArgs,
  probeFray,
  readPreferredPort,
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
import { assertLaunchPrerequisites, ensureNativeHelperPermissions } from "./preflight.ts";

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
  --app                use the legacy dedicated app window instead of a browser tab
  --no-app             print the URL without opening a browser
  --port <port>        request a fixed port for a new workspace server
  -h, --help           show this help`,
  );
  process.exit(0);
}
if (options.dev || rawArgs.includes("--prod")) fail("--dev and --prod are not available from the registry launcher");

const workspace: Workspace = (() => {
  try {
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  if (reexec) {
    if (!pinned) throw new Error("registry successor is missing its pinned project identity");
    return workspaceFromLaunchTarget(pinned);
  }
  return resolveWorkspace(options.repoPath);
  } catch (error) { return fail(error); }
})();
process.chdir(workspace.root);
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
  console.log(`${reused ? "reusing" : "started"} Fray ${PACKAGE_VERSION} for ${workspace.root}`);
  if (options.noApp) {
    console.log(url);
    return;
  }
  try {
    if (options.appMode) {
      await launchApp(url, { dataPath: join(workspace.stateDir, "browser-profile") });
      console.log(`${reused ? "focused" : "opened"} Fray app — ${url}`);
    } else {
      await launchBrowserTab(url);
      console.log(`requested Fray in your default browser — ${url}`);
    }
  } catch {
    console.log(
      `Could not open the ${options.appMode ? "Fray app window" : "default browser"}. Open manually: ${url}`,
    );
  }
}

async function runSupervisor(port: number, token: string): Promise<never> {
  assertLaunchPrerequisites();
  // Registry installs may have skipped node-pty's post-install; repair it before anything spawns a pty.
  ensureNativeHelperPermissions();
  const owner = adoptProjectLaunchOwner(target, token, "supervisor");
  const env = projectLaunchEnvironment({ ...process.env, FRAY_PRODUCTION_SUPERVISOR: "1" }, target, owner.token);
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
  const stop = createSupervisorShutdownHandler({ close: () => supervisor.close(), force: () => supervisor.forceStop(), release: () => owner.release(), exit: (code) => process.exit(code), error: (line) => console.error(line) });
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
  try {
    const port = await choosePort(options.port, readPreferredPort(workspace.stateDir));
    // The supervisor owns the rest of this process's life (runSupervisor never returns), so start it
    // WITHOUT awaiting and race it against health. Awaiting it directly is what made everything below
    // unreachable: parseCliArgs pins `foreground` to true, so the old `if (options.foreground) await
    // runSupervisor(...)` always won and a cold `npx frayui` never printed its URL, never opened a
    // browser, and never released the lock it took — the detached-spawn branch that used to follow was
    // dead code the day parseCliArgs stopped honouring --detach.
    const running = runSupervisor(port, claim.lease.token);
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
    // Hold the machine-global allocation lock only until the port is actually listening. It must NOT
    // span the foreground server lifetime, or a single `npx frayui` blocks every other repository's
    // launch on this machine until it is stopped.
    release();
    release = undefined;
    await openOrPrint(port, false);
    await running;
  } finally { release?.(); claim.lease.release(); }
} catch (error) { fail(error); }
