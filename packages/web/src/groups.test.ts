import { test } from "node:test"
import assert from "node:assert/strict"
import type { ThreadView } from "@frizz/shared"
import { needsAction, queued, orderQueue, partitionActive, sectionOf, sectionThreads, isHeld, sessionIndicatorKind, offersRetry, titleIsProvisional, displayTitle, lastActiveLabelAt, SPINNING_UP_TITLE, UNTITLED_THREAD_TITLE } from "./groups.ts"

// Minimal ThreadView fixture — the same shape board-delta.test.ts uses, defaulting to a live/active
// thread; each case overrides only the fields under test.
function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: "t",
    title: "t",
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    pendingQuestion: false,
    spawnedAt: "2026-07-08T00:00:00.000Z",
    ...over,
  }
}

// ---- needsAction: the queue definition ----

test("needsAction: needs-human AT REST cards — but only with a SESSION (humanBlocked derived from status)", () => {
  // humanBlocked is re-derived server-side as status === "needs-human"; the client sees the flag.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "turn-idle" })), true)
  // exited still cards: that agent RAN and asked here — the ask is in its transcript.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "exited" })), true)
})

test("needsAction: SESSION-LESS needs-human NEVER cards (the queue is agent work paused on the human)", () => {
  // A thread worked outside frizz (frizz classic / hand edits): no session, no transcript to card.
  // It surfaces in the SIDEBAR (yellow awaiting-you dot); its click-through composite (doc +
  // kick-off composer) is where it gets read and acted on.
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "none", spawnedAt: undefined })), false)
  // Even with a spawnedAt on the row, `none` + needs-human stays out of the queue (the crash net
  // only covers active/planning — verified below — so the two clauses never fight).
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "none" })), false)
})

test("needsAction: needs-human MID-TURN does NOT card (the ask text hasn't landed yet)", () => {
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "running" })), false)
  assert.equal(needsAction(thread({ status: "needs-human", humanBlocked: true, runtime: "spawning" })), false)
})

test("needsAction: perm-prompt always cards (a frozen worker can't declare anything)", () => {
  assert.equal(needsAction(thread({ runtime: "perm-prompt" })), true)
})

test("needsAction: a chat question at rest cards; mid-turn it does not", () => {
  assert.equal(needsAction(thread({ pendingQuestion: true, runtime: "turn-idle" })), true)
  assert.equal(needsAction(thread({ pendingQuestion: true, runtime: "running" })), false)
})

test("needsAction: `unread` no longer drives carding (unread is dead)", () => {
  // A completed turn on a still-live thread badged unread — pure progress, never a card.
  assert.equal(needsAction(thread({ unread: true, runtime: "turn-idle" })), false)
  assert.equal(needsAction(thread({ unread: true, runtime: "running" })), false)
})

test("needsAction: crash net — a spawned agent gone while IN-FLIGHT (active/planning) cards", () => {
  assert.equal(needsAction(thread({ status: "active", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), true)
  assert.equal(needsAction(thread({ status: "planning", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), true)
})

test("needsAction: crash net does NOT card a `blocked` MACHINE-wait whose session was cleaned up", () => {
  // blocked = waiting on revalidate_at / blocking_threads. killAgent / reboot kills the tmux session
  // (runtime exited/none, spawnedAt set) — but the agent is LEGITIMATELY absent, not crashed. It must
  // NOT card and must NOT steal the blue dot from its timer/threads glyph (Nav short-circuits on this).
  assert.equal(needsAction(thread({ status: "blocked", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z", mechanism: "timer" })), false)
  assert.equal(needsAction(thread({ status: "blocked", runtime: "none", spawnedAt: "2026-07-08T00:00:00.000Z", mechanism: "threads" })), false)
})

test("needsAction: crash net does NOT flood never-spawned roadmap items", () => {
  // runtime none + no spawnedAt = a planned/planning item no agent ever touched → not a crash.
  assert.equal(needsAction(thread({ status: "planned", runtime: "none", spawnedAt: undefined })), false)
  assert.equal(needsAction(thread({ status: "planning", runtime: "none", spawnedAt: undefined })), false)
  // A spawned `planned` (backlog) thread whose agent exited is NOT mid-work → does not card.
  assert.equal(needsAction(thread({ status: "planned", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
})

test("needsAction: an ARCHIVED thread never crash-cards (even if its archive→done write raced)", () => {
  assert.equal(needsAction(thread({ status: "active", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z", archived: true })), false)
})

test("needsAction: terminal threads NEVER card, even exited-with-spawn (crash net can't win)", () => {
  assert.equal(needsAction(thread({ status: "done", runtime: "exited", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
  assert.equal(needsAction(thread({ status: "dismissed", runtime: "exited", unread: true })), false)
})

// ---- queued: the session-first queue definition (server-derived t.needsYou) ----

test("queued: a session thread with needsYou cards; without it, it does not", () => {
  assert.equal(queued(thread({ kind: "session", needsYou: true, state: "open" })), true)
  assert.equal(queued(thread({ kind: "session", needsYou: false, state: "open" })), false)
})

test("queued: a server-marked checked/done thread cards and keeps its active checked presentation", () => {
  const done = thread({
    kind: "session",
    needsYou: true,
    state: "open",
    lastFence: { kind: "done", body: "shipped", hints: [] },
  })
  assert.equal(queued(done), true)
  assert.equal(sectionOf(done), "active")
  assert.equal(sessionIndicatorKind(done), "done")
})

test("sessionIndicatorKind: bare queued rest stays rest while concrete input states use question styling", () => {
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, runtime: "turn-idle" })), "rest")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, pendingQuestion: true, runtime: "exited" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, pendingAsk: { questions: [] }, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, nativeInputRequired: { kind: "permission", title: "Permission required" }, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, actionableInteraction: true, runtime: "turn-idle" })), "needs-input")
  assert.equal(sessionIndicatorKind(thread({ needsYou: true, status: "needs-human", humanBlocked: true, runtime: "exited" })), "needs-input")
  // STALLED keys on the PROCESS being gone (runtime "exited"), NOT on the server's `crashed` bit —
  // a mid-turn death and an exit at bare rest are equally stopped and need the same verb, so all three
  // `crashed` shapes (true / false / absent on an older snapshot) render the same [!].
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: true, runtime: "exited" })), "stalled")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: false, runtime: "exited" })), "stalled")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: undefined, runtime: "exited" })), "stalled")
  // …and a thread with no retryable process behind it is never stalled, however `crashed` reads.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", foreign: true, needsYou: true, crashed: true, runtime: "exited" })), "rest")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", needsYou: true, crashed: true, runtime: "none" })), "rest")
  // A live SUB-AGENT is live work → "working", beating the future-timer held state.
  assert.equal(sessionIndicatorKind(thread({ runtime: "turn-idle", subAgents: liveSub, lastFence: awaitingTimer })), "working")
  // A live background SHELL is NOT live work by itself (2026-07-22 — `bgShells` is telemetry, and the
  // server's awaitingBackground is what speaks for the thread): the future-timer wait shows through as "held".
  assert.equal(sessionIndicatorKind(thread({ runtime: "turn-idle", bgShells: liveShell, lastFence: awaitingTimer })), "held")
  assert.equal(sessionIndicatorKind(thread({ state: "archived", needsYou: true, runtime: "exited" })), "archived")
})

// A worker that comes to rest and lands in the queue reads AT REST on the rail, even while the
// sub-agents it dispatched keep running (maintainer 2026-07-27). The children still spin — on their
// OWN indented rows — but the parent's mark speaks for the parent, and the parent has handed off.
test("sessionIndicatorKind: a rested QUEUED thread is at rest even with live sub-agents", () => {
  const restedInQueue = thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", subAgents: liveSub })
  assert.equal(sessionIndicatorKind(restedInQueue), "rest")
  // …and it stays in the undimmed Active section's RESTED band: only the glyph changed.
  assert.equal(sectionOf(restedInQueue), "active")
  assert.equal(isHeld(restedInQueue), false)
  assert.equal(partitionActive([restedInQueue]).rested.length, 1)

  // NOTHING else collapses into the ellipsis:
  // • the parent's OWN turn in flight still spins, queued or not
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, runtime: "running" })), "working")
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, runtime: "spawning" })), "working")
  // • a rested thread with live children that is NOT a handoff (event-snoozed card, no queue entry)
  //   keeps its spinner — that row is genuinely just cooking, and the child's return will re-invoke it
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, needsYou: false })), "working")
  // • a concrete ask still wins the row
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, pendingQuestion: true })), "needs-input")
  // • a done fence still reads as the completed handoff
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, lastFence: { kind: "done", body: "shipped", hints: [] } })), "done")
  // • a parked wait keeps its hourglass (needsYou is false there — the server holds it out of the queue)
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, needsYou: false, subAgents: [], lastFence: awaitingHuman })), "held")
  // • an EXITED parent with children still reading "running" is a stall, not a rest
  assert.equal(sessionIndicatorKind(thread({ ...restedInQueue, runtime: "exited" })), "stalled")
})

// THE SHELL-ONLY REST — maintainer 2026-08-01: "if a thread has rested but it still has background work
// going, like background shells, we should … stop the spinner and put a pulsing blue dot in the middle
// of the rounded circle shape" — and, decisively, "this should not show up if there are sub-agents". So
// the two live-work states are told apart rather than merged: a dispatched CHILD will come back and
// re-invoke the parent (real motion → spinner), a detached SHELL will not (alive but still → dot).
//
// The MARK outlived the BAND. Since 2026-08-04 such a thread QUEUES ("if a thread has rested and the
// only thing remaining is background shells, we should put it into the queue"), so `needsYou` puts its
// row below the rule — and the dot stays, because it is what tells that row apart from a bare rest.
test("sessionIndicatorKind: a queued shell-only rest sits in the rested band and still wears the dot", () => {
  // needsYou TRUE is server truth for this state, not an assumption: board.deriveNeedsYou excuses a rest
  // on a live SUB-AGENT only, so a shell-only rest is an ordinary queue handoff again.
  const shellRest = thread({ kind: "session", state: "open", needsYou: true, runtime: "turn-idle", awaitingBackground: true, bgShells: liveShell })
  assert.equal(sessionIndicatorKind(shellRest), "background", "the dot outranks the 2026-07-27 queued-rest ellipsis")
  assert.equal(queued(shellRest), true)
  assert.deepEqual(partitionActive([shellRest]).rested.map((t) => t.id), ["t"], "a card must have a rested-band row")

  // SNOOZED — the card's own event-Snooze clears needsYou (board.bgSnoozeArmed) while the thread stays
  // alive. It goes back to the running band wearing the SAME dot: still alive, no longer asking.
  const snoozed = thread({ ...shellRest, needsYou: false })
  assert.equal(sessionIndicatorKind(snoozed), "background")
  assert.deepEqual(partitionActive([snoozed]).running.map((t) => t.id), ["t"])
  assert.equal(queued(snoozed), false, "a row in the running band must never also be a queue card")

  // A LIVE SUB-AGENT OUTRANKS THE SHELL — the dot must not show up for it, however the shell reads.
  const withChild = thread({ ...shellRest, needsYou: false, subAgents: liveSub })
  assert.equal(sessionIndicatorKind(withChild), "working", "a dispatched child is real motion — it spins")
  assert.equal(sessionIndicatorKind(thread({ ...withChild, needsYou: true })), "rest", "…and queued, it is the 2026-07-27 ellipsis, still never the dot")

  // The shell going quiet leaves an ordinary rest — same band, the plain ellipsis, still queued.
  const settled = thread({ ...shellRest, awaitingBackground: false, bgShells: [] })
  assert.equal(sessionIndicatorKind(settled), "rest")
  assert.equal(queued(settled), true)
  assert.deepEqual(partitionActive([settled]).rested.map((t) => t.id), ["t"])
  // An EXITED worker whose shell still reads live is a stall, not a quietly-alive row.
  assert.equal(sessionIndicatorKind(thread({ ...shellRest, runtime: "exited" })), "stalled")
})

// A RECURRING PROMPT IS NOT A RAIL FACT — maintainer 2026-08-02, killing a mark that had shipped hours
// earlier: "the whole point of a stop hook is that it means the agent never stops, so it should always
// just be loading." (Said of the rest trigger, back when it was its own feature; it binds the merged
// control the same way, and the schedule trigger only makes it truer.)
//
// Exactly right, and the mark could only ever have contradicted it. `working` outranks everything below
// it, so the mark renders only in the at-rest gap — and a live prompt barely has one (the thread is
// bumped again within a tick of stopping). The at-rest state that does last is the thread whose agent
// answered ALLDONE, i.e. the loop that just CLOSED. The mark was invisible while the prompt was doing
// its job and visible only once it had stopped doing it.
//
// So an armed thread's rail row is whatever it would have been anyway: spinning while it works, at rest
// when it is genuinely done. This test is the guard against reintroducing the mark.
test("sessionIndicatorKind: an armed recurring prompt changes NO rail mark", () => {
  const hook = { prompt: "keep going", stopHook: true, heartbeat: false, armedAt: "2026-07-10T00:00:00.000Z" }
  const base = { kind: "session" as const, state: "open" as const, needsYou: false, runtime: "turn-idle" as const }

  // At rest with a hook armed: the ordinary at-rest ellipsis, exactly as without one.
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook })), "rest")
  assert.equal(sessionIndicatorKind(thread({ ...base })), "rest")
  // Disabled likewise.
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: { ...hook, stopHook: false } })), "rest")
  // And every other state keeps the mark it earned on its own terms.
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook, subAgents: liveSub })), "working")
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook, awaitingBackground: true, bgShells: liveShell })), "background")
  assert.equal(sessionIndicatorKind(thread({ ...base, recurringPrompt: hook, needsYou: true, pendingQuestion: true })), "needs-input")
})

// THE INVARIANT, stated once and checked over every shape the rail can produce (maintainer 2026-08-01:
// "if something is listed as currently running, then it should never show up in the queue"). It holds by
// CONSTRUCTION — inActiveBand is `isActivelyRunning && !needsYou`, and `queued` is `needsYou` —
// so this test is really guarding the construction: any future clause that bands a row on something
// OTHER than the absence of a queue card breaks it here.
test("partitionActive: NOTHING in the running band has a queue card, and every card has a rested-band row", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const base = { kind: "session" as const, state: "open" as const, lastUserAt: at }
  const shapes = [
    thread({ ...base, id: "own-turn", runtime: "running", needsYou: false }),
    thread({ ...base, id: "spawning", runtime: "spawning", needsYou: false }),
    thread({ ...base, id: "rested-on-child", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: liveSub }),
    // Shell-only, EVENT-SNOOZED — the one shape that still bands here since shells re-queued on
    // 2026-08-04. Its unsnoozed twin is `queued-on-shell` below.
    thread({ ...base, id: "snoozed-on-shell", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgShells: liveShell }),
    thread({ ...base, id: "queued-on-shell", runtime: "turn-idle", needsYou: true, awaitingBackground: true, bgShells: liveShell }),
    thread({ ...base, id: "bare-rest", runtime: "turn-idle", needsYou: true }),
    thread({ ...base, id: "asking", runtime: "turn-idle", needsYou: true, pendingQuestion: true }),
    thread({ ...base, id: "stalled", runtime: "exited", needsYou: true }),
    thread({ ...base, id: "done-fenced", runtime: "turn-idle", needsYou: true, lastFence: { kind: "done", body: "shipped", hints: [] } }),
    // The rare spinning-yet-queued shape: its own turn is in flight AND the server queued it.
    thread({ ...base, id: "spin-ask", runtime: "running", needsYou: true }),
  ]
  const { running, rested } = partitionActive(shapes)
  assert.equal(running.length + rested.length, shapes.length, "every thread lands in exactly one band")
  for (const t of running) assert.equal(queued(t), false, `${t.id} is in the running band but carries a queue card`)
  for (const t of shapes.filter(queued)) {
    assert.ok(rested.some((r) => r.id === t.id), `${t.id} has a queue card but no rested-band row to map it to`)
  }
  // …and the rested-with-live-work rows are exactly the ones that made this worth pinning: the excused
  // child and the snoozed shell band on top, while the QUEUED shell sits below the rule with its card.
  assert.deepEqual(running.map((t) => t.id), ["own-turn", "spawning", "rested-on-child", "snoozed-on-shell"])
})

// ── THE STALLED/RETRY CONTRACT ────────────────────────────────────────────────────────────────────
// The queue card's Retry button and the sidebar row's yellow [!] must be ONE decision. They were not:
// the card gated on "the process exited" while the row gated on the server's `crashed` bit (exited AND
// turn-in-flight/live-background-work), so a worker that exited at BARE REST carried a Retry button on
// its card while its rail row read a calm "At rest" […] (maintainer 2026-07-23: "the card in the queue
// has a retry button, but it's not marked as stalled in the sidebar with the yellow and the exclamation
// point"). This table is the enumeration that found it; the invariant below is what keeps it fixed.
const RETRY_CONTRACT: { name: string; over: Partial<ThreadView>; kind: string; retry: boolean }[] = [
  // ── the states that must show BOTH the [!] and the Retry ──
  { name: "exited mid-turn (crashed) — the classic stall", over: { needsYou: true, crashed: true, runtime: "exited" }, kind: "stalled", retry: true },
  // THE REGRESSION: this row said kind "rest" (no badge) while its card offered Retry.
  { name: "exited at bare rest (crashed:false, no done fence)", over: { needsYou: true, crashed: false, runtime: "exited" }, kind: "stalled", retry: true },
  { name: "exited on a pre-reload snapshot with no `crashed` field", over: { needsYou: true, runtime: "exited" }, kind: "stalled", retry: true },
  { name: "exited at rest and NOT queued (needsYou cleared)", over: { needsYou: false, crashed: false, runtime: "exited" }, kind: "stalled", retry: true },
  // ── the states that must show NEITHER ──
  { name: "live and working", over: { runtime: "running" }, kind: "working", retry: false },
  { name: "live at rest (turn-idle) — type at it, don't retry", over: { needsYou: true, crashed: false, runtime: "turn-idle" }, kind: "rest", retry: false },
  { name: "exited mid-ask — answered, not retried", over: { needsYou: true, crashed: true, humanBlocked: true, status: "needs-human", runtime: "exited" }, kind: "needs-input", retry: false },
  { name: "exited with a pending question", over: { needsYou: true, pendingQuestion: true, runtime: "exited" }, kind: "needs-input", retry: false },
  { name: "exited after a done fence — finished, not stopped", over: { runtime: "exited", lastFence: { kind: "done", body: "shipped", hints: [] } }, kind: "done", retry: false },
  { name: "exited but snoozed — held, wakes on its own deadline", over: { runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z" }, kind: "held", retry: false },
  { name: "archived", over: { state: "archived", needsYou: true, crashed: true, runtime: "exited" }, kind: "archived", retry: false },
  { name: "foreign (read-only — nothing frizz can restart)", over: { foreign: true, crashed: true, needsYou: true, runtime: "exited" }, kind: "rest", retry: false },
  { name: "registry lost the row (runtime none — not reattachable)", over: { needsYou: true, crashed: true, runtime: "none" }, kind: "rest", retry: false },
  // ── HELD by a usage limit frizz will auto-resume: keeps the hourglass mark, but ALSO offers Retry ──
  // (maintainer 2026-07-23) — the one-click continue is a faster door to the in-drawer "Continue now".
  { name: "held on a session limit (auto-resume) — retry without the [!]", over: { runtime: "exited", limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "held", retry: true },
  { name: "held on a weekly limit (auto-resume) — same one-click continue", over: { runtime: "exited", limitPause: { backend: "codex", window: "weekly", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "held", retry: true },
  // A limit pause frizz will NOT auto-resume is not held — it fell through to the ordinary handoff, and
  // with its process exited it is a plain stall, already carrying Retry via the stalled branch.
  { name: "limit pause without auto-resume — plain stall, not a held park", over: { needsYou: true, runtime: "exited", limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: false } }, kind: "stalled", retry: true },
  // A FOREIGN read-only session parked on a limit still reads as held, but is nothing frizz can restart.
  { name: "foreign held on a limit — read-only, no retry", over: { foreign: true, runtime: "exited", limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: true } }, kind: "held", retry: false },
]

test("offersRetry: the retry gate is the stalled state PLUS the auto-resume usage-limit park", () => {
  for (const { name, over, kind, retry } of RETRY_CONTRACT) {
    const t = thread({ kind: "session", ...over })
    assert.equal(sessionIndicatorKind(t), kind, `${name}: sidebar indicator`)
    assert.equal(offersRetry(t), retry, `${name}: inline retry`)
  }
  assert.equal(offersRetry(thread({ kind: "legacy", crashed: true, runtime: "exited" })), false, "legacy: no provider runtime")
})

test("every surface shares the ONE offersRetry derivation — the retry verb is stalled OR limit-held", () => {
  // The load-bearing invariant is that the sidebar row, queue card, and drawer header ALL read
  // offersRetry, so no two can disagree about a thread (the drift bug, maintainer 2026-07-23, twice).
  // The verb is DELIBERATELY broader than the yellow [!]: a usage-limit park keeps its hourglass mark
  // yet still offers the one-click continue. So the pairing to pin is retry ⇔ (stalled OR limit-held),
  // NOT retry ⇔ stalled — and a held row that offers retry must be a limit park, never a snooze/timer.
  for (const { name, over } of RETRY_CONTRACT) {
    const t = thread({ kind: "session", ...over })
    const kind = sessionIndicatorKind(t)
    const limitHeld = kind === "held" && t.foreign !== true && Boolean(t.limitPause?.autoResume)
    assert.equal(
      offersRetry(t),
      kind === "stalled" || limitHeld,
      `${name}: Retry is offered on exactly the stalled and auto-resume-limit-held rows`,
    )
  }
  // A held row parked by something OTHER than a limit frizz will auto-resume (a user snooze, a timer
  // wait) must NEVER offer Retry — those are intentional parks with no stall to recover.
  assert.equal(offersRetry(thread({ kind: "session", runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z" })), false, "snooze-held: no retry")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", runtime: "exited", snoozedUntil: "2999-01-01T00:00:00.000Z" })), "held", "snooze-held: still held")
})

test("queued: legacy rows NEVER card (only session threads enter the queue)", () => {
  // kind absent = legacy; even a would-be-actionable legacy row stays out of the queue.
  assert.equal(queued(thread({ needsYou: true, status: "needs-human", humanBlocked: true })), false)
  assert.equal(queued(thread({ kind: "legacy", needsYou: true })), false)
})

test("queued: an archived session thread stays out of the queue even if needsYou lingers", () => {
  assert.equal(queued(thread({ kind: "session", needsYou: true, state: "archived" })), false)
})

test("queued: pre-restart snapshot (no kind/needsYou) degrades to an empty queue", () => {
  assert.equal(queued(thread({})), false)
})

test("orderQueue: NO priority band — one strict time order across attention + passive alike", () => {
  // The hidden hard-attention band is gone (maintainer 2026-07-21: "too confusing"). Order is
  // last-active alone; kind (crash/question vs done/rest) never lifts a card into a separate tier.
  // The timestamps deliberately INTERLEAVE attention and passive rows so BOTH directions differ from
  // the old banded order — proving band removal, not just re-proving FIFO:
  //   crash-newest 07-14 (hard) · done-newer 07-13 (passive) · question-older 07-11 (hard) · rest-oldest 07-10 (passive)
  // Old banded FIFO would be [question-older, crash-newest, rest-oldest, done-newer]; old banded LIFO
  // [crash-newest, question-older, done-newer, rest-oldest]. Both differ from the strict orders below.
  const rows = () => [
    thread({ id: "crash-newest", lastUserAt: "2026-07-14T12:00:00.000Z", crashed: true }),
    thread({ id: "done-newer", lastUserAt: "2026-07-13T12:00:00.000Z", lastFence: { kind: "done", body: "shipped", hints: [] } }),
    thread({ id: "question-older", lastUserAt: "2026-07-11T12:00:00.000Z", pendingQuestion: true }),
    thread({ id: "rest-oldest", lastUserAt: "2026-07-10T12:00:00.000Z" }),
  ]
  // FIFO oldest-first: the fresh CRASH sinks to the BOTTOM under an older done card — the accepted tradeoff.
  assert.deepEqual(orderQueue(rows()).map((item) => item.id), ["rest-oldest", "question-older", "done-newer", "crash-newest"])
  // LIFO newest-first: a newer DONE card outranks an older question — impossible under the old band.
  assert.deepEqual(orderQueue(rows(), "lifo").map((item) => item.id), ["crash-newest", "done-newer", "question-older", "rest-oldest"])
})

test("orderQueue: AT-REST rows key on REST TIME (lastAssistantAt), not lastActivityAt; direction flips it", () => {
  // The row that came to REST later (later lastAssistantAt = its final assistant output) is more
  // recently active. Ordering keys on this, NOT lastActivityAt — even though a much-later lastActivityAt
  // (a background sub-agent's completion notification) is present, it must NOT move the row. FIFO
  // (default) leads with the longest-since-rested (earlier-rested) row.
  const rows = () => [
    thread({ id: "rested-later", lastUserAt: "2026-07-14T12:00:00.000Z", lastAssistantAt: "2026-07-14T12:05:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" }),
    thread({ id: "rested-earlier", lastUserAt: "2026-07-14T12:00:00.000Z", lastAssistantAt: "2026-07-14T12:01:00.000Z", lastActivityAt: "2026-07-14T13:30:00.000Z" }),
  ]
  assert.deepEqual(orderQueue(rows()).map((item) => item.id), ["rested-earlier", "rested-later"])
  // LIFO surfaces the most recently rested first.
  assert.deepEqual(orderQueue(rows(), "lifo").map((item) => item.id), ["rested-later", "rested-earlier"])
})

test("orderQueue: a background sub-agent completing (lastActivityAt bump) does NOT reorder an at-rest row", () => {
  // The exact regression: a completed sub-agent posts a promptSource:system record that bumps the
  // parent's lastActivityAt but NOT its lastAssistantAt (rest time). Since ordering keys on rest time,
  // the parent's position is invariant to that child motion. Equal rest times ⇒ id tiebreak holds
  // no matter how recent the child-driven lastActivityAt is.
  const rows = (childActivity: string) => [
    thread({ id: "bravo", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: childActivity }),
    thread({ id: "alpha", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: childActivity }),
  ]
  assert.deepEqual(orderQueue(rows("2026-07-14T12:00:01.000Z")).map((item) => item.id), ["alpha", "bravo"])
  assert.deepEqual(orderQueue(rows("2026-07-14T18:00:00.000Z")).map((item) => item.id), ["alpha", "bravo"])
})

test("orderQueue: high-frequency agent activity on a RUNNING row cannot oscillate order (churn guard)", () => {
  // A running row keys off its STABLE user-interaction time, never the churning lastActivityAt — so
  // tool_result motion the user didn't cause can never reorder it. Equal lastUserAt/spawnedAt ⇒ the
  // id tiebreak holds regardless of how fast lastActivityAt advances.
  const rows = (activity: string) => [
    thread({ id: "bravo", runtime: "running", lastUserAt: "2026-07-14T12:00:00.000Z", lastActivityAt: activity }),
    thread({ id: "alpha", runtime: "running", lastUserAt: "2026-07-14T12:00:00.000Z", lastActivityAt: activity }),
  ]
  assert.deepEqual(orderQueue(rows("2026-07-14T12:00:01.000Z")).map((item) => item.id), ["alpha", "bravo"])
  assert.deepEqual(orderQueue(rows("2026-07-14T12:09:00.000Z")).map((item) => item.id), ["alpha", "bravo"])
})

test("lastActiveLabelAt: at-rest shows REST time, running shows live activity, sub-agent bump ignored at rest", () => {
  // At rest → the agent's own rest time (lastAssistantAt), NOT the later lastActivityAt a completed
  // sub-agent bumped. So the label reads "when the agent rested", never a spurious "just now".
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "turn-idle", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" })),
    "2026-07-14T12:00:00.000Z",
  )
  // Running → live activity (a running row IS active now), matching the spinner.
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "running", lastAssistantAt: "2026-07-14T12:00:00.000Z", lastActivityAt: "2026-07-14T13:00:00.000Z" })),
    "2026-07-14T13:00:00.000Z",
  )
  // At rest with no recorded rest instant → falls back to lastActivityAt, then spawn.
  assert.equal(
    lastActiveLabelAt(thread({ runtime: "turn-idle", lastAssistantAt: undefined, lastActivityAt: "2026-07-14T11:00:00.000Z" })),
    "2026-07-14T11:00:00.000Z",
  )
})

// ---- sidebar sections: session-first partition ----

test("sectionOf: running/needs-you land in the Active+Rested section; only truthful human/future-timer waits are Held", () => {
  // Legacy / absent-kind rows are HIDDEN entirely (null), any status.
  assert.equal(sectionOf(thread({ status: "active" })), null)
  assert.equal(sectionOf(thread({ kind: "legacy", status: "done" })), null)
  // Open in-play work stays in the Active+Rested section: running, at-rest bare, needs-you, done-fenced.
  // Which BAND each lands in is partitionActive's job, not this key's — a needs-you row is RESTED, not Active.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "running" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "done", body: "shipped", hints: [] } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), "active")
  // Archive wins over a lingering needsYou.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived" })), "inactive")
  assert.equal(sectionOf(thread({ kind: "session", needsYou: true, state: "archived" })), "inactive")
  // Foreign sessions section as active by sectionOf — but sectionThreads EXCLUDES them from rows.
  assert.equal(sectionOf(thread({ kind: "session", foreign: true, runtime: "running" })), "active")
})

test("sectionOf: an ARCHIVED thread that's ACTIVELY RUNNING goes to Active (never a spinner under Inactive)", () => {
  // Idle-archived stays Inactive — the user hid it and it's at rest.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle" })), "inactive")
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "exited" })), "inactive")
  // Running / spawning archived → Active (a live, in-flight session must NEVER sit in Inactive; maintainer hit 3×).
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "running" })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "spawning" })), "active")
  // turn-idle but a dispatched sub-agent is still going (the sidebar shows a spinner) → Active too.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", subAgents: [{ label: "x", startedAt: "2026-07-10T00:00:00.000Z", state: "running", id: "a1" }] })), "active")
  // A live background Bash/Monitor is NOT live work (2026-07-22): an idle-archived thread with only a
  // background shell stays Inactive — the shell can't be told apart from an endless dev server.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", bgShells: [{ label: "watch CI", startedAt: "2026-07-10T00:00:00.000Z", state: "running" }] })), "inactive")
})

test("sectionThreads v2: Active bands rested-on-top (queue order) then running; foreign + legacy excluded", () => {
  const s = sectionThreads([
    thread({ id: "older", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "newer", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T01:00:00.000Z" }),
    thread({ id: "queued", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-09T02:00:00.000Z" }),
    thread({ id: "arch", kind: "session", state: "archived" }),
    thread({ id: "old", status: "done" }),
    thread({ id: "term", kind: "session", foreign: true, runtime: "running" }),
  ])
  // The CUE leads (the rested rows, in queue order, sit directly under the prompt box); the running
  // band follows BELOW it, ordered by interaction recency (newer before older).
  assert.deepEqual(s.active.map((t) => t.id), ["queued", "newer", "older"])
  assert.deepEqual(s.inactive.map((t) => t.id), ["arch"])
  assert.equal("legacy" in s, false)
})

test("partitionActive: splits an ordered Active list into running/rested; queued stays rested; FIFO within rested", () => {
  // A queued thread that ALSO reads as actively running (spinning-yet-needs-you) still files under
  // rested so its queue card maps to a rested-band row.
  const active = [
    thread({ id: "run-b", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-09T00:00:00.000Z" }),
    thread({ id: "run-a", kind: "session", state: "open", runtime: "spawning", lastUserAt: "2026-07-08T00:00:00.000Z" }),
    thread({ id: "rest-old", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-05T00:00:00.000Z" }),
    thread({ id: "rest-new", kind: "session", state: "open", needsYou: true, lastUserAt: "2026-07-11T00:00:00.000Z" }),
    thread({ id: "spin-ask", kind: "session", state: "open", runtime: "running", needsYou: true, lastUserAt: "2026-07-06T00:00:00.000Z" }),
  ]
  // orderQueue over the rested set is FIFO (oldest first): rest-old (07-05) < spin-ask (07-06) < rest-new (07-11).
  const ordered = [
    active[2], active[4], active[3], // the cue leads, in FIFO order
    active[0], active[1], // running band below it (already recency-ordered for this fixture)
  ]
  const { running, rested } = partitionActive(ordered)
  assert.deepEqual(running.map((t) => t.id), ["run-b", "run-a"])
  assert.deepEqual(rested.map((t) => t.id), ["rest-old", "spin-ask", "rest-new"])
})

// LIVE OWN WORK KEEPS THE ROW IN THE RUNNING BAND, and the server is what puts it there — by excusing it
// from the queue, which is the same thing. A live child is excused outright; a shell-only rest reaches
// this state only once the human snoozes its card (needsYou false is the shared precondition). They
// differ only in what the row READS as.
test("partitionActive: a thread cooking on its own background work, with no card, stays in the running band", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const shellOnly = thread({ id: "shell-only", kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: [], bgShells: liveShell, lastUserAt: at })
  const withChild = thread({ id: "with-child", kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: [{ id: "a1", label: "c", startedAt: at, state: "running" }], lastUserAt: at })
  const { running, rested } = partitionActive([shellOnly, withChild])
  assert.deepEqual(running.map((t) => t.id), ["shell-only", "with-child"])
  assert.deepEqual(rested.map((t) => t.id), [])
  // Same band, two different readings — and that split is deliberate: the shell is alive-but-still, the
  // dispatched child is motion that will come back.
  assert.equal(sessionIndicatorKind(shellOnly), "background")
  assert.equal(sessionIndicatorKind(withChild), "working")
})

// THE LAYOUT-SHIFT FIX (maintainer 2026-07-30): "if an agent has children that are still running child
// subprocesses or subagents, but it itself has rested, it should still stay in the active agent's rail
// instead of shifting down to the queue … it should only show up in the queue when it's fully rested and
// it has no running sub-agents". The server stops setting needsYou for that thread
// (board.deriveNeedsYou), and these are the two consequences on the rail that the human actually sees.
test("partitionActive: a parent resting on a live sub-agent holds its place in the running band", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const child = [{ id: "a1", label: "c", startedAt: at, state: "running" as const }]
  // Mid-turn, then rested-with-the-child-still-out: the SAME row, and it must not move between them.
  const working = thread({ id: "p", kind: "session", state: "open", runtime: "running", needsYou: false, subAgents: child, lastUserAt: at })
  const rested = thread({ id: "p", kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: child, lastUserAt: at })
  assert.deepEqual(partitionActive([working]).running.map((t) => t.id), ["p"])
  assert.deepEqual(partitionActive([rested]).running.map((t) => t.id), ["p"], "resting on a child must not drop it to the rested band")
  // FULLY rested — the last child returned — is the one state that belongs in the queue-ordered band.
  const done = thread({ id: "p", kind: "session", state: "open", runtime: "turn-idle", needsYou: true, subAgents: [], lastUserAt: at })
  assert.deepEqual(partitionActive([done]).rested.map((t) => t.id), ["p"])
})

test("sessionIndicatorKind: a parent resting on a live sub-agent keeps its spinner, so the row never flickers", () => {
  const at = "2026-07-09T00:00:00.000Z"
  const child = [{ id: "a1", label: "c", startedAt: at, state: "running" as const }]
  // Same glyph mid-turn and at rest-with-a-child — the point is that NOTHING about the row changes when
  // the parent's own turn ends, which is what removes the churn the maintainer reported. The 2026-08-01
  // dot deliberately does NOT reach here ("this should not show up if there are sub-agents").
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", runtime: "running", needsYou: false, subAgents: child })), "working")
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", runtime: "turn-idle", needsYou: false, awaitingBackground: true, subAgents: child })), "working")
  // The EXITED parent is the case restedQueueHandoff still protects: its children keep reading "running"
  // until they go stale, and it must read as a stall, never as a spinner.
  assert.equal(sessionIndicatorKind(thread({ kind: "session", state: "open", runtime: "exited", needsYou: true, subAgents: child })), "stalled")
})

// ---- isHeld: every rendered wait glyph belongs to the labeled dimmed Held band ----

const awaitingHuman = { kind: "awaiting" as const, body: "", hints: [{ kind: "human" as const, value: "Cloudflare maintainer must approve fork CI" }] }
const awaitingPrWatch = { kind: "awaiting" as const, body: "", hints: [{ kind: "pr-watch" as const, value: "owner/repo#12" }] }
const awaitingTimer = { kind: "awaiting" as const, body: "", hints: [{ kind: "timer" as const, value: "2099-07-15T17:00:00Z" }] }
const awaitingElapsedTimer = { kind: "awaiting" as const, body: "", hints: [{ kind: "timer" as const, value: "2020-07-15T17:00:00Z" }] }
const awaitingBadTimer = { kind: "awaiting" as const, body: "", hints: [{ kind: "timer" as const, value: "tomorrow-ish" }] }
const awaitingPr = { kind: "awaiting" as const, body: "", hints: [{ kind: "pr" as const, value: "owner/repo#12" }] }
const awaitingCi = { kind: "awaiting" as const, body: "", hints: [{ kind: "ci" as const, value: "build #4821" }] }
const liveSub = [{ label: "x", startedAt: "2026-07-10T00:00:00.000Z", state: "running" as const, id: "a1" }]
const liveShell = [{ label: "Watch CI", startedAt: "2026-07-10T00:00:00.000Z", state: "running" as const }]

test("isHeld: only current human/future-timer fences and canonical timed status are held", () => {
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingHuman })), true)
  assert.equal(isHeld(thread({ runtime: "exited", lastFence: awaitingHuman })), true)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingTimer })), true)
  // pr-watch is the review/approval/comment watcher and NEVER parks — a PR handoff stays a visible
  // queue card, never hidden in Held even though the scheduler is polling it. (2026-07-22)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingPrWatch })), false, "pr-watch queues, never Held")
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingBadTimer })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingElapsedTimer })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingPr })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingCi })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [{ kind: "session", value: "s1" }] } })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), false)
  assert.equal(isHeld(thread({ status: "blocked", mechanism: "timer", revalidate: "2099-07-15T17:00:00Z", runtime: "turn-idle" })), true, "pre-session canonical future timer status")
  assert.equal(isHeld(thread({ status: "blocked", mechanism: "timer", runtime: "turn-idle" })), false, "a timestamp-less timer cannot claim a durable wake")
  assert.equal(isHeld(thread({ status: "blocked", mechanism: "timer", revalidate: "2020-07-15T17:00:00Z", runtime: "turn-idle" })), false, "an elapsed timer is no longer Held")
})

test("manual snooze: every parked queue reason is Held until the exact deadline", () => {
  const future = "2099-07-15T17:00:00.000Z"
  const elapsed = "2020-07-15T17:00:00.000Z"
  const snoozed = thread({ kind: "session", state: "open", runtime: "turn-idle", snoozedUntil: future, needsYou: false })
  assert.equal(isHeld(snoozed), true)
  assert.equal(sectionOf(snoozed), "held")
  assert.equal(sessionIndicatorKind(snoozed), "held")
  assert.equal(isHeld(thread({ ...snoozed, snoozedUntil: elapsed })), false)
  assert.equal(sectionOf(thread({ ...snoozed, snoozedUntil: elapsed, needsYou: true })), "active")
  assert.equal(queued(thread({ ...snoozed, snoozedUntil: elapsed, needsYou: true })), true)
  assert.equal(isHeld(thread({ ...snoozed, needsYou: true, pendingQuestion: true })), true)
  assert.equal(sectionOf(thread({ ...snoozed, needsYou: true, pendingQuestion: true })), "held")
  assert.equal(isHeld(thread({ ...snoozed, runtime: "perm-prompt", pendingAsk: { questions: [] } })), true)
  assert.equal(isHeld(thread({ ...snoozed, runtime: "exited", crashed: true })), true)
  assert.equal(isHeld(thread({ ...snoozed, runtime: "running" })), false, "snooze never relabels a turn still producing output")
})

test("isHeld: live work, mid-turn, settled, bare, archived, and non-timer blocked states are not held", () => {
  // Awaiting its own live SUB-AGENT is live work, even with a stale wait fence — not held.
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingHuman, subAgents: liveSub })), false)
  // A background shell is NOT live work (2026-07-22), so it can't rescue a thread from a valid future
  // wait: awaitingTimer + only a bgShell → held (see the held test below for the paired assertion).
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: awaitingTimer, bgShells: liveShell })), true)
  // Mid-turn (still working) never awaits externally, even with a stale human fence.
  assert.equal(isHeld(thread({ runtime: "running", lastFence: awaitingHuman })), false)
  // A done fence or a bare rest is NOT awaiting-external (those read as done/idle).
  assert.equal(isHeld(thread({ runtime: "turn-idle", lastFence: { kind: "done", body: "x", hints: [] } })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle" })), false)
  assert.equal(isHeld(thread({ runtime: "turn-idle", state: "archived", lastFence: awaitingTimer })), false)
  assert.equal(isHeld(thread({ status: "blocked", mechanism: "threads", runtime: "turn-idle" })), false)
  assert.equal(isHeld(thread({ needsYou: true, runtime: "exited", lastFence: awaitingTimer })), false, "attention beats a stale wait fence")
  assert.equal(isHeld(thread({ pendingAsk: { questions: [] }, runtime: "turn-idle", lastFence: awaitingHuman })), false)
})

test("sectionOf: human/future-timer waits and canonical timers are Held; machine waits stay out of Held", () => {
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingHuman })), "held")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer })), "held")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingCi })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", status: "blocked", mechanism: "timer", revalidate: "2099-07-15T17:00:00Z", runtime: "turn-idle" })), "held")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", needsYou: true, runtime: "exited", lastFence: awaitingTimer })), "active")
  // A live SUB-AGENT wins over a stale parked fence (live work → Active).
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingHuman, subAgents: liveSub })), "active")
  // A background shell does NOT (2026-07-22): the future-timer wait shows through → Held.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, bgShells: liveShell })), "held")
  // Session-hint / hintless / elapsed timer waits remain Active, like bare rest.
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [{ kind: "session", value: "s1" }] } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: [] } })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingElapsedTimer })), "active")
  assert.equal(sectionOf(thread({ kind: "session", state: "open", runtime: "turn-idle" })), "active")
  // Archive wins over an external wait.
  assert.equal(sectionOf(thread({ kind: "session", state: "archived", runtime: "turn-idle", lastFence: awaitingHuman })), "inactive")
})

test("sectionThreads: only human/future-timer waits partition into Held; live and machine waits stay out of it", () => {
  const s = sectionThreads([
    thread({ id: "human-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingHuman, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
    thread({ id: "timer-old", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, lastUserAt: "2026-07-08T05:00:00.000Z" }),
    thread({ id: "sub-wait", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingHuman, subAgents: liveSub, lastUserAt: "2026-07-09T01:00:00.000Z" }),
    // shell-wait: a future-timer fence + only a background shell. The shell is no longer live work
    // (2026-07-22), so this now partitions into HELD (its timer wait), not the Active running band.
    thread({ id: "shell-wait", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingTimer, bgShells: liveShell, lastUserAt: "2026-07-09T02:00:00.000Z" }),
    thread({ id: "legacy-pr", kind: "session", state: "open", runtime: "turn-idle", lastFence: awaitingPr, lastUserAt: "2026-07-09T03:00:00.000Z" }),
  ])
  // The cue leads with the legacy-pr rest; the running band — live-old + the one live-SUB-AGENT
  // waiter, by recency — follows below it.
  assert.deepEqual(s.active.map((t) => t.id), ["legacy-pr", "sub-wait", "live-old"])
  // Held: the two human/future-timer waits — now including shell-wait, whose shell can't hold it Active.
  assert.deepEqual(s.held.map((t) => t.id), ["human-new", "shell-wait", "timer-old"])
})

test("displayTitle: an explicit human title wins over stale backend AI-title and slug fallbacks", () => {
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "Human-readable thread title", titleAuto: false, titleLocked: true, aiTitle: "generated-slug" })),
    "Human-readable thread title",
  )
  // A pre-split row carries no titleLocked; its real-looking title must still read as the human's.
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "Human-readable thread title", titleAuto: false, aiTitle: "generated-slug" })),
    "Human-readable thread title",
  )
})

test("displayTitle: a title a dispatch CALLER hard-coded shows until the worker names the thread itself", () => {
  // `Investigate acme/app#391` (GitHub batch) / a parent agent's spawn_thread guess: a real name, so no
  // "Spinning up…" placeholder, but nobody human chose it.
  const hardCoded = { id: "investigate-acme-app-391", title: "Investigate acme/app#391", titleAuto: false, titleLocked: false }
  assert.equal(titleIsProvisional(thread({ ...hardCoded, spawnedAt: new Date().toISOString() })), false)
  assert.equal(displayTitle(thread(hardCoded)), "Investigate acme/app#391")
  // …and the moment the worker reports what the task actually is, that wins.
  assert.equal(
    displayTitle(thread({ ...hardCoded, aiTitle: "Cache key collides on normalized ids" })),
    "Cache key collides on normalized ids",
  )
  // Renaming it locks it again — a later/stale backend record can no longer displace the human's choice.
  assert.equal(
    displayTitle(thread({ ...hardCoded, title: "Resolver cache bug", titleLocked: true, aiTitle: "generated-slug" })),
    "Resolver cache bug",
  )
})

test("displayTitle: a machine-generated session slug is never presented as a successful title", () => {
  assert.equal(
    displayTitle(thread({ id: "generated-slug", title: "generated-slug", titleAuto: true, spawnedAt: "2026-07-01T00:00:00.000Z" })),
    "Untitled thread",
  )
  assert.equal(
    displayTitle(thread({ id: "internal-id", title: "internal-id", titleAuto: true, aiTitle: "conversation-summary-task" })),
    "Conversation summary task",
    "a native backend slug is humanized (sentence case) even when it differs from the Frizz thread id",
  )
})

test("a legacy session/hintless declared wait is never Held — at rest it is simply a rested/queued row", () => {
  const sessWait = { kind: "awaiting" as const, body: "", hints: [{ kind: "session" as const, value: "s1" }] }
  const s = sectionThreads([
    thread({ id: "wait-new", kind: "session", state: "open", runtime: "turn-idle", lastFence: sessWait, lastUserAt: "2026-07-09T05:00:00.000Z" }),
    thread({ id: "live-old", kind: "session", state: "open", runtime: "running", lastUserAt: "2026-07-08T01:00:00.000Z" }),
  ])
  // The hintless-wait rest (wait-new) is a cue row, so it leads; live-old is running and files below it.
  assert.deepEqual(s.active.map((t) => t.id), ["wait-new", "live-old"])
  assert.deepEqual(s.held.map((t) => t.id), [])
})

// ---- title placeholder: never show the machine-guessed dispatch title ----

test("titleIsProvisional / displayTitle: 'Spinning up' shows briefly, then falls back to the dispatch title", () => {
  const fresh = new Date().toISOString()
  // Fresh dispatch, guessed title, no aiTitle yet → the placeholder.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: fresh })), true)
  assert.equal(displayTitle(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: fresh })), SPINNING_UP_TITLE)
  // aiTitle landed → not provisional; the real name wins.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, aiTitle: "Parser fix", spawnedAt: fresh })), false)
  assert.equal(displayTitle(thread({ titleAuto: true, aiTitle: "Parser fix", spawnedAt: fresh })), "Parser fix")
  // STALE spawn, still no aiTitle (e.g. a compacted session whose transcript frizz lost track of) → NOT
  // provisional: fall back to the dispatch title, never stick on "Spinning up…" forever.
  assert.equal(titleIsProvisional(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: "2026-07-08T00:00:00.000Z" })), false)
  assert.equal(displayTitle(thread({ titleAuto: true, title: "fix the parser bug", spawnedAt: "2026-07-08T00:00:00.000Z" })), "fix the parser bug")
  // A user-supplied title (titleAuto false) is real — shown as-is, never provisional.
  assert.equal(titleIsProvisional(thread({ titleAuto: false, title: "My thread", spawnedAt: fresh })), false)
  assert.equal(displayTitle(thread({ titleAuto: false, title: "My thread" })), "My thread")
  // Absent titleAuto (legacy/slim/foreign row) ⇒ never provisional.
  assert.equal(titleIsProvisional(thread({ title: "legacy" })), false)
})

test("Codex automatic titles follow runtime and never expose the raw initial-prompt fallback", () => {
  const rawPrompt = "Please inspect this entire raw initial prompt and fix everything"
  const fresh = new Date().toISOString()
  const stale = new Date(Date.now() - 20_000).toISOString()
  const spawning = thread({ backend: "codex", runtime: "spawning", titleAuto: true, title: rawPrompt, spawnedAt: fresh })
  assert.equal(titleIsProvisional(spawning), true)
  assert.equal(displayTitle(spawning), SPINNING_UP_TITLE)

  const runningBeforeSignal = thread({ backend: "codex", runtime: "running", titleAuto: true, title: rawPrompt, spawnedAt: fresh })
  assert.equal(titleIsProvisional(runningBeforeSignal), true)
  assert.equal(displayTitle(runningBeforeSignal), SPINNING_UP_TITLE, "task_started cannot flash Untitled before first commentary")

  for (const runtime of ["running", "turn-idle", "exited"] as const) {
    const omitted = thread({ backend: "codex", runtime, titleAuto: true, title: rawPrompt, spawnedAt: stale })
    assert.equal(titleIsProvisional(omitted), false)
    assert.equal(displayTitle(omitted), UNTITLED_THREAD_TITLE)
  }

  assert.equal(
    displayTitle(thread({ backend: "codex", runtime: "turn-idle", titleAuto: true, title: "slug", aiTitle: "Fix queue focus" })),
    "Fix queue focus",
  )
  assert.equal(
    displayTitle(thread({ backend: "codex", runtime: "turn-idle", titleAuto: false, title: "Human rename" })),
    "Human rename",
  )
})
