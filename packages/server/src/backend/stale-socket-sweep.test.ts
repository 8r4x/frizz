// The sweep's only interesting property is what it does NOT do, so the headline test is the real
// thing: a genuine corpse socket (a child that bound one and was SIGKILLed) next to a genuine LIVE
// listener in the same directory, swept by the real `lsof` and the real kernel. The corpse must go and
// the live one must be untouched — not merely still present on disk, but never even CONNECTED to,
// because a connection is itself destructive to both daemon families (the codex daemon destroys the
// previous client socket; the Claude broker reassigns `client` and drains its event backlog into
// whoever just connected). The remaining tests drive the fail-closed branches through injected seams,
// which is the only way to stage "lsof is missing" and "lsof lied".
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sweepStaleSockets } from "./stale-socket-sweep.ts"

const PREFIX = "frizz-swtest-"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(50)
  }
  return predicate()
}

test("the real sweep unlinks a killed daemon's socket and never touches a live one", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sweep-"))
  const deadPath = join(dir, `${PREFIX}dead.sock`)
  const livePath = join(dir, `${PREFIX}live.sock`)

  // A live listener that COUNTS accepted connections — the assertion that matters.
  let accepted = 0
  const live = net.createServer((sock) => { accepted++; sock.end() })
  await new Promise<void>((resolve) => live.listen(livePath, resolve))

  // A real corpse: a child binds its socket, announces it, and is SIGKILLed — so its file is left
  // behind exactly the way a killed broker/daemon leaves one.
  const child = spawn(process.execPath, [
    "-e",
    `require("net").createServer().listen(process.argv[1], () => console.log("up"))`,
    deadPath,
  ], { stdio: ["ignore", "pipe", "ignore"] })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => resolve())
    child.once("error", reject)
    setTimeout(() => reject(new Error("child never bound its socket")), 10_000).unref?.()
  })
  child.kill("SIGKILL")
  await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  assert.equal(existsSync(deadPath), true, "the killed child left its socket file behind")

  sweepStaleSockets({ dir, prefix: PREFIX })

  assert.equal(await until(() => !existsSync(deadPath)), true, "the corpse's socket is unlinked")
  assert.equal(existsSync(livePath), true, "the live listener's socket survives")
  assert.equal(accepted, 0, "and the live listener was never connected to — not even to probe it")

  // Still serving, which is the point of not having probed it.
  await new Promise<void>((resolve, reject) => {
    const client = net.connect(livePath)
    client.once("connect", () => { client.end(); resolve() })
    client.once("error", reject)
  })
  assert.equal(accepted, 1)
  await new Promise<void>((resolve) => live.close(() => resolve()))
})

// ---- fail-closed branches (injected seams) ---------------------------------------------------------

interface Recorded { probed: string[]; unlinked: string[] }

function run(
  files: string[],
  referenced: Set<string> | null,
  options: { keep?: readonly string[]; dead?: (path: string) => boolean } = {},
): Recorded {
  const out: Recorded = { probed: [], unlinked: [] }
  sweepStaleSockets({ dir: "/sockets", prefix: PREFIX, keep: options.keep }, {
    readdir: () => files,
    listReferenced: (_prefix, done) => done(referenced),
    probe: (path, verdict) => { out.probed.push(path); verdict(options.dead ? options.dead(path) : true) },
    unlink: (path) => out.unlinked.push(path),
  })
  return out
}

test("a referenced path is never probed, and only a refused probe unlinks", () => {
  const live = `/sockets/${PREFIX}live.sock`
  const dead = `/sockets/${PREFIX}dead.sock`
  const lying = `/sockets/${PREFIX}lying.sock` // absent from lsof, but the probe connects
  const out = run(
    [`${PREFIX}live.sock`, `${PREFIX}dead.sock`, `${PREFIX}lying.sock`],
    new Set([live]),
    { dead: (path) => path !== lying },
  )
  assert.deepEqual(out.probed, [dead, lying], "the referenced path is not even probed")
  assert.deepEqual(out.unlinked, [dead], "a probe that CONNECTS means lsof was wrong; that path stays")
})

test("no lsof evidence sweeps nothing at all", () => {
  const out = run([`${PREFIX}a.sock`, `${PREFIX}b.sock`], null)
  assert.deepEqual(out.probed, [])
  assert.deepEqual(out.unlinked, [])
})

test("only this family's .sock files are candidates, and `keep` is absolute", () => {
  const keep = `/sockets/${PREFIX}mine.sock`
  const out = run(
    [`${PREFIX}mine.sock`, `${PREFIX}other.sock`, `${PREFIX}notasocket.json`, "frizz-codex-x.sock", "unrelated"],
    new Set(),
    { keep: [keep] },
  )
  assert.deepEqual(out.probed, [`/sockets/${PREFIX}other.sock`])
  assert.deepEqual(out.unlinked, [`/sockets/${PREFIX}other.sock`])
})

test("an unreadable directory is not evidence of anything", () => {
  const out: Recorded = { probed: [], unlinked: [] }
  sweepStaleSockets({ dir: "/sockets", prefix: PREFIX }, {
    readdir: () => { throw new Error("ENOENT") },
    listReferenced: () => assert.fail("must not reach lsof when the directory could not be read"),
    probe: (path, verdict) => { out.probed.push(path); verdict(true) },
    unlink: (path) => out.unlinked.push(path),
  })
  assert.deepEqual(out.unlinked, [])
})
