// End-to-end proof that a REAL fray-ui launcher shuts down gracefully and leaves nothing behind.
//
// Boots the actual dev supervisor + forked control-plane child on a fully-ISOLATED stack (temp HOME,
// unique port, unique tmux socket, wakers/reaper off), puts REAL load on it (an open /events SSE board
// stream, an open /ws application socket, in-flight RPC calls), then delivers a signal to the whole
// process group exactly the way Ctrl-C does — and asserts:
//
//   • the launcher exits 0 within the bound,
//   • its output contains NO timeout / error / stack-trace noise,
//   • every process in the launcher's process group is gone afterwards (exact PID accounting).
//
//   npx tsx ui/scripts/verify-graceful-shutdown.mjs [--port=4952] [--mode=sigint|sigterm|double-sigint]
//
// --mode=double-sigint sends a second SIGINT 150ms after the first (the impatient operator): a second
// signal must escalate/no-op, never deadlock.
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const uiDir = resolve(scriptsDir, "..")
const repoDir = resolve(uiDir, "..")

const args = process.argv.slice(2)
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}

// ── launcher role ────────────────────────────────────────────────────────────────────────────────────
// Same topology as packages/server/src/dev.ts, but on a caller-chosen port so a verification run can
// never collide with the operator's live boards.
if (process.env.FRAY_SHUTDOWN_HARNESS === "launcher") {
  const port = Number(process.env.FRAY_SHUTDOWN_HARNESS_PORT)
  const { projectLaunchTarget, resolveProject } = await import("../packages/server/src/project.ts")
  const { acquireProjectLaunchOwner, projectLaunchEnvironment } = await import("../packages/server/src/project-launch.ts")
  const project = resolveProject()
  const target = projectLaunchTarget(project)
  const launchOwner = acquireProjectLaunchOwner(target, "supervisor")
  const launchEnv = projectLaunchEnvironment(process.env, target, launchOwner.token)
  const { createSupervisorShutdownHandler, startDevSupervisor } = await import("../packages/server/src/dev-supervisor.ts")
  let supervisor
  try {
    supervisor = await startDevSupervisor({
      port,
      cwd: project.dir,
      env: launchEnv,
      stateDir: project.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      childEntry: resolve(uiDir, "packages/server/src/dev.ts"),
    })
    await supervisor.firstBoot
  } catch (error) {
    launchOwner.release()
    throw error
  }
  console.log(`FRAY_HARNESS_READY ${JSON.stringify({ port, pid: process.pid })}`)
  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    release: () => { launchOwner.release() },
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  void supervisor.stopRequested.then(stop)
} else {
  // ── driver role ────────────────────────────────────────────────────────────────────────────────────
  const port = Number(opt("port", "4952"))
  const mode = opt("mode", "sigint")
  const home = mkdtempSync(join(tmpdir(), "fray-shutdown-verify-"))
  mkdirSync(join(home, ".fray"), { recursive: true })

  const descendants = (root) => {
    const seen = new Set()
    const walk = (pid) => {
      let out = ""
      try {
        out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      } catch {
        return
      }
      for (const line of out.split("\n")) {
        const child = Number(line.trim())
        if (!child || seen.has(child)) continue
        seen.add(child)
        walk(child)
      }
    }
    walk(root)
    return [...seen]
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const child = spawn(process.execPath, [resolve(uiDir, "node_modules/tsx/dist/cli.mjs"), resolve(scriptsDir, "verify-graceful-shutdown.mjs")], {
    cwd: uiDir,
    // Its own process group, so the driver can deliver a signal to the WHOLE group exactly the way a
    // terminal delivers Ctrl-C to its foreground group.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      FRAY_SHUTDOWN_HARNESS: "launcher",
      FRAY_SHUTDOWN_HARNESS_PORT: String(port),
      FRAY_TMUX_SOCKET: `fray-shutdown-verify-${port}-${process.pid}`,
      FRAY_WAKERS_OFF: "1",
      FRAY_ORPHAN_REAPER_OFF: "1",
      FRAY_DIRECT_SUPERVISOR: "1",
    },
  })
  const transcript = []
  const record = (stream) => (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.length === 0) continue
      transcript.push(`[${stream}] ${line}`)
      if (process.env.HARNESS_VERBOSE) console.log(`[${stream}] ${line}`)
    }
  }
  child.stdout.on("data", record("out"))
  child.stderr.on("data", record("err"))

  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })))
  const fail = async (why) => {
    try { process.kill(-child.pid, "SIGKILL") } catch {}
    console.error(`FAIL: ${why}`)
    console.error(transcript.join("\n"))
    rmSync(home, { recursive: true, force: true })
    process.exit(1)
  }

  const readyDeadline = Date.now() + 180_000
  while (!transcript.some((l) => l.includes("FRAY_HARNESS_READY"))) {
    if (Date.now() > readyDeadline) await fail("launcher never became ready")
    if (child.exitCode !== null) await fail(`launcher exited early (${child.exitCode})`)
    await new Promise((r) => setTimeout(r, 200))
  }
  const origin = `http://127.0.0.1:${port}`
  console.log(`[verify] launcher ready on ${origin} (pid ${child.pid})`)

  // Real load, held open at the instant the signal lands.
  const sse = await fetch(`${origin}/events`, { headers: { origin, "sec-fetch-site": "same-origin" } })
  const sseReader = sse.body.getReader()
  await sseReader.read()
  // The supervisor's public proxy fronts a private control-plane port. Attach the WebSocket load to the
  // real control-plane server itself so the load is genuinely on the process being shut down.
  const childPortLine = transcript.find((l) => /server on http:\/\/127\.0\.0\.1:(\d+)/.test(l))
  const childPort = Number(childPortLine.match(/server on http:\/\/127\.0\.0\.1:(\d+)/)[1])
  const childOrigin = `http://127.0.0.1:${childPort}`
  const wsmod = await import("../packages/server/node_modules/ws/index.js")
  const WebSocket = wsmod.WebSocket ?? wsmod.default?.WebSocket ?? wsmod.default
  const ws = new WebSocket(`ws://127.0.0.1:${childPort}/ws`, { headers: { origin: childOrigin } })
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j) })
  const rpc = Promise.allSettled(Array.from({ length: 8 }, () =>
    fetch(`${origin}/rpc/board.snapshot`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.text()),
  ))
  console.log("[verify] load in flight: 1 SSE board stream, 1 app socket, 8 RPC calls")

  const group = descendants(child.pid)
  const owned = [child.pid, ...group]
  console.log(`[verify] launcher process tree before signal: ${owned.join(", ")}`)

  const signal = mode === "sigterm" ? "SIGTERM" : "SIGINT"
  const t0 = Date.now()
  process.kill(-child.pid, signal)
  if (mode === "double-sigint") {
    await new Promise((r) => setTimeout(r, 150))
    try { process.kill(-child.pid, "SIGINT") } catch {}
  }

  const raced = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 20_000)),
  ])
  const shutdownMs = Date.now() - t0
  if (raced === "TIMEOUT") await fail(`launcher did not exit within 20000ms of ${signal}`)
  await rpc.catch(() => {})

  // Give any orphan a moment to surface, then account for every PID exactly.
  await new Promise((r) => setTimeout(r, 1000))
  const survivors = owned.filter(alive)

  const NOISE = [
    /did not quiesce/,
    /did not settle within/,
    /could not safely close storage/,
    /shutdown failed/,
    /late shutdown drain failed/,
    /retaining ownership while the drain completes/,
    /force deadline exceeded/,
    /did not close in \d+ms/,
    /ShutdownTimeoutError/,
    /AggregateError/,
    /EPIPE/,
    /^\[err\]\s+at /,
  ]
  const noisy = transcript.filter((line) => NOISE.some((re) => re.test(line)))

  console.log("─".repeat(90))
  console.log(`SHUTDOWN TRANSCRIPT (${signal}${mode === "double-sigint" ? " ×2" : ""}, port ${port})`)
  console.log("─".repeat(90))
  console.log(transcript.join("\n"))
  console.log("─".repeat(90))

  const result = {
    mode,
    signal,
    shutdownMs,
    exit: raced,
    noisyLines: noisy,
    ownedPids: owned,
    survivingPids: survivors,
  }
  console.log(JSON.stringify(result, null, 2))

  rmSync(home, { recursive: true, force: true })
  const problems = []
  if (raced.code !== 0) problems.push(`launcher exited ${JSON.stringify(raced)} — expected code 0`)
  if (noisy.length > 0) problems.push(`${noisy.length} timeout/error line(s) in shutdown output`)
  if (survivors.length > 0) problems.push(`${survivors.length} process(es) survived: ${survivors.join(", ")}`)
  if (problems.length > 0) {
    console.error(`FAIL: ${problems.join("; ")}`)
    for (const pid of survivors) { try { process.kill(pid, "SIGKILL") } catch {} }
    process.exit(1)
  }
  console.log(`PASS: clean ${signal} shutdown in ${shutdownMs}ms, ${owned.length} owned process(es) all reaped`)
  process.exit(0)
}
