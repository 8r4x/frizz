import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { resolveClaudeExecutableAbsolute } from "./claude-broker-host.ts"

// The npm `.cmd` stub, verbatim from a real `npm i -g @anthropic-ai/claude-code` on Windows Server
// 2022 (claude 2.1.220). Its whole job is to call the native exe that ships inside the package.
const REAL_CMD_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join("\r\n")

function binDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-claude-bin-"))
  // POSIX npm symlinks the bare name to the JS entry; WINDOWS npm cannot, so it writes a shell script
  // by that name instead. Either way the bare name exists — which is exactly why the old scan was
  // fooled into returning it.
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nexec node cli.js \"$@\"\n", { mode: 0o755 })
  return dir
}

test("windows: the resolver follows the .cmd stub to the real exe, never the #!/bin/sh sibling", (t) => {
  if (process.platform !== "win32") return t.skip("windows-only resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const exeDir = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin")
  mkdirSync(exeDir, { recursive: true })
  writeFileSync(join(exeDir, "claude.exe"), "MZ")
  writeFileSync(join(dir, "claude.cmd"), REAL_CMD_SHIM)

  const resolved = resolveClaudeExecutableAbsolute(undefined, { PATH: dir })
  assert.equal(resolved, join(exeDir, "claude.exe"))
  assert.ok(!resolved.endsWith(`${delimiter}claude`), "must never hand the SDK the shell script")
})

test("windows: a real claude.exe on PATH wins outright, without reading any stub", (t) => {
  if (process.platform !== "win32") return t.skip("windows-only resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "claude.exe"), "MZ")
  // A stub pointing somewhere that does NOT exist: if the .exe did not win, this would resolve to
  // undefined and the scan would fall through, so the assertion below is load-bearing.
  writeFileSync(join(dir, "claude.cmd"), '"%dp0%\\nope\\missing.exe"   %*')
  assert.equal(resolveClaudeExecutableAbsolute(undefined, { PATH: dir }), join(dir, "claude.exe"))
})

test("windows: a bin dir holding ONLY the shell script is not a resolution", (t) => {
  if (process.platform !== "win32") return t.skip("windows-only resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // This is the state that shipped broken: the bare name is present and nothing else is. Returning it
  // handed the SDK a file Windows cannot execute, so every dispatch died before the handshake.
  assert.throws(() => resolveClaudeExecutableAbsolute(undefined, { PATH: dir }), /could not resolve/)
})

test("posix: the bare name on PATH still resolves, and an absolute bin is passed through", (t) => {
  if (process.platform === "win32") return t.skip("posix resolution path")
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(resolveClaudeExecutableAbsolute(undefined, { PATH: dir }), join(dir, "claude"))
  assert.equal(resolveClaudeExecutableAbsolute("/opt/claude/bin/claude", { PATH: dir }), "/opt/claude/bin/claude")
})

// This is the one that made the whole SERVER refuse to boot on Windows, not merely a dispatch.
// Windows environment names are case-insensitive and it spells this one `Path`; only `process.env`
// emulates that, so the plain object the bridge copies out of it has no `PATH` key at all and the
// resolver scanned an empty search path. Measured on Windows Server 2022 / node 26.7.0: with
// `process.env` it resolved claude 2.1.241; with `{...process.env}` it threw. The startup path raises
// that throw during context creation, so nothing on Windows started.
//
// Asserted on EVERY platform deliberately: the spelling is what is under test, not the OS, and a
// win32-only gate would leave the regression unpinned on the machines that actually run this suite.
test("the search path is found under any spelling of its name, not just PATH", (t) => {
  const dir = binDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const expected = process.platform === "win32" ? join(dir, "claude.exe") : join(dir, "claude")
  if (process.platform === "win32") writeFileSync(join(dir, "claude.exe"), "MZ")
  for (const spelling of ["PATH", "Path", "path"]) {
    assert.equal(
      resolveClaudeExecutableAbsolute(undefined, { [spelling]: dir }), expected,
      `a search path spelled ${spelling} must still resolve`,
    )
  }
})

test("an unresolvable name fails loudly rather than handing the SDK a bare name", () => {
  const empty = mkdtempSync(join(tmpdir(), "frizz-claude-empty-"))
  try {
    assert.throws(() => resolveClaudeExecutableAbsolute("definitely-not-installed", { PATH: empty }), /could not resolve/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
