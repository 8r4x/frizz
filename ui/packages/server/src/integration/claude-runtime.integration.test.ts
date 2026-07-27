// End-to-end over the REAL fray graph — storage → tailer fold → board assembly — driven by a
// scripted Claude provider that writes the same two artifacts a live broker session does: records on
// disk and typed events over the socket. No `claude`, no daemon, no tmux, no browser, no sleeps.
//
// These are the assertions that decide whether consuming the broker's event stream (item 1 of
// plans/t3code-adoption-spike.md) made the board FASTER without making it WRONG. The wrongness risk
// is entirely about ORDERING between the two surfaces, so the ordering cases are the ones written
// out longhand below.
import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createIntegrationHarness } from "./harness.ts"
import {
  assistantEvent,
  assistantRecord,
  event,
  record,
  resultEvent,
  userEvent,
  userRecord,
  agentDispatchRecord,
  agentLaunchRecord,
  taskEvent,
  taskNotificationRecord,
} from "./scripted-claude.ts"

const T0 = "2026-07-01T00:00:00.000Z"
const T1 = "2026-07-01T00:00:01.000Z"
const T2 = "2026-07-01T00:00:02.000Z"

test("integration: a scripted broker turn folds through the real graph to an idle board thread", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("alpha")
    h.telemetry("alpha") // prime

    s.play(
      record(userRecord("go", T0)),
      event(userEvent("go", s.sessionId)),
      record(assistantRecord("looking", "tool_use", T1)),
      event(assistantEvent("looking", s.sessionId)),
      record(assistantRecord("```done\n- shipped it\n```", "end_turn", T2)),
      event(assistantEvent("shipped it", s.sessionId)),
      event(resultEvent(s.sessionId)),
    )
    await h.settle()

    const tele = h.telemetry("alpha")
    assert.equal(tele?.turn, "idle")
    assert.equal(tele?.lastActivityAt, T2)
    // The DX guard: the signal fence still parses out of the final message after the whole chain.
    assert.equal(tele?.lastFence?.kind, "done")

    const thread = h.boardThread("alpha")
    assert.ok(thread, "the thread reaches the board")
    assert.equal(thread?.runtime, "turn-idle", "the process is alive and waiting at the prompt")
  } finally {
    h.close()
  }
})

test("integration: a `result` event NEVER queues a thread ahead of its final record reaching disk", async () => {
  // The single most dangerous ordering, and the reason resolveRuntimeTurn refuses to override folded
  // evidence. The SDK reports the turn finished while the last record the tailer can see is an
  // unresolved tool_use. If "settled" won here, the board would card the thread at rest showing the
  // TOOL-CALL as its last message and no parsed fence — a worse regression than the latency it fixes.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("beta")
    h.telemetry("beta")

    s.play(
      record(userRecord("go", T0)),
      record(assistantRecord("calling a tool", "tool_use", T1)),
      event(resultEvent(s.sessionId)), // the SDK is ahead of the file
    )
    await h.settle()

    const midFlight = h.telemetry("beta")
    assert.equal(midFlight?.turn, "in-flight", "folded tool_use outranks a runtime `settled`")
    assert.equal(midFlight?.lastFence, undefined, "no fence has been written yet")

    // Now the real final record lands.
    s.play(record(assistantRecord("```done\n- finished\n```", "end_turn", T2)))
    await h.settle()

    const settled = h.telemetry("beta")
    assert.equal(settled?.turn, "idle")
    assert.equal(settled?.lastFence?.kind, "done", "the thread rests on the message it actually ended with")
  } finally {
    h.close()
  }
})

test("integration: a `result` event short-circuits the 5s unknown-stop_reason backstop", async () => {
  // The case where the fold has NO evidence: an assistant record whose stop_reason is missing. Today
  // that costs a 5-second wait before the thread can come to rest. The SDK already said the turn was
  // over; that is not a guess.
  const withRuntime = createIntegrationHarness()
  try {
    const s = withRuntime.dispatch("gamma")
    withRuntime.telemetry("gamma")
    s.play(
      record(userRecord("go", T0)),
      record(assistantRecord("done, i think", undefined, T1)),
    )
    await withRuntime.settle()
    assert.equal(withRuntime.telemetry("gamma")?.turn, "in-flight", "backstop has not elapsed")

    s.play(event(resultEvent(s.sessionId)))
    await withRuntime.settle()
    assert.equal(withRuntime.telemetry("gamma")?.turn, "idle", "the SDK settles it without waiting out 5s")
  } finally {
    withRuntime.close()
  }
})

test("integration: without a runtime signal the backstop behaves exactly as before", async () => {
  // The control for the test above — same script, no `result` event. This is what every tmux thread
  // and every pre-broker session still does, and it must be untouched.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("delta")
    h.telemetry("delta")
    s.play(record(userRecord("go", T0)), record(assistantRecord("done, i think", undefined, T1)))
    await h.settle()
    assert.equal(h.telemetry("delta")?.turn, "in-flight")

    // IDLE_BACKSTOP_MS is 5s measured from lastActivityAt (T1), and the comparison is strict, so the
    // clock has to pass 00:00:06 — not merely reach it. Exactness here is the point of the control.
    h.advance(7_000)
    assert.equal(h.telemetry("delta")?.turn, "idle", "the 5s backstop still resolves it on its own")
  } finally {
    h.close()
  }
})

test("integration: a delivered follow-up shows in-flight before its user record reaches disk", async () => {
  // The other direction, and the safe one: the SDK says a turn is running while the transcript still
  // ends on the previous end_turn. Reporting `idle` there is the "I sent a message and the thread
  // still looks asleep" flicker. This can never fire a premature turn-done — it only moves the board
  // toward in-flight.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("epsilon")
    h.telemetry("epsilon")
    s.play(record(userRecord("go", T0)), record(assistantRecord("all done", "end_turn", T1)))
    await h.settle()
    assert.equal(h.telemetry("epsilon")?.turn, "idle")

    s.play(event(userEvent("one more thing", s.sessionId))) // nothing on disk yet
    await h.settle()
    assert.equal(h.telemetry("epsilon")?.turn, "in-flight", "the board moves the instant the turn starts")
  } finally {
    h.close()
  }
})

test("integration: the runtime turn reading is scoped to broker rows and dies with the session", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("zeta")
    h.telemetry("zeta")
    s.play(record(userRecord("go", T0)), record(assistantRecord("all done", "end_turn", T1)))
    s.play(event(assistantEvent("working", s.sessionId)))
    await h.settle()
    assert.equal(h.ingest.liveness(s.sessionId)?.turn, "running")
    assert.equal(h.telemetry("zeta")?.turn, "in-flight")

    // A replaced session reuses the slug; a stale "running" left behind would be consulted for the
    // NEW session's row and spin a finished thread forever.
    h.ingest.release(s.sessionId)
    assert.equal(h.ingest.liveness(s.sessionId), undefined)
    assert.equal(h.telemetry("zeta")?.turn, "idle", "the fold decides alone again")
  } finally {
    h.close()
  }
})

test("integration: receipts name each milestone, and drain means the ingest is finished", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("eta")
    h.telemetry("eta")

    const cursor = h.receipts.cursor()
    s.play(
      event(userEvent("go", s.sessionId)),
      event(assistantEvent("working", s.sessionId)),
      event(resultEvent(s.sessionId)),
    )
    await h.ingest.drain()
    assert.equal(h.ingest.liveness(s.sessionId)?.events, 3)

    // `since: cursor` is what makes these matchable even though they were published before the await.
    const started = await h.receipts.waitFor((r) => r.type === "claude.runtime.turn.started", { since: cursor })
    assert.equal(started.type === "claude.runtime.turn.started" && started.slug, "eta")
    const settled = await h.receipts.waitFor((r) => r.type === "claude.runtime.turn.settled", { since: cursor })
    assert.equal(settled.type === "claude.runtime.turn.settled" && settled.isError, false)
  } finally {
    h.close()
  }
})

test("integration: the fold catches up when the provider's event beats its own disk write", async () => {
  // THE case the promoted-artifact measurement caught, and the reason chaseRuntime exists. Measured
  // against a real broker session (backend/_live_broker_ingest.mts): the SDK emitted `assistant` and
  // `result` with the transcript still at its previous size, and the record landed ~100-140ms later.
  // A single nudge on the event therefore folds NOTHING, and before the chase the change sat until the
  // next 1s poll — which is exactly what the artifact showed (~920ms, i.e. no improvement at all).
  //
  // Real timers here on purpose: the whole point is that the tick has to run AGAIN, later, without
  // anything else prompting it. `settle()` (which ticks by hand) would hide the bug completely.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("iota")
    h.telemetry("iota") // prime; nothing calls tick() by hand past this line

    // The events arrive first, describing a turn whose records are not on disk yet.
    s.play(event(userEvent("go", s.sessionId)), event(assistantEvent("all done", s.sessionId)), event(resultEvent(s.sessionId)))
    await h.ingest.drain()

    // …and the writes land a beat later, with NO event to announce them.
    await new Promise((r) => setTimeout(r, 60))
    s.play(record(userRecord("go", T0)), record(assistantRecord("all done", "end_turn", T1)))

    const deadline = Date.now() + 2_000
    while (h.tailer.get("iota")?.lastAssistant !== "all done" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(h.tailer.get("iota")?.lastAssistant, "all done", "the chase re-read after the write landed")
    assert.equal(h.tailer.get("iota")?.turn, "idle")
  } finally {
    h.close()
  }
})

test("integration: the chase is bounded — events that never produce a record stop nudging", async () => {
  // The other half of the contract: `init` and the system sidecars bump the provider's event count
  // without ever writing a record the fold can consume. Chasing those forever would turn a quiet
  // session into a permanent tick loop, which is a worse stability problem than the latency.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("kappa")
    h.telemetry("kappa")
    s.play(event({ kind: "other", type: "system", sessionId: s.sessionId }))
    await h.ingest.drain()

    await new Promise((r) => setTimeout(r, 900)) // ≫ RUNTIME_CHASE_MAX × the ~25ms nudge floor
    const settled = h.boardRefreshes()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(h.boardRefreshes(), settled, "the chase gave up rather than nudging forever")
  } finally {
    h.close()
  }
})

test("integration: a runtime event drives a tailer re-read with no poll tick at all", async () => {
  // The latency claim, asserted against the REAL nudge path — real timers, no tailer.tick() call.
  // Before this the same assertion would have had to wait out POLL_MS (1s) at best and MAX_POLL_MS
  // (10s) under load.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("theta")
    h.telemetry("theta") // prime; from here nothing calls tick() by hand
    const before = h.boardRefreshes()

    s.play(
      record(userRecord("go", T0)),
      record(assistantRecord("all done", "end_turn", T1)),
      event(resultEvent(s.sessionId)),
    )

    const deadline = Date.now() + 2_000
    while (h.boardRefreshes() === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.notEqual(h.boardRefreshes(), before, "the nudge ran a tick without waiting for the poll")
    assert.equal(h.tailer.get("theta")?.turn, "idle")
    assert.equal(h.tailer.get("theta")?.lastAssistant, "all done")
  } finally {
    h.close()
  }
})

// ---- sub-agent progress: the structured stream over the prose fold --------------------------------
// "There's not really any indication of what they're up to aside from starts and stops." These pin the
// three rules that answer it: the structured stream ENRICHES a folded child, it may RETIRE one, and it
// may never INVENT one. The prose path is exercised alongside in every case, because a tmux thread has
// nothing else and must keep behaving exactly as it did.

// The child's own transcript, which the fold resolves out of the launch ack's prose and then stats as
// the staleness clock. It has to EXIST: a path that never stats reads as stale, which is correct
// behaviour (a child whose transcript vanished is not healthy) and would mask what these tests assert.
function childTranscript(h: { project: { dir: string } }): string {
  const path = join(h.project.dir, "child.jsonl")
  writeFileSync(path, "")
  return path
}

test("integration: the structured task stream says what a live sub-agent is DOING", async () => {
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("progress")
    h.telemetry("progress")

    // The prose path registers the child, exactly as it always has.
    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Audit the fold", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
    )
    await h.settle()
    const bare = h.telemetry("progress")?.subAgents?.[0]
    assert.equal(bare?.label, "Audit the fold")
    assert.equal(bare?.activity, undefined, "before the SDK reports anything there is nothing to show")

    // Now the SDK reports what the child is up to — data that exists ONLY on this stream.
    s.play(
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child", description: "Audit the fold" })),
      event(taskEvent(s.sessionId, { phase: "progress", taskId: "task-1", lastToolName: "Bash", summary: "running the harness", usage: { totalTokens: 40123, toolUses: 18, durationMs: 92_000 } })),
    )
    await h.settle()

    const live = h.telemetry("progress")?.subAgents?.[0]
    assert.equal(live?.state, "running")
    assert.equal(live?.activity, "Bash", "the tool the child is running right now")
    assert.equal(live?.summary, "running the harness")
    assert.equal(live?.toolUses, 18)
    assert.equal(live?.tokens, 40123)
    assert.equal(live?.durationMs, 92_000)
    // ...and the correlation key a manual TaskStop needs is backfilled from the structured pairing.
    assert.equal(h.tailer.subAgent("progress", "toolu_child")?.state, "running")
  } finally {
    h.close()
  }
})

test("integration: a structured task_notification retires the child with NO prose notification", async () => {
  // The phantom bug, in its exact shape. `<task-notification>` records are how the fold learns a child
  // finished — and the tailer's own comments record three separate leaks from missing one. Here none
  // ever lands on disk: the ONLY terminal signal is the SDK's, and the live count must still reach zero.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("retire")
    h.telemetry("retire")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Do the thing", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
    )
    await h.settle()
    assert.equal(h.telemetry("retire")?.subAgents.length, 1, "the child is live")

    s.play(event(taskEvent(s.sessionId, { phase: "notification", taskId: "task-1", toolUseId: "toolu_child", status: "completed", summary: "all green" })))
    await h.settle()

    assert.equal(h.telemetry("retire")?.subAgents.length, 0, "the live sub-agent count returned to zero")
    // ...and it is RETAINED for the drill-in drawer, exactly as a prose completion would leave it.
    assert.equal(h.tailer.subAgent("retire", "toolu_child")?.state, "done")
  } finally {
    h.close()
  }
})

test("integration: the structured stream never INVENTS a sub-agent the fold does not track", async () => {
  // `trackDispatches` deliberately skips a FOREGROUND Agent (run_in_background:false) because the
  // thread spinner already covers it — and the provider reports those tasks too. Minting board rows
  // from the task stream would put foreground children on the live count and into the completion hold:
  // manufacturing exactly the phantoms this change exists to remove.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("noinvent")
    h.telemetry("noinvent")

    s.play(
      record(userRecord("go", T0)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "ghost", toolUseId: "toolu_ghost", description: "A foreground child" })),
      event(taskEvent(s.sessionId, { phase: "progress", taskId: "ghost", lastToolName: "Read" })),
      event(taskEvent(s.sessionId, { phase: "level", tasks: [{ taskId: "ghost" }] })),
    )
    await h.settle()

    assert.equal(h.telemetry("noinvent")?.subAgents.length, 0, "no folded dispatch, no board row")
    assert.equal(h.boardThread("noinvent")?.subAgents?.length ?? 0, 0)
  } finally {
    h.close()
  }
})

test("integration: the PROSE fold still retires a child on its own, with no structured stream at all", async () => {
  // The fallback that must not rot. A tmux thread emits no task events ever, so this is the whole of
  // its sub-agent lifecycle — byte-identical to before this change existed.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("prose")
    h.telemetry("prose")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Prose only", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
    )
    await h.settle()
    assert.equal(h.telemetry("prose")?.subAgents.length, 1)

    s.play(record(taskNotificationRecord("toolu_child", "completed", T2)))
    await h.settle()
    assert.equal(h.telemetry("prose")?.subAgents.length, 0, "the prose notification is still terminal")
  } finally {
    h.close()
  }
})

test("integration: a NON-terminal structured status never retires a live child", async () => {
  // The dangerous direction. A status fray has never seen, or a plain progress ping, must leave the
  // child exactly where it is — the board reporting done while the work continues is far worse than
  // the phantom this whole change is about.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("nonterminal")
    h.telemetry("nonterminal")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Still going", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
      event(taskEvent(s.sessionId, { phase: "updated", taskId: "task-1", status: "paused" })),
      event(taskEvent(s.sessionId, { phase: "updated", taskId: "task-1", status: "hibernating" })),
      event(taskEvent(s.sessionId, { phase: "progress", taskId: "task-1", lastToolName: "Edit" })),
    )
    await h.settle()

    const view = h.telemetry("nonterminal")?.subAgents?.[0]
    assert.equal(view?.state, "running", "paused / unknown / progress are all still alive")
    assert.equal(view?.activity, "Edit")
  } finally {
    h.close()
  }
})

test("integration: a structured completion reaches the BOARD, not just the tailer", async () => {
  // The signature has to move for progress to be visible at all: a completion clears an entry without
  // touching lastActivityAt, and an activity change writes no record whatsoever.
  const h = createIntegrationHarness()
  try {
    const OUT = childTranscript(h)
    const s = h.dispatch("boardmove")
    h.telemetry("boardmove")

    s.play(
      record(userRecord("go", T0)),
      record(agentDispatchRecord("toolu_child", "Visible child", T1)),
      record(agentLaunchRecord("toolu_child", OUT, T1)),
      event(taskEvent(s.sessionId, { phase: "started", taskId: "task-1", toolUseId: "toolu_child" })),
    )
    await h.settle()
    assert.equal(h.boardThread("boardmove")?.subAgents?.length, 1)

    const before = h.boardRefreshes()
    s.play(event(taskEvent(s.sessionId, { phase: "progress", taskId: "task-1", lastToolName: "Grep", summary: "searching" })))
    await h.settle()
    assert.ok(h.boardRefreshes() > before, "an activity change with no new record still moves the board")
    assert.equal(h.boardThread("boardmove")?.subAgents?.[0]?.activity, "Grep")

    s.play(event(taskEvent(s.sessionId, { phase: "notification", taskId: "task-1", toolUseId: "toolu_child", status: "completed" })))
    await h.settle()
    assert.equal(h.boardThread("boardmove")?.subAgents?.length ?? 0, 0, "the board's live child list is empty")
  } finally {
    h.close()
  }
})
