import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCliArgs } from "./launcher.ts";
import {
  PRODUCTION_PRINT_LAUNCHER_FLAG,
  PRODUCTION_REEXEC_FLAG,
  canReexecInPlace,
  handoffToRegistrySuccessor,
  npmRegistryReleaseAdapter,
  planRegistryUpdate,
  reexecIntoRegistrySuccessor,
  resolveNpmInvocation,
  resolveRegistrySuccessor,
  successorArgs,
  type RegistryReleaseAdapter,
  type RegistrySuccessor,
} from "./production-update.ts";

const execFileP = promisify(execFile);

const plan = { packageName: "frizz", currentVersion: "1.2.3", latestVersion: "1.3.0", packageSpec: "frizz@1.3.0" };
// A file that exists, standing in for the successor's launcher bundle.
const thisFile = fileURLToPath(import.meta.url);

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unrefCalls: number; unref(): void };
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls++; };
  return child;
}

test("registry update does nothing when the installed version is current", async () => {
  assert.equal(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.2.3" }), null);
});

test("registry update selects an immutable newer package spec", async () => {
  assert.deepEqual(await planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => "1.3.0" }), plan);
});

test("registry lookup failure leaves the healthy process untouched", async () => {
  await assert.rejects(() => planRegistryUpdate("frizz", "1.2.3", { latestVersion: async () => { throw new Error("offline"); } }), /offline/);
});

test("npm runs as node + npm-cli.js — the bare `npm` name is only a `.cmd` shim on Windows", () => {
  const node = join("/", "opt", "node", "bin", "node");
  const cli = join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const exists = (path: string) => path === cli;
  const rows: Array<{ name: string; env: NodeJS.ProcessEnv; execPath: string; exists: (path: string) => boolean; expected: ReturnType<typeof resolveNpmInvocation> }> = [
    { name: "npm_execpath names npm-cli.js", env: { npm_execpath: cli }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "an npx-cli.js hint resolves to the sibling npm-cli.js", env: { npm_execpath: join("/", "opt", "node", "lib", "node_modules", "npm", "bin", "npx-cli.js") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "a pnpm hint has no npm-cli.js beside it", env: { npm_execpath: join("/", "opt", "pnpm", "bin", "pnpm.cjs") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "no hint: the npm that ships with node (POSIX layout)", env: {}, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
    { name: "a stale hint that points nowhere is skipped", env: { npm_execpath: join("/", "gone", "npm-cli.js") }, execPath: node, exists, expected: { command: node, prefixArgs: [cli] } },
  ];
  const windowsNode = join("C:", "Program Files", "nodejs", "node.exe");
  const windowsCli = join("C:", "Program Files", "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  rows.push({ name: "no hint: the npm beside node.exe (Windows layout)", env: {}, execPath: windowsNode, exists: (path) => path === windowsCli, expected: { command: windowsNode, prefixArgs: [windowsCli] } });
  for (const row of rows) assert.deepEqual(resolveNpmInvocation(row.env, row.execPath, row.exists, "linux"), row.expected, row.name);
  // No script at all: POSIX keeps the bare command, Windows refuses (the bare name is a dead spawn there).
  assert.deepEqual(resolveNpmInvocation({}, node, () => false, "linux"), { command: "npm", prefixArgs: [] });
  assert.throws(() => resolveNpmInvocation({}, windowsNode, () => false, "win32"), /npm-cli\.js not found beside/);
});

test("the resolved npm invocation actually starts on this platform", async () => {
  // Pins the spawn, not the registry: before this, Windows failed with `spawn npm ENOENT` because the
  // bare name only reaches a `.cmd` shim there. `--version` is the cheapest thing npm answers offline.
  const npm = resolveNpmInvocation();
  const { stdout } = await execFileP(npm.command, [...npm.prefixArgs, "--version"], { encoding: "utf8" });
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/u);
});

test("the in-place re-exec is only taken where execve works: never on Windows, even though the function exists there", () => {
  const execve = () => {};
  assert.equal(canReexecInPlace("linux", execve), true);
  assert.equal(canReexecInPlace("darwin", execve), true);
  // Node 24 on Windows defines process.execve and throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM when called.
  assert.equal(canReexecInPlace("win32", execve), false);
  assert.equal(canReexecInPlace("linux", null), false);
});

test("the real spawnDetached starts a detached node script that outlives the call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-spawn-detached-"));
  try {
    const marker = join(dir, "started");
    const entry = join(dir, "entry.cjs");
    writeFileSync(entry, `require("node:fs").writeFileSync(process.argv[process.argv.length - 1], process.argv.slice(2).join(" "));`);
    // cwd is the system temp dir, not `dir`: Windows refuses to remove a directory that is still a
    // live process's working directory, and the child may outlive the assertion by a few ms.
    const child = npmRegistryReleaseAdapter.spawnDetached({ entry, args: ["--port", "1", marker], cwd: tmpdir(), env: process.env });
    child.unref();
    // Poll until the marker holds the full text: a read can land between the child's create and its
    // write, so a short or missing file is "not yet", and only the deadline is a failure.
    const expected = `--port 1 ${marker}`;
    const deadline = Date.now() + 10_000;
    let seen = "";
    while (Date.now() < deadline) {
      try { seen = readFileSync(marker, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (seen === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(seen, expected, "the spawned entry never wrote its marker");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The 2026-09-10 failure, pinned at the seam that produced it: the successor was started with the
// project directory as a positional argument, which parseCliArgs has refused since the singleton
// launch — so every registry update started a successor that died on its first line, unseen.
test("the successor's argv is one parseCliArgs accepts: the re-exec flag, the port, and no repository path", () => {
  const args = successorArgs(4917);
  assert.deepEqual(args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  const parsed = parseCliArgs(args.filter((arg) => arg !== PRODUCTION_REEXEC_FLAG));
  assert.equal(parsed.port, 4917);
});

test("resolving the successor installs it through npm exec and reads its launcher entry off stdout", async () => {
  let captured: Parameters<RegistryReleaseAdapter["npmExec"]>[0] | undefined;
  const successor = await resolveRegistrySuccessor(plan, { cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } }, {
    npmExec: async (request) => {
      captured = request;
      // npm may print its own lines first (a funding notice, a config warning); the entry is the last one.
      return { code: 0, signal: null, stdout: `npm warn Unknown project config "node-linker"\n${thisFile}\n`, stderr: "" };
    },
  });
  assert.equal(successor.entry, thisFile);
  assert.equal(successor.plan, plan);
  assert.equal(captured?.packageSpec, "frizz@1.3.0");
  // The invoked bin tracks the package name so a renamed release can't invoke a stale bin.
  assert.equal(captured?.bin, "frizz");
  assert.deepEqual(captured?.args, [PRODUCTION_PRINT_LAUNCHER_FLAG]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
});

test("a successor that npm cannot install or start fails the update BEFORE anything is drained, quoting stderr", async () => {
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 1, signal: null, stdout: "", stderr: "npm error 404 Not Found\nnpm error frizz@1.3.0 is not in this registry\n" }),
    }),
    /npm exec frizz@1\.3\.0 failed \(exit 1\): npm error 404 Not Found\nnpm error frizz@1\.3\.0 is not in this registry/,
  );
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 0, signal: null, stdout: "dist/frizz.js\n", stderr: "" }),
    }),
    /did not report its launcher entry/,
  );
  await assert.rejects(
    () => resolveRegistrySuccessor(plan, { cwd: "/repo", env: {} }, {
      npmExec: async () => ({ code: 0, signal: null, stdout: "/definitely/not/here/frizz.js\n", stderr: "" }),
    }),
    /did not report its launcher entry/,
  );
});

test("the in-place handoff execve's node onto the resolved entry with the lease and the release in the environment", () => {
  const successor: RegistrySuccessor = { plan, entry: thisFile };
  let captured: { file: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
  assert.throws(() =>
    reexecIntoRegistrySuccessor(successor, { port: 4917, env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } }, (file, args, env) => {
      captured = { file, args, env };
      throw new Error("execve stand-in");
    }),
  /execve stand-in/);
  assert.equal(captured?.file, process.execPath);
  assert.deepEqual(captured?.args, [process.execPath, thisFile, PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_PACKAGE, "frizz");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
});

test("the detached fallback starts the resolved entry, not another npm exec, and lets go of it", () => {
  const child = fakeChild();
  let captured: Parameters<RegistryReleaseAdapter["spawnDetached"]>[0] | undefined;
  handoffToRegistrySuccessor(
    { plan, entry: thisFile },
    { port: 4917, cwd: "/repo", env: { FRIZZ_LAUNCH_OWNER_TOKEN: "lease" } },
    { spawnDetached: (request) => { captured = request; return child as never; } },
  );
  assert.equal(captured?.entry, thisFile);
  assert.deepEqual(captured?.args, [PRODUCTION_REEXEC_FLAG, "--port", "4917"]);
  assert.equal(captured?.env.FRIZZ_LAUNCH_OWNER_TOKEN, "lease");
  assert.equal(captured?.env.FRIZZ_REGISTRY_VERSION, "1.3.0");
  assert.equal(child.unrefCalls, 1);
});
