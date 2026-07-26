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
import { createIntegrationHarness } from "./harness.ts"
import {
  assistantEvent,
  assistantRecord,
  event,
  record,
  resultEvent,
  userEvent,
  userRecord,
} from "./scripted-claude.ts"

const T0 = "2026-07-01T00:00:00.000Z"
const T1 = "2026-07-01T00:00:01.000Z"
const T2 = "2026-07-01T00:00:02.000Z"

test("integration: a scripted broker turn folds through the real graph to an idle board thread", async () => {
  const h = createIntegrationHarness()
  try {
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

test("integration: a runtime event drives a tailer re-read with no poll tick at all", async () => {
  // The latency claim, asserted against the REAL nudge path — real timers, no tailer.tick() call.
  // Before this the same assertion would have had to wait out POLL_MS (1s) at best and MAX_POLL_MS
  // (10s) under load.
  const h = createIntegrationHarness()
  try {
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
