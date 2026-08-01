import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  assertLaunchPrerequisites,
  assertRequiredExecutables,
  ensureNativeHelperPermissions,
  MINIMUM_NODE,
  NODE_API_AVAILABILITY,
  providerReadiness,
  SUPPORTED_NODE_LINES,
  supportedNodeRange,
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
    assertLaunchPrerequisites({ nodeVersion: "22.14.0", command: () => true })
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
    /Node\.js \^22\.14\.0 \|\| >=23\.6\.0 is required \(found 18\.20\.0\)/
  );
});

test("core launch preflight rejects Node 20, which better-sqlite3 ^13 no longer supports", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "20.19.0", command: () => true }),
    /Node\.js \^22\.14\.0 \|\| >=23\.6\.0 is required \(found 20\.19\.0\)/
  );
});

test("core launch preflight rejects an old 22.x minor below the floor", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "22.11.0", command: () => true }),
    /Node\.js \^22\.14\.0 \|\| >=23\.6\.0 is required \(found 22\.11\.0\)/
  );
});

test("core launch preflight gives an actionable error for a missing executable", () => {
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "22.14.0", command: (name) => name !== "tmux" }),
    /required executable `tmux` is not available on PATH; Fray uses tmux for its terminal panes and interactive provider logins\. Install tmux \(`brew install tmux` on macOS, `apt install tmux` on Debian\/Ubuntu\) and relaunch Fray/
  );
});

// The launchers probe for these BEFORE resolving a workspace, which is what makes the diagnosis
// eager: resolving one execs `git` and then reads the project's tmux socket, and each of those used
// to report the absence in its own unrelated vocabulary.
test("the eager executable probe names each missing tool and why Fray wants it", () => {
  assert.throws(
    () => assertRequiredExecutables((name) => name !== "git"),
    /required executable `git` is not available on PATH; Fray identifies a project by its Git repository\./
  );
  assert.throws(
    () => assertRequiredExecutables((name) => name !== "tmux"),
    /required executable `tmux` is not available on PATH; Fray uses tmux/
  );
  assert.doesNotThrow(() => assertRequiredExecutables(() => true));
});

// Node's floor is deliberately NOT part of the eager probe: `--stop`/`--status`/`promote` stay
// reachable for repair on a host whose Node is too old, and only a real launch enforces it.
test("the eager executable probe leaves the Node floor to the full prerequisite check", () => {
  assert.doesNotThrow(() => assertRequiredExecutables(() => true));
  assert.throws(
    () => assertLaunchPrerequisites({ nodeVersion: "20.19.0", command: () => true }),
    /Node\.js \^22\.14\.0 \|\| >=23\.6\.0 is required/
  );
});

// The floor users are TOLD about and the floor Fray enforces must be the same. They have drifted
// twice, in opposite directions: `>=26` against an enforced 22.12 (EBADENGINE about a floor nothing
// checked), then `>=22.12.0` against a runtime that segfaults there.
test("the published engines floor is exactly the floor the launcher enforces", () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
  ) as { engines?: { node?: string } };
  assert.equal(
    manifest.engines?.node,
    supportedNodeRange(),
    "package.json engines.node must mirror SUPPORTED_NODE_LINES"
  );
});

// Measured, not derived: `new Database(":memory:")` from the real published tarball segfaults on
// 22.0-22.13 and 23.0-23.5 and works from 22.14 and 23.6 up. Bisected over 38 installed Node releases
// against ONE install directory, so the Node binary was the only variable. A plain `>=22.14` floor
// would still advertise 23.0-23.5, where Fray dies before the board boots.
test("the Node floor tracks the versions better-sqlite3 was measured to survive", () => {
  for (const version of ["22.14.0", "22.23.1", "23.6.0", "23.11.0", "24.17.0", "25.9.0", "26.5.0"]) {
    assert.doesNotThrow(
      () => assertLaunchPrerequisites({ nodeVersion: version, command: () => true }),
      `${version} was measured to work`
    );
  }
  for (const version of ["20.11.0", "21.7.0", "22.0.0", "22.12.0", "22.13.0", "23.0.0", "23.5.0"]) {
    assert.throws(
      () => assertLaunchPrerequisites({ nodeVersion: version, command: () => true }),
      /is required/,
      `${version} segfaults and must be refused`
    );
  }
  assert.equal(supportedNodeRange(), "^22.14.0 || >=23.6.0");
  // MINIMUM_NODE stays the lowest supported release, for callers that want a single number.
  assert.deepEqual({ ...MINIMUM_NODE }, { major: 22, minor: 14 });
});

// The floor has now drifted TWICE, and both times a human number went stale against a dependency.
// So stop trusting the number: re-derive it from what better-sqlite3 actually builds against, every
// run. Its `engines` field says `>=22` and is simply wrong — `binding.gyp` builds with
// `NAPI_VERSION=10`, which exists only from Node 22.14 and 23.6, and an older Node does not reject the
// addon but CRASHES registering it (EXC_BAD_ACCESS in napi_module_register_by_symbol during DLOpen).
// When better-sqlite3 next raises NAPI_VERSION, this fails here instead of on a user's machine.
test("the Node floor still covers the Node-API version better-sqlite3 is built against", () => {
  const gyp = readFileSync(
    join(
      dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json")),
      "binding.gyp"
    ),
    "utf8"
  );
  const required = Number(/NAPI_VERSION=(\d+)/.exec(gyp)?.[1]);
  assert.ok(
    Number.isSafeInteger(required),
    "could not read NAPI_VERSION from better-sqlite3's binding.gyp"
  );
  const lines = NODE_API_AVAILABILITY[required];
  assert.ok(
    lines,
    `better-sqlite3 now needs Node-API ${required}, which NODE_API_AVAILABILITY does not describe. ` +
      `Add it from https://nodejs.org/api/n-api.html and re-measure SUPPORTED_NODE_LINES.`
  );
  assert.deepEqual(
    SUPPORTED_NODE_LINES.map((line) => `${line.major}.${line.minor}`),
    lines!.map((line) => `${line.major}.${line.minor}`),
    `Fray advertises Node releases that cannot load better-sqlite3's Node-API ${required} addon`
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
      nodeVersion: "22.14.0",
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
