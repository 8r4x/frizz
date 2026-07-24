// Focused real-subsystem harness for Claude profile queueing. It uses the production controller,
// storage CAS, reattach path, and a real isolated tmux server. The Claude executable is a deterministic
// idle-composer stand-in so the harness never touches real credentials or conversations.
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Settings } from "@fray-ui/shared"
import { createClaudeBackend } from "../packages/server/src/backend/claude.ts"
import type { BoardManager } from "../packages/server/src/board.ts"
import { inspectClaudeComposer } from "../packages/server/src/permission-controller.ts"
import { createProfileController } from "../packages/server/src/profile-controller.ts"
import type { Project } from "../packages/server/src/project.ts"
import { reattachThreadWithProfile } from "../packages/server/src/resume.ts"
import { createStorage, type SessionRow } from "../packages/server/src/storage.ts"
import type { SessionTelemetry, Tailer } from "../packages/server/src/tailer.ts"
import * as tmux from "../packages/server/src/tmux.ts"

const root = mkdtempSync(join(tmpdir(), "fray-profile-queue-"))
const stateDir = join(root, "state")
mkdirSync(stateDir, { recursive: true })
const socket = `fray-profile-queue-${process.pid}`
tmux.setSocket(socket)
const slug = "queued-profile"
const sessionId = "profile-session"
const argvLog = join(root, "profile-argv.log")
const fakeClaude = join(root, "fake-claude")
writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> '${argvLog}'
printf '❯ \\n────────────\\n  profile-harness · disposable\\n'
exec sleep 7200
`)
chmodSync(fakeClaude, 0o755)

const project: Project = {
  dir: root,
  id: "profile-queue-harness",
  name: "profile-queue-harness",
  label: "profile-queue-harness",
  stateDir,
  cwdSlug: "profile-queue-harness",
  tmuxSocket: socket,
  tmuxSocketManaged: false,
}
const storage = createStorage(join(stateDir, "ui.db"))
const row: SessionRow = {
  slug,
  session_id: sessionId,
  tmux_name: `fray-${slug}`,
  spawned_at: new Date().toISOString(),
  last_read_at: null,
  unread: 0,
  exited: 0,
  archived: 0,
  rested_at: null,
  title_auto: 0,
  title: "Queued profile",
  state: "open",
  meta: null,
  seen_at: null,
  plan_path: null,
  transcript_id: null,
  backend: "claude",
  agent_session_id: sessionId,
  model: "opus",
  effort: "high",
  permission_mode: "default",
}
storage.upsertSession(row)
const initialIdentity = tmux.spawn(slug, [fakeClaude, "--resume", sessionId], root)
let telemetry: SessionTelemetry = {
  turn: "in-flight",
  permPrompt: false,
  subAgents: [],
  bgShells: [],
  pendingQuestion: false,
}
const tailer = {
  get: () => telemetry,
  tick: () => undefined,
} as unknown as Tailer
const board = { refresh: () => ({}) } as unknown as BoardManager
const backend = createClaudeBackend({ logDir: join(root, "logs"), claudeBin: fakeClaude })
const settings = {
  permissionMode: "default",
  runtimeGate: false,
} as unknown as Settings
const deps = {
  project,
  storage,
  board,
  getSettings: () => settings,
  backendFor: () => backend,
}
const controller = createProfileController({
  storage,
  tailer,
  board,
  reattach: (threadSlug, current, requested, onGeneration, onCheckpoint) =>
    reattachThreadWithProfile(deps, threadSlug, current, requested, onGeneration, onCheckpoint),
})

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
  console.log(`PASS ${message}`)
}

try {
  const result = await controller.request(slug, { model: "fable", effort: "medium" })
  check(result.effect === "queued", "active Claude profile request is queued")
  check(storage.getSession(slug)?.runtime_control === "profile-queued", "queue is durable in SQLite")
  check(tmux.paneIdentity(slug)?.paneId === initialIdentity.paneId, "active pane is untouched while work runs")

  telemetry = { ...telemetry, turn: "idle" }
  const initialPane = tmux.capturePane(slug)
  if (inspectClaudeComposer(initialPane).kind !== "empty") console.error("initial pane", JSON.stringify(initialPane))
  check(inspectClaudeComposer(initialPane).kind === "empty", "real pane exposes an idle Claude composer")
  controller.tick()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && storage.getSession(slug)?.runtime_control !== null) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const committed = storage.getSession(slug)!
  if (committed.runtime_control !== null) {
    console.error("queued row after deadline", committed)
    console.error("pane", JSON.stringify(tmux.capturePane(slug)))
  }
  check(committed.runtime_control === null, "queued control retires after the safe handoff")
  check(committed.model === "fable" && committed.effort === "medium", "requested pair commits atomically")
  const replacement = tmux.paneIdentity(slug)
  check(replacement && replacement.panePid !== initialIdentity.panePid, "real tmux worker was replaced")
  const argv = readFileSync(argvLog, "utf8").trim().split("\n").at(-1) ?? ""
  check(argv.includes("--model fable"), "replacement argv carries --model fable")
  check(argv.includes("--effort medium"), "replacement argv carries --effort medium")
  console.log("CLAUDE PROFILE QUEUE HARNESS OK")
} finally {
  controller.stop()
  try { tmux.killSession(slug) } catch {}
  try { execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" }) } catch {}
  storage.close()
  rmSync(root, { recursive: true, force: true })
}
