import { spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface CommandProbe {
  (command: string): boolean;
}

export interface LaunchPrerequisiteOptions {
  nodeVersion?: string;
  command?: CommandProbe;
}

/**
 * The lowest Node the runtime dependencies actually support, derived (not guessed) from what the
 * launch chain loads and runs:
 *   - the artifact build runs Vite ^8 on the user's own machine, engines `^20.19.0 || >=22.12.0`;
 *   - the runtime links better-sqlite3 ^13, engines `>=22` (v13 moved to the N-API and dropped 20);
 *   - the runtime uses `import.meta.dirname`, available since Node 20.11.
 * better-sqlite3 rules out Vite's 20.19 branch, so 22.12 is the tightest of these. Revisit this
 * constant when those dependency floors move.
 */
const MINIMUM_NODE = { major: 22, minor: 12 } as const;

export interface ProviderReadiness {
  claude: boolean;
  codex: boolean;
}

/**
 * The executables every Fray launch shells out to, with the reason each one is needed. Both are
 * reached before any prerequisite check used to run — `resolveWorkspace` execs `git rev-parse` and
 * then resolves the project's tmux socket — so a machine missing either was diagnosed by whichever
 * caller happened to fail first, in that caller's vocabulary. A missing `git` reported "fray-dev
 * must be run inside a Git repository"; a missing `tmux` reported the project's own `fray.id` as
 * duplicate or corrupt. Say what is actually wrong, and say it before the work starts.
 */
const REQUIRED_EXECUTABLES = [
  { name: "git", need: "Fray identifies a project by its Git repository" },
  { name: "tmux", need: "Fray uses tmux for its terminal panes and interactive provider logins" },
] as const;

export function assertRequiredExecutables(command: CommandProbe = commandIsAvailable): void {
  for (const { name, need } of REQUIRED_EXECUTABLES) {
    if (command(name)) continue;
    throw new Error(
      `required executable \`${name}\` is not available on PATH; ${need}. ` +
        `Install ${name} (\`brew install ${name}\` on macOS, \`apt install ${name}\` on Debian/Ubuntu) ` +
        `and relaunch Fray`
    );
  }
}

export function commandIsAvailable(command: string): boolean {
  // `tmux --version` is not portable (macOS tmux accepts `-V` instead), so keep the probe
  // executable-specific while avoiding a shell and any persistent side effects.
  const versionArg = command === "tmux" ? "-V" : "--version";
  const result = spawnSync(command, [versionArg], {
    stdio: "ignore",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/**
 * Prerequisites shared by every local Fray launch. Provider CLIs are deliberately not included:
 * a workstation may use one backend while the other is unavailable.
 *
 * The Node floor here is a genuine minimum, not a proxy for the older Node-26 gate: it is the lowest
 * version Fray's build toolchain and native modules support (see `MINIMUM_NODE`). It is complementary
 * to `assertArtifactHostCompatible`, which only enforces that a reused artifact's Node major equals
 * the host's — that equality check cannot catch a host whose Node is simply below what the
 * dependencies need, which is precisely what this floor reports cleanly.
 */
export function assertLaunchPrerequisites(
  options: LaunchPrerequisiteOptions = {}
): void {
  const version = options.nodeVersion ?? process.versions.node;
  const [major, minor] = version.split(".").map(Number);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major < MINIMUM_NODE.major ||
    (major === MINIMUM_NODE.major && minor < MINIMUM_NODE.minor)
  )
    throw new Error(
      `Node.js ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer is required (found ${version}); ` +
        `Fray's build (Vite) and native modules (better-sqlite3) do not support older Node. ` +
        `Install a newer Node release and relaunch Fray`
    );
  assertRequiredExecutables(options.command ?? commandIsAvailable);
}

export interface NativeHelperOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Resolves node-pty's package.json; injectable so the repair is testable without the real module. */
  resolvePty?: () => string;
  stat?: (path: string) => { mode: number };
  chmod?: (path: string, mode: number) => void;
}

/**
 * Mark node-pty's `spawn-helper` executable when the install left it unreadable-as-a-program.
 *
 * node-pty ships prebuilt `spawn-helper` binaries and relies on its own `post-install` script to set
 * the executable bit. npm 11 blocks dependency install scripts by default (`allow-scripts`), so a
 * plain `npm i frayui` — and `npx frayui`, which installs the same way — leaves the helper at 0644
 * and EVERY pty spawn dies with `posix_spawnp failed.`: no terminal panes and no agent sessions at
 * all. The source checkout hides this because `@fray-ui/server` carries a postinstall that chmods it;
 * the registry package cannot rely on a script npm may refuse to run, so the launcher repairs the bit
 * itself before anything spawns a pty. Idempotent, best-effort, and a no-op on Windows (conpty has no
 * helper) — a failure here is left for the pty spawn itself to report.
 */
export function ensureNativeHelperPermissions(options: NativeHelperOptions = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return;
  const stat = options.stat ?? ((path: string) => statSync(path));
  const chmod = options.chmod ?? ((path: string, mode: number) => chmodSync(path, mode));
  const resolvePty =
    options.resolvePty ?? (() => createRequire(import.meta.url).resolve("node-pty/package.json"));
  try {
    const helper = join(
      dirname(resolvePty()),
      "prebuilds",
      `${platform}-${options.arch ?? process.arch}`,
      "spawn-helper"
    );
    const mode = stat(helper).mode;
    if ((mode & 0o111) === 0o111) return;
    chmod(helper, mode | 0o755);
  } catch {
    // node-pty resolved elsewhere, or the helper is missing/read-only. Nothing actionable here.
  }
}

/** Non-blocking provider capability snapshot for callers that can selectively expose backends. */
export function providerReadiness(
  command: CommandProbe = commandIsAvailable
): ProviderReadiness {
  return { claude: command("claude"), codex: command("codex") };
}
