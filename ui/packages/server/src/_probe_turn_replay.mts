// READ-ONLY PROBE: re-derive what the BOARD would render for a set of threads, from a COPY of a live
// project DB plus the real transcripts, with the runtime-liveness signal under the probe's control.
//
//   nub packages/server/src/_probe_turn_replay.mts <db-dir> <project-dir> [--stale-running] <slug…>
//
// Built for the "rested thread still shows a spinner" report (2026-07-30). It splits the two candidate
// causes apart on the operator's OWN data rather than on a fixture:
//
//   (default)         no runtime signal at all — what the FOLD alone says.
//   --stale-running   every broker row gets `{turn:"running", at: <2h ago>}`, which is the reading the
//                     live server was holding: a turn the SDK once called running, that then stopped
//                     advancing because the turn had in fact ended. This is the differential for the
//                     staleness bound in resolveRuntimeTurn — before it, every row here reads
//                     `running`; after it, every rested row reads `turn-idle`.
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { createTailer, defaultLogDir } from "./tailer.ts"
import { createBoard } from "./board.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { Bus } from "./bus.ts"
import { cwdSlug, type Project } from "./project.ts"
import type { AgentBackend } from "./backend/types.ts"

const argv = process.argv.slice(2)
const staleRunning = argv.includes("--stale-running")
const [dbDir, projectDir, ...rest] = argv.filter((a) => a !== "--stale-running")
const slugs = rest
if (!dbDir || !projectDir || slugs.length === 0) {
  console.error("usage: _probe_turn_replay.mts <db-dir> <project-dir> [--stale-running] <slug…>")
  process.exit(2)
}

const project: Project = {
  dir: projectDir, id: "probe", name: "probe", label: "probe",
  stateDir: dbDir, cwdSlug: cwdSlug(projectDir),
}
const storage = createStorage(join(dbDir, "ui.db"))
const backend = createClaudeBackend({ claudeBin: "claude", logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => backend

// Two hours old — well past any conceivable "the SDK's socket is ahead of its own disk write" lag, and
// roughly how stale the live server's readings were when the board was still rendering "Working…".
const STALE_AT = Date.now() - 2 * 60 * 60 * 1000

const tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false, capturePane: () => "",
  runtimeLiveness: staleRunning
    ? () => ({ turn: "running" as const, at: STALE_AT, events: 1 })
    : undefined,
})
const board = createBoard(project, storage, new Bus(), tailer, "probe-boot", {
  subscribe: (async () => ({ unsubscribe: async () => {} })) as never, // no filesystem watcher
})

tailer.tick()
tailer.tick()
const threads = board.refresh().threads ?? []

console.log(`mode: ${staleRunning ? "--stale-running (a 2h-old `running` reading)" : "fold only (no runtime signal)"}`)
for (const slug of slugs) {
  const tele = tailer.get(slug)
  const view = threads.find((t) => t.id === slug)
  console.log(
    `${slug.padEnd(36)} board.runtime=${(view?.runtime ?? "(absent)").padEnd(10)}` +
      ` tele.turn=${tele?.turn ?? "(none)"}` +
      ` lastAssistantAt=${tele?.lastAssistantAt ?? "-"}`,
  )
}

tailer.stop()
storage.close()
