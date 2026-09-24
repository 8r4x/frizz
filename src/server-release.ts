import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { frizzPaths } from "@frizz/server/frizz-paths";

/** Bump the data epoch BEFORE introducing writes an older server cannot safely read. */
export const SERVER_PROTOCOL = 1;
export const SERVER_DATA_EPOCH = 1;

export interface ServerReleaseSpec {
  package: string;
  version: string;
  protocol: number;
  dataEpoch: number;
}

/** The protocol this shell can speak and the newest durable data it may open. */
export interface ServerCompatibility {
  protocol: number;
  dataEpoch: number;
}

export interface ServerGeneration extends ServerReleaseSpec {
  id: string;
  root: string;
  entry: string;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CURRENT_COMPATIBILITY: ServerCompatibility = { protocol: SERVER_PROTOCOL, dataEpoch: SERVER_DATA_EPOCH };

function assertSpecShape(spec: ServerReleaseSpec): void {
  if (typeof spec.package !== "string" || typeof spec.version !== "string" || !PACKAGE.test(spec.package) || !VERSION.test(spec.version))
    throw new Error("invalid exact Frizz server package/version");
  if (!Number.isSafeInteger(spec.protocol) || spec.protocol < 1 || !Number.isSafeInteger(spec.dataEpoch) || spec.dataEpoch < 1)
    throw new Error("invalid Frizz server protocol/data epoch");
}

function assertSpec(spec: ServerReleaseSpec, compatibility: ServerCompatibility = CURRENT_COMPATIBILITY): void {
  assertSpecShape(spec);
  if (spec.protocol !== compatibility.protocol || spec.dataEpoch !== compatibility.dataEpoch)
    throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
}

/** Fail closed: a missing/corrupt selection must never silently downgrade a migrated database. */
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Frizz server manifest");
  return value as Record<string, unknown>;
}

export function serverReleaseSpec(manifest: unknown, packageOverride?: string): ServerReleaseSpec {
  const metadata = record(record(manifest).frizzServer);
  const spec = {
    package: packageOverride ?? metadata.package,
    version: metadata.version,
    protocol: metadata.protocol,
    dataEpoch: metadata.dataEpoch,
  } as ServerReleaseSpec;
  assertSpec(spec);
  return spec;
}

function containedFile(root: string, name: string, directory = false): string {
  const path = realpathSync(join(root, name));
  const rel = relative(realpathSync(root), path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Frizz server artifact escapes its package: ${name}`);
  const stat = statSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`invalid Frizz server artifact: ${name}`);
  return path;
}

export function validateServerGeneration(
  root: string,
  spec: ServerReleaseSpec,
  id: string,
  compatibility: ServerCompatibility = CURRENT_COMPATIBILITY,
): ServerGeneration {
  assertSpec(spec, compatibility);
  if (!GENERATION.test(id)) throw new Error("invalid Frizz server generation id");
  const manifest = record(readJson(join(root, "package.json")));
  const metadata = record(manifest.frizzServer);
  if (manifest.name !== spec.package || manifest.version !== spec.version)
    throw new Error(`Frizz server install did not contain ${spec.package}@${spec.version}`);
  if (metadata.protocol !== spec.protocol || metadata.dataEpoch !== spec.dataEpoch)
    throw new Error("Frizz server protocol/data epoch is incompatible; the current server has not been stopped");
  const entry = containedFile(root, "dist/dev-child.js");
  // Protocol 1 includes both detached provider entries. Readiness alone does not exercise dispatch.
  containedFile(root, "dist/codex-app-server-daemon.js");
  containedFile(root, "dist/claude-agent-broker.js");
  containedFile(root, "web-dist/index.html");
  containedFile(root, "runtime/board/index.mjs");
  containedFile(root, "runtime/cc-worker/.claude-plugin/plugin.json");
  return { ...spec, id, root: realpathSync(root), entry };
}

export function serverGenerationLaunch(generation: ServerGeneration): { entry: string; environment: NodeJS.ProcessEnv } {
  return {
    entry: generation.entry,
    environment: {
      FRIZZ_STABLE_ARTIFACT: `npm:${generation.package}@${generation.version}`,
      FRIZZ_STABLE_WEB_DIST: join(generation.root, "web-dist"),
      FRIZZ_SCRIPTS_DIR: join(generation.root, "runtime/board"),
      FRIZZ_WORKER_PLUGIN_DIR: join(generation.root, "runtime/cc-worker"),
    },
  };
}

/** Resolve npm's JS entry, not npm.cmd: execFile must not invoke a shell (or its cd hooks). */
export function resolveNpmCli(env: NodeJS.ProcessEnv = process.env, executable = process.execPath): string {
  const candidates: string[] = [];
  if (env.npm_execpath?.endsWith("npm-cli.js")) candidates.push(env.npm_execpath);
  for (const directory of [dirname(executable), ...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)]) {
    candidates.push(join(directory, "node_modules/npm/bin/npm-cli.js"), join(directory, "../lib/node_modules/npm/bin/npm-cli.js"));
    try {
      const path = realpathSync(join(directory, "npm"));
      if (path.endsWith("npm-cli.js")) candidates.push(path);
    } catch { /* Not every PATH entry contains npm. */ }
  }
  const found = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (!found) throw new Error("npm was not found beside Node or on PATH; install Node with npm to install Frizz server releases");
  return resolve(found);
}

export interface ServerPackageInstaller {
  install(prefix: string, spec: ServerReleaseSpec): Promise<void>;
  latestVersion(packageName: string): Promise<string>;
  /**
   * Make the installed tree's native addons loadable on THIS host, after `install` or for a generation
   * an older launcher staged. Optional so a test double need not implement it; the npm adapter does.
   */
  ensureNativeBinaries?(prefix: string): Promise<void>;
}

/**
 * Does this node-pty directory hold an addon this host can load? Mirrors node-pty's own loader
 * (`lib/utils.js` `loadNativeModule`): a local build first, then the per-target prebuild.
 *
 * node-pty 1.1 published prebuilds for darwin and win32 ONLY. Elsewhere its `install` script compiles
 * one, and the install below never runs lifecycle scripts, so a Linux server generation had no
 * `pty.node` and every pty (the terminal, provider sign-in) died with "Failed to load native module:
 * pty.node". The pinned 1.2 beta adds glibc linux-x64 and linux-arm64 prebuilds; any other host still
 * needs the build. A musl host is not covered: node-pty's own install skips the build when the glibc
 * prebuild directory exists, and so does this check.
 */
export function nodePtyHasNativeBinary(packageDir: string, platform: string = process.platform, arch: string = process.arch): boolean {
  return ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]
    .some((directory) => existsSync(join(packageDir, directory, "pty.node")));
}

/**
 * A source build of node-pty on a slow box; the same ceiling production-update gives an npm exec that
 * may compile it. Far longer than a registry install needs, so it gets its own limit.
 */
const NATIVE_BUILD_TIMEOUT_MS = 10 * 60_000;

function nativeToolchainHint(platform: string = process.platform): string {
  if (platform === "linux")
    return "install a C++ toolchain (`sudo apt install -y python3 make g++` on Debian/Ubuntu/WSL, `sudo dnf install -y python3 make gcc-c++` on Fedora) and relaunch Frizz";
  if (platform === "darwin") return "install the Xcode command line tools (`xcode-select --install`) and relaunch Frizz";
  return "install Python 3 and the Visual Studio C++ build tools, then relaunch Frizz";
}

/**
 * npm's `allowScripts` policy gates a lifecycle script even when `--ignore-scripts=false` asks for it:
 * npm 12 skips an unapproved one and still exits 0, and npm 11 fails it under `strict-allow-scripts`.
 * `--allow-scripts` is refused in a project-scoped install, so the approval goes in the prefix's own
 * manifest, the one Frizz writes. Written here rather than at staging so a generation an older
 * launcher staged is approved before its repair too. npm 10 ignores the field.
 */
function approveNodePtyScripts(prefix: string): void {
  const path = join(prefix, "package.json");
  const manifest = record(readJson(path));
  const allowScripts = manifest.allowScripts === undefined ? {} : record(manifest.allowScripts);
  if (allowScripts["node-pty"] === true) return;
  writeFileSync(path, `${JSON.stringify({ ...manifest, allowScripts: { ...allowScripts, "node-pty": true } })}\n`, { mode: 0o600 });
}

export function npmServerPackageInstaller(env: NodeJS.ProcessEnv = process.env): ServerPackageInstaller {
  const run = (args: string[], cwd?: string, timeout = 180_000): Promise<string> => new Promise((resolveOutput, reject) => {
    let cli: string;
    try { cli = resolveNpmCli(env); } catch (error) { reject(error); return; }
    execFile(process.execPath, [cli, ...args], {
      env, cwd, encoding: "utf8", windowsHide: true, timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const tail = stderr.trim().split("\n").slice(-8).join("\n");
        reject(new Error(`Frizz server npm operation failed: ${tail || error.message}`));
      } else resolveOutput(stdout);
    });
  });
  return {
    async install(prefix, spec) {
      assertSpec(spec);
      // Never execute dependency lifecycle scripts, read the user's project manifest, or mutate a
      // global installation. node-pty's shipped helper is repaired inside the server generation, and
      // a host with no node-pty prebuild gets exactly node-pty's own build (ensureNativeBinaries).
      await run([
        "install", "--prefix", prefix, "--global=false", "--ignore-scripts", "--no-audit", "--no-fund",
        "--engine-strict", "--install-strategy=hoisted", "--include=optional", "--omit=dev", "--save-exact", `${spec.package}@${spec.version}`,
      ], prefix);
    },
    async ensureNativeBinaries(prefix) {
      const pty = join(prefix, "node_modules", "node-pty");
      // No node-pty at all is a different, louder failure; and a host with a prebuild needs nothing.
      if (!existsSync(join(pty, "package.json")) || nodePtyHasNativeBinary(pty)) return;
      // The ONE lifecycle script this installer runs, and only when the host has no prebuild: node-pty's
      // own `install` (check prebuilds, else node-gyp). `rebuild <name>` scopes it to that package, not
      // the tree; `--ignore-scripts=false` beats a user npmrc that disables scripts, which would
      // otherwise make this a silent no-op.
      approveNodePtyScripts(prefix);
      try {
        await run([
          "rebuild", "node-pty", "--prefix", prefix, "--global=false", "--ignore-scripts=false", "--no-audit", "--no-fund",
        ], prefix, NATIVE_BUILD_TIMEOUT_MS);
      } catch (error) {
        throw new Error(
          `Frizz could not build node-pty for ${process.platform}-${process.arch} (it publishes no prebuilt binary here); ` +
            `${nativeToolchainHint()}.\n${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!nodePtyHasNativeBinary(pty))
        throw new Error(`Frizz built node-pty but found no loadable pty.node for ${process.platform}-${process.arch}; ${nativeToolchainHint()}`);
    },
    async latestVersion(packageName) {
      if (!PACKAGE.test(packageName)) throw new Error("invalid Frizz server package name");
      const version: unknown = JSON.parse(await run(["view", `${packageName}@latest`, "version", "--json"]));
      if (typeof version !== "string" || !VERSION.test(version)) throw new Error("npm returned an invalid Frizz server version");
      return version;
    },
  };
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    // Windows cannot open a directory for fsync. The replacement itself is still atomic there.
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* Best effort directory durability on filesystems without directory fsync. */ }
  } finally { rmSync(temp, { force: true }); }
}

export class ServerReleaseStore {
  readonly generations: string;
  readonly selection: string;
  /** One global data marker: every package override opens the same Frizz databases. */
  readonly compatibilityMarker: string;
  constructor(
    readonly spec: ServerReleaseSpec,
    private installer: ServerPackageInstaller,
    private roots = frizzPaths(),
    readonly compatibility: ServerCompatibility = CURRENT_COMPATIBILITY,
  ) {
    assertSpec(spec, compatibility);
    const key = createHash("sha256").update(spec.package).digest("hex").slice(0, 16);
    this.generations = join(roots.cache, "server-releases", key);
    this.selection = join(roots.state, "server-releases", key, "active.json");
    this.compatibilityMarker = join(roots.state, "server-releases", "data-compatibility.json");
  }

  private packageRoot(id: string): string { return join(this.generations, id, "node_modules", this.spec.package); }

  private readCompatibilityMarker(): ServerCompatibility | undefined {
    if (!existsSync(this.compatibilityMarker)) return undefined;
    try {
      const marker = record(readJson(this.compatibilityMarker));
      const compatibility = { protocol: marker.protocol, dataEpoch: marker.dataEpoch } as ServerCompatibility;
      assertSpecShape({ package: this.spec.package, version: this.spec.version, ...compatibility });
      return compatibility;
    } catch {
      throw new Error("invalid saved Frizz server data compatibility marker; refusing to risk a data downgrade");
    }
  }

  private assertMarkerIsSupported(): void {
    const marker = this.readCompatibilityMarker();
    if (!marker) return;
    if (marker.protocol !== this.compatibility.protocol || marker.dataEpoch > this.compatibility.dataEpoch)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
  }

  /**
   * Advance the global epoch only after the exact replacement has been staged and validated, but
   * before handing it to the caller that can launch it. A crash before first boot must never let an
   * older shell reopen the database the candidate may already have migrated.
   */
  private markCompatibilityBeforeLaunch(): void {
    const marker = this.readCompatibilityMarker();
    if (marker?.protocol !== undefined && marker.protocol !== this.compatibility.protocol)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    if ((marker?.dataEpoch ?? 0) > this.compatibility.dataEpoch)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    if (marker?.dataEpoch === this.compatibility.dataEpoch) return;
    atomicJson(this.compatibilityMarker, this.compatibility);
  }

  private async prepareInitial(version: string): Promise<ServerGeneration> {
    const generation = await this.prepare(version);
    this.markCompatibilityBeforeLaunch();
    return generation;
  }

  async load(): Promise<ServerGeneration> {
    this.assertMarkerIsSupported();
    if (!existsSync(this.selection)) return this.prepareInitial(this.spec.version);
    const selected = record(readJson(this.selection));
    const spec = selected as unknown as ServerReleaseSpec;
    assertSpecShape(spec);
    if (spec.package !== this.spec.package || typeof selected.id !== "string" || !GENERATION.test(selected.id))
      throw new Error("invalid saved Frizz server selection; refusing to fall back to an older server");
    // A new shell knows its exact epoch-compatible default. Stage that generation before recording
    // the data boundary; an older shell can never select this old pointer again after the marker wins.
    if (spec.protocol !== this.compatibility.protocol)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    if (spec.dataEpoch < this.compatibility.dataEpoch) return this.prepareInitial(this.spec.version);
    if (spec.dataEpoch > this.compatibility.dataEpoch)
      throw new Error("this Frizz server requires a newer launcher or a data migration; restart with a compatible Frizz release");
    const root = this.packageRoot(selected.id);
    // Cache eviction is recoverable, but only by reinstalling the EXACT committed release.
    let generation: ServerGeneration;
    if (!existsSync(root)) generation = await this.prepare(spec.version);
    else {
      generation = validateServerGeneration(root, spec, selected.id, this.compatibility);
      // A generation staged by an older launcher on a host without a node-pty prebuild (all of Linux)
      // holds no loadable pty.node, and the committed pointer would keep selecting it forever. Repair
      // it in place: the step only ADDS the missing addon, so a worker already executing this
      // generation's files is unaffected.
      await this.installer.ensureNativeBinaries?.(join(this.generations, selected.id));
    }
    this.markCompatibilityBeforeLaunch();
    return generation;
  }

  async prepare(version: string): Promise<ServerGeneration> {
    const spec = { ...this.spec, version };
    assertSpec(spec, this.compatibility);
    mkdirSync(this.generations, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const staging = join(this.generations, `${id}.staging`);
    const destination = join(this.generations, id);
    mkdirSync(staging, { mode: 0o700 });
    try {
      // An explicit private manifest keeps npm from discovering a package in an ancestor directory.
      writeFileSync(join(staging, "package.json"), '{"private":true}\n', { mode: 0o600 });
      await this.installer.install(staging, spec);
      // Before validation and the rename: a generation that cannot open a pty is never selectable.
      await this.installer.ensureNativeBinaries?.(staging);
      validateServerGeneration(join(staging, "node_modules", spec.package), spec, id, this.compatibility);
      renameSync(staging, destination);
      return validateServerGeneration(this.packageRoot(id), spec, id, this.compatibility);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }

  commit(generation: ServerGeneration): void {
    if (generation.package !== this.spec.package || generation.root !== realpathSync(this.packageRoot(generation.id)))
      throw new Error("cannot select a Frizz server outside this release store");
    validateServerGeneration(generation.root, generation, generation.id, this.compatibility);
    const { package: packageName, version, protocol, dataEpoch, id } = generation;
    atomicJson(this.selection, { package: packageName, version, protocol, dataEpoch, id });
    // Old generations are intentionally retained: detached workers can still execute their files.
    // Neither npm cache cleanup nor a later update may remove a live worker's runtime closure.
  }
}
