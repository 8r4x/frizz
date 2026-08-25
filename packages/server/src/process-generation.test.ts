import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { test, type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import {
  defaultProcessPlatformAdapter,
  observeProcessGeneration,
  type ProcessGenerationObservation,
  type ProcessPlatformAdapter,
} from "./process-generation.ts"

/** The platforms with a real birth-time source. Anything else fails closed to `unavailable`. */
const PREFIX: Record<string, string | undefined> = {
  linux: "linux",
  darwin: "ps-utc",
  win32: "win32",
}
const expectedPrefix = PREFIX[process.platform]

function spawnIdle(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" })
  assert.ok(child.pid)
  return child
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
    await once(child, "close")
  }
}

/** A just-spawned PID can briefly be invisible to the OS query; give it the same grace the launcher does. */
async function settled(pid: number): Promise<ProcessGenerationObservation> {
  let observed = defaultProcessPlatformAdapter.observe(pid)
  const deadline = Date.now() + 5_000
  while (!observed.processStart && Date.now() < deadline) {
    await delay(20)
    observed = defaultProcessPlatformAdapter.observe(pid)
  }
  return observed
}

function skipUnobservable(t: TestContext): boolean {
  if (expectedPrefix) return false
  t.skip("this platform cannot observe an external process generation")
  return true
}

test("an external process's marker is stable across observations and distinct per process", { timeout: 30_000 }, async (t) => {
  if (skipUnobservable(t)) return
  const first = spawnIdle()
  // Two children born inside one tick of the platform's birth clock legitimately share a marker, so
  // cross that boundary before spawning the second — otherwise this asserts the clock's resolution
  // rather than the property it is for, which is that the marker TRACKS birth instead of being a
  // per-machine constant. Each figure is measured, not assumed:
  //   darwin — `ps -o lstart=` resolves to the SECOND, which is what its `weak` confidence admits.
  //   linux  — `/proc/<pid>/stat` field 20 is in clock ticks and `getconf CLK_TCK` is 100, i.e. 10ms.
  //            Measured on Ubuntu with node 26.7.0: six children spawned back to back produced only
  //            THREE distinct tick values, so neighbouring pairs shared a marker.
  //   win32  — FILETIME is 100ns and four back-to-back children came out 5.6-6.4ms apart with
  //            sub-millisecond digits, so no wait is needed at all.
  const BIRTH_CLOCK_TICK_MS: Partial<Record<NodeJS.Platform, number>> = { darwin: 1_100, linux: 30 }
  await delay(BIRTH_CLOCK_TICK_MS[process.platform] ?? 0)
  const second = spawnIdle()
  try {
    const once1 = await settled(first.pid!)
    const twice = await settled(first.pid!)
    const other = await settled(second.pid!)

    assert.notEqual(once1.confidence, "unavailable")
    assert.equal(once1.processStart?.split(":", 1)[0], expectedPrefix)
    // Same process, observed twice: identical, or every lock check would read as a mismatch.
    assert.equal(once1.processStart, twice.processStart)
    // Two live processes: different, or a recycled PID would pass for its predecessor.
    assert.notEqual(once1.processStart, other.processStart)
  } finally {
    await stopChild(first)
    await stopChild(second)
  }
})

test("a stale generation is refused while the live one it shadows is retained", { timeout: 30_000 }, async (t) => {
  if (skipUnobservable(t)) return
  const live = spawnIdle()
  const doomed = spawnIdle()
  try {
    const liveObserved = await settled(live.pid!)
    const doomedObserved = await settled(doomed.pid!)
    assert.ok(liveObserved.processStart)
    assert.ok(doomedObserved.processStart)

    const generation = { pid: live.pid!, processStart: liveObserved.processStart }
    assert.equal(observeProcessGeneration(generation), liveObserved.confidence)

    // NEGATIVE CONTROL. The same live PID carrying a marker recorded for an EARLIER occupant is the
    // recycled-PID case this file exists for: it must read `mismatch`, not a match by default.
    assert.equal(
      observeProcessGeneration({ pid: live.pid!, processStart: `${liveObserved.processStart}0` }),
      "mismatch",
    )

    await stopChild(doomed)
    assert.equal(
      observeProcessGeneration({ pid: doomed.pid!, processStart: doomedObserved.processStart }),
      "dead",
    )
  } finally {
    await stopChild(live)
    await stopChild(doomed)
  }
})

test("windows emits an absolute 100ns FILETIME it can compare exactly", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("the win32 marker format is only produced on win32")
    return
  }
  const child = spawnIdle()
  try {
    const observed = await settled(child.pid!)
    assert.equal(observed.confidence, "exact")
    assert.match(observed.processStart ?? "", /^win32:\d{18}$/u)
    // FILETIME counts 100ns units from 1601-01-01 UTC. Decoding it back to a wall-clock instant near
    // now is what proves the value is absolute rather than boot-relative — which is why, unlike the
    // linux marker, it needs no boot id to stay distinct across a reboot.
    const filetime = BigInt(observed.processStart!.slice("win32:".length))
    const epochMs = Number(filetime / 10_000n) - 11_644_473_600_000
    assert.ok(
      Math.abs(epochMs - Date.now()) < 60_000,
      `win32 marker decoded to ${new Date(epochMs).toISOString()}`,
    )
  } finally {
    await stopChild(child)
  }
})

test("the win32 tag passes the untagged-legacy gate and still compares, on any platform", () => {
  const marker = "win32:134321087620870013"
  const generation = { pid: 4321, processStart: marker }
  const base: ProcessPlatformAdapter = {
    current: () => ({ pid: 1, processStart: "win32:134321087600000000" }),
    observe: () => ({ processStart: marker, confidence: "exact" }),
    isAlive: () => true,
    now: () => 0,
    sleep: () => {},
  }
  assert.equal(observeProcessGeneration(generation, base), "exact")
  assert.equal(
    observeProcessGeneration(generation, {
      ...base,
      observe: () => ({ processStart: "win32:134321087620999999", confidence: "exact" }),
    }),
    "mismatch",
  )
  // A version-1 owner's untagged `ps` prose is still refused rather than compared to a tagged marker.
  assert.equal(
    observeProcessGeneration({ pid: 4321, processStart: "Mon Aug 24 00:00:00 2026" }, base),
    "unavailable",
  )
  // A marker written on another platform never compares: differing tags are `unavailable`, never
  // `mismatch`, so a foreign record can never authorize stealing the lock.
  assert.equal(
    observeProcessGeneration({ pid: 4321, processStart: "linux:boot:99" }, base),
    "unavailable",
  )
})
