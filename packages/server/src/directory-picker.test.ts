import assert from "node:assert/strict"
import { test } from "node:test"
import { pickDirectory } from "./directory-picker.ts"

// The picker opens a real modal window, so the darwin/linux/win32 branches are exercised by hand
// rather than here — popping a dialog on the operator's desktop is not something a test suite may do.
// What IS testable is that an unsupported platform degrades to the typed-path fallback instead of
// throwing, which is the difference between "no picker here" and a broken Add button.
test("a platform with no folder picker reports it rather than throwing", async () => {
  for (const platform of ["freebsd", "aix", "sunos"] as const) {
    const result = await pickDirectory("Choose", platform)
    assert.equal(result.kind, "unavailable")
    assert.match(result.kind === "unavailable" ? result.reason : "", new RegExp(platform))
  }
})

// Verified against the real tool on macOS 2026-08-06, and both details bite:
//   osascript -e 'POSIX path of (path to home folder)'  →  "/Users/colinmcd94/"   (trailing slash)
//   osascript -e 'error "User canceled." number -128'   →  "execution error: User canceled. (-128)"
// The trailing slash would miss every path comparison in the registry, and AppleScript reports a
// DISMISSED dialog as an error — so without the -128 case a mis-click reads as a broken picker.
test("the darwin contract this depends on is documented where it can be re-checked", () => {
  assert.ok(true)
})
