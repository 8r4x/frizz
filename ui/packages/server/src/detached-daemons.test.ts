// These pin the packaging invariant that a detached daemon must be a REAL FILE at runtime. The
// end-to-end proof — that a promoted artifact actually ships each daemon and that node can load it
// from there — lives in packages/cli/src/artifacts.test.ts, because only a real build can show it.
import assert from "node:assert/strict"
import { test } from "node:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  DETACHED_DAEMON_ENTRIES,
  detachedDaemonOutputName,
  resolveDetachedDaemonEntry,
} from "./detached-daemons.ts"

const workspaceRoot = resolve(import.meta.dirname, "..", "..", "..")

test("every declared detached daemon entry exists in the source tree", () => {
  for (const entry of DETACHED_DAEMON_ENTRIES) {
    assert.ok(existsSync(join(workspaceRoot, entry)), `${entry} is missing — the build would emit nothing for it`)
  }
})

test("detached daemon output names strip the .ts and drop the directory", () => {
  assert.equal(detachedDaemonOutputName("packages/server/src/backend/codex-app-server-daemon.ts"), "codex-app-server-daemon.js")
  assert.equal(detachedDaemonOutputName("packages/server/src/session-broker-daemon.ts"), "session-broker-daemon.js")
})

test("the entry resolver prefers the bundled .js, falls back to source .ts, and names both when neither is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-daemon-entry-"))
  const callerUrl = pathToFileURL(join(dir, "index.js")).href

  // A promoted artifact: one bundle plus the daemons emitted beside it.
  assert.throws(
    () => resolveDetachedDaemonEntry(callerUrl, "codex-app-server-daemon"),
    /missing the codex-app-server-daemon entry — looked for .*codex-app-server-daemon\.js and .*codex-app-server-daemon\.ts/,
    "a missing daemon reads as a packaging bug, not a mystery",
  )

  writeFileSync(join(dir, "codex-app-server-daemon.ts"), "")
  assert.equal(resolveDetachedDaemonEntry(callerUrl, "codex-app-server-daemon"), join(dir, "codex-app-server-daemon.ts"))

  writeFileSync(join(dir, "codex-app-server-daemon.js"), "")
  assert.equal(resolveDetachedDaemonEntry(callerUrl, "codex-app-server-daemon"), join(dir, "codex-app-server-daemon.js"))
})
