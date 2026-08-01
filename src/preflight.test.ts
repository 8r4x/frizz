import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLaunchPrerequisites,
  ensureNativeHelperPermissions,
  providerReadiness,
} from "./preflight.ts";

/** A node-pty layout whose spawn-helper carries `mode`, plus the chmod calls the repair makes. */
function ptyInstall(mode: number, platform: NodeJS.Platform = "darwin") {
  const helper = `/pkg/node_modules/node-pty/prebuilds/${platform}-arm64/spawn-helper`;
  const chmods: Array<[string, number]> = [];
  return {
    helper,
    chmods,
    options: {
      platform,
      arch: "arm64",
      resolvePty: () => "/pkg/node_modules/node-pty/package.json",
      stat: (path: string) => {
        if (path !== helper) throw new Error(`unexpected stat of ${path}`);
        return { mode };
      },
      chmod: (path: string, next: number) => chmods.push([path, next]),
    },
  };
}

test("core launch preflight accepts a supported Node host with git and tmux", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ nodeVersion: "22.12.0", command: () => true })
  );
});

test("core launch preflight accepts newer Node majors", () => {
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({ nodeVersion: "26.0.0", command: () => true })
  );
});

test("core launch preflight rejects a Node host below the dependency floor", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "18.20.0", command: () => true }),
    /Node\.js 22\.12 or newer is required \(found 18\.20\.0\)/
  );
});

test("core launch preflight rejects Node 20, which better-sqlite3 ^13 no longer supports", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "20.19.0", command: () => true }),
    /Node\.js 22\.12 or newer is required \(found 20\.19\.0\)/
  );
});

test("core launch preflight rejects an old 22.x minor below the floor", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "22.11.0", command: () => true }),
    /Node\.js 22\.12 or newer is required \(found 22\.11\.0\)/
  );
});

test("core launch preflight gives an actionable error for a missing executable", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "22.12.0", command: (name) => name !== "tmux" }),
    /required executable `tmux` is not available on PATH; install tmux and relaunch Fray/
  );
});

test("provider readiness disables only the unavailable backend and never requires gh", () => {
  const seen: string[] = [];
  const readiness = providerReadiness((name) => {
    seen.push(name);
    return name === "codex";
  });
  assert.deepEqual(readiness, { claude: false, codex: true });
  assert.deepEqual(seen, ["claude", "codex"]);
  assert.doesNotThrow(() =>
    assertLaunchPrerequisites({
      nodeVersion: "22.12.0",
      command: (name) => name === "git" || name === "tmux",
    })
  );
});

test("a registry install that skipped node-pty's post-install gets its spawn-helper made executable", () => {
  // 0o644 is exactly what `npm i frayui` leaves behind under npm 11's allow-scripts gate; every pty
  // spawn fails with `posix_spawnp failed.` until the bit is set.
  const install = ptyInstall(0o100644);
  ensureNativeHelperPermissions(install.options);
  assert.deepEqual(install.chmods, [[install.helper, 0o100644 | 0o755]]);
});

test("an already-executable spawn-helper is left untouched", () => {
  const install = ptyInstall(0o100755);
  ensureNativeHelperPermissions(install.options);
  assert.deepEqual(install.chmods, []);
});

test("the spawn-helper repair is skipped on Windows, which has no helper binary", () => {
  const install = ptyInstall(0o100644, "win32");
  ensureNativeHelperPermissions({
    ...install.options,
    stat: () => assert.fail("Windows must not probe for a spawn-helper"),
  });
  assert.deepEqual(install.chmods, []);
});

test("an unresolvable node-pty never breaks launch", () => {
  const chmods: string[] = [];
  assert.doesNotThrow(() =>
    ensureNativeHelperPermissions({
      platform: "linux",
      arch: "x64",
      resolvePty: () => {
        throw new Error("Cannot find module 'node-pty/package.json'");
      },
      chmod: (path) => chmods.push(path),
    })
  );
  assert.deepEqual(chmods, []);
});
