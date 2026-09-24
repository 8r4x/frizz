import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn as spawnChild, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadSlug } from "@frizz/shared"
import { createLoginUtility, lineDiscipline } from "./login-utility.ts"

// A stand-in provider CLI on REAL pipes: it announces itself, echoes every stdin line back as
// `GOT:<line>`, prints `SAY <text>` verbatim, and exits on `quit`. Every test drives the utility's own
// spawn, stdio and teardown; only the executable is swapped, and the argv it was asked for is recorded.
const FAKE_CLI = `
  process.stdout.write("LOGIN-READY\\n")
  let pending = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    pending += chunk
    let newline
    while ((newline = pending.indexOf("\\n")) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line === "quit") process.exit(0)
      if (line.startsWith("SAY ")) process.stdout.write(line.slice(4) + "\\n")
      else process.stdout.write("GOT:" + line + "\\n")
    }
  })
`

interface Spawned { file: string; args: string[]; cwd: string; child: ChildProcess }

function harness(over: { lifetimeMs?: number; claudeBin?: string; codexBin?: string; env?: NodeJS.ProcessEnv; spawnThrows?: string } = {}) {
  const spawned: Spawned[] = []
  const cwd = mkdtempSync(join(tmpdir(), "frizz-login-cwd-"))
  const utility = createLoginUtility({
    claudeBin: over.claudeBin ?? "/stub/claude",
    codexBin: over.codexBin ?? "/stub/codex",
    cwd,
    lifetimeMs: over.lifetimeMs ?? 60_000,
    ...(over.env ? { env: over.env } : {}),
    spawn: ((file: string, args: string[], options: { cwd: string }) => {
      if (over.spawnThrows) throw new Error(over.spawnThrows)
      const child = spawnChild(process.execPath, ["-e", FAKE_CLI], { ...options, env: process.env })
      spawned.push({ file, args, cwd: options.cwd, child })
      return child
    }) as never,
  })
  return { utility, spawned, cwd }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve()
  else child.once("exit", () => resolve())
})

test("start spawns exactly the provider login argv, no shell, addressed by a slug-shaped opaque id", (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const { attemptId } = h.utility.start("claude")
  assert.match(attemptId, /^login-[0-9a-f]{16}$/)
  assert.equal(ThreadSlug.safeParse(attemptId).success, true, "the id must ride the /term slug transport")
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0]!.file, "/stub/claude")
  assert.deepEqual(h.spawned[0]!.args, ["auth", "login"])
  assert.equal(h.spawned[0]!.cwd, h.cwd)
})

test("codex signs in with its own argv", (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  h.utility.start("codex")
  assert.equal(h.spawned[0]!.file, "/stub/codex")
  assert.deepEqual(h.spawned[0]!.args, ["login"])
})

test("one live attempt per provider: a second start reuses the running CLI", (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const first = h.utility.start("claude")
  const second = h.utility.start("claude")
  assert.equal(second.attemptId, first.attemptId)
  assert.equal(h.spawned.length, 1, "a second Sign in click must not race a second OAuth flow")
})

test("a finished attempt is replaced rather than reused", async (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const first = h.utility.start("claude")
  h.utility.attach(first.attemptId)!.write("quit\r") // the CLI finished (e.g. the flow failed)
  await waitFor(() => h.utility.status(first.attemptId).state === "exited", "the CLI to exit")
  const second = h.utility.start("claude")
  assert.notEqual(second.attemptId, first.attemptId)
  assert.equal(h.spawned.length, 2)
})

test("attach gates on a live attempt; unknown ids never attach", (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const { attemptId } = h.utility.start("claude")
  assert.ok(h.utility.attach(attemptId), "a live attempt attaches")
  assert.equal(h.utility.attach("login-0000000000000000"), null, "an unknown id never attaches")
  assert.equal(h.utility.attach("some-thread"), null, "a thread slug is not a login attempt")
})

// tmux used to multiplex viewers for free. This is the replacement, and it is the property that
// matters: two tabs on the sign-in modal watch ONE flow, and both see output printed before they
// opened — otherwise a tab opened after the OAuth URL scrolled past is useless.
test("every viewer shares one CLI, and a late viewer replays what it missed", async (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const { attemptId } = h.utility.start("claude")
  const first = h.utility.attach(attemptId)!
  const seenByFirst: string[] = []
  first.onData((c) => seenByFirst.push(c))

  first.write("SAY Open https://oauth.example/xyz\r")
  // Anchored on the line start: the echo of the typed `SAY …` line carries the URL too.
  await waitFor(() => /\nOpen https:\/\/oauth\.example\/xyz\r\n/.test(seenByFirst.join("")), "the OAuth URL")

  const late = h.utility.attach(attemptId)!
  assert.match(late.replay(), /LOGIN-READY\r\n/, "a tab opened later still sees the banner")
  assert.match(late.replay(), /oauth\.example\/xyz/, "a tab opened later still sees the OAuth URL")

  const seenByLate: string[] = []
  late.onData((c) => seenByLate.push(c))
  first.write("SAY both\r")
  await waitFor(() => seenByLate.join("").includes("\nboth\r\n"), "the second viewer's output")
  assert.match(seenByFirst.join(""), /\nboth\r\n/, "both viewers are fed by the same CLI")
  assert.equal(h.spawned.length, 1)
})

// A pipe has no line discipline, so the one the pty used to supply is the utility's: the pasted code
// is echoed as it is typed, Enter hands the line to the CLI, and one viewer closing never kills it.
test("a viewer's typed line reaches the shared CLI on Enter; closing one viewer never kills it", async (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const { attemptId } = h.utility.start("claude")
  const a = h.utility.attach(attemptId)!
  const b = h.utility.attach(attemptId)!
  const seen: string[] = []
  b.onData((c) => seen.push(c))
  a.write("pasted-cod")
  a.write("x\x7fe\r")
  await waitFor(() => seen.join("").includes("GOT:pasted-code\r\n"), "the CLI to read the line")
  assert.ok(seen.join("").includes("pasted-codx\b \be\r\n"), "every viewer sees the typing echoed, Backspace included")
  a.close()
  assert.equal(h.spawned[0]!.child.exitCode, null, "one tab closing must not abandon the other tab's flow")
  b.write("more\r")
  await waitFor(() => seen.join("").includes("GOT:more\r\n"), "the second viewer's line")
})

test("status: running until the CLI exits; an unknown id reads as exited", async (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const { attemptId } = h.utility.start("claude")
  assert.deepEqual(h.utility.status(attemptId), { state: "running", backend: "claude" })
  h.utility.attach(attemptId)!.write("quit\r")
  await waitFor(() => h.utility.status(attemptId).state === "exited", "the CLI to exit")
  assert.deepEqual(h.utility.status(attemptId), { state: "exited", backend: "claude" })
  assert.deepEqual(h.utility.status("login-ffffffffffffffff"), { state: "exited" })
})

test("cancel and stop kill the CLI and drop the OAuth replay; teardown is idempotent", async () => {
  const h = harness()
  const { attemptId } = h.utility.start("claude")
  const viewer = h.utility.attach(attemptId)!
  viewer.write("SAY https://oauth.example/secret\r")
  await waitFor(() => viewer.replay().includes("\nhttps://oauth.example/secret\r\n"), "the secret URL")
  h.utility.cancel(attemptId)
  await exited(h.spawned[0]!.child)
  assert.equal(viewer.replay(), "", "the OAuth bytes must not survive teardown")
  h.utility.cancel(attemptId) // second cancel is a no-op
  const again = h.utility.start("claude")
  h.utility.stop()
  await exited(h.spawned[1]!.child)
  assert.equal(h.utility.attach(again.attemptId), null)
})

test("Ctrl-C ends the attempt, as it did on a pty", async (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const { attemptId } = h.utility.start("claude")
  h.utility.attach(attemptId)!.write("\x03")
  await exited(h.spawned[0]!.child)
  await waitFor(() => h.utility.status(attemptId).state === "exited", "the attempt to read as exited")
})

// The tmux implementation needed a boot-time sweep for `remain-on-exit` panes left in a detached
// server holding OAuth scrollback. The CLI is a CHILD of this process, so that whole leak class is gone.
test("a viewer attached before exit is told when the CLI finishes, after its last line", async (t) => {
  const h = harness()
  t.after(() => h.utility.stop())
  const { attemptId } = h.utility.start("claude")
  const viewer = h.utility.attach(attemptId)!
  let output = ""
  let outputAtExit: string | undefined
  viewer.onData((c) => { output += c })
  viewer.onExit(() => { outputAtExit = output })
  viewer.write("SAY Login successful\r")
  viewer.write("quit\r")
  await waitFor(() => outputAtExit !== undefined, "the exit notice")
  assert.match(outputAtExit!, /\nLogin successful\r\n/, "the last line arrives before the viewer is detached")
})

// A BARE name is never spawned. Windows' CreateProcessW finds `.exe` on PATH and nothing else an npm
// install writes, so the utility resolves the name itself and spawns an absolute path — or, when
// nothing resolves, an attempt that explains itself instead of a dead pane (Windows audit 2026-09-11,
// finding 7). The resolvers are the real ones, pointed at a directory of this test's own.
test("a bare provider name is resolved to an absolute executable before it is spawned", { skip: process.platform === "win32" ? "posix resolution path" : false }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-login-bin-"))
  for (const name of ["claude", "codex"]) writeFileSync(join(dir, name), "#!/bin/sh\n", { mode: 0o755 })
  const h = harness({ claudeBin: "claude", codexBin: "codex", env: { PATH: dir } })
  t.after(() => h.utility.stop())
  const claude = h.utility.start("claude")
  const codex = h.utility.start("codex")
  assert.equal(h.spawned[0]!.file, join(dir, "claude"))
  assert.deepEqual(h.spawned[0]!.args, ["auth", "login"])
  assert.equal(h.spawned[1]!.file, join(dir, "codex"))
  assert.deepEqual(h.spawned[1]!.args, ["login"])
  assert.deepEqual(h.utility.status(claude.attemptId), { state: "running", backend: "claude" })
  assert.deepEqual(h.utility.status(codex.attemptId), { state: "running", backend: "codex" })
})

test("a name that resolves to nothing is the attempt's status and its replay, never a dead pane", () => {
  const empty = mkdtempSync(join(tmpdir(), "frizz-login-empty-"))
  const h = harness({ claudeBin: "claude", codexBin: "codex", env: { PATH: empty } })
  const { attemptId } = h.utility.start("codex")
  assert.match(attemptId, /^login-[0-9a-f]{16}$/, "still slug-shaped: the modal polls it like any other attempt")
  assert.equal(h.spawned.length, 0, "nothing was spawned")
  const status = h.utility.status(attemptId)
  assert.equal(status.state, "exited")
  assert.equal(status.backend, "codex")
  assert.match(status.error ?? "", /Could not start the Codex sign-in: .*could not resolve 'codex'/)
  const viewer = h.utility.attach(attemptId)
  assert.ok(viewer, "a viewer attaches and reads the reason")
  assert.match(viewer!.replay(), /could not resolve 'codex'/)
  let exits = 0
  viewer!.onExit(() => exits++)
  assert.equal(exits, 1, "a late viewer of a finished attempt is told at once")
  // The next click starts over rather than attaching to the failure.
  const again = h.utility.start("codex")
  assert.notEqual(again.attemptId, attemptId)
  h.utility.stop()
})

test("a spawn that throws is reported the same way", () => {
  const h = harness({ spawnThrows: "spawn EINVAL" })
  const { attemptId } = h.utility.start("claude")
  assert.deepEqual(h.utility.status(attemptId), { state: "exited", backend: "claude", error: "Could not start the Claude sign-in: spawn EINVAL" })
  h.utility.cancel(attemptId)
  assert.deepEqual(h.utility.status(attemptId), { state: "exited" }, "teardown of a never-started attempt is clean")
})

// Node reports most refused spawns (ENOENT, EACCES) asynchronously, as an `error` with no exit after it.
test("a spawn the OS refuses asynchronously is reported the same way", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "frizz-login-cwd-"))
  const utility = createLoginUtility({ claudeBin: join(cwd, "no-such-claude"), cwd, env: {} as NodeJS.ProcessEnv, spawn: ((_file: string, args: string[], options: object) => spawnChild(join(cwd, "no-such-claude"), args, options)) as never })
  const { attemptId } = utility.start("claude")
  await waitFor(() => utility.status(attemptId).state === "exited", "the refused spawn")
  assert.match(utility.status(attemptId).error ?? "", /^Could not start the Claude sign-in: spawn .*ENOENT/)
  assert.match(utility.attach(attemptId)!.replay(), /ENOENT\r\n$/)
  utility.stop()
})

test("the line discipline echoes, erases, submits once per Enter, and drops escape sequences", () => {
  let echoed = ""
  const lines: string[] = []
  let interrupts = 0
  const type = lineDiscipline({ echo: (text) => { echoed += text }, submit: (line) => lines.push(line), interrupt: () => interrupts++ })
  type("ab\x7f\x7f\x7fc")
  assert.equal(echoed, "ab\b \b\b \bc", "Backspace on an empty line echoes nothing")
  type("\x1b[A\x1b[200~dé\x1b[201~\x1bOB\r\n")
  assert.deepEqual(lines, ["cdé"], "a pasted CRLF is one Enter, and arrows/paste markers never reach the CLI")
  type("\n\r")
  assert.deepEqual(lines, ["cdé", "", ""], "a bare LF and a later CR each submit")
  type("x\x03")
  assert.equal(interrupts, 1)
  assert.match(echoed, /x\^C\r\n$/)
})
