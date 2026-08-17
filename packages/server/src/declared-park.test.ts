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
import { createScheduler } from "./scheduler.ts"
import type { FenceView, SessionTelemetry } from "./tailer.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"

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

// ---- SOURCE 12: THE PARK THAT STOPPED BEING TRUE --------------------------------------------------
// The two ways an awaiting fence goes stale, and the property that matters is that NEITHER is silent.
// Every stall this grammar replaced was silent: a watcher matched on ids the worker never saw, a
// blocking call that starved its own notification, a timer written in the past. Each one left a thread
// looking parked forever, and frizz said nothing.

function parkHarness(hints: FenceView["hints"], opts: { shells?: any[]; restedAt?: string; body?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-park-"))
  const storage = createStorage(join(dir, "ui.db"))
  storage.setSetting("signoffNudge", "off") // isolate SOURCE 12 from the nudge
  const slug = "parked"
  const restedAt = opts.restedAt ?? new Date(Date.now() - 60_000).toISOString()
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: "2026-08-15T11:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: restedAt, title_auto: 0,
    title: null, state: "open", meta: null, seen_at: null, plan_path: null, transcript_id: null,
  } as SessionRow)
  const s = createScheduler({
    storage,
    tailer: {
      get: () => ({
        turn: "idle",
        lastAssistantAt: restedAt,
        lastActivityAt: restedAt,
        subAgents: [],
        bgShells: opts.shells ?? [],
        pendingQuestion: false,
        permPrompt: false,
        lastFence: { kind: "awaiting", body: opts.body ?? "", hints },
      }),
    } as never,
    resume: async () => {},
    log: () => {},
  })
  const queued = () => storage.db.prepare("SELECT fence_id, message FROM wake_delivery WHERE thread_slug = ?").all(slug) as { fence_id: string; message: string }[]
  return { s, storage, queued, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const LIVE_SHELL = { label: "the suite", startedAt: "2026-08-15T11:59:00.000Z", state: "running" as const, id: "toolu_x", taskId: "bzvtnt3ig" }

test("a park naming something that is NOT running bumps the worker, and says which", async () => {
  const h = parkHarness([
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "shell", value: "bGONE" },
    { kind: "for", value: "2h" },
  ], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a park that cannot resolve is never silent")
    assert.match(rows[0].fence_id, /^park:dead:/)
    // NAMING WHICH is the whole point: "your fence is wrong" sends a worker back to hunt for an id it
    // has already lost, which is how it got the id wrong in the first place.
    assert.match(rows[0].message, /bGONE.*NOT RUNNING/s)
    assert.match(rows[0].message, /bzvtnt3ig.*still running/s)
    assert.match(rows[0].message, /mcp__frizz__activity/, "…and points at the tool that hands the ids back")
  } finally { h.close() }
})

test("a park whose every item is live is left alone", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    assert.deepEqual(h.queued(), [], "an honest park is not interrupted")
  } finally { h.close() }
})

// `for:` ELAPSED. The wait did not fail — it simply outlived its own estimate, which is a checkpoint
// rather than an error, so the worker is brought back to look rather than told off.
test("a park whose `for:` runs out bumps with the status of every item, and re-parking is unlimited", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "30s" }], {
    shells: [LIVE_SHELL],
    restedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:expired:/)
    assert.match(rows[0].message, /Your wait expired, nothing resolved\. Check back in on everything\./)
    assert.match(rows[0].message, /bzvtnt3ig.*still running/s, "the status list says what is and is not going")
    assert.match(rows[0].message, /no limit on that/, "re-parking is explicitly unlimited")
    // ONE bump per rest per cause — not one per tick, which would be a loop.
    for (let i = 0; i < 3; i++) await h.s.tick()
    assert.equal(h.queued().length, 1, "one rest, one expiry bump")
  } finally { h.close() }
})
// A fence with ITEMS but no `for:` is MALFORMED rather than wrong, and the sign-off nudge teaches the
// whole grammar in one message — a better teacher than a correction aimed at one missing line. (A fence
// with no items AT ALL is the opposite case and is bumped here; see the nameless tests below.)
test("a fence with items but no `for:` is left to the sign-off nudge", async () => {
  const h = parkHarness([{ kind: "shell", value: "bzvtnt3ig" }], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    assert.deepEqual(h.queued(), [], "not SOURCE 12's to report")
  } finally { h.close() }
})

// THE FENCE THAT NAMES NOTHING — the shape the maintainer caught in the wild (2026-08-16): `for: 24h`
// plus "TypeScript legs still running … waiting on the checks and your merge", and no item at all. The
// worker could have registered a PR watcher and been woken the moment CI settled; instead it waited on
// nothing, and frizz — which correctly refused the park — said nothing about why for a whole day.
//
// It is now the most explicit of the three bumps, because it is the one where the worker has the most to
// gain from being told: it does not need to fix an id, it needs to register something at all.
test("an awaiting fence naming NOTHING is bumped, with how to register a real wait", async () => {
  const h = parkHarness([{ kind: "for", value: "24h" }, { kind: "reason", value: "TypeScript legs still running; waiting on the checks and your merge" }])
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1, "a wait with nothing to wake it is never silent")
    assert.match(rows[0].fence_id, /^park:nameless:/)
    assert.match(rows[0].message, /names nothing to wait on/)
    // It has to say HOW, naming the tool for each kind — a worker told only "that is wrong" writes the
    // same fence again.
    assert.match(rows[0].message, /mcp__frizz__watch_pr/, "the PR case, which is the one it had")
    assert.match(rows[0].message, /mcp__frizz__timer/)
    assert.match(rows[0].message, /mcp__frizz__activity/, "…and where to get the ids")
    // …and the other honest exit: if it is not waiting, it is done.
    assert.match(rows[0].message, /you are not awaiting — you are done/)
  } finally { h.close() }
})

// One bump per rest per CAUSE. A fence that names nothing is a different piece of news from one whose
// item died, so the ids must not collide — but neither may fire twice for the same rest.
test("the nameless bump fires once per rest, and does not collide with the other two causes", async () => {
  const h = parkHarness([{ kind: "for", value: "2h" }, { kind: "reason", value: "waiting" }])
  try {
    for (let i = 0; i < 4; i++) await h.s.tick()
    assert.equal(h.queued().length, 1, "one rest, one nameless bump")
  } finally { h.close() }
})

// A RETIRED LINE KIND IS BLOCKED BY NAME, not silently ignored (maintainer 2026-08-17: "BLOCK THEM with
// an error message… tell them what is now supported").
//
// A worker's contract is frozen at dispatch, so every session started before the 2026-08-15 cut keeps
// writing the old kinds. A deleted kind does not parse, so it falls into the fence BODY as prose and the
// fence silently becomes a park naming nothing — and the worker cannot see WHICH line frizz ignored, so
// it writes the same one again. That produced three separate bug reports in two days, one of them a Goal
// loop re-writing `pr-watch:` every six seconds.
test("a fence using a RETIRED kind is bumped by name, with what replaced it", async () => {
  // The exact shape from the looping thread: the deleted kind lands in the body, hints are empty.
  const h = parkHarness([], { body: "pr-watch: pullfrog/app#1221\nDrift check re-run: CI green." })
  try {
    await h.s.tick()
    const rows = h.queued()
    assert.equal(rows.length, 1)
    assert.match(rows[0].fence_id, /^park:retired:/, "its own cause, so it cannot collide with the others")
    // NAMES THE OFFENDING LINE. "Your fence names nothing" was true but not actionable — the worker
    // could not tell which of its lines frizz had dropped.
    assert.match(rows[0].message, /`pr-watch:` is GONE/)
    assert.match(rows[0].message, /mcp__frizz__watch_pr/, "…and what to do instead")
    // AND THE WHOLE SUPPORTED SET, so the answer does not depend on the worker's frozen contract.
    for (const kind of ["shell:", "agent:", "timer:", "pr:", "for:", "reason:"]) {
      assert.ok(rows[0].message.includes(kind), `the supported set must name ${kind}`)
    }
    assert.match(rows[0].message, /REQUIRED — a DURATION, never an instant/)
  } finally { h.close() }
})

// A CORRECTION CARRIES THE IDS, not a tool name. A worker dispatched before `mcp__frizz__activity`
// existed cannot call it — its MCP server is frozen at dispatch — and those are exactly the threads still
// writing fences this check refuses. Telling them to call it was pointing the whole affected population
// at a remedy they do not have.
test("a correction prints the live ids inline, ready to copy into a fence", async () => {
  const h = parkHarness([{ kind: "shell", value: "bGONE" }, { kind: "for", value: "2h" }], { shells: [LIVE_SHELL] })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /Background shells still running:/)
    // The COPYABLE form — the exact line the worker should have written, by the id the runtime showed it.
    assert.match(msg, /`shell: bzvtnt3ig`/, "the id, in the shape a fence line takes")
  } finally { h.close() }
})

// …and when there is genuinely nothing out, that is the answer rather than an empty list. This is the
// commonest nameless fence: a worker "waiting" on nothing at all.
test("a nameless fence with nothing running is told it is not awaiting at all", async () => {
  const h = parkHarness([{ kind: "for", value: "24h" }, { kind: "reason", value: "waiting on the merge" }])
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    assert.match(msg, /You have NOTHING running right now/)
    assert.match(msg, /finish in\s*```done, or ask a ```question/s)
  } finally { h.close() }
})

// THE CORRECTION IS CAPPED, because a correction only helps a worker that can act on it.
//
// Every test above ticks against ONE rest, where the delivery id alone bounds the bump. The loop lives in
// the shape they cannot express: the worker WAKES, cannot write a fence this grammar accepts — its
// contract froze before the grammar existed — and rests again under a NEW instant, which is a new
// delivery id and so a new bump. Closed loop, no dedupe reached.
//
// Measured on the live board 2026-08-17: `investigate-nubjs-nub-656` had taken 617 corrective bumps in
// 4h45m, one every ~28 seconds, and two more threads were doing the same. Every other parked thread on
// that board had taken exactly one.
function loopHarness(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-parkloop-"))
  const storage = createStorage(join(dir, "ui.db"))
  storage.setSetting("signoffNudge", "off")
  const slug = "looping"
  storage.upsertSession({
    slug, session_id: "sid", tmux_name: `frizz-${slug}`, spawned_at: "2026-08-17T11:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: new Date().toISOString(),
    title_auto: 0, title: null, state: "open", meta: null, seen_at: null, plan_path: null,
    transcript_id: null,
  } as SessionRow)
  // The worker's own last word, advanced by `restAgain()` to model a wake that changes nothing.
  let restedAt = new Date(Date.now() - 60_000).toISOString()
  const s = createScheduler({
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastAssistantAt: restedAt, lastActivityAt: restedAt,
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        lastFence: { kind: "awaiting", body, hints: [] },
      }),
    } as never,
    resume: async () => {},
    log: () => {},
  })
  return {
    s, storage,
    restAgain: () => { restedAt = new Date(Date.parse(restedAt) + 30_000).toISOString() },
    bumps: () => (storage.db.prepare("SELECT COUNT(*) n FROM wake_delivery WHERE thread_slug = ?").get(slug) as { n: number }).n,
    close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("a worker that cannot act on the correction is corrected a few times, then left alone", async () => {
  const h = loopHarness("pr-watch: a/b#1")
  try {
    // Twelve rests it never learns from. Uncapped this is twelve bumps — and in production it was 617.
    for (let i = 0; i < 12; i++) {
      await h.s.tick()
      h.restAgain()
    }
    const n = h.bumps()
    assert.ok(n > 0, "it is still told — a silent refusal is the bug this source exists to fix")
    assert.ok(n <= 3, `the correction is bounded, got ${n} bumps from 12 unlearning rests`)
  } finally { h.close() }
})

// …and the allowance comes BACK, so the cap cannot silently retire the check on a long-lived thread that
// makes one mistake early and another one hours later.
test("an honoured park gives the corrective allowance back", async () => {
  const h = loopHarness("pr-watch: a/b#1")
  try {
    for (let i = 0; i < 6; i++) { await h.s.tick(); h.restAgain() }
    const spent = h.bumps()
    assert.ok(spent > 0 && spent <= 3, "capped first")
    h.storage.resetParkBumps("looping") // what an honoured park does, exercised directly
    for (let i = 0; i < 6; i++) { await h.s.tick(); h.restAgain() }
    assert.ok(h.bumps() > spent, "a thread that came right is corrected again when it errs again")
  } finally { h.close() }
})

test("every retired kind is recognized, and a repeat teaches once", async () => {
  const h = parkHarness([], { body: "watch: b1\nhuman: Alice\nci: build 9\nsession: s1\npr-watch: a/b#1\npr-watch: a/b#2" })
  try {
    await h.s.tick()
    const msg = h.queued()[0].message
    for (const k of ["watch:", "human:", "ci:", "session:", "pr-watch:"]) {
      assert.ok(msg.includes(`\`${k}\` is GONE`), `${k} must be named`)
    }
    // Two `pr-watch:` lines are ONE thing to learn.
    assert.equal(msg.match(/`pr-watch:` is GONE/g)?.length, 1, "deduped by kind, not by line")
  } finally { h.close() }
})
