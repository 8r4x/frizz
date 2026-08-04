import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bundleNameMatchesManifest,
  defaultBrowserOpenCommand,
  launchBrowserTab,
} from "./browser.ts"

test("default browser launch uses each platform's shell-free URL handler", () => {
  const url = "http://127.0.0.1:4917"
  assert.deepEqual(defaultBrowserOpenCommand(url, "darwin"), {
    command: "/usr/bin/open",
    args: ["http://127.0.0.1:4917/"],
  })
  assert.deepEqual(defaultBrowserOpenCommand(url, "linux"), {
    command: "xdg-open",
    args: ["http://127.0.0.1:4917/"],
  })
  assert.deepEqual(defaultBrowserOpenCommand(url, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4917/"],
  })
})

test("default browser launch accepts only absolute http(s) URLs", () => {
  assert.deepEqual(defaultBrowserOpenCommand("https://example.com/path?a=1", "darwin"), {
    command: "/usr/bin/open",
    args: ["https://example.com/path?a=1"],
  })
  assert.throws(() => defaultBrowserOpenCommand("not a URL", "darwin"), /invalid browser URL/)
  assert.throws(() => defaultBrowserOpenCommand("file:///tmp/frizz", "darwin"), /unsupported browser URL scheme/)
  assert.throws(() => defaultBrowserOpenCommand("https://example.com", "aix"), /not supported/)
})

test("macOS makes exactly one awaited standard default-browser request", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  let accepted = false
  await launchBrowserTab("http://127.0.0.1:4917", {
    platform: "darwin",
    runCommand: async (command, args) => {
      calls.push({ command, args })
      accepted = true
      return ""
    },
  })

  assert.equal(accepted, true)
  assert.deepEqual(calls, [{
    command: "/usr/bin/open",
    args: ["http://127.0.0.1:4917/"],
  }])
})

test("browser launch reports OS-handler rejection", async () => {
  await assert.rejects(
    launchBrowserTab("http://127.0.0.1:4917", {
      platform: "darwin",
      runCommand: async () => { throw new Error("open failed") },
    }),
    /open failed/,
  )
})

test("non-macOS launch waits for the platform URL handler before reporting success", async () => {
  let completed = false
  await launchBrowserTab("http://127.0.0.1:4917", {
    platform: "linux",
    runCommand: async (command, args) => {
      assert.equal(command, "xdg-open")
      assert.deepEqual(args, ["http://127.0.0.1:4917/"])
      completed = true
      return ""
    },
  })
  assert.equal(completed, true)
})

test("a Chrome-disambiguated shim bundle is the same app, not a stale one", () => {
  // Chrome appends " 1", " 2", … when the bundle filename already exists, and that is the COMMON
  // case: manifestIdFor is origin-scoped, so every project's port installs its own bundle. Rejecting
  // the suffix made every project after the first reinstall its shim on each --app launch, which is
  // how a real machine ended up with Frizz.app, Frizz 1.app, Frizz 2.app and Frizz 3.app.
  assert.equal(bundleNameMatchesManifest("Frizz"), true)
  assert.equal(bundleNameMatchesManifest("Frizz 1"), true)
  assert.equal(bundleNameMatchesManifest("Frizz 42"), true)

  // A genuine rename must still read as stale so the bundle gets reinstalled under the new name.
  assert.equal(bundleNameMatchesManifest("Frizzed"), false)
  assert.equal(bundleNameMatchesManifest("Frizz Board"), false)
  assert.equal(bundleNameMatchesManifest("Frizz "), false)
  assert.equal(bundleNameMatchesManifest("Frizz 1x"), false)
  assert.equal(bundleNameMatchesManifest(""), false)
})
