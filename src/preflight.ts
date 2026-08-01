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
 * The Node releases Fray actually runs on, MEASURED rather than derived from dependency manifests.
 *
 * The derivation says 22.12: Vite ^8 wants `^20.19.0 || >=22.12.0`, better-sqlite3 ^13 says `>=22`,
 * and `import.meta.dirname` needs 20.11. Every one of those is a manifest claim, and on this platform
 * the manifests are wrong. Installing the real published tarball and constructing a single database —
 * `new Database(":memory:")` — SEGFAULTS (exit 139) on 22.0 through 22.13 and on 23.0 through 23.5,
 * and succeeds from 22.14 and 23.6 onward. Bisected across 38 installed Node releases against ONE
 * install directory, so the Node binary was the only variable; better-sqlite3 13.0.2 ships a single
 * N-API prebuild per platform, so the same bytes crash on one Node and work on the next.
 *
 * Hence a floor PER RELEASE LINE instead of one number: `>=22.14` alone would still advertise 23.0-23.5,
 * where Fray dies before the board ever boots. Anything newer than the highest line listed is assumed
 * good — 24, 25 and 26 were all verified clean.
 *
 * `package.json`'s `engines.node` mirrors this table and a test asserts they stay equal. They have
 * drifted twice now, in both directions: first `>=26` against an enforced 22.12 (an EBADENGINE warning
 * about a floor nothing checked), then `>=22.12.0` against a runtime that segfaults there. The
 * published package ships COMPILED JS, so the source workflow's Node is never the consumer's Node.
 */
export const SUPPORTED_NODE_LINES = [
  { major: 22, minor: 14 },
  { major: 23, minor: 6 },
] as const;

/** The lowest release overall, for the message and for anything that just wants one number. */
export const MINIMUM_NODE = SUPPORTED_NODE_LINES[0];

/** The `engines.node` range this table describes, so the manifest is never hand-maintained. */
export function supportedNodeRange(): string {
  const highest = SUPPORTED_NODE_LINES[SUPPORTED_NODE_LINES.length - 1]!;
  return SUPPORTED_NODE_LINES.map((line) =>
    line === highest
      ? `>=${line.major}.${line.minor}.0`
      : `^${line.major}.${line.minor}.0`
  ).join(" || ");
}

/** Is this Node one Fray is known to run on? See SUPPORTED_NODE_LINES for how "known" was decided. */
export function nodeVersionIsSupported(major: number, minor: number): boolean {
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return false;
  const line = SUPPORTED_NODE_LINES.find((entry) => entry.major === major);
  if (line) return minor >= line.minor;
  // Below every line we know about, or between two of them, is unsupported; above them all is fine.
  return major > SUPPORTED_NODE_LINES[SUPPORTED_NODE_LINES.length - 1]!.major;
}

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
  if (!nodeVersionIsSupported(major!, minor!))
    throw new Error(
      `Node.js ${supportedNodeRange()} is required (found ${version}); ` +
        `better-sqlite3 segfaults on older releases in each line, so Fray would crash on boot rather ` +
        `than misbehave. Install a newer Node release and relaunch Fray`
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
