import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudConfigPath,
  normalizeHostname,
  promptForCloudConfig,
  readCloudConfig,
  resolveTunnelConfigPath,
  writeCloudConfig,
} from "./cloud.ts";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "frizz-cloud-"));
}

test("a pasted URL, a trailing slash or a stray dot all resolve to the same hostname", () => {
  // People paste the address bar. Refusing that would be a pointless second question.
  for (const raw of ["colin.frizz.sh", "https://colin.frizz.sh", "https://colin.frizz.sh/", "COLIN.Frizz.SH", "colin.frizz.sh."]) {
    assert.equal(normalizeHostname(raw), "colin.frizz.sh", raw);
  }
  assert.equal(normalizeHostname("  https://colin.frizz.sh/board  "), "colin.frizz.sh");
});

test("something that is not a hostname is refused at the prompt, not at the 403", () => {
  // A bare word would produce `https://laptop`, which fails later as an opaque origin mismatch.
  for (const raw of ["", "   ", "laptop", "https://"]) {
    assert.throws(() => normalizeHostname(raw), /invalid hostname/, JSON.stringify(raw));
  }
});

test("the config round-trips, so the second run of --cloud asks nothing", () => {
  const home = tempHome();
  try {
    assert.equal(readCloudConfig(home), null, "no config means first run");
    writeCloudConfig({ hostname: "colin.frizz.sh", tunnel: "colin" }, home);
    assert.deepEqual(readCloudConfig(home), { hostname: "colin.frizz.sh", tunnel: "colin" });
    assert.ok(readFileSync(cloudConfigPath(home), "utf8").endsWith("\n"), "written as a normal text file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt or half-written config reads as absent rather than throwing", () => {
  // The failure mode this avoids is a launcher that cannot start at all because a JSON file got
  // truncated — falling back to the prompt is always recoverable.
  const home = tempHome();
  try {
    mkdirSync(join(home, ".frizz"), { recursive: true });
    for (const bad of ["", "{", "null", '{"hostname":"x.dev"}', '{"tunnel":"t"}', '{"hostname":"","tunnel":"t"}']) {
      writeFileSync(cloudConfigPath(home), bad);
      assert.equal(readCloudConfig(home), null, JSON.stringify(bad));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit cloudflared config wins; otherwise it is found or reported missing", () => {
  const home = tempHome();
  try {
    const base = { hostname: "colin.frizz.sh", tunnel: "colin" };
    assert.equal(resolveTunnelConfigPath(base, home), null, "absent means let cloudflared use its own default");

    mkdirSync(join(home, ".cloudflared"), { recursive: true });
    writeFileSync(join(home, ".cloudflared", "frizz.yml"), "tunnel: colin\n");
    assert.equal(resolveTunnelConfigPath(base, home), join(home, ".cloudflared", "frizz.yml"));

    assert.equal(resolveTunnelConfigPath({ ...base, config: "/somewhere/else.yml" }, home), "/somewhere/else.yml");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a --cloud launch with no terminal refuses rather than blocking on stdin forever", async () => {
  // Update & Restart re-execs the launcher with --cloud and no TTY. A prompt there would hang on a
  // stdin nobody can reach, and the board would never come back at all.
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    await assert.rejects(promptForCloudConfig(), /needs a saved hostname/);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
  }
});
