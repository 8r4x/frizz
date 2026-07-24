// LIVE harness (excluded from the test glob). Drives the real installed `codex app-server` through
// CodexAppServerBridge and proves model/effort changes are accepted both idle and mid-turn:
//   nubx tsx --tsconfig packages/web/tsconfig.json packages/server/src/backend/_live_appserver_profile_update.mts
import { spawn as spawnChild } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { createInteractionStore } from "../interaction-store.ts"
import {
  CodexAppServerBridge,
  type CodexAppServerSpawn,
} from "./codex-app-server.ts"

const dir = mkdtempSync(join(tmpdir(), "fray-live-codex-profile-"))
const dbPath = join(dir, "ui.db")
const db = new Database(dbPath)
db.pragma("journal_mode = WAL")
const interactions = createInteractionStore(db)
const pids: number[] = []
const spawn: CodexAppServerSpawn = (binary, args, options) => {
  const child = spawnChild(binary, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (child.pid) pids.push(child.pid)
  return child
}
const bridge = new CodexAppServerBridge({
  projectId: "live-profile",
  projectDir: dir,
  dbPath,
  interactions,
  spawn,
  requestTimeoutMs: 30_000,
})
const threadSlug = "live-profile"
const sessionId = "live-profile-session"

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
  console.log(`PASS ${message}`)
}

async function cleanup(): Promise<void> {
  try { await bridge.shutdown() } catch {}
  try { interactions.dispose() } catch {}
  try { db.close() } catch {}
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
}

try {
  const binding = await bridge.startDisposableSession({
    threadSlug,
    sessionId,
    cwd: dir,
    model: "gpt-5.6-luna",
    sandbox: "read-only",
    approvalPolicy: "never",
  })
  const idle = await bridge.setProfile({
    threadSlug,
    sessionId,
    model: "gpt-5.6-luna",
    effort: "medium",
  })
  check(idle.applied && idle.confirmedBy === "notification", "idle pair confirmed by thread/settings/updated")
  check(!idle.turnInFlight, "idle update reports no turn in flight")

  await bridge.startTurn({
    threadSlug,
    sessionId,
    text: "Think silently for a while before replying with OK.",
  })
  check(bridge.binding(threadSlug, sessionId)?.currentTurnId, "real Codex turn is in flight")
  const queued = await bridge.setProfile({
    threadSlug,
    sessionId,
    model: "gpt-5.6-terra",
    effort: "high",
  })
  check(queued.applied && queued.confirmedBy === "notification", "mid-turn pair confirmed by thread/settings/updated")
  check(queued.turnInFlight, "mid-turn update is reported as next-turn")
  check((await bridge.interruptTurn(threadSlug, sessionId)).interrupted, "owned probe turn interrupted cleanly")
  check(binding.ephemeral, "probe thread is disposable")
  console.log("LIVE CODEX PROFILE HARNESS OK")
  await cleanup()
} catch (error) {
  console.error("LIVE CODEX PROFILE HARNESS FAILED", error)
  await cleanup()
  process.exitCode = 1
}
