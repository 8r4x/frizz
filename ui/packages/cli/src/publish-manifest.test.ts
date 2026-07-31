import assert from "node:assert/strict";
import { test } from "node:test";
import { stripWorkspaceDependencies } from "./publish-manifest.ts";

test("the published manifest drops pnpm workspace specifiers and keeps registry ones", () => {
  const { manifest, stripped } = stripWorkspaceDependencies({
    name: "frayui",
    dependencies: { "node-pty": "^1.1" },
    devDependencies: {
      "@fray-ui/server": "workspace:*",
      "@fray-ui/shared": "workspace:^",
      esbuild: "^0.25.0",
    },
  });
  assert.deepEqual(manifest.devDependencies, { esbuild: "^0.25.0" });
  assert.deepEqual(manifest.dependencies, { "node-pty": "^1.1" });
  assert.deepEqual(stripped, ["devDependencies/@fray-ui/server", "devDependencies/@fray-ui/shared"]);
});

test("a dependency field left empty is removed rather than published as an empty object", () => {
  const { manifest } = stripWorkspaceDependencies({
    name: "frayui",
    devDependencies: { "@fray-ui/server": "workspace:*" },
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
  const original = { name: "frayui", devDependencies: { esbuild: "^0.25.0" } };
  const { manifest, stripped } = stripWorkspaceDependencies(original);
  assert.deepEqual(stripped, []);
  assert.deepEqual(manifest, original);
});

test("stripping never mutates the manifest it was handed", () => {
  const original = { devDependencies: { "@fray-ui/server": "workspace:*", esbuild: "^0.25.0" } };
  stripWorkspaceDependencies(original);
  assert.deepEqual(original.devDependencies, {
    "@fray-ui/server": "workspace:*",
    esbuild: "^0.25.0",
  });
});
