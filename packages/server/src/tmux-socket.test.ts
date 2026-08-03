import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { acquireProjectLaunchOwner, type ProjectLaunchTarget } from "./project-launch.ts"
import {
  deriveLegacySocket,
  deriveSocket,
  deriveWorktreeSocket,
  parseTmuxSocketInspection,
  productionTmuxSocketRuntime,
  readTmuxSocketMigration,
  resolveProjectTmuxSocket,
  resolveProjectTmuxSocketSelection,
  tmuxProjectRootHash,
  tmuxSocketMigrationPath,
  type TmuxSocketObservation,
  type TmuxSocketRuntime,
} from "./tmux-socket.ts"

const PROJECT_ID = "12345678-1234-4234-8234-123456789abc"
const OTHER_ID = "12345678-9999-4999-8999-999999999999"

interface Harness {
  base: string
  target: ProjectLaunchTarget
  legacySocket: string
  fullSocket: string
  calls: Array<{ kind: "inspect" | "label"; socket: string }>
  labels: Array<{
    socket: string
    anchor: { paneId: string; panePid: number; sessionCreated: number }
    marker: { projectId: string; projectRootHash: string }
  }>
  runtime: TmuxSocketRuntime
  set(socket: string, ...observations: TmuxSocketObservation[]): void
  setLabelResult(value: boolean): void
  present(options?: {
    projectId?: string | null
    projectRootHash?: string | null
    currentPath?: string
    sessionName?: string
    extra?: Array<{ currentPath: string; sessionName?: string }>
  }): Extract<TmuxSocketObservation, { kind: "present" }>
  cleanup(): void
}

function harness(): Harness {
  const base = mkdtempSync(join(tmpdir(), "fray tmux migration "))
  const projectDir = join(base, "repo")
  const stateDir = join(base, "home", ".fray", "projects", PROJECT_ID)
  mkdirSync(projectDir, { recursive: true })
  const target: ProjectLaunchTarget = { projectId: PROJECT_ID, projectDir: realpathSync(projectDir), stateDir }
  const sequences = new Map<string, TmuxSocketObservation[]>()
  const calls: Harness["calls"] = []
  const labels: Harness["labels"] = []
  let labelResult = true
  const runtime: TmuxSocketRuntime = {
    inspect(socket) {
      calls.push({ kind: "inspect", socket })
      const sequence = sequences.get(socket)
      if (!sequence || sequence.length === 0) return { kind: "absent" }
      return sequence.length === 1 ? sequence[0]! : sequence.shift()!
    },
    label(socket, anchor, marker) {
      calls.push({ kind: "label", socket })
      labels.push({
        socket,
        anchor: {
          paneId: anchor.paneId,
          panePid: anchor.panePid,
          sessionCreated: anchor.sessionCreated,
        },
        marker,
      })
      return labelResult
    },
  }
  const h: Harness = {
    base,
    target,
    legacySocket: deriveLegacySocket(PROJECT_ID),
    fullSocket: deriveSocket(PROJECT_ID),
    calls,
    labels,
    runtime,
    set(socket, ...observations) {
      sequences.set(socket, observations)
    },
    setLabelResult(value) {
      labelResult = value
    },
    present(options = {}) {
      const rootHash = tmuxProjectRootHash(target.projectDir)
      const panes = [{
        sessionName: options.sessionName ?? "fray-owned-thread",
        paneId: "%1",
        panePid: 10_001,
        sessionCreated: 1_700_000_001,
        dead: false,
        currentPath: options.currentPath ?? target.projectDir,
      }]
      for (const [index, extra] of (options.extra ?? []).entries()) {
        panes.push({
          sessionName: extra.sessionName ?? `fray-owned-extra-${index}`,
          paneId: `%${index + 2}`,
          panePid: 10_002 + index,
          sessionCreated: 1_700_000_002 + index,
          dead: false,
          currentPath: extra.currentPath,
        })
      }
      return {
        kind: "present",
        projectId: options.projectId === undefined ? PROJECT_ID : options.projectId,
        projectRootHash: options.projectRootHash === undefined ? rootHash : options.projectRootHash,
        panes,
      }
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true })
    },
  }
  return h
}

function migration(h: Harness) {
  const value = readTmuxSocketMigration(h.target.stateDir)
  assert.ok(value)
  return value
}

test("an exact-marked full socket accepts a dead pane with tmux's empty current path", () => {
  const rootHash = tmuxProjectRootHash("/repo")
  assert.deepEqual(
    parseTmuxSocketInspection(
      `fray-phase1-dogfood\t%1\t123\t1700000000\t1\t\t${PROJECT_ID}\t${rootHash}\n`,
    ),
    {
      kind: "present",
      projectId: PROJECT_ID,
      projectRootHash: rootHash,
      panes: [{
        sessionName: "fray-phase1-dogfood",
        paneId: "%1",
        panePid: 123,
        sessionCreated: 1_700_000_000,
        dead: true,
        currentPath: "",
      }],
    },
  )
})

// A machine with no tmux at all must never be told its PROJECT IDENTITY is corrupt. `execFileSync`
// reports "the binary never ran" with an undefined stderr, which used to read as "tmux answered
// something we don't recognise" — so the first `npx frayui` on a stock Mac died accusing the user's
// own fray.id of being duplicate or corrupt (reported 2026-08-01) instead of saying `install tmux`.
test("a machine without tmux reports the missing executable, not a socket ownership problem", (t) => {
  const originalPath = process.env.PATH
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  })
  process.env.PATH = join(tmpdir(), "fray-absent-toolchain-do-not-create")

  assert.throws(
    () => productionTmuxSocketRuntime.inspect(deriveSocket(PROJECT_ID)),
    (error: Error) => {
      assert.match(error.message, /required executable `tmux` could not be run \(ENOENT\)/)
      assert.match(error.message, /Install tmux .* and relaunch Fray/)
      assert.doesNotMatch(error.message, /ownership|fray\.id/)
      return true
    },
  )
})

test("explicit overrides are verbatim unmanaged escape hatches for repository and linked-worktree targets", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(tmuxSocketMigrationPath(h.target.stateDir), "intentionally invalid\n")
  h.set("fray", h.present({ projectId: OTHER_ID }))

  assert.deepEqual(
    resolveProjectTmuxSocketSelection(h.target, { repositoryOverride: "fray", runtime: h.runtime }),
    { socket: "fray", managed: false },
  )
  assert.deepEqual(
    resolveProjectTmuxSocketSelection(
      { ...h.target, identityScope: "worktree" },
      { repositoryOverride: "custom.operator.socket", runtime: h.runtime },
    ),
    { socket: "custom.operator.socket", managed: false },
  )
  assert.deepEqual(h.calls, [])
  assert.throws(
    () => resolveProjectTmuxSocket(h.target, { repositoryOverride: "", runtime: h.runtime }),
    /invalid FRAY_TMUX_SOCKET/,
  )
  assert.deepEqual(h.calls, [])
})

test("a managed linked worktree remains isolated without consulting ordinary-repository migration state", (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  mkdirSync(h.target.stateDir, { recursive: true })
  writeFileSync(tmuxSocketMigrationPath(h.target.stateDir), "irrelevant to linked worktree\n")

  assert.deepEqual(
    resolveProjectTmuxSocketSelection(
      { ...h.target, identityScope: "worktree" },
      { runtime: h.runtime },
    ),
    { socket: deriveWorktreeSocket(PROJECT_ID), managed: true },
  )
  assert.deepEqual(h.calls, [])
})

