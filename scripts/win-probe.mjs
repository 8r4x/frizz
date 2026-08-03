// Windows readiness probe for the post-tmux-strip stack. Runs the REAL production functions on a real
// Windows host: the launch preflight, the three socket-path helpers, and a live node-pty round trip
// through the rewritten login utility (the transport that replaced tmux).
import { createLoginUtility } from "../packages/server/src/login-utility.ts"
import { claudeBrokerSocketPath } from "../packages/server/src/backend/claude-broker-host.ts"
import { codexAppServerSocketPath } from "../packages/server/src/backend/codex-app-server-host.ts"
import { nativeListenSocketPath } from "../packages/server/src/backend/codex-app-server-native.ts"
import * as pty from "node-pty"

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

// --- 3. A REAL ConPTY round trip through the rewritten login transport ----------------------------
let spawnedPid = null
const util = createLoginUtility({
  cwd: process.env.USERPROFILE ?? "C:\\",
  spawnPty: (_f, _a, opts) => {
    const t = pty.spawn("cmd.exe", ["/c", "echo LOGIN-READY && pause"], opts)
    spawnedPid = t.pid
    return t
  },
})
const { attemptId } = util.start("claude")
await wait(1500)
ok(spawnedPid > 0 && alive(spawnedPid), `ConPTY spawned a real process (pid ${spawnedPid})`)
const a = util.attach(attemptId)
ok(!!a, "a viewer attaches to the ConPTY session")
await wait(800)
ok(a.replay().includes("LOGIN-READY"), "ConPTY output reaches the shared replay buffer")
const b = util.attach(attemptId)
ok(b.replay().includes("LOGIN-READY"), "a late viewer replays what it missed over ConPTY")
b.resize(100, 40)
ok(true, "resize against a real ConPTY did not throw")
b.close()
await wait(300)
ok(alive(spawnedPid), "one viewer closing leaves the ConPTY alive")
util.stop()
await wait(1200)
ok(!alive(spawnedPid), "stop() reaps the real ConPTY process — no orphan on Windows")

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
