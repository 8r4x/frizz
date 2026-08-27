import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import { startTenantPrime, type PrimeCandidate, type TenantPrimeDeps, type TenantPrimeRun } from "./tenant-prime.ts"
import type { Project } from "./project.ts"

// The background pass that opens every registered project after boot, so the rail can badge all of
// them instead of only the ones the operator has clicked into. Every wait is injected away here: the
// real gaps are seconds, and none of them is what these assert.

const candidate = (id: string, over: Partial<PrimeCandidate> = {}): PrimeCandidate =>
  ({ id, path: `${tmpdir()}/${id}`, stale: false, ...over })

const project = (entry: PrimeCandidate): Project =>
  ({ id: entry.id, dir: entry.path, stateDir: entry.path, name: entry.id, label: entry.id, cwdSlug: entry.id }) as Project

function harness(over: Partial<TenantPrimeDeps> = {}) {
  const opened: string[] = []
  const logs: string[] = []
  const deps: TenantPrimeDeps = {
    list: () => [candidate("a"), candidate("b"), candidate("c")],
    isOpen: () => false,
    toProject: project,
    activate: async (p) => {
      opened.push(p.id)
      return {}
    },
    delay: async () => {},
    log: (message) => logs.push(message),
    ...over,
  }
  return { deps, opened, logs }
}

test("opens every registered project, in rail order", async () => {
  const { deps, opened } = harness()
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "b", "c"])
  assert.deepEqual(result.opened, ["a", "b", "c"])
  assert.deepEqual(result.failed, [])
})

test("skips the projects already open here — the launching one above all", async () => {
  const { deps, opened } = harness({ isOpen: (id) => id === "a" })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["b", "c"])
  assert.deepEqual(result.skipped, ["a"])
})

test("skips a project whose directory is gone rather than failing to open it", async () => {
  const { deps, opened } = harness({ list: () => [candidate("a", { stale: true }), candidate("b")] })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["b"])
  assert.deepEqual(result.skipped, ["a"])
  assert.deepEqual(result.failed, [])
})

test("leaves a project another live Frizz is serving closed, and says so once", async () => {
  const { deps, opened, logs } = harness({ servedElsewhere: (p) => (p.id === "b" ? 4242 : undefined) })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "c"])
  assert.deepEqual(result.skipped, ["b"])
  assert.equal(logs.filter((line) => line.includes("4242")).length, 1)
})

test("a project that will not open is one missing badge, not the end of the pass", async () => {
  // `undefined` is exactly what the tenant seam resolves for a project it could not build.
  const { deps, opened } = harness({
    activate: async (p) => {
      opened.push(p.id)
      return p.id === "a" ? undefined : {}
    },
  })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "b", "c"])
  assert.deepEqual(result.failed, ["a"])
  assert.deepEqual(result.opened, ["b", "c"])
})

test("an activation that THROWS is caught too — the pass is a floating promise", async () => {
  const { deps, opened, logs } = harness({
    activate: async (p) => {
      opened.push(p.id)
      if (p.id === "b") throw new Error("board stopped")
      return {}
    },
  })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "b", "c"])
  assert.deepEqual(result.failed, ["b"])
  assert.ok(logs.some((line) => line.includes("board stopped")))
})

test("a registry entry that will not resolve is stepped over", async () => {
  const { deps, opened } = harness({
    toProject: (entry) => {
      if (entry.id === "a") throw new Error("unreadable state dir")
      return project(entry)
    },
  })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["b", "c"])
  assert.deepEqual(result.failed, ["a"])
})

test("stop() halts the pass, so shutdown never races an activation into a drained map", async () => {
  let run: TenantPrimeRun
  const opened: string[] = []
  const deps: TenantPrimeDeps = {
    list: () => [candidate("a"), candidate("b"), candidate("c")],
    isOpen: () => false,
    toProject: project,
    activate: async (p) => {
      opened.push(p.id)
      if (p.id === "a") run.stop()
      return {}
    },
    delay: async () => {},
    log: () => {},
  }
  run = startTenantPrime(deps)
  const result = await run.done
  assert.deepEqual(opened, ["a"])
  assert.deepEqual(result.opened, ["a"])
})

test("stop() before the first project opens nothing at all", async () => {
  const { deps, opened } = harness()
  const run = startTenantPrime(deps)
  run.stop()
  const result = await run.done
  assert.deepEqual(opened, [])
  assert.deepEqual(result.opened, [])
})

test("the pause between projects tracks the last activation, clamped at both ends", async () => {
  // The pacing is a 50% duty cycle on a measured cost, not a flat guess — an empty project (13ms here)
  // costs the 25ms floor, a big board (800ms here) is capped at the 250ms ceiling, and a middling one
  // is paid back exactly. The first project waits only the opening delay: there is nothing to be polite
  // about yet.
  const waits: number[] = []
  let clock = 0
  const costs = new Map([["a", 13], ["b", 90], ["c", 800]])
  const result = await startTenantPrime({
    list: () => [candidate("a"), candidate("b"), candidate("c")],
    isOpen: () => false,
    toProject: project,
    activate: async (p) => {
      clock += costs.get(p.id)!
      return {}
    },
    monotonicNow: () => clock,
    startDelayMs: 250,
    delay: async (ms) => void waits.push(ms),
    log: () => {},
  }).done
  assert.deepEqual(result.tookMs, [13, 90, 800])
  assert.deepEqual(waits, [250, 25, 90])
})

test("a run of skips costs no pause at all — only an activation earns one", async () => {
  const waits: number[] = []
  const result = await startTenantPrime({
    list: () => [candidate("open"), candidate("gone", { stale: true }), candidate("a")],
    isOpen: (id) => id === "open",
    toProject: project,
    activate: async () => ({}),
    monotonicNow: () => 0,
    startDelayMs: 250,
    delay: async (ms) => void waits.push(ms),
    log: () => {},
  }).done
  assert.deepEqual(result.opened, ["a"])
  assert.deepEqual(waits, [250], `a skip paced the pass: ${JSON.stringify(waits)}`)
})

test("the real timer is interruptible, so a shutdown during the opening wait settles at once", async () => {
  // No injected delay: this is the shipped wait, cut short by stop(). Without the interrupt the
  // shutdown phase would block for the full opening delay on every server that has just booted.
  const started = Date.now()
  const run = startTenantPrime({
    list: () => [candidate("a")],
    isOpen: () => false,
    toProject: project,
    activate: async () => ({}),
    startDelayMs: 30_000,
    log: () => {},
  })
  run.stop()
  const result = await run.done
  assert.deepEqual(result.opened, [])
  assert.ok(Date.now() - started < 1_000, "stop() did not cut the opening wait short")
})
