import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  nodePtyHasNativeBinary, npmServerPackageInstaller, resolveNpmCli, serverGenerationLaunch, serverReleaseSpec, ServerReleaseStore,
  validateServerGeneration, type ServerCompatibility, type ServerPackageInstaller, type ServerReleaseSpec,
} from "./server-release.ts";

const baseline: ServerReleaseSpec = { package: "frizz-server", version: "1.0.0", protocol: 1, dataEpoch: 1 };
const epochTwo: ServerReleaseSpec = { ...baseline, version: "2.0.0", dataEpoch: 2 };
const epochTwoCompatibility: ServerCompatibility = { protocol: 1, dataEpoch: 2 };
const files = ["dist/dev-child.js", "dist/codex-app-server-daemon.js", "dist/claude-agent-broker.js", "web-dist/index.html", "runtime/board/index.mjs", "runtime/cc-worker/.claude-plugin/plugin.json"];
function fixture(prefix: string, spec: ServerReleaseSpec): string {
  const root = join(prefix, "node_modules", spec.package);
  for (const name of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), name);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: spec.package, version: spec.version, frizzServer: { protocol: spec.protocol, dataEpoch: spec.dataEpoch } }));
  return root;
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "frizz-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installs: string[] = [];
  const installer: ServerPackageInstaller = {
    async install(prefix, spec) { installs.push(spec.version); fixture(prefix, spec); },
    async latestVersion() { return "1.1.0"; },
  };
  const roots = { cache: join(root, "cache"), state: join(root, "state"), data: join(root, "data"), legacy: false };
  return { root, roots, installs, installer, store: new ServerReleaseStore(baseline, installer, roots) };
}

test("boot metadata rejects unknown protocol, data epoch and non-exact package versions", () => {
  assert.deepEqual(serverReleaseSpec({ frizzServer: baseline }), baseline);
  for (const patch of [{ protocol: 2 }, { dataEpoch: 2 }, { version: "latest" }, { package: "file:../../repo" }])
    assert.throws(() => serverReleaseSpec({ frizzServer: { ...baseline, ...patch } }));
});

test("a server that can boot but cannot dispatch either provider is rejected before selection", async (t) => {
  const { store } = setup(t);
  for (const file of ["dist/codex-app-server-daemon.js", "dist/claude-agent-broker.js"]) {
    const generation = await store.prepare("1.1.0");
    rmSync(join(generation.root, file));
    assert.throws(() => store.commit(generation), /ENOENT/);
    assert.equal(existsSync(store.selection), false);
  }
});

test("preparation is immutable and does not commit until the server is ready", async (t) => {
  const { store, installs, installer, roots } = setup(t);
  const first = await store.load();
  assert.equal(existsSync(store.selection), false);
  store.commit(first);
  const saved = readFileSync(store.selection, "utf8");
  const candidate = await store.prepare("1.1.0");
  assert.equal(readFileSync(store.selection, "utf8"), saved);
  assert.notEqual(first.root, candidate.root);
  assert.equal((await new ServerReleaseStore(baseline, installer, roots).load()).id, first.id);
  store.commit(candidate);
  assert.equal((await store.load()).id, candidate.id);
  assert.deepEqual(installs, ["1.0.0", "1.1.0"]);
  assert.equal(existsSync(first.entry), true, "old worker runtime must be retained");
  const launch = serverGenerationLaunch(candidate);
  assert.equal(launch.entry, candidate.entry);
  assert.equal(launch.environment.FRIZZ_STABLE_ARTIFACT, "npm:frizz-server@1.1.0");
  assert.equal(launch.environment.FRIZZ_WORKER_PLUGIN_DIR, join(candidate.root, "runtime/cc-worker"));
});

test("an interrupted or failed install leaves the active release and no partially selectable generation", async (t) => {
  const { store, installer } = setup(t);
  const first = await store.load();
  store.commit(first);
  installer.install = async (prefix, spec) => { fixture(prefix, spec); throw new Error("registry interrupted"); };
  await assert.rejects(store.prepare("1.1.0"), /registry interrupted/);
  assert.equal((await store.load()).id, first.id);
  assert.deepEqual(readdirSync(store.generations), [first.id]);
});

test("cache eviction reinstalls exactly the committed version, never the launcher's older default", async (t) => {
  const { store, installs } = setup(t);
  const current = await store.prepare("1.2.0");
  store.commit(current);
  rmSync(join(store.generations, current.id), { recursive: true });
  const restored = await store.load();
  assert.equal(restored.version, "1.2.0");
  assert.deepEqual(installs, ["1.2.0", "1.2.0"]);
  assert.notEqual(restored.id, current.id);
});

test("a newer shell stages its exact epoch generation before making its data boundary durable", async (t) => {
  const { installer, roots, installs, store: old } = setup(t);
  const oldGeneration = await old.load();
  old.commit(oldGeneration);

  const newer = new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility);
  const candidate = await newer.load();
  assert.equal(candidate.version, "2.0.0");

  // This is the crash window: no child has become ready and the old selection remains on disk, but
  // the candidate could have migrated data as soon as it is launched. The global marker must win.
  assert.deepEqual(JSON.parse(readFileSync(newer.compatibilityMarker, "utf8")), epochTwoCompatibility);
  await assert.rejects(() => old.load(), /newer launcher or a data migration/);
  assert.deepEqual(installs, ["1.0.0", "2.0.0"]);
});

test("failed epoch preparation never advances the marker and leaves the old shell bootable", async (t) => {
  const { installer, roots, store: old } = setup(t);
  const oldGeneration = await old.load();
  old.commit(oldGeneration);
  installer.install = async (prefix, spec) => {
    fixture(prefix, spec);
    throw new Error("epoch-two registry interruption");
  };

  const newer = new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility);
  await assert.rejects(() => newer.load(), /epoch-two registry interruption/);
  assert.deepEqual(JSON.parse(readFileSync(newer.compatibilityMarker, "utf8")), { protocol: 1, dataEpoch: 1 });
  assert.equal((await old.load()).id, oldGeneration.id);
});

test("an epoch-two committed selection reinstalls its exact version and never permits an epoch-one fallback", async (t) => {
  const { installer, roots, installs, store: old } = setup(t);
  const oldGeneration = await old.load();
  old.commit(oldGeneration);
  const newer = new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility);
  const selected = await newer.load();
  newer.commit(selected);
  rmSync(join(newer.generations, selected.id), { recursive: true });

  const restored = await new ServerReleaseStore(epochTwo, installer, roots, epochTwoCompatibility).load();
  assert.equal(restored.version, "2.0.0");
  assert.notEqual(restored.id, selected.id);
  await assert.rejects(() => old.load(), /newer launcher or a data migration/);
  assert.deepEqual(installs, ["1.0.0", "2.0.0", "2.0.0"]);
});

test("a malformed global compatibility marker fails closed for every package selection", async (t) => {
  const { store, roots } = setup(t);
  mkdirSync(dirname(store.compatibilityMarker), { recursive: true });
  writeFileSync(store.compatibilityMarker, "{");
  await assert.rejects(() => store.load(), /data compatibility marker/);

  const override = new ServerReleaseStore({ ...baseline, package: "frizz-server-preview" }, {
    async install(prefix, spec) { fixture(prefix, spec); },
    async latestVersion() { return "1.0.0"; },
  }, roots);
  await assert.rejects(() => override.load(), /data compatibility marker/);
});

test("corrupt, escaping and incompatible saved selections fail closed", async (t) => {
  const { store, installs } = setup(t);
  mkdirSync(dirname(store.selection), { recursive: true });
  for (const selected of ["{", JSON.stringify({ ...baseline, id: "../../outside" }), JSON.stringify({ ...baseline, id: randomUUID(), dataEpoch: 2 })]) {
    writeFileSync(store.selection, selected);
    await assert.rejects(store.load());
  }
  assert.deepEqual(installs, []);
});

test("incompatible candidate manifests are refused while the previous selection stays intact", async (t) => {
  const { store, installer } = setup(t);
  const first = await store.load();
  store.commit(first);
  installer.install = async (prefix, spec) => { fixture(prefix, { ...spec, dataEpoch: 2 }); };
  await assert.rejects(store.prepare("1.1.0"), /protocol\/data epoch is incompatible/);
  assert.equal((await store.load()).id, first.id);
});

test("missing or symlink-escaped runtime assets cannot become a generation", async (t) => {
  const { root } = setup(t);
  const packageRoot = fixture(root, baseline);
  rmSync(join(packageRoot, "web-dist/index.html"));
  assert.throws(() => validateServerGeneration(packageRoot, baseline, randomUUID()));
  const outside = join(root, "outside.html");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(packageRoot, "web-dist/index.html"));
  assert.throws(() => validateServerGeneration(packageRoot, baseline, randomUUID()), /escapes its package/);
});

test("concurrent preparations cannot overwrite each other's package files", async (t) => {
  const { store } = setup(t);
  const [a, b] = await Promise.all([store.prepare("1.1.0"), store.prepare("1.1.0")]);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.root, b.root);
  assert.equal(existsSync(a.entry) && existsSync(b.entry), true);
  assert.equal(existsSync(store.selection), false);
});

test("commit rejects generations owned by a different store", async (t) => {
  const a = setup(t);
  const b = setup(t);
  const generation = await a.store.load();
  assert.throws(() => b.store.commit(generation));
  assert.equal(existsSync(b.store.selection), false);
});

test("a failed pointer replacement preserves the previous committed selection", async (t) => {
  const { store } = setup(t);
  const first = await store.load();
  store.commit(first);
  const candidate = await store.prepare("1.1.0");
  // A broken destination is an actual filesystem failure, not a fake successful persistence call.
  const saved = readFileSync(store.selection, "utf8");
  rmSync(store.selection);
  mkdirSync(store.selection);
  assert.throws(() => store.commit(candidate));
  assert.equal(readdirSync(dirname(store.selection)).some((path) => path.endsWith(".tmp")), false);
  rmSync(store.selection, { recursive: true });
  writeFileSync(store.selection, saved);
  assert.equal((await store.load()).id, first.id);
});

test("npm is resolved beside Node including paths with spaces, without launching npm.cmd", async (t) => {
  const { root } = setup(t);
  const nodeDir = join(root, "Node with spaces");
  const cli = join(nodeDir, "node_modules/npm/bin/npm-cli.js");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "console.log('stub')");
  writeFileSync(join(nodeDir, "npm.cmd"), "exit /b 99");
  assert.equal(resolveNpmCli({ PATH: nodeDir }, join(nodeDir, "node.exe")), cli);
  assert.throws(() => resolveNpmCli({ PATH: "" }, join(root, "missing/node")), /npm was not found/);
});

test("the npm adapter executes a real JS child with isolated prefix and scripts disabled", async (t) => {
  const { root } = setup(t);
  const cli = join(root, "npm-cli.js");
  const captured = join(root, "captured.json");
  writeFileSync(cli, `require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})); console.log('"1.1.0"')`);
  const installer = npmServerPackageInstaller({ ...process.env, npm_execpath: cli, CAPTURE: captured });
  const prefix = join(root, "prefix with spaces & literal");
  mkdirSync(prefix);
  await installer.install(prefix, baseline);
  const { argv, cwd } = JSON.parse(readFileSync(captured, "utf8"));
  assert.equal(cwd, realpathSync(prefix));
  assert.deepEqual(argv.slice(0, 4), ["install", "--prefix", prefix, "--global=false"]);
  assert.equal(argv.includes("--ignore-scripts"), true);
  assert.equal(argv.at(-1), "frizz-server@1.0.0");
  assert.equal(await installer.latestVersion("frizz-server"), "1.1.0");
});

/** A node-pty package directory holding only `binaries` (paths relative to the package, each a pty.node). */
function fakePty(prefix: string, binaries: string[] = []): string {
  const pty = join(prefix, "node_modules", "node-pty");
  mkdirSync(pty, { recursive: true });
  // The prefix manifest `prepare` writes, as `install --save-exact` leaves it.
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ private: true, dependencies: { "frizz-server": "1.0.0" } }));
  writeFileSync(join(pty, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
  for (const binary of binaries) {
    mkdirSync(join(pty, binary), { recursive: true });
    writeFileSync(join(pty, binary, "pty.node"), "addon");
  }
  return pty;
}

test("node-pty's addon is found exactly where its own loader looks, per host", (t) => {
  const { root } = setup(t);
  // node-pty 1.1 published darwin and win32 prebuilds only: a Linux host has nothing to load.
  const published = fakePty(join(root, "published"), ["prebuilds/darwin-arm64", "prebuilds/darwin-x64", "prebuilds/win32-x64"]);
  assert.equal(nodePtyHasNativeBinary(published, "linux", "x64"), false);
  assert.equal(nodePtyHasNativeBinary(published, "darwin", "arm64"), true);
  assert.equal(nodePtyHasNativeBinary(published, "win32", "x64"), true);
  // A local build satisfies any host, as it does for node-pty's loader.
  assert.equal(nodePtyHasNativeBinary(fakePty(join(root, "built"), ["build/Release"]), "linux", "x64"), true);
  assert.equal(nodePtyHasNativeBinary(fakePty(join(root, "debug"), ["build/Debug"]), "linux", "arm64"), true);
  // An empty per-target directory is not an addon.
  const empty = fakePty(join(root, "empty"));
  mkdirSync(join(empty, "prebuilds", "linux-x64"), { recursive: true });
  assert.equal(nodePtyHasNativeBinary(empty, "linux", "x64"), false);
});

test("native binaries are ensured in staging before a new generation can be validated or selected", async (t) => {
  const { store, installer } = setup(t);
  const ensured: string[] = [];
  installer.ensureNativeBinaries = async (prefix) => {
    ensured.push(prefix);
    assert.equal(prefix.endsWith(".staging"), true, "repair runs before the generation is renamed into place");
  };
  const generation = await store.prepare("1.1.0");
  assert.equal(ensured.length, 1);
  assert.equal(generation.root.startsWith(realpathSync(ensured[0]!.replace(/\.staging$/, ""))), true);

  // A host that cannot build the addon never gets a selectable generation.
  installer.ensureNativeBinaries = async () => { throw new Error("no C++ toolchain"); };
  const before = readdirSync(store.generations).sort();
  await assert.rejects(store.prepare("1.2.0"), /no C\+\+ toolchain/);
  assert.deepEqual(readdirSync(store.generations).sort(), before, "no generation or staging directory survives");
});

test("an already-committed generation missing its addon is repaired in place on load", async (t) => {
  const { store, installer } = setup(t);
  const first = await store.load();
  store.commit(first);
  // The generation an older launcher staged: committed, valid, and unrepaired.
  const ensured: string[] = [];
  installer.ensureNativeBinaries = async (prefix) => { ensured.push(prefix); };
  const again = await store.load();
  assert.equal(again.id, first.id, "the committed generation is kept, not reinstalled");
  assert.deepEqual(ensured, [join(store.generations, first.id)]);

  // And a repair that fails is loud rather than launching a server whose terminal cannot open.
  installer.ensureNativeBinaries = async () => { throw new Error("could not build node-pty"); };
  await assert.rejects(store.load(), /could not build node-pty/);
});

/**
 * A stub npm that logs every invocation, and on `rebuild` optionally produces the addon a real build
 * would. Like npm 12, it skips a script the prefix manifest's `allowScripts` does not approve and
 * still exits 0.
 */
function stubNpm(root: string, build: boolean) {
  // resolveNpmCli honours npm_execpath only when it names an `npm-cli.js`; anything else silently
  // falls through to the REAL npm, which would make these assertions about the wrong program.
  const directory = join(root, `npm-${randomUUID()}`);
  mkdirSync(directory);
  const cli = join(directory, "npm-cli.js");
  const log = join(directory, "log.jsonl");
  writeFileSync(log, "");
  writeFileSync(cli, `
    const fs = require('node:fs'), path = require('node:path');
    const argv = process.argv.slice(2);
    fs.appendFileSync(process.env.LOG, JSON.stringify(argv) + '\\n');
    const prefix = argv[argv.indexOf('--prefix') + 1];
    if (argv[0] === 'rebuild' && JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8')).allowScripts?.['node-pty'] !== true) {
      console.error('npm warn rebuild 1 package had install scripts blocked because they are not covered by allowScripts.');
      process.exit(0);
    }
    if (argv[0] === 'rebuild' && ${build}) {
      const out = path.join(prefix, 'node_modules/node-pty/build/Release');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'pty.node'), 'addon');
    }
    if (argv[0] === 'rebuild' && !${build}) { console.error('gyp ERR! stack Error: not found: make'); process.exit(1); }
  `);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { installer: npmServerPackageInstaller({ ...process.env, npm_execpath: cli, LOG: log }), calls };
}

test("the npm adapter builds node-pty ONLY when this host has no addon, with that package's scripts alone", async (t) => {
  const { root } = setup(t);

  // Host already has a prebuild: nothing runs at all.
  const covered = join(root, "covered");
  fakePty(covered, [`prebuilds/${process.platform}-${process.arch}`]);
  const quiet = stubNpm(root, true);
  await quiet.installer.ensureNativeBinaries!(covered);
  assert.deepEqual(quiet.calls(), []);

  // No node-pty in the tree: not this step's failure to report.
  const absent = join(root, "absent");
  mkdirSync(absent);
  await quiet.installer.ensureNativeBinaries!(absent);
  assert.deepEqual(quiet.calls(), []);

  // No addon for this host (the Linux case): exactly one scoped rebuild, scripts explicitly allowed.
  const bare = join(root, "bare prefix & spaces");
  const pty = fakePty(bare, ["prebuilds/some-other-os"]);
  const building = stubNpm(root, true);
  await building.installer.ensureNativeBinaries!(bare);
  const calls = building.calls();
  assert.equal(calls.length, 1);
  const [argv] = calls as [string[]];
  assert.deepEqual(argv.slice(0, 5), ["rebuild", "node-pty", "--prefix", bare, "--global=false"]);
  assert.equal(argv.includes("--ignore-scripts=false"), true);
  assert.equal(argv.includes("--ignore-scripts"), false);
  assert.equal(nodePtyHasNativeBinary(pty), true);
  // npm's script policy approves node-pty alone, in the prefix manifest, which keeps everything else.
  assert.deepEqual(JSON.parse(readFileSync(join(bare, "package.json"), "utf8")), {
    private: true, dependencies: { "frizz-server": "1.0.0" }, allowScripts: { "node-pty": true },
  });

  // Idempotent: a second pass finds the addon and runs nothing.
  await building.installer.ensureNativeBinaries!(bare);
  assert.equal(building.calls().length, 1);
});

test("a failed node-pty build names the platform and the toolchain to install", async (t) => {
  const { root } = setup(t);
  const bare = join(root, "bare");
  fakePty(bare);
  const failing = stubNpm(root, false);
  await assert.rejects(failing.installer.ensureNativeBinaries!(bare), (error: Error) => {
    assert.match(error.message, new RegExp(`could not build node-pty for ${process.platform}-${process.arch}`));
    assert.match(error.message, /relaunch Frizz/);
    assert.match(error.message, /not found: make/, "npm's own output is carried through");
    return true;
  });
});
