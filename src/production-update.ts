import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PRODUCTION_REEXEC_FLAG = "--_frizz-production-reexec";
/**
 * Print the absolute path of the launcher bundle that is running and exit 0. Internal: this is how
 * an OLDER launcher finds the entry of the release it resolved through npm, so it can execve into it
 * (keeping this pid and this terminal) instead of guessing where npm put the execution cache.
 */
export const PRODUCTION_PRINT_LAUNCHER_FLAG = "--_frizz-print-launcher";

export interface RegistryReleaseAdapter {
  latestVersion(packageName: string): Promise<string>;
  /**
   * Run one command through `npm exec --package=<spec>` TO COMPLETION and hand back what it wrote.
   * The explicit package spec makes npm resolve and install the release into its own execution
   * cache first, so this is also the install step — and the one place an install failure can be read.
   */
  npmExec(request: {
    packageSpec: string;
    /** Bin to invoke from the resolved package. Defaults to the package name (frizz). */
    bin: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
  /** Start a resolved successor entry as a detached process. The fallback where execve does not exist. */
  spawnDetached(request: { entry: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): ChildProcess;
}

export interface RegistryUpdatePlan {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  packageSpec: string;
}

/** A release npm has installed into an immutable execution cache, located by its own launcher bundle. */
export interface RegistrySuccessor {
  plan: RegistryUpdatePlan;
  /** Absolute path of the successor's launcher bundle (the file its `frizz` bin resolves to). */
  entry: string;
}

/**
 * Compare normal npm versions without bringing a runtime semver dependency into the launcher.
 * Unknown/non-semver versions deliberately never self-update: an operator can still run npx with
 * an explicit tag, but the browser button must fail closed rather than downgrade or guess.
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
    if (!match) return null;
    return { numeric: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let index = 0; index < left.numeric.length; index++) {
    const delta = left.numeric[index]! - right.numeric[index]!;
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export async function planRegistryUpdate(
  packageName: string,
  currentVersion: string,
  adapter: Pick<RegistryReleaseAdapter, "latestVersion">
): Promise<RegistryUpdatePlan | null> {
  const latestVersion = (await adapter.latestVersion(packageName)).trim();
  const comparison = compareReleaseVersions(currentVersion, latestVersion);
  if (comparison === null)
    throw new Error(`cannot safely compare installed Frizz version ${currentVersion} with registry version ${latestVersion}`);
  if (comparison >= 0) return null;
  return { packageName, currentVersion, latestVersion, packageSpec: `${packageName}@${latestVersion}` };
}

/**
 * The argv a successor is started with, after its entry. NO repository path: an internal launch
 * reads its pinned project out of the environment (`projectLaunchTargetFromEnvironment`), and
 * `parseCliArgs` REFUSES a positional path since the singleton (bc037f17) — "Frizz takes no
 * repository path". The handoff kept passing one anyway, so from that day every registry Update &
 * Restart started a successor that died on its first line, exit 1, into `stdio: "ignore"`, after the
 * launcher had already printed "taking over" and quit. Measured 2026-09-10 22:35: the npm debug log
 * for `npm exec --package=frizz@0.12.10` ends `verbose exit 1` four seconds in, no Frizz log was ever
 * created, and the operator found a dead board with a note saying it had updated.
 */
export function successorArgs(port: number): string[] {
  return [PRODUCTION_REEXEC_FLAG, "--port", String(port)];
}

/**
 * Ask npm for a separate, immutable execution cache holding the planned release, and locate its
 * launcher bundle. This never edits the package directory npx is currently executing, which might be
 * shared or deleted by npm while the durable supervisor is still live.
 *
 * Runs BEFORE the running board is drained: everything that can go wrong with the install — a
 * registry that is down, a native module that fails to build, a bin that will not start — surfaces
 * here as a failed update with the board still up, instead of after the old owner has already exited.
 */
export async function resolveRegistrySuccessor(
  plan: RegistryUpdatePlan,
  request: { cwd: string; env: NodeJS.ProcessEnv },
  adapter: Pick<RegistryReleaseAdapter, "npmExec">
): Promise<RegistrySuccessor> {
  const result = await adapter.npmExec({
    packageSpec: plan.packageSpec,
    // The published bin name tracks the package name (frizz). Never hardcode a stale bin here or
    // a renamed release would resolve the new package but invoke a bin that no longer exists.
    bin: plan.packageName,
    args: [PRODUCTION_PRINT_LAUNCHER_FLAG],
    cwd: request.cwd,
    env: request.env,
  });
  if (result.code !== 0) {
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    const tail = result.stderr.trim().split("\n").slice(-6).join("\n").trim();
    throw new Error(`npm exec ${plan.packageSpec} failed (${how})${tail ? `: ${tail}` : ""}`);
  }
  // The last non-empty line: npm itself may print above it (a funding notice, a config warning).
  const entry = result.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  if (!isAbsolute(entry) || !existsSync(entry))
    throw new Error(`${plan.packageSpec} did not report its launcher entry (got ${JSON.stringify(entry)})`);
  return { plan, entry };
}

/**
 * Replace this process with the successor: same pid, same terminal, same stdio, so ctrl-c still
 * stops the board and the readout keeps going. The environment must already carry the tokenized
 * project owner (`projectLaunchEnvironment`); the successor adopts that exact lease.
 */
export function reexecIntoRegistrySuccessor(
  successor: RegistrySuccessor,
  request: { port: number; env: NodeJS.ProcessEnv },
  execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => never = process.execve!.bind(process)
): never {
  return execve(process.execPath, [process.execPath, successor.entry, ...successorArgs(request.port)], {
    ...request.env,
    FRIZZ_REGISTRY_PACKAGE: successor.plan.packageName,
    FRIZZ_REGISTRY_VERSION: successor.plan.latestVersion,
  });
}

/**
 * Start the successor detached — the fallback for a runtime without `process.execve` (Windows).
 * This terminal is not handed to it: the launcher ends, and the board serves from a pid this
 * window can no longer signal. The caller has to say so.
 */
export function handoffToRegistrySuccessor(
  successor: RegistrySuccessor,
  request: { port: number; cwd: string; env: NodeJS.ProcessEnv },
  adapter: Pick<RegistryReleaseAdapter, "spawnDetached">
): void {
  const child = adapter.spawnDetached({
    entry: successor.entry,
    args: successorArgs(request.port),
    cwd: request.cwd,
    env: {
      ...request.env,
      FRIZZ_REGISTRY_PACKAGE: successor.plan.packageName,
      FRIZZ_REGISTRY_VERSION: successor.plan.latestVersion,
    },
  });
  child.once("error", () => {});
  child.unref();
}

export const npmRegistryReleaseAdapter: RegistryReleaseAdapter = {
  latestVersion(packageName) {
    return new Promise((resolveVersion, reject) => {
      execFile("npm", ["view", `${packageName}@latest`, "version", "--json"], { encoding: "utf8" }, (error, stdout) => {
        if (error) return reject(new Error(`could not check npm for ${packageName}: ${error.message}`));
        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolveVersion(typeof parsed === "string" ? parsed : String(parsed));
        } catch {
          resolveVersion(stdout.trim().replaceAll('"', ""));
        }
      });
    });
  },
  npmExec({ packageSpec, bin, args, cwd, env }) {
    return new Promise((settle) => {
      // The explicit package spec forces npm to resolve/install a new cache entry before running it.
      const child = spawn("npm", ["exec", "--yes", `--package=${packageSpec}`, "--", bin, ...args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => settle({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` }));
      child.once("close", (code, signal) => settle({ code, signal, stdout, stderr }));
    });
  },
  spawnDetached({ entry, args, cwd, env }) {
    return spawn(process.execPath, [entry, ...args], { cwd, env, detached: true, stdio: "ignore" });
  },
};
