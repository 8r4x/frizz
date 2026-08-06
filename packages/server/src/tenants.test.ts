import assert from "node:assert/strict"
import { test } from "node:test"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { createTenantMap } from "./tenants.ts"

function project(id: string, name = id): Project {
  return { dir: `/repos/${name}`, id, name, label: name, stateDir: `/state/${id}`, cwdSlug: `-repos-${name}` }
}

/** A context whose closeable parts record the order they were stopped in. */
function fakeContext(stopped: string[], overrides: Partial<Record<string, () => unknown>> = {}): AppContext {
  const mark = (n: string, fn?: () => unknown) => () => { stopped.push(n); return fn?.() }
  return {
    tailer: { stop: mark("tailer", overrides.tailer) },
    loginUtility: { stop: mark("loginUtility", overrides.loginUtility) },
    stopSubscriptions: mark("subscriptions", overrides.subscriptions),
    scheduler: { stop: mark("scheduler", overrides.scheduler) },
    board: { stop: mark("board", overrides.board) },
    codexAppServer: { shutdown: mark("bridge", overrides.bridge) },
    storage: { close: mark("storage", overrides.storage) },
  } as unknown as AppContext
}

test("activate opens a project once, and a second activate returns the same context", async () => {
  const stopped: string[] = []
  let built = 0
  const tenants = createTenantMap({ createContext: async () => { built++; return fakeContext(stopped) } })
  const a = await tenants.activate(project("p1"))
  const b = await tenants.activate(project("p1"))
  assert.ok(a)
  assert.equal(a, b, "the same context, not a second one over the same SQLite file")
  assert.equal(built, 1)
  assert.equal(tenants.active().length, 1)
})

// Two viewers opening one project at the same instant must not race two contexts onto one database.
test("concurrent activations of one project build exactly one context", async () => {
  let built = 0
  const tenants = createTenantMap({
    createContext: async () => {
      built++
      await new Promise((r) => setTimeout(r, 5))
      return fakeContext([])
    },
  })
  const [a, b, c] = await Promise.all([
    tenants.activate(project("p1")),
    tenants.activate(project("p1")),
    tenants.activate(project("p1")),
  ])
  assert.equal(built, 1)
  assert.equal(a, b)
  assert.equal(b, c)
})

test("several projects are open at once and addressed by id", async () => {
  const tenants = createTenantMap({ createContext: async () => fakeContext([]) })
  await tenants.activate(project("p1", "frizz"))
  await tenants.activate(project("p2", "nub"))
  assert.equal(tenants.active().length, 2)
  assert.ok(tenants.get("p1"))
  assert.ok(tenants.get("p2"))
  assert.equal(tenants.get("nope"), undefined)
})

// THE POINT OF THE SEAM: one project that will not open is one dead card, not an outage.
test("a project that fails to open is reported, and the others keep serving", async () => {
  const failures: string[] = []
  const tenants = createTenantMap({
    createContext: async ({ project: p }) => {
      if (p?.id === "broken") throw new Error("ui.db is corrupt")
      return fakeContext([])
    },
    onError: (p, error) => failures.push(`${p.id}: ${(error as Error).message}`),
  })

  assert.ok(await tenants.activate(project("healthy")))
  const broken = await tenants.activate(project("broken"))

  assert.equal(broken, undefined, "activate reports rather than throwing")
  assert.deepEqual(failures, ["broken: ui.db is corrupt"])
  assert.equal(tenants.active().length, 1, "the healthy project is untouched")
  assert.ok(tenants.get("healthy"))
  // …and it can be retried once whatever was wrong is fixed.
  assert.equal(tenants.get("broken"), undefined)
})

test("deactivate stops one project's resources in the barrier's order, leaving the rest", async () => {
  const stopped: string[] = []
  const tenants = createTenantMap({ createContext: async () => fakeContext(stopped) })
  await tenants.activate(project("p1"))
  await tenants.activate(project("p2"))

  assert.equal(await tenants.deactivate("p1"), true)
  assert.deepEqual(stopped, [
    "tailer", "loginUtility", "subscriptions", "scheduler", "board", "bridge", "storage",
  ])
  assert.equal(tenants.get("p1"), undefined)
  assert.ok(tenants.get("p2"), "the other project is still serving")
  assert.equal(await tenants.deactivate("p1"), false, "idempotent")
})

// Storage is the handle that actually has to be released; a stuck subsystem before it must not strand it.
test("a subsystem that throws on close does not strand the ones after it", async () => {
  const stopped: string[] = []
  const tenants = createTenantMap({
    createContext: async () => fakeContext(stopped, { scheduler: () => { throw new Error("wedged") } }),
  })
  await tenants.activate(project("p1"))
  await tenants.deactivate("p1")
  assert.ok(stopped.includes("storage"), "storage still closed after an earlier phase threw")
  assert.deepEqual(stopped.slice(-2), ["bridge", "storage"])
})

test("a half-failed deactivate still removes the project from the map", async () => {
  const tenants = createTenantMap({
    createContext: async () => fakeContext([], { storage: () => { throw new Error("busy") } }),
  })
  await tenants.activate(project("p1"))
  await tenants.deactivate("p1")
  assert.equal(tenants.get("p1"), undefined, "never reachable again once its storage has been closed")
})

test("closeAll drains every project", async () => {
  const stopped: string[] = []
  const tenants = createTenantMap({ createContext: async () => fakeContext(stopped) })
  await tenants.activate(project("p1"))
  await tenants.activate(project("p2"))
  await tenants.closeAll()
  assert.equal(tenants.active().length, 0)
  assert.equal(stopped.filter((s) => s === "storage").length, 2)
})
