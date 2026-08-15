// THE DECLARED PARK — a thread is "awaiting background work" when it SAYS SO, naming what it waits on.
//
// The inference it replaces (does this thread happen to have something running?) is what put the resting
// card on a thread whose only background work was a dev server nobody tore down: true by the letter,
// useless as a signal.
//
// THE FENCE REGISTERS NOTHING — it is display-only, and exists so a worker can rest without being bumped
// for a handoff. A background shell already wakes its agent when it finishes, and a sub-agent's return
// re-invokes its parent, so there was never anything for frizz to arm (maintainer 2026-08-14: "Both
// subagents and background shells should be display-only here").
//
// So what these pin is the INTEGRITY CHECK: every name in the fence has to correspond to something the
// thread ACTUALLY has out right now, and everything else must fail OPEN — back to the queue, never
// parked behind a wait that does not exist. A typo is not a way to disappear from the board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { declaredWaitIds, hasDeclaredBackgroundPark, hasDeclaredWait } from "./board.ts"
import type { SessionTelemetry } from "./tailer.ts"

const AT = "2026-08-14T00:00:00.000Z"
const NOW = Date.parse("2026-08-14T00:05:00.000Z")

type Shell = SessionTelemetry["bgShells"][number]
type Agent = SessionTelemetry["subAgents"][number]

const shell = (label: string, id?: string, state: "running" | "stale" = "running") =>
  ({ label, id, startedAt: AT, state }) as unknown as Shell
const agent = (label: string, id: string, state: "running" | "stale" | "rested" = "running") =>
  ({ label, id, startedAt: AT, state }) as unknown as Agent

function parked(names: string[], over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    lastAssistantAt: AT,
    bgShells: [],
    subAgents: [],
    lastFence: {
      kind: "awaiting",
      body: "Waiting on the test run.",
      hints: names.map((value) => ({ kind: "shell" as const, value })),
    },
    ...over,
  } as SessionTelemetry
}

// `declaredWaitIds` is the thread's OWN RUNNING WORK, by the handle the worker sees. `timer:` and
// `pr:` are waits too, but they name rows in their own registries and are checked against those —
// mixing them in here would compare a timer id against a set of shell handles and call a healthy wait
// dead. `for:` and `reason:` describe the park itself and name nothing at all.
test("the names come off the shell/agent lines, and nothing else does", () => {
  const tele = parked([], {
    lastFence: {
      kind: "awaiting",
      body: "",
      hints: [
        { kind: "shell", value: "nub run test" },
        { kind: "pr", value: "acme/app#1" },
        { kind: "agent", value: "agent_7" },
        { kind: "timer", value: "tmr_abc123" },
        { kind: "for", value: "2h" },
        { kind: "reason", value: "waiting on the suite" },
        { kind: "shell", value: "bash_2" },
      ],
    },
  } as Partial<SessionTelemetry>)
  assert.deepEqual(declaredWaitIds(tele), ["nub run test", "agent_7", "bash_2"])
})

test("a done fence declares nothing, and neither does a thread with no fence", () => {
  assert.deepEqual(declaredWaitIds({ lastFence: { kind: "done", body: "", hints: [] } } as unknown as SessionTelemetry), [])
  assert.deepEqual(declaredWaitIds({} as unknown as SessionTelemetry), [])
  assert.deepEqual(declaredWaitIds(undefined), [])
})

// A worker names what it can see in its own transcript, which is sometimes the tool id and sometimes the
// label. Refusing the label would make the fence unusable for the case it exists for.
test("a shell or a sub-agent can be named by id OR by label", () => {
  const withShell = { bgShells: [shell("nub run test", "bash_1")] }
  assert.equal(hasDeclaredBackgroundPark(parked(["bash_1"], withShell), NOW), true)
  assert.equal(hasDeclaredBackgroundPark(parked(["nub run test"], withShell), NOW), true)
  const withAgent = { subAgents: [agent("reviewer", "toolu_9")] }
  assert.equal(hasDeclaredBackgroundPark(parked(["toolu_9"], withAgent), NOW), true)
  assert.equal(hasDeclaredBackgroundPark(parked(["reviewer"], withAgent), NOW), true)
})

// EVERY ONE of these is a way a thread could vanish behind a wait nothing will resolve. They all have to
// land the same way: not a park, so the thread queues exactly as it would have without the fence.
test("a name matching nothing live is NOT a park", () => {
  // The fence outlived the work, or the worker invented the entry outright.
  assert.equal(hasDeclaredBackgroundPark(parked(["nub run test"]), NOW), false)
  // A typo against a real shell.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["nub run tests"], { bgShells: [shell("nub run test", "bash_1")] }), NOW),
    false,
  )
  // The shell went stale, so it is not live work any more and nothing will report back.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["bash_1"], { bgShells: [shell("nub run test", "bash_1", "stale")] }), NOW),
    false,
  )
  // A rested sub-agent has already returned; waiting on it waits forever.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["toolu_9"], { subAgents: [agent("reviewer", "toolu_9", "rested")] }), NOW),
    false,
  )
  // All-or-nothing: the thread claimed to be waiting on BOTH, so one dead name voids the claim.
  assert.equal(
    hasDeclaredBackgroundPark(parked(["bash_1", "ghost"], { bgShells: [shell("nub run test", "bash_1")] }), NOW),
    false,
  )
  // An awaiting fence with no `watch:` line at all is prose, not a declaration.
  assert.equal(hasDeclaredBackgroundPark(parked([], { bgShells: [shell("nub run test", "bash_1")] }), NOW), false)
})

// A park with no expiry is the dev-server problem inverted: instead of a card that lies, a thread that
// disappears. The fence's own instant bounds it without any new syntax.
test("a park expires, so nothing parks forever", () => {
  const live = { bgShells: [shell("nub run test", "bash_1")] }
  const dayLater = Date.parse(AT) + 24 * 60 * 60 * 1000 + 1000
  assert.equal(hasDeclaredBackgroundPark(parked(["bash_1"], live), dayLater), false)
  // Just inside the cap it still holds.
  assert.equal(hasDeclaredBackgroundPark(parked(["bash_1"], live), Date.parse(AT) + 60_000), true)
})

// A `pr-watch:` park is ALSO a declaration and it also cards — but it must never take the thread out of
// the queue on its own. A PR whose reviews never arrive would vanish silently, which is the reason no
// watcher has ever parked its thread (maintainer 2026-07-22, reaffirmed 2026-08-12). Own background work
// is the opposite case: it reports on its own and there is nothing for the human to do meanwhile.
test("a pr-watch park cards but does NOT take the thread out of the queue", () => {
  const prWatch = {
    lastAssistantAt: AT,
    bgShells: [],
    subAgents: [],
    lastFence: { kind: "awaiting", body: "PR up.", hints: [{ kind: "pr", value: "acme/app#1" }] },
  } as unknown as SessionTelemetry
  assert.equal(hasDeclaredWait(prWatch, NOW), true, "it states a wait, so the card shows")
  assert.equal(hasDeclaredBackgroundPark(prWatch, NOW), false, "but it never excuses the queue")
})

test("own background work does both — it cards AND it leaves the queue", () => {
  const own = parked(["bash_1"], { bgShells: [shell("nub run test", "bash_1")] })
  assert.equal(hasDeclaredWait(own, NOW), true)
  assert.equal(hasDeclaredBackgroundPark(own, NOW), true)
})
