// THE DECLARED PARK — a thread is "awaiting background work" when it SAYS SO, naming what it waits on.
//
// The inference it replaces (does this thread happen to have something running?) is what put the resting
// card on a thread whose only background work was a dev server nobody tore down: true by the letter,
// useless as a signal. An `awaiting` fence with `watch: <id>` lines is the declaration, and because the
// ids come from the registry frizz can CHECK it — the thing every earlier free-text version of this
// syntax could not do.
//
// What these pin is that the check actually happens and that it FAILS OPEN. A declaration frizz cannot
// verify must put the thread back in the queue, never park it: a typo is not a way to disappear.
import { test } from "node:test"
import assert from "node:assert/strict"
import { declaredWaitIds, hasDeclaredBackgroundPark, hasDeclaredWait } from "./board.ts"
import type { SessionTelemetry } from "./tailer.ts"

const AT = "2026-08-14T00:00:00.000Z"
const NOW = Date.parse("2026-08-14T00:05:00.000Z")

function parked(ids: string[], over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    lastAssistantAt: AT,
    lastFence: {
      kind: "awaiting",
      body: "Waiting on the test run.",
      hints: ids.map((value) => ({ kind: "watch" as const, value })),
    },
    ...over,
  } as SessionTelemetry
}

test("the ids come off the fence's `watch:` lines, and nothing else does", () => {
  const tele = parked(["wch_a", "wch_b"], {
    lastFence: {
      kind: "awaiting",
      body: "prose",
      hints: [
        { kind: "watch", value: "wch_a" },
        { kind: "pr-watch", value: "acme/app#1" },
        { kind: "human", value: "Colin" },
        { kind: "watch", value: "wch_b" },
      ],
    },
  } as Partial<SessionTelemetry>)
  assert.deepEqual(declaredWaitIds(tele), ["wch_a", "wch_b"])
})

test("a done fence declares nothing, and neither does a thread with no fence", () => {
  assert.deepEqual(declaredWaitIds({ lastFence: { kind: "done", body: "", hints: [] } } as unknown as SessionTelemetry), [])
  assert.deepEqual(declaredWaitIds({} as unknown as SessionTelemetry), [])
  assert.deepEqual(declaredWaitIds(undefined), [])
})

test("a park counts while every id it names is an armed watch on this thread", () => {
  assert.equal(hasDeclaredBackgroundPark(parked(["wch_a"]), new Set(["wch_a"]), NOW), true)
  assert.equal(hasDeclaredBackgroundPark(parked(["wch_a", "wch_b"]), new Set(["wch_a", "wch_b"]), NOW), true)
})

// EVERY ONE of these is a way a thread could vanish behind a wait nothing will resolve. They all have to
// land the same way: not a park, so the thread queues exactly as it would have without the fence.
test("an unverifiable declaration is NOT a park", () => {
  // A typo, or an id belonging to another thread — `armedWatchIds` is this thread's own set.
  assert.equal(hasDeclaredBackgroundPark(parked(["wch_typo"]), new Set(["wch_a"]), NOW), false)
  // One good, one stale: a park is all-or-nothing, because the thread claimed to be waiting on BOTH.
  assert.equal(hasDeclaredBackgroundPark(parked(["wch_a", "wch_gone"]), new Set(["wch_a"]), NOW), false)
  // The watcher settled — it fired or the worker dropped it — so there is nothing left to wait for.
  assert.equal(hasDeclaredBackgroundPark(parked(["wch_a"]), new Set(), NOW), false)
  // An awaiting fence with no `watch:` line at all is prose, not a declaration.
  assert.equal(hasDeclaredBackgroundPark(parked([]), new Set(["wch_a"]), NOW), false)
})

// A park with no expiry is the dev-server problem inverted: instead of a card that lies, a thread that
// disappears. The fence's own instant bounds it without any new syntax.
test("a park expires, so nothing parks forever", () => {
  const dayLater = Date.parse(AT) + 24 * 60 * 60 * 1000 + 1000
  assert.equal(hasDeclaredBackgroundPark(parked(["wch_a"]), new Set(["wch_a"]), dayLater), false)
  // Just inside the cap it still holds.
  assert.equal(hasDeclaredBackgroundPark(parked(["wch_a"]), new Set(["wch_a"]), Date.parse(AT) + 60_000), true)
})

// A `pr-watch:` park is ALSO a declaration and it also cards — but it must never take the thread out of
// the queue. A PR whose reviews never arrive would vanish silently, which is the reason no watcher has
// ever parked its thread (maintainer 2026-07-22, reaffirmed 2026-08-12). Own background work is the
// opposite case: it reports on its own and there is nothing for the human to do meanwhile.
test("a pr-watch park cards but does NOT take the thread out of the queue", () => {
  const prWatch = {
    lastAssistantAt: AT,
    lastFence: { kind: "awaiting", body: "PR up.", hints: [{ kind: "pr-watch", value: "acme/app#1" }] },
  } as unknown as SessionTelemetry
  assert.equal(hasDeclaredWait(prWatch, new Set(), NOW), true, "it states a wait, so the card shows")
  assert.equal(hasDeclaredBackgroundPark(prWatch, new Set(), NOW), false, "but it never excuses the queue")
})

test("own background work does both — it cards AND it leaves the queue", () => {
  const own = parked(["wch_a"])
  assert.equal(hasDeclaredWait(own, new Set(["wch_a"]), NOW), true)
  assert.equal(hasDeclaredBackgroundPark(own, new Set(["wch_a"]), NOW), true)
})
