// Does the broker's REAL binary resolver pick something Windows can actually execute?
// No credentials needed: the failure mode under test is exec resolution (ENOENT / not-executable),
// which an UNAUTHENTICATED claude answers just as well as an authed one — a process that starts and
// then complains about auth has proven the exec path works.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveClaudeExecutableAbsolute } from "../packages/server/src/backend/claude-broker-host.ts"

let fails = 0
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++ }

const prefix = process.env.NPM_PREFIX
process.env.PATH = `${prefix};${process.env.PATH}`

console.log(`platform=${process.platform} arch=${process.arch}`)
console.log(`shims present: ${["claude", "claude.cmd", "claude.ps1"].filter((n) => existsSync(join(prefix, n))).join(", ")}`)

const resolved = resolveClaudeExecutableAbsolute(undefined, process.env)
console.log(`resolveClaudeExecutableAbsolute() -> ${resolved}`)

// The SDK spawns this path directly. Does Windows accept it?
const direct = spawnSync(resolved, ["--version"], { encoding: "utf8", windowsHide: true })
const directOk = !direct.error && direct.status === 0
console.log(`  spawn(resolved) -> ${direct.error ? direct.error.code : `exit ${direct.status}`} ${(direct.stdout || "").trim().slice(0, 40)}`)

// The differential control: the .cmd shim, which is what Windows actually wants.
const cmdPath = join(prefix, "claude.cmd")
const viaCmd = spawnSync(cmdPath, ["--version"], { encoding: "utf8", windowsHide: true, shell: true })
const cmdOk = !viaCmd.error && viaCmd.status === 0
console.log(`  spawn(claude.cmd) -> ${viaCmd.error ? viaCmd.error.code : `exit ${viaCmd.status}`} ${(viaCmd.stdout || "").trim().slice(0, 40)}`)

ok(cmdOk, "CONTROL: claude.cmd runs, so claude IS installed and runnable on this box")
ok(directOk, "the path the broker resolves is executable by Windows")
if (cmdOk && !directOk) {
  console.log("\nDIAGNOSIS: the resolver returned a path Windows cannot execute while a working shim")
  console.log("sits beside it. Every Claude dispatch on Windows dies before the SDK handshake.")
}
process.exit(fails === 0 ? 0 : 1)
