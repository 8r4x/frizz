import assert from "node:assert/strict";
import { test } from "node:test";
import { stripWorkspaceDependencies } from "./publish-manifest.ts";

test("the published manifest drops pnpm workspace specifiers and keeps registry ones", () => {
  const { manifest, stripped } = stripWorkspaceDependencies({
    name: "frizz",
    dependencies: { "node-pty": "^1.1" },
    devDependencies: {
      "@frizz/server": "workspace:*",
      "@frizz/shared": "workspace:^",
      esbuild: "^0.25.0",
    },
  });
  assert.deepEqual(manifest.devDependencies, { esbuild: "^0.25.0" });
  assert.deepEqual(manifest.dependencies, { "node-pty": "^1.1" });
  assert.deepEqual(stripped, ["devDependencies/@frizz/server", "devDependencies/@frizz/shared"]);
});

test("a dependency field left empty is removed rather than published as an empty object", () => {
  const { manifest } = stripWorkspaceDependencies({
    name: "frizz",
    devDependencies: { "@frizz/server": "workspace:*" },
  });
  assert.equal("devDependencies" in manifest, false);
});

test("every dependency field is swept, not just devDependencies", () => {
  const { stripped } = stripWorkspaceDependencies({
    dependencies: { a: "workspace:*" },
    optionalDependencies: { b: "workspace:*" },
    peerDependencies: { c: "workspace:*" },
  });
  assert.deepEqual(stripped, ["dependencies/a", "optionalDependencies/b", "peerDependencies/c"]);
});

test("a manifest with no workspace specifiers is returned unchanged", () => {
  const original = { name: "frizz", devDependencies: { esbuild: "^0.25.0" } };
  const { manifest, stripped } = stripWorkspaceDependencies(original);
  assert.deepEqual(stripped, []);
  assert.deepEqual(manifest, original);
});

test("stripping never mutates the manifest it was handed", () => {
  const original = { devDependencies: { "@frizz/server": "workspace:*", esbuild: "^0.25.0" } };
  stripWorkspaceDependencies(original);
  assert.deepEqual(original.devDependencies, {
    "@frizz/server": "workspace:*",
    esbuild: "^0.25.0",
  });
});
