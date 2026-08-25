import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"

// The rail's badges. Handlers are lazy, so the stub carries only what `createRouter` resolves up
// front plus this procedure's one dependency: `activeTenants`, the server's view of which projects are
// open in this process and their boards.
function harness(activeTenants: AppContext["activeTenants"], own?: { project: Project; board: BoardManager }) {
  const ctx = {
    project: own?.project ?? { dir: tmpdir(), stateDir: tmpdir(), id: "own" },
    storage: {},
    board: own?.board ?? {},
    tailer: {},
    activeTenants,
  } as unknown as AppContext
  return createRouter(ctx)
}

const project = (id: string): Project => ({ id, dir: tmpdir(), stateDir: tmpdir(), name: id, label: id, cwdSlug: id })
const board = (threads: Partial<ThreadView>[]): BoardManager =>
  ({ snapshot: async () => ({ threads }) as unknown as BoardSnapshot }) as unknown as BoardManager
const session = (needsYou: boolean, extra: Partial<ThreadView> = {}): Partial<ThreadView> =>
  ({ kind: "session", state: "open", needsYou, ...extra })

test("counts the queue of every open project, keyed by id, and leaves out one that will not answer", async () => {
  const router = harness(() => [
    { project: project("a"), board: board([session(true), session(true), session(false)]) },
    // Archived, foreign and legacy rows never queue, whatever `needsYou` says — the same predicate the
    // web's sidebar bands on (groups.ts `queued`), so the badge and the rail cannot disagree.
    { project: project("b"), board: board([session(true, { state: "archived" }), session(true, { foreign: true }), { kind: "legacy", needsYou: true }, session(true)]) },
    { project: project("c"), board: board([]) },
    // A board mid-deactivation throws from snapshot(); that project has no count this round, and the
    // others still do.
    { project: project("d"), board: { snapshot: async () => { throw new Error("board stopped") } } as unknown as BoardManager },
  ])
  assert.deepEqual(await router.projectsQueueCounts.handler({ input: undefined }), { a: 2, b: 1, c: 0 })
})

test("without a tenant map (a test context, a one-project server) it answers for its own project alone", async () => {
  const router = harness(undefined, { project: project("solo"), board: board([session(true), session(false)]) })
  assert.deepEqual(await router.projectsQueueCounts.handler({ input: undefined }), { solo: 1 })
})
