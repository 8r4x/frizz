// REAL harness for the node-pty native repair (server-release.ts ensureNativeBinaries). No stubs: the
// real npm adapter installs a REAL frizz-server from the registry into a sandbox release store, then a
// REAL pty is spawned from that generation's own node-pty. Meaningful on a host WITHOUT a node-pty
// prebuild (Linux); on macOS/Windows the repair is a no-op and phase B has nothing to strip.
//
//   nub scripts/verify-linux-pty-generation.mjs [frizz-server version]
//
// Phase A: a fresh generation is loadable and opens a pty.
// Phase B: a committed generation staged by a launcher WITHOUT the fix (addon stripped) is proven
//          broken first — the negative control — then repaired in place by load() and opens a pty.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodePtyHasNativeBinary, npmServerPackageInstaller, ServerReleaseStore } from "../src/server-release.ts";

const version = process.argv[2] ?? "0.14.5";
const spec = { package: "frizz-server", version, protocol: 1, dataEpoch: 1 };
const root = mkdtempSync(join(tmpdir(), "frizz-pty-harness-"));
const roots = { cache: join(root, "cache"), state: join(root, "state"), data: join(root, "data"), legacy: false };

/** Load node-pty the way the generation's own server does: resolved from inside the generation. */
function openPty(generation) {
  const pty = createRequire(join(generation.root, "package.json"))("node-pty");
  return new Promise((resolve, reject) => {
    const child = pty.spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      process.platform === "win32" ? ["/c", "echo pty-ok"] : ["-c", "echo pty-ok"], {});
    let output = "";
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => exitCode === 0 ? resolve(output.trim()) : reject(new Error(`pty exited ${exitCode}`)));
  });
}

const ptyDir = (store, generation) => join(store.generations, generation.id, "node_modules", "node-pty");

try {
  console.log(`host ${process.platform}-${process.arch}, node ${process.version}, frizz-server@${version}`);

  // ---- Phase A: fresh install through the fixed store ----------------------------------------
  let started = Date.now();
  const store = new ServerReleaseStore(spec, npmServerPackageInstaller(), roots);
  const generation = await store.load();
  console.log(`A  staged generation ${generation.id} in ${Date.now() - started}ms`);
  assert.equal(nodePtyHasNativeBinary(ptyDir(store, generation)), true, "fresh generation must carry a loadable addon");
  assert.equal(await openPty(generation), "pty-ok");
  console.log("A  real pty from the fresh generation: pty-ok");
  store.commit(generation);

  // ---- Phase B: the generation an unfixed launcher leaves behind ------------------------------
  const built = join(ptyDir(store, generation), "build");
  if (!existsSync(built)) {
    console.log("B  skipped: this host loads a shipped prebuild, so no older launcher left anything to repair");
  } else {
    rmSync(built, { recursive: true, force: true });
    assert.equal(nodePtyHasNativeBinary(ptyDir(store, generation)), false);
    // Negative control: in a FRESH process (require caches the addon in this one) the stripped
    // generation fails exactly as users see it.
    const { execFileSync } = await import("node:child_process");
    let failure = "";
    try {
      execFileSync(process.execPath, ["-e", `require(${JSON.stringify(ptyDir(store, generation))})`], { stdio: "pipe" });
    } catch (error) { failure = String(error.stderr ?? error); }
    assert.match(failure, /Failed to load native module: pty\.node/, "negative control must reproduce the user's error");
    console.log("B  negative control reproduced: Failed to load native module: pty.node");

    started = Date.now();
    const reopened = await new ServerReleaseStore(spec, npmServerPackageInstaller(), roots).load();
    assert.equal(reopened.id, generation.id, "the committed generation is repaired in place, not replaced");
    assert.equal(nodePtyHasNativeBinary(ptyDir(store, reopened)), true);
    console.log(`B  load() repaired generation ${reopened.id} in ${Date.now() - started}ms`);
    const { execFileSync: run } = await import("node:child_process");
    const out = run(process.execPath, ["-e", `
      const pty = require(${JSON.stringify(ptyDir(store, reopened))});
      const p = pty.spawn('/bin/sh', ['-c', 'echo pty-ok'], {});
      let o = ''; p.onData(d => o += d); p.onExit(({ exitCode }) => { console.log(o.trim()); process.exit(exitCode); });
    `], { encoding: "utf8" }).trim();
    assert.equal(out, "pty-ok");
    console.log("B  real pty from the repaired generation (fresh process): pty-ok");
  }
  console.log("PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
