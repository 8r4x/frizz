#!/usr/bin/env node
import { bindHostIsExposed } from "@frizz/server/local-origin";
import { loadOrCreateSessionKey } from "@frizz/server/access-codes";
import { renderQrLines } from "@frizz/server/qr";
import { SUPERVISOR_ACCESS_CODE_PATH } from "@frizz/server/restart-supervisor";
import { installAccessPane, type AccessPane } from "./access-pane.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
} from "@frizz/server/logging";
import {
  buildFrizzArtifact,
  assertArtifactHostCompatible,
  defaultArtifactRoot,
  ensureStableFrizzArtifact,
  promoteCurrentSourceArtifact,
  promoteFrizzArtifact,
  readFrizzArtifact,
  readStableArtifact,
} from "./artifacts.ts";
import { assertLaunchPrerequisites, assertRequiredExecutables } from "./preflight.ts";
import { DEFAULT_DEV_PORT, fallbackPort } from "@frizz/shared";
import {
  acquireGlobalLaunchLock,
  allocatePort,
  boardAddress,
  canBindPort,
  resolveLaunchIntent,
  EXPOSED_WARNING,
  PUBLIC_ORIGIN_WARNING,
  REUSED_NETWORK_FLAGS_WARNING,
  expectedOwnerHealth,
  FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS,
  helpText,
  liveWorkspaceOwner,
  networkUrls,
  parseCliArgs,
  persistLauncher,
  probeFrizz,
  JOIN_PROBE_TIMEOUT_MS,
  prepareBeforeGlobalLaunchLock,
  readPreferredPort,
  requestFrizzStop,
  resolveBindSelection,
  resolveWorkspace,
  sourceLabel,
  sourceWorkspaceDir,
  supervisorNeedsAttention,
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
  processGenerationIsStale,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
  verifyProjectLaunchDelegate,
  type ProjectLaunchLease,
} from "@frizz/server/project-launch";
import { registerProject } from "@frizz/server/project-registry";
import { resolveProjectLabel } from "@frizz/server/project-identity";

function fail(error: unknown): never {
  console.error(`frizz: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

/**
 * The last thing the operator sees when the board stops. Ctrl-C used to print nothing whatsoever, so
 * a clean shutdown and a crashed one looked identical, and neither told you where to read the log.
 */
function printFarewell(code: number): void {
  const suffix = logger.file ? `\n  log: ${tildePath(logger.file, homedir())}` : "";
  process.stdout.write(
    code === 0
      ? `\n  Frizz stopped. Running agents keep going — they are detached daemons.${suffix}\n\n`
      : `\n  Frizz stopped with errors (exit ${code}).${suffix}\n\n`
  );
}

/** The version this checkout reports, for the readout header. Best-effort; never fails a launch. */
function sourceVersion(): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

const argv = process.argv.slice(2);
const sourceCommand = process.env.FRIZZ_SOURCE_COMMAND ?? "frizz-dev";
const command = ["build", "promote", "restart"].includes(argv[0] ?? "")
  ? argv[0]
  : undefined;
let options: CliOptions;
try {
  options = parseCliArgs(
    command === "promote" ? argv.slice(2) : command ? argv.slice(1) : argv
  );
} catch (error) {
  fail(error);
}
if (options.help) {
  console.log(helpText(sourceCommand));
  process.exit(0);
}
if (argv.includes("--prod"))
  fail("--prod is not available from the source-backed development launcher");

const internalLaunch =
  process.env.FRIZZ_DIRECT_SUPERVISOR === "1" ||
  process.env.FRIZZ_DAEMON_CHILD === "1" ||
  process.env.FRIZZ_DEV_REEXEC === "1" ||
  process.env.FRIZZ_DEV_CHILD === "1";
const interactiveLaunch =
  !internalLaunch &&
  !options.stop &&
  !options.status &&
  command !== "restart" &&
  command !== "promote";

const readout = interactiveLaunch
  ? new Readout({ debug: options.debug, version: sourceVersion() })
  : undefined;

readout?.plan([
  { key: "workspace", label: "Workspace" },
  ...(options.dev ? [] : [{ key: "artifact", label: "Artifact" }]),
  { key: "server", label: "Server" },
  { key: "browser", label: options.noApp ? "Address" : "Browser" },
]);
readout?.begin("workspace");

let workspace: Workspace;
let launchIntent: ReturnType<typeof resolveLaunchIntent> | undefined;
try {
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  const internal =
    process.env.FRIZZ_DEV_CHILD === "1" ||
    process.env.FRIZZ_DIRECT_SUPERVISOR === "1" ||
    process.env.FRIZZ_DAEMON_CHILD === "1" ||
    process.env.FRIZZ_DEV_REEXEC === "1";
  if (internal && !pinned)
    throw new Error("internal launch is missing its pinned project identity");
  // Resolving a workspace already shells out to `git` and to `tmux` and opens this project's
  // database, so check first and name what is wrong. The Node floor is part of it for a real launch:
  // on an unsupported release SQLite SEGFAULTS rather than erroring, and a segfault mid-boot reads as
  // "Frizz is broken" instead of "upgrade Node". `--stop`/`--status` and the repair commands keep the
  // executables-only check, since they only read a status file and signal a process.
  if (!internal) {
    if (interactiveLaunch) assertLaunchPrerequisites();
    else assertRequiredExecutables();
  }
  // Running the command no longer ADOPTS the directory it was run in — see resolveLaunchIntent. An
  // unknown directory hosts the server on the most recent real project and asks about itself on the
  // grid; $HOME is never asked about at all.
  let hosted: Workspace | undefined;
  if (!internal) {
    const intent = resolveLaunchIntent(options.repoPath);
    if (intent.kind === "empty") {
      throw new Error(
        intent.reason === "home"
          ? "frizz cannot open your home directory as a project, and there is no other project to show yet. cd into a repository and run frizz there."
          : `${intent.directory} is not a Frizz project yet, and there is no other project to show. Run frizz inside a repository, or add this one from the projects page once a board is open.`
      );
    }
    launchIntent = intent;
    hosted = intent.workspace;
  }
  workspace = internal ? workspaceFromLaunchTarget(pinned!) : hosted!;
} catch (error) {
  // Report ONCE — `fail()` prints too, and doing both showed the operator the same sentence twice
  // under two prefixes, which reads like two separate failures.
  //
  // No project is known yet, so this record goes to the machine-level fallback directory rather than
  // a per-project one. Written directly: there is no logger to own, and none is worth creating for a
  // launch that is already over.
  const fallback = runLogPath();
  appendCrashRecord(
    fallback,
    `workspace resolution failed: ${error instanceof Error ? error.stack ?? error.message : error}`
  );
  if (readout) {
    readout.fail(error instanceof Error ? error.message : String(error), fallback);
    process.exit(1);
  }
  fail(error);
}
process.chdir(workspace.root);
// The project is known now, so this run's log belongs in its state directory, beside every other
// per-project artifact a reader debugging this board already looks at. A forked child inherits the
// parent's path through the environment instead of opening its own.
const logger: Logger = setAmbientLogger(
  process.env.FRIZZ_LOG_FILE
    ? createLogger({ file: process.env.FRIZZ_LOG_FILE, owner: false })
    : createLogger({ file: runLogPath(workspace.stateDir) })
);
attachTerminalMirror(logger, options.debug || process.env.FRIZZ_DEBUG === "1");
// Only the OPERATOR's invocation announces itself. The control-plane child re-enters this same entry
// point with FRIZZ_DEV_CHILD=1 before reaching its own branch below, so without this guard every run
// logged the launcher banner twice — once for the real launch and once for the child.
if (!internalLaunch) {
  logger.info("launcher", `${sourceCommand} starting in ${options.dev ? "source" : "artifact"} mode`);
  logger.info("launcher", `workspace ${workspace.name} (${workspace.root})`);
}
readout?.settle("workspace", "done", workspace.name);
const expectedHealth = { projectId: workspace.id, projectDir: workspace.root };
const launchTarget = workspaceLaunchTarget(workspace);
/**
 * The first single-use access link, minted once the supervisor is listening.
 *
 * Module-scoped because the supervisor is built inside the launch path while the readout is assembled
 * in another function entirely, and threading one nullable string through that call chain buys nothing.
 */
let activeAccessLink: { code: string; url: string; expiresAt: number } | null = null;
/** The keypress listener, held so shutdown can put the terminal back the way it found it. */
let accessPane: AccessPane | null = null;

const bind = (() => {
  try {
    return resolveBindSelection(options, process.env);
  } catch (error) {
    return fail(error);
  }
})();

// The supervisor validates every generation by forking this same source entry with a private marker.
// That disposable child boots only the HTTP/Vite control plane; it must never recursively supervise.
if (process.env.FRIZZ_DEV_CHILD === "1") {
  const token = projectLaunchOwnerTokenFromEnvironment(process.env);
  if (!token) throw new Error("dev child is missing project launch ownership");
  verifyProjectLaunchDelegate(workspaceLaunchTarget(workspace), token);
  const { runDevControlPlaneChild } = await import(
    "@frizz/server/dev-supervisor"
  );
  await runDevControlPlaneChild();
  await new Promise<never>(() => {});
}

async function runSupervisor(
  port: number,
  inheritedToken?: string | null,
  pinnedArtifactDigest?: string
): Promise<never> {
  // Keep build/promote/status/stop usable for repair on a partially provisioned machine, but never
  // let a control-plane server start when its mandatory local tools are unavailable.
  assertLaunchPrerequisites();
  const target = workspaceLaunchTarget(workspace);
  const token =
    inheritedToken ?? projectLaunchOwnerTokenFromEnvironment(process.env);
  if (!token) throw new Error("supervisor launch is missing project ownership");
  const launchOwner = adoptProjectLaunchOwner(target, token, "supervisor");
  const supervisorEnv = projectLaunchEnvironment(
    {
      ...process.env,
      FRIZZ_DIRECT_SUPERVISOR: "1",
      // Every descendant appends to THIS run's log. That is what lets the control-plane child stay
      // silent on the terminal without its records being lost.
      ...logEnvironment(logger, options.debug ? "debug" : "info"),
      ...(options.debug ? { FRIZZ_DEBUG: "1" } : {}),
    },
    target,
    launchOwner.token
  );
  const selectedArtifact = options.dev
    ? undefined
    : pinnedArtifactDigest ?? process.env.FRIZZ_STABLE_ARTIFACT
    ? readFrizzArtifact(
        pinnedArtifactDigest ?? process.env.FRIZZ_STABLE_ARTIFACT!,
        defaultArtifactRoot()
      )
    : ensureStableFrizzArtifact(
        workspace.stateDir,
        sourceWorkspaceDir(),
        defaultArtifactRoot()
      );
  if (selectedArtifact) assertArtifactHostCompatible(selectedArtifact);
  const { createSupervisorShutdownHandler, startDevSupervisor } = await import(
    "@frizz/server/dev-supervisor"
  );
  let supervisor: Awaited<ReturnType<typeof startDevSupervisor>>;
  const stableOptions = selectedArtifact
    ? (() => {
        let updateRollbackArtifact: typeof selectedArtifact | undefined;
        let firstChildLaunch = true;
        const selectedChildLaunch = () => {
          // The launcher selected this artifact before starting the foreground supervisor. The first control-plane child is
          // pinned to that verified digest even if source or the durable pointer changes while the
          // supervisor is coming up. Later authenticated restarts intentionally consult promotion.
          const artifact = firstChildLaunch
            ? selectedArtifact
            : readStableArtifact(workspace.stateDir, defaultArtifactRoot());
          firstChildLaunch = false;
          if (!artifact)
            throw new Error(
              "the currently promoted Frizz artifact is missing or failed verification"
            );
          assertArtifactHostCompatible(artifact);
          return {
            entry: join(artifact.runtimeDir, "src", "index.js"),
            environment: {
              FRIZZ_STABLE_WEB_DIST: artifact.webDir,
              FRIZZ_STABLE_ARTIFACT: artifact.digest,
              FRIZZ_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
              // The bundled runtime resolves its worker plugin from the verified artifact closure.
              FRIZZ_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
            },
          };
        };
        return {
          childLaunchProvider: selectedChildLaunch,
          watch: false,
          updateRestart: async () => {
            // Build and verify before touching the healthy child. No source edit can enter this path.
            // An unverifiable current artifact leaves us without a rollback target but does not
            // block the update — see promoteCurrentSourceArtifact.
            try {
              const { previous } = promoteCurrentSourceArtifact(
                workspace.stateDir,
                sourceWorkspaceDir(),
                defaultArtifactRoot()
              );
              updateRollbackArtifact = previous;
              return { state: "ready" as const };
            } catch (error) {
              return {
                state: "failed" as const,
                message: error instanceof Error ? error.message : String(error),
              };
            }
          },
          rollbackUpdate: () => {
            if (!updateRollbackArtifact) return;
            promoteFrizzArtifact(
              workspace.stateDir,
              updateRollbackArtifact.digest,
              defaultArtifactRoot()
            );
            updateRollbackArtifact = undefined;
          },
          ...(typeof process.execve === "function"
            ? {
                durableReexec: () => {
                  // Update & Restart promotes a complete deployed CLI/runtime, not merely the
                  // child HTTP entry. Replace this owner with that immutable CLI so
                  // server/supervisor fixes take effect too. The tokenized launch lease stays in
                  // the environment across execve; SQLite, tmux and provider-side sessions are
                  // project resources and are never copied or torn down for this handoff.
                  const artifact = readStableArtifact(
                    workspace.stateDir,
                    defaultArtifactRoot()
                  );
                  if (!artifact)
                    throw new Error(
                      "the promoted Frizz artifact is missing or failed verification"
                    );
                  assertArtifactHostCompatible(artifact);
                  const env = projectLaunchEnvironment(
                    {
                      ...supervisorEnv,
                      FRIZZ_DEV_REEXEC: "1",
                      FRIZZ_SOURCE_DIR: sourceLabel(),
                      FRIZZ_STABLE_ARTIFACT: artifact.digest,
                    },
                    target,
                    launchOwner.token
                  );
                  delete env.FRIZZ_DEV_CHILD;
                  delete env.FRIZZ_DEV_PORT;
                  process.execve!(
                    process.execPath,
                    [
                      process.execPath,
                      join(artifact.runtimeDir, "src", "index.js"),
                      "--port",
                      String(port),
                      workspace.root,
                    ],
                    env
                  );
                },
              }
            : {}),
        };
      })()
    : {
        // --dev is intentionally the only route that can boot source plus Vite/HMR.
        watch: true,
      };
  try {
    supervisor = await startDevSupervisor({
      port,
      host: bind.host,
      allowedHosts: bind.allowedHosts,
      ...(bind.publicOrigin ? { publicOrigin: bind.publicOrigin } : {}),
      ...(bind.publicToken ? { publicToken: bind.publicToken } : {}),
      // Persisted beside the project's other state so a restart does not sign every device out.
      ...(bind.publicOrigin ? { sessionKey: loadOrCreateSessionKey(workspace.stateDir) } : {}),
      cwd: workspace.root,
      env: supervisorEnv,
      stateDir: workspace.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      ...stableOptions,
      // This file IS frizz-dev: it only ever runs from a source checkout, and the published bin is
      // src/production.ts (scripts/build-package.mjs maps "frizz.js" to it). So reaching here means
      // a development build, on BOTH routes — the artifact one as much as `--dev`. The web client
      // cannot work that out for itself, because the artifact route serves a Vite PRODUCTION bundle
      // where `import.meta.env.DEV` is statically false. Stated after the spread so no launch-mode
      // option can quietly take it away.
      dev: true,
    });
    // The supervisor is listening now, so a code minted here is immediately redeemable.
    activeAccessLink = bind.publicOrigin ? supervisor.issueAccessLink() : null;
    // "Press L for a fresh link" — the only way to reissue without restarting the board. Returns null
    // when stdout is not a terminal, which leaves the plain records path completely untouched.
    if (bind.publicOrigin) {
      accessPane = installAccessPane({ issue: () => supervisor.issueAccessLink() });
    }
  } catch (error) {
    launchOwner.release();
    throw error;
  }
  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => {
      launchOwner.release();
    },
    exit: (code) => {
      // Ctrl-C printed nothing at all before this. Say the board stopped, and where the complete
      // record of the run it just ended can be read.
      logger.info("launcher", `stopped with code ${code}`);
      // Before the farewell, or the operator's shell is left in raw mode echoing nothing.
      accessPane?.dispose();
      printFarewell(code);
      process.exit(code);
    },
    error: (line) =>
      logger.error("supervisor", line.startsWith("[frizz] ") ? line.slice(10) : line),
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void supervisor.stopRequested.then(stop);
  await supervisor.firstBoot;
  persistLauncher(workspace, port, sourceWorkspaceDir());
  return await new Promise<never>(() => {});
}

// A legacy detached supervisor or durable re-exec re-enters here after launcher source changes. It must rebuild
// its watcher in-place without competing with its own global lock or trying to open another window.
if (
  process.env.FRIZZ_DIRECT_SUPERVISOR === "1" ||
  process.env.FRIZZ_DAEMON_CHILD === "1" ||
  process.env.FRIZZ_DEV_REEXEC === "1"
) {
  if (!options.port) fail("internal supervisor launch is missing --port");
  await runSupervisor(
    options.port,
    projectLaunchOwnerTokenFromEnvironment(process.env)
  );
}

if (command === "build") {
  try {
    const artifact = buildFrizzArtifact(
      sourceWorkspaceDir(),
      defaultArtifactRoot(),
      { onProgress: (message) => logger.info("artifact", message) }
    );
    logger.info("artifact", `built ${artifact.digest}`);
    console.log(`built Frizz artifact ${artifact.digest}`);
    console.log(`web: ${artifact.webDir}`);
    process.exit(0);
  } catch (error) {
    logger.error(
      "artifact",
      `build failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    fail(error);
  }
}

if (command === "promote") {
  try {
    const digest = argv[1];
    if (!digest) throw new Error("usage: frizz-dev promote <artifact-digest>");
    const pointer = promoteFrizzArtifact(
      workspace.stateDir,
      digest,
      defaultArtifactRoot()
    );
    console.log(
      `promoted Frizz artifact ${pointer.current}${
        pointer.previous ? ` (rollback ${pointer.previous})` : ""
      }`
    );
    process.exit(0);
  } catch (error) {
    fail(error);
  }
}

async function existingHealth() {
  const ports = new Set<number>();
  const authoritative = readProjectLaunchOwner(workspace.stateDir);
  const owner = liveWorkspaceOwner(workspace.stateDir, launchTarget);
  if (
    authoritative &&
    (authoritative.state === "draining" ||
      processGenerationIsStale(authoritative))
  ) {
    return {
      port: undefined,
      health: null,
      owner: null,
      launchOwner: authoritative,
    };
  }
  const expected = expectedOwnerHealth(launchTarget, authoritative);
  if (owner) ports.add(owner.port);
  const preferred = readPreferredPort(workspace.stateDir);
  if (preferred) ports.add(preferred);
  for (const port of ports) {
    const health = await probeFrizz(port, expected);
    if (health) return { port, health, owner, launchOwner: authoritative };
  }
  return { port: undefined, health: null, owner, launchOwner: authoritative };
}

async function claimProjectLaunch(): Promise<
  ProjectLaunchLease | { reusePort: number }
> {
  const target = workspaceLaunchTarget(workspace);
  const deadline = Date.now() + 10_000;
  let lastOwner = readProjectLaunchOwner(workspace.stateDir);
  for (;;) {
    const attempt = tryAcquireProjectLaunchOwner(target, "launcher");
    if (attempt.kind === "acquired") return attempt.lease;
    lastOwner = attempt.owner ?? lastOwner;
    const existing = await existingHealth();
    if (existing.health && existing.port) return { reusePort: existing.port };
    if (Date.now() >= deadline) {
      const detail = lastOwner
        ? `${lastOwner.role} pid ${lastOwner.pid} owns startup but did not become ready`
        : "another launcher is still publishing project ownership";
      throw new Error(
        `${detail}; retry, inspect frizz-dev --status, or stop the exact owner with frizz-dev --stop`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Hand the operator the running board and print the block that stays on screen.
 *
 * Exactly ONE address appears here, and it is the one to open. The old readout printed the control
 * plane's private child port as well ("server on http://127.0.0.1:51739") — two ports, no indication
 * which was real. That port is an implementation detail and now goes to the log only.
 */
/**
 * This project's URL segment, registering it with the machine if it has not been seen before.
 *
 * `/` is the project grid now, so a board lives at `/<slug>` — including the board we are about to
 * launch. Registration is idempotent: an id already in the registry keeps the slug it was given.
 */
function ownSlug(): string | undefined {
  try {
    return registerProject(
      {
        dir: workspace.root,
        id: workspaceLaunchTarget(workspace).projectId,
        remoteOwner: resolveProjectLabel(workspace.root)?.split("/")[0],
      },
      homedir()
    ).entry?.slug;
  } catch {
    // The registry is an INDEX. If it cannot be written, opening the board unprefixed still works.
    return undefined;
  }
}

/**
 * Where a Frizz that could already be serving this project would be listening.
 *
 * An explicit `--port` is asked FIRST, for the same reason the well-known ones are asked at all: if a
 * Frizz is already serving this project there, joining it is the answer and starting a rival is not.
 * Without it `--port N` skipped the join outright and then died at allocation, because the port it was
 * told to use was held by the very server it should have been using.
 */
function joinCandidatePorts(): number[] {
  return [
    ...new Set(
      [options.port, DEFAULT_DEV_PORT, fallbackPort(DEFAULT_DEV_PORT)].filter(
        (candidate): candidate is number => candidate !== undefined
      )
    ),
  ];
}

/**
 * A frizz-dev already running on this machine, serving THIS project under its own slug.
 *
 * The same client-not-a-server move the published launcher makes, and it matters more here: this is
 * the command the maintainer actually runs, in four repositories. Without it a second `frizz-dev`
 * would start a second server rather than joining the one that is already serving every project.
 *
 * The identity check is the launcher's own handshake minus the owner proof — that proof is keyed to a
 * launch LEASE and a client holds none. What a client needs to know is that this port serves ITS id
 * from ITS directory, which is exactly what the id and dir answer.
 */
async function joinRunningFrizz(): Promise<
  { port: number; slug: string } | undefined
> {
  const slug = ownSlug();
  if (!slug) return undefined;
  const target = workspaceLaunchTarget(workspace);
  for (const port of joinCandidatePorts()) {
    if (
      await probeFrizz(
        port,
        {
          projectId: target.projectId,
          projectDir: target.projectDir,
          slug,
        },
        fetch,
        JOIN_PROBE_TIMEOUT_MS
      )
    )
      return { port, slug };
  }
  return undefined;
}

/**
 * Say it on screen when this launch is about to become the machine's SECOND Frizz.
 *
 * Falling past the join is right when nothing is running and wrong in every other case: two Frizzes
 * means two schedulers, and one board's timers and recurring prompts firing twice. Until now the only
 * trace was `machine server address is held by a live frizz …; leaving it` in a per-project log file,
 * printed by the child a full twenty seconds after the launcher had already committed — so what the
 * operator saw was a clean startup banner on a port they did not ask for.
 */
async function warnAboutStartingASecondFrizz(): Promise<void> {
  for (const port of joinCandidatePorts()) {
    if (await canBindPort(port)) continue;
    const detail = `port ${port} is in use but did not answer for ${workspace.root}; starting a SECOND Frizz`;
    logger.warn("launcher", detail);
    console.warn(`warning: ${detail}`);
    return;
  }
}

let cachedSlugPath: string | undefined;
/**
 * Where to land: this project's board, the grid, or the grid with a directory to ask about.
 *
 * `?add=` is a REQUEST, not a registration — nothing on disk changes until the operator confirms on
 * the page. That is the whole point of the change: a command typed in the wrong terminal must not
 * leave a permanent card behind.
 */
function slugPath(): string {
  if (cachedSlugPath === undefined) {
    if (launchIntent?.kind === "grid") cachedSlugPath = "/";
    else if (launchIntent?.kind === "offer")
      cachedSlugPath = `/?add=${encodeURIComponent(launchIntent.directory)}`;
    else {
      const slug = ownSlug();
      cachedSlugPath = slug ? `/project/${slug}` : "";
    }
  }
  return cachedSlugPath;
}

async function openOrPrint(
  port: number,
  reused: boolean,
  path = ""
): Promise<void> {
  const url = `http://127.0.0.1:${port}${path}`;
  const home = homedir();
  logger.info("launcher", `${reused ? "reusing" : "started"} Frizz at ${url} for ${workspace.root}`);
  if (reused) {
    // Nothing was built and nothing was started. Settle those steps for what they are, or a reuse
    // paints as a cold boot whose artifact and server rows simply never happened.
    readout?.settle("artifact", "skipped", "server already running");
    readout?.settle("server", "done", `already running on port ${port}`);
  }
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
  const network = reused ? [] : networkUrls(port, bind.host);
  const publicOrigin = reused ? undefined : bind.publicOrigin;
  // A reused server was started by someone else's invocation, so these flags did nothing. Say so.
  const networkFlagsIgnored = reused && (bind.publicOrigin !== undefined || bindHostIsExposed(bind.host));
  // Mint the first single-use link now, so the readout can show something scannable. Codes expire in
  // minutes by design; the QR pane (below) is how you get a fresh one without restarting the board.
  const accessLink = publicOrigin && !reused ? activeAccessLink : null;
  const warnings = [
    ...(network.length > 0 ? [EXPOSED_WARNING] : []),
    ...(publicOrigin ? [PUBLIC_ORIGIN_WARNING] : []),
    ...(networkFlagsIgnored ? [REUSED_NETWORK_FLAGS_WARNING] : []),
  ];
  if (!readout) {
    // `--status`, internal launches and pipes keep the plain, parseable records.
    console.log(`${reused ? "reusing" : "started"} Frizz for ${workspace.root}`);
    console.log(`source: ${sourceLabel()}`);
    console.log(url);
    for (const address of network) console.log(address);
    if (publicOrigin) console.log(accessLink?.url ?? `${publicOrigin}/`);
    for (const warning of warnings) console.log(warning);
    return;
  }
  readout.ready(
    [
      { label: "Local", value: boardAddress(url), accent: true },
      ...network.map((address) => ({ label: "Network", value: `${address}/`, accent: true })),
      ...(publicOrigin ? [{ label: "Public", value: accessLink?.url ?? `${publicOrigin}/`, accent: true }] : []),
      { label: "Project", value: `${workspace.name} — ${tildePath(workspace.root, home)}` },
      { label: "Source", value: tildePath(sourceLabel(), home) },
      ...(logger.file ? [{ label: "Logs", value: tildePath(logger.file, home) }] : []),
    ],
    reused
      ? // Ctrl-C is the WRONG instruction here: this launch owns nothing and exits immediately, so
        // the server it just reopened would keep running either way.
        `reopened the server already running for this project · run ${sourceCommand} --stop to stop it`
      : options.debug
        ? undefined
        : accessPane
          ? `press L for a fresh access link · ctrl-c to stop · --debug for the full event feed`
          : `press ctrl-c to stop · run with --debug for the full event feed`,
    {
      ...(reused ? { status: `already running on port ${port}` } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      // Scannable, because the point of the link is to reach a phone and nobody types 40 characters
      // off a terminal. Only when there IS a link — a loopback board has nothing to scan.
      ...(accessLink ? { qr: renderQrLines(accessLink.url) } : {}),
    }
  );
}

async function stopWorkspace(): Promise<void> {
  const target = launchTarget;
  const owner = readProjectLaunchOwner(workspace.stateDir);
  if (!owner) {
    console.log(`Frizz is not running for ${workspace.root}`);
    return;
  }
  const status = liveWorkspaceOwner(workspace.stateDir, target);
  const healthy = status ? null : await existingHealth();
  const controlPort = status?.port ?? healthy?.port;
  const controlled = controlPort
    ? await requestFrizzStop(
        controlPort,
        expectedOwnerHealth(target, owner),
        owner.token
      )
    : false;
  // Never turn a process-generation observation into a later PID signal: the PID can be recycled in
  // that gap. Live shutdown requires the owner token over HTTP/IPC. Proven-stale owners are recovered
  // below while registered children self-exit on supervisor IPC disconnect.
  if (!controlled && !processGenerationIsStale(owner)) {
    throw new Error(
      "Frizz refused to stop a live owner without authenticated token-bound control; the owner was left untouched"
    );
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!readProjectLaunchOwner(workspace.stateDir)) {
      console.log(
        `stopped Frizz for ${workspace.root}; tmux agent sessions were preserved`
      );
      return;
    }
    // A process can exit after accepting authenticated control but before its finally block removes
    // ownership. Reap through the same delegate-fencing protocol; never unlink the record directly.
    const reaped = tryAcquireProjectLaunchOwner(target, "launcher", {
      delegateDrainTimeoutMs: 250,
    });
    if (reaped.kind === "acquired") {
      reaped.lease.release();
      console.log(
        `stopped Frizz for ${workspace.root}; tmux agent sessions were preserved`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The last poll can race a supervisor's finally block by a few milliseconds. Make one final
  // generation-safe observation before calling this a timeout: never signal a PID or unlink an
  // ownership record directly, and only reclaim through the same token/delegate protocol.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const lateOwner = readProjectLaunchOwner(workspace.stateDir);
  if (!lateOwner) {
    console.log(
      `stopped Frizz for ${workspace.root}; tmux agent sessions were preserved`
    );
    return;
  }
  if (processGenerationIsStale(lateOwner)) {
    const reaped = tryAcquireProjectLaunchOwner(target, "launcher", {
      delegateDrainTimeoutMs: 250,
    });
    if (reaped.kind === "acquired") {
      reaped.lease.release();
      console.log(
        `stopped Frizz for ${workspace.root}; tmux agent sessions were preserved`
      );
      return;
    }
  }
  throw new Error(`supervisor pid ${owner.pid} did not stop within 10s`);
}

try {
  if (options.stop) {
    await stopWorkspace();
    process.exit(0);
  }

  if (options.link) {
    // Mint from the RUNNING board rather than starting one. This is the answer for a board running
    // detached or in someone else's terminal, where the interactive QR pane cannot install — without
    // it, "I need another code" means restarting the server, which is absurd.
    const running = liveWorkspaceOwner(workspace.stateDir, launchTarget);
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

  let before = await existingHealth();
  if (command === "restart") {
    if (!before.port) throw new Error("Frizz is not running for this workspace");
    const response = await fetch(
      `http://127.0.0.1:${before.port}/_frizz/control/restart`,
      {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${before.port}` },
      }
    );
    const result = (await response.json()) as {
      state?: string;
      message?: string;
    };
    if (!response.ok || result.state !== "ready")
      throw new Error(
        result.message ?? "Frizz did not become ready after restart"
      );
    console.log(
      `restarted Frizz artifact ${
        readStableArtifact(workspace.stateDir)?.digest ?? "unknown"
      }`
    );
    process.exit(0);
  }
  if (options.status) {
    if (before.health && before.port) {
      const needsAttention = supervisorNeedsAttention(before.owner);
      console.log(
        `${needsAttention ? "degraded" : "running"}: http://127.0.0.1:${
          before.port
        }`
      );
      console.log(`workspace: ${before.health.projectDir}`);
      console.log(`source: ${sourceLabel()}`);
      if (before.owner?.artifactDigest)
        console.log(`artifact: ${before.owner.artifactDigest}`);
      console.log(`supervisor pid: ${before.owner?.pid ?? "unknown"}`);
      if (needsAttention) {
        console.log(
          `detail: ${
            before.owner?.message ?? `supervisor is ${before.owner?.state}`
          }`
        );
        process.exitCode = 1;
      }
    } else if (before.owner) {
      console.log(
        `broken: supervisor pid ${before.owner.pid} is ${
          before.owner.state ?? "alive"
        } but port ${before.owner.port} is unhealthy`
      );
      if (before.owner.message) console.log(`detail: ${before.owner.message}`);
      process.exitCode = 1;
    } else if (before.launchOwner) {
      console.log(
        `broken: ${before.launchOwner.role} pid ${before.launchOwner.pid} owns launch in ${before.launchOwner.state} state without a healthy control plane`
      );
      if (before.launchOwner.delegates.length > 0) {
        console.log(
          `detail: waiting for ${before.launchOwner.delegates.length} delegated control plane(s) to drain`
        );
      }
      process.exitCode = 1;
    } else {
      // Under one server per machine, "this project has no server of its own" and "this project is
      // not being served" stopped being the same statement. A project that joined holds no launch
      // lease and never writes a server.lock, so every check above misses it and the honest answer
      // is the one the join path already knows how to get.
      const joined = await joinRunningFrizz();
      if (joined) {
        console.log(`running: http://127.0.0.1:${joined.port}/project/${joined.slug}`);
        console.log(`workspace: ${workspace.root}`);
        console.log(`served by the frizz running on this machine, which this project did not start`);
      } else console.log(`stopped: ${workspace.root}`);
    }
    process.exit();
  }
  if (before.health && before.port) {
    await openOrPrint(before.port, true, slugPath());
    process.exit(0);
  }
  {
    const joined = await joinRunningFrizz();
    if (joined) {
      // slugPath(), not the joined slug: the slug names the project this launch is HOSTED on, which
      // is only the project to open when the intent is `open`. A `grid`/`offer` launch is hosted on
      // the most recent project and must still land on the grid — hard-coding the host's board here
      // is what made `frizz-dev` in an unadopted directory open somebody else's board outright.
      await openOrPrint(joined.port, true, slugPath());
      process.exit(0);
    }
    await warnAboutStartingASecondFrizz();
  }
  if (before.owner && !readProjectLaunchOwner(workspace.stateDir)) {
    const owner = before.owner;
    // Upgrade compatibility: an old supervisor has atomic-ish status but predates tokenized ownership.
    // Never start over it; allow its current child handoff to finish, then fail closed if still unhealthy.
    try {
      await waitForWorkspace(owner.port, expectedHealth, 5_000);
      before = await existingHealth();
    } catch {}
    if (before.health && before.port) {
      await openOrPrint(before.port, true, slugPath());
      process.exit(0);
    }
    throw new Error(
      `supervisor pid ${
        owner.pid
      } is alive but its control plane is unhealthy (${
        owner.state ?? "unknown"
      }: ${
        owner.message ?? "no detail"
      }); fix the source or run frizz-dev --stop`
    );
  }

  const projectClaim = await claimProjectLaunch();
  if ("reusePort" in projectClaim) {
    await openOrPrint(projectClaim.reusePort, true, slugPath());
    process.exit(0);
  }
  const launchOwner = projectClaim;
  const target = workspaceLaunchTarget(workspace);
  // This preparation is local to the project. Keep it outside the machine-global port/start lock
  // so independent repositories can perform cold source/artifact work concurrently.
  let pinnedArtifact: ReturnType<typeof ensureStableFrizzArtifact> | undefined;
  let release: (() => void) | undefined;
  let portReservation: (() => void) | undefined;
  try {
    const sequenced = await prepareBeforeGlobalLaunchLock(
      () => {
        logger.info("launcher", "checking launch prerequisites");
        assertLaunchPrerequisites();
        // The verified digest is passed to the foreground supervisor generation so a source mutation
        // after this point cannot alter its first child.
        return options.dev
          ? undefined
          : (() => {
              readout?.begin("artifact", "checking for a verified build");
              const artifact = ensureStableFrizzArtifact(
                workspace.stateDir,
                sourceWorkspaceDir(),
                defaultArtifactRoot(),
                {
                  onProgress: (message) => {
                    logger.info("artifact", message);
                    readout?.detail("artifact", message.toLowerCase());
                  },
                }
              );
              assertArtifactHostCompatible(artifact);
              readout?.settle("artifact", "done", artifact.digest.slice(0, 12));
              return artifact;
            })();
      },
      () => {
        readout?.begin("server", "waiting for the machine-wide startup lock");
        logger.info("launcher", "waiting for the machine-wide startup lock");
        // This lock protects only machine-shared port allocation and initial supervisor startup.
        // Artifact publication handles same-digest winners independently of this critical section.
        return acquireGlobalLaunchLock(
          undefined,
          FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS
        );
      }
    );
    pinnedArtifact = sequenced.prepared;
    release = sequenced.release;
  } catch (error) {
    launchOwner.release();
    throw error;
  }
  try {
    // Another invocation may have completed while this one waited for the allocator lock.
    const after = await existingHealth();
    if (after.health && after.port) {
      await openOrPrint(after.port, true, slugPath());
      release();
      release = undefined;
      launchOwner.release();
      process.exit(0);
    }
    if (after.owner)
      throw new Error(
        `supervisor pid ${after.owner.pid} became unhealthy during launch; run frizz-dev --status`
      );

    const allocation = await allocatePort(
      options.port,
      readPreferredPort(workspace.stateDir),
      { host: bind.host, base: DEFAULT_DEV_PORT }
    );
    const port = allocation.port;
    portReservation = allocation.release;
    const ownedHealth = expectedOwnerHealth(
      target,
      readProjectLaunchOwner(workspace.stateDir)
    );
    readout?.begin("server", `starting on port ${port}`);
    logger.info("launcher", `starting the control plane on port ${port}`);
    const running = runSupervisor(port, launchOwner.token, pinnedArtifact?.digest);
    // Allocation is the only machine-shared step, so the machine-global lock ends HERE — the port
    // reservation above, not this lock, is what keeps `port` ours until the child listens on it.
    // Holding the lock across the health wait below is what made three repositories launched in quick
    // succession fail: that wait is progress-tracked, so one cold boot can legitimately hold on for
    // minutes (up to LAUNCH_HARD_TIMEOUT_MS) while every other repository's launcher gives up on the
    // lock after its own much shorter budget.
    release();
    release = undefined;
    // The forked control-plane child no longer writes to this TTY (its records go to the run log, and
    // to the terminal only under --debug), so the readout keeps repainting through the health wait
    // instead of standing down the moment the child starts talking.
    readout?.detail("server", "waiting for health");
    // Progress-tracked (see waitForWorkspace): the flat deadline made a slow-but-healthy boot — a big
    // board, or a busy machine — indistinguishable from a wedge. `running` still wins the race the
    // moment the in-process supervisor itself fails, so a real failure is reported immediately.
    await Promise.race([
      waitForWorkspace(port, ownedHealth, undefined, { stateDir: workspace.stateDir }),
      running,
    ]);
    // The child is listening now, so the port defends itself and the reservation has done its job. It
    // must NOT span the foreground server lifetime, or a stopped-but-unreleased claim would push the
    // next launch of this repository off its remembered port.
    portReservation();
    portReservation = undefined;
    // Settle the server step BEFORE handing off to the browser. Leaving it to `ready()` meant the
    // browser row showed a ✓ while the server row above it was still spinning — a later step
    // finishing before an earlier one, which reads as the display being wrong.
    readout?.settle("server", "done", `port ${port}`);
    // A COLD launch lands on this project's board too. This call passed no path from before boards had
    // slugs at all, so `/` — the project grid — was where the one command that definitely knows which
    // project you meant dropped you, every time it was the first to start the server.
    await openOrPrint(port, false, slugPath());
    // The normal launcher intentionally remains attached. Its SIGINT/SIGTERM handler is installed
    // by runSupervisor and stops only this workspace's UI control plane.
    await running;
  } finally {
    release?.();
    portReservation?.();
    launchOwner.release();
  }
} catch (error) {
  logger.error(
    "launcher",
    `startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
  );
  if (readout) {
    const where = readout.activeStep();
    readout.fail(
      `${where ? `${where.label.toLowerCase()}: ` : ""}${
        error instanceof Error ? error.message : String(error)
      }`,
      logger.file ?? undefined
    );
    process.exit(1);
  }
  fail(error);
}
