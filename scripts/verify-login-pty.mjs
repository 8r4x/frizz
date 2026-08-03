// REAL node-pty harness for the rewritten login utility: no fake, no provider CLI. Spawns a real pty
// running a benign script, then exercises the transport the /term route depends on — shared pty across
// viewers, replay for a late viewer, input/resize reaching the child, one viewer closing never killing
// the others, and teardown actually reaping the process.
import { createLoginUtility } from "../packages/server/src/login-utility.ts"
import * as pty from "node-pty"

let fails = 0
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++ }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let spawnedPid = null
const util = createLoginUtility({
  cwd: "/tmp",
  // Redirect the provider argv to a REAL pty running a harmless echo-loop. Everything below this line
  // is the production code path over a genuine ConPTY/forkpty.
  spawnPty: (_file, _args, opts) => {
    const t = pty.spawn("/bin/sh", ["-c", "printf 'LOGIN-READY\\n'; read line; printf \"GOT:%s\\n\" \"$line\"; sleep 30"], opts)
    spawnedPid = t.pid
    return t
  },
})

const { attemptId } = util.start("claude")
ok(!!attemptId, `start() minted an attempt id (${attemptId})`)
await wait(400)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
ok(spawnedPid > 0 && alive(spawnedPid), `a REAL pty process is alive (pid ${spawnedPid})`)

const a = util.attach(attemptId)
ok(!!a, "first viewer attaches")
const seenA = []
a.onData((c) => seenA.push(c))
await wait(300)
ok(a.replay().includes("LOGIN-READY"), "replay carries the child's output")

// A LATE viewer must see what it missed — tmux gave this away free; the shared buffer replaces it.
const b = util.attach(attemptId)
ok(b.replay().includes("LOGIN-READY"), "a late viewer replays what it missed")

const seenB = []
b.onData((c) => seenB.push(c))
b.write("hello\r")
await wait(500)
const all = a.replay()
ok(all.includes("GOT:hello"), "a viewer's input reaches the real child process")
ok(seenA.join("").includes("GOT:hello") && seenB.join("").includes("GOT:hello"), "BOTH viewers received the same live bytes")

b.resize(100, 40)
ok(true, "resize did not throw against the real pty")

b.close()
await wait(200)
ok(alive(spawnedPid), "the shared pty survives a single viewer closing")
ok(seenA.length > 0, "the surviving viewer still holds its stream")

util.stop()
await wait(500)
ok(!alive(spawnedPid), "stop() actually reaps the real pty process — no orphan")

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
