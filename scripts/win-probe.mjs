// Windows readiness probe for the post-tmux-strip stack. Runs the REAL production functions on a real
// Windows host: the launch preflight and the three socket-path helpers.
import { claudeBrokerSocketPath } from "../packages/server/src/backend/claude-broker-host.ts"
import { codexAppServerSocketPath } from "../packages/server/src/backend/codex-app-server-host.ts"
import { nativeListenSocketPath } from "../packages/server/src/backend/codex-app-server-native.ts"

let fails = 0
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++ }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

console.log(`platform=${process.platform} arch=${process.arch} node=${process.version}`)
ok(process.platform === "win32", "running on a REAL win32 host")

// --- 1. The launch preflight no longer demands tmux (the headline claim of the strip) -------------
const { assertRequiredExecutables } = await import("../src/preflight.ts")
// Observe the REAL function: record every executable it probes for, with a probe that answers "only
// git exists" — i.e. exactly a Windows box, where tmux has no native build at all.
const asked = []
let threw = null
try { assertRequiredExecutables((name) => { asked.push(name); return name === "git" }) } catch (e) { threw = e }
ok(threw === null, `preflight PASSES on a host with only git — no tmux (probed: ${asked.join(", ")})`)
ok(!asked.includes("tmux"), "preflight never probes for tmux at all")
// Negative control: the gate must still FAIL when its one real requirement is missing, so the PASS
// above is evidence the gate works rather than evidence it was gutted.
let threwNoGit = null
try { assertRequiredExecutables(() => false) } catch (e) { threwNoGit = e }
ok(threwNoGit !== null, "negative control: preflight still REFUSES a host with no git")

// --- 2. Every socket path is a Windows named pipe, never a POSIX path -----------------------------
const sd = "C:\\Users\\nub\\state", sid = "abc123", pid_ = "proj1"
for (const [label, p] of [
  ["claude broker", claudeBrokerSocketPath(sd, sid)],
  ["codex daemon", codexAppServerSocketPath(sd, pid_)],
  ["codex native", nativeListenSocketPath(sd, pid_)],
]) {
  ok(p.startsWith("\\\\.\\pipe\\"), `${label} socket is a named pipe: ${p}`)
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
