// Disposable dev control-plane child. The long-lived supervisor forks this process and replaces it
// whenever server/shared/RPC source changes. Claude/Codex workers remain in their independent tmux
// server; this process owns only Frizz's HTTP/Vite/watch/tailer/storage handles.
import { projectFromLaunchTarget } from "./project.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  currentProcessGeneration,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"
import { ShutdownTimeoutError } from "./shutdown.ts"
import { log as frizzLog } from "./logging.ts"

// A control-plane child that dies must leave its reason in the run log, not only on a terminal the
// launcher may have already repainted past. Its stdio is still inherited, so an uncaught stack would
// otherwise land on the operator's screen and nowhere durable.
process.on("uncaughtException", (error) => {
  frizzLog.error("dev-child", `uncaught exception: ${error instanceof Error ? error.stack ?? error.message : error}`)
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  frizzLog.error("dev-child", `unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`)
})

const rawPort = process.env.FRIZZ_DEV_PORT
const port = Number(rawPort)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  frizzLog.error("dev-child", `invalid FRIZZ_DEV_PORT: ${rawPort ?? "<unset>"}`)
  process.exit(1)
}

// Telling the supervisor something must never be able to KILL this child. `process.send` still exists
// after the parent goes away — the channel object outlives the peer — so `process.send?.(…)` is not a
// guard at all: the write fails asynchronously and, with no callback, Node surfaces it as an
// unhandled 'error' event that takes the process down. The user sees an EPIPE stack printed over
// their shell prompt seconds after they already gave up (2026-07-23, twice, in two repos).
//
// Check `connected` first, and ALWAYS pass a callback — with one, Node routes the failure there
// instead of emitting 'error'. Losing this message is harmless: a parent that is gone is not waiting.
function notifySupervisor(message: Record<string, unknown>): void {
  if (!process.connected || typeof process.send !== "function") return
  try {
    process.send(message, undefined, undefined, () => {})
  } catch {
    // The channel closed between the check and the write. Nothing to report it to.
  }
}

try {
  const target = projectLaunchTargetFromEnvironment(process.env)
  const launchOwnerToken = projectLaunchOwnerTokenFromEnvironment(process.env)
  if (!target || !launchOwnerToken) throw new Error("dev child is missing pinned project launch ownership")
  verifyProjectLaunchDelegate(target, launchOwnerToken)
  const { startServer } = await import("./index.ts")
  const project = projectFromLaunchTarget(target)
  const stableWebDist = process.env.FRIZZ_STABLE_WEB_DIST
  const stableArtifact = process.env.FRIZZ_STABLE_ARTIFACT
  if (stableArtifact && !stableWebDist)
    throw new Error("stable artifact launch is missing FRIZZ_STABLE_WEB_DIST")
  if (stableWebDist) {
    const required = [
      ["FRIZZ_SCRIPTS_DIR", process.env.FRIZZ_SCRIPTS_DIR, "index.mjs"],
      ["FRIZZ_WORKER_PLUGIN_DIR", process.env.FRIZZ_WORKER_PLUGIN_DIR, ".claude-plugin/plugin.json"],
    ] as const
    if (!existsSync(stableWebDist)) throw new Error("stable artifact launch is missing its verified web directory")
    for (const [name, directory, requiredFile] of required) {
      if (!directory || !existsSync(join(directory, requiredFile)))
        throw new Error(`stable artifact launch is missing verified ${name}`)
    }
  }
  const server = await startServer({
    dev: !stableWebDist,
    port,
    installSignalHandlers: false,
    requireDevWeb: !stableWebDist,
    ...(stableWebDist ? { webDistDir: stableWebDist } : {}),
    project,
    launchOwnerToken,
    requestOwnerStop: () => notifySupervisor({ type: "frizz-stop-owner", token: launchOwnerToken }),
  })
  notifySupervisor({
    type: "frizz-ready",
    ...currentProcessGeneration(),
    port: server.port,
    bootId: server.ctx.bootId,
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    const force = setTimeout(() => process.exit(1), 15_000)
    force.unref()
    try {
      await server.close()
      process.exit(0)
    } catch (err) {
      // close() reports its bounded public deadline while the shutdown fence continues draining.
      // Do not turn that diagnostic into an immediate process exit: doing so repeatedly kills clean
      // late drains and makes the supervisor log a misleading restart storm.
      if (err instanceof ShutdownTimeoutError) {
        frizzLog.warn("dev-child", `shutdown exceeded ${err.timeoutMs}ms; retaining ownership while the drain completes`)
        try {
          await server.shutdownFence.whenSafe()
          process.exit(0)
          return
        } catch (drainError) {
          frizzLog.error("dev-child", `late shutdown drain failed: ${drainError instanceof Error ? drainError.stack ?? drainError.message : drainError}`)
        }
      }
      frizzLog.error("dev-child", `shutdown failed: ${err instanceof Error ? err.stack ?? err.message : err}`)
      process.exit(1)
    }
  }

  // Keep the guard installed for repeated same-kind signals so they cannot restore Node's default
  // immediate termination while the server's bounded shutdown barrier is draining.
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  // A crashed/killed supervisor must not leave an unsupervised control plane behind.
  process.once("disconnect", () => void shutdown())
} catch (err) {
  frizzLog.error("dev-child", `failed to start: ${err instanceof Error ? err.stack ?? err.message : err}`)
  process.exit(1)
}
