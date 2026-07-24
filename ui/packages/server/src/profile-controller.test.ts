import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProfileController } from "./profile-controller.ts"
import { createStorage, type ProfileHandoffJournal, type SessionRow } from "./storage.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"
import type { BoardManager } from "./board.ts"
import type { PermissionTerminal } from "./permission-controller.ts"

const SPAWNED = "2026-07-13T10:00:00.000Z"
const EMPTY_CLAUDE = "❯\u00a0\n────────────\n  project · branch\n"
const PANE = { paneId: "%1", panePid: 101, sessionCreated: 1_750_000_000 }

function journal(
  slug: string,
  previous: { model: string; effort: string } = { model: "opus", effort: "high" },
  requested: { model: string; effort: string } = { model: "sonnet", effort: "max" },
): ProfileHandoffJournal {
  return {
    version: 1,
    phase: "armed",
    nativeSessionId: `session-${slug}`,
    previous: { ...previous, binding: { kind: "standalone", ...PANE } },
    requested,
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function session(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `session-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: SPAWNED,
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: null,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    backend: "claude",
    model: "opus",
    effort: "high",
    permission_mode: "default",
    ...over,
  }
}

function telemetry(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, ...over }
}

function harness(options: { live?: boolean; tele?: SessionTelemetry; now?: number } = {}) {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-profile-controller-")), "ui.db"))
  const currentTelemetry = { value: options.tele ?? telemetry() }
  let refreshes = 0
  const tailer = {
    get: () => currentTelemetry.value,
    tick: () => undefined,
  } as unknown as Tailer
  const board = { refresh: () => { refreshes++ } } as unknown as BoardManager
  const terminal: PermissionTerminal = {
    isLive: () => options.live ?? true,
    paneIdentity: () => PANE,
    capturePane: () => EMPTY_CLAUDE,
  }
  return { storage, tailer, board, terminal, currentTelemetry, refreshes: () => refreshes, now: () => options.now ?? Date.parse("2026-07-13T12:00:00.000Z") }
}

test("exited profile changes persist one validated pair for the next resume", async () => {
  const h = harness({ live: false })
  h.storage.upsertSession(session("exited", { exited: 1 }))
  const controller = createProfileController(h)
  assert.deepEqual(await controller.request("exited", { model: "sonnet", effort: "max" }), { effect: "next-resume" })
  assert.equal(h.storage.getSession("exited")?.model, "sonnet")
  assert.equal(h.storage.getSession("exited")?.effort, "max")
  await assert.rejects(controller.request("exited", { model: "unknown", effort: "high" }), /Unsupported claude model\/effort pair/)

  h.storage.upsertSession(session("legacy-exited", { exited: 1, model: "retired-model", effort: "retired-effort" }))
  assert.deepEqual(await controller.request("legacy-exited", { model: "haiku", effort: "low" }), { effect: "next-resume" })
  assert.deepEqual(
    { model: h.storage.getSession("legacy-exited")?.model, effort: h.storage.getSession("legacy-exited")?.effort },
    { model: "haiku", effort: "low" },
  )
  h.storage.close()
})

test("an idle live profile change owns one generation and commits only after readiness", async () => {
  const h = harness()
  h.storage.upsertSession(session("live"))
  const calls: unknown[][] = []
  const controller = createProfileController({
    ...h,
    reattach: async (slug, current, requested, onGeneration, onCheckpoint) => {
      calls.push([slug, current, requested])
      const row = h.storage.getSession(slug)!
      const generation = h.storage.beginRuntimeGeneration(slug, {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        permissionPending: null,
        runtimeControl: "profile",
      }, "2026-07-13T11:00:00.000Z")
      assert.equal(generation, 1)
      onGeneration?.(generation!)
      const handoffToken = randomUUID()
      onCheckpoint?.({ phase: "target-starting", generation: generation!, handoffToken })
      onCheckpoint?.({ phase: "target-spawned", generation: generation!, handoffToken, identity: PANE })
      onCheckpoint?.({ phase: "target-ready", generation: generation!, handoffToken, identity: PANE })
      return { generation: generation!, outcome: "target-ready" }
    },
  })
  assert.deepEqual(await controller.request("live", { model: "sonnet", effort: "xhigh" }), { effect: "applied" })
  assert.deepEqual(calls, [["live", { model: "opus", effort: "high" }, { model: "sonnet", effort: "xhigh" }]])
  const saved = h.storage.getSession("live")!
  assert.equal(saved.runtime_generation, 1)
  assert.equal(saved.model, "sonnet")
  assert.equal(saved.effort, "xhigh")
  assert.equal(saved.runtime_control, null)
  assert.equal(saved.profile_pending_model, null)
  h.storage.close()
})

test("a live thread whose launch effort was never recorded can still change model", async () => {
  // Claude records a thread's model but frequently not its launch effort, so a live thread sits at a
  // known model with an absent effort. That pair is not launchable argv, and validating it as the
  // rollback target used to reject the change outright — leaving the thread stuck on that model.
  const h = harness()
  h.storage.upsertSession(session("unrecorded", { model: "fable", effort: "" }))
  const calls: unknown[][] = []
  const controller = createProfileController({
    ...h,
    reattach: async (slug, current, requested, onGeneration, onCheckpoint) => {
      calls.push([slug, current, requested])
      const row = h.storage.getSession(slug)!
      const generation = h.storage.beginRuntimeGeneration(slug, {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        permissionPending: null,
        runtimeControl: "profile",
      }, "2026-07-13T11:00:00.000Z")!
      onGeneration?.(generation)
      const handoffToken = randomUUID()
      onCheckpoint?.({ phase: "target-ready", generation, handoffToken, identity: PANE })
      return { generation, outcome: "target-ready" }
    },
  })
  assert.deepEqual(await controller.request("unrecorded", { model: "opus", effort: "high" }), { effect: "applied" })
  // The rollback target handed to the reattach is the RECONSTRUCTED launchable pair, never the raw
  // empty effort that would have produced malformed relaunch argv.
  assert.deepEqual(calls, [["unrecorded", { model: "fable", effort: "medium" }, { model: "opus", effort: "high" }]])
  const saved = h.storage.getSession("unrecorded")!
  assert.equal(saved.model, "opus")
  assert.equal(saved.effort, "high")
  h.storage.close()

  // An unknown MODEL still fails closed — nothing can reconstruct a launchable rollback pair.
  const unknown = harness()
  unknown.storage.upsertSession(session("mystery", { model: "claude-mystery-9", effort: "high" }))
  await assert.rejects(
    createProfileController(unknown).request("mystery", { model: "opus", effort: "high" }),
    /Unsupported claude model\/effort pair/,
  )
  assert.equal(unknown.storage.getSession("mystery")?.model, "claude-mystery-9")
  unknown.storage.close()
})

test("a live thread whose profile was only ever OBSERVED can change model and effort", async () => {
  // The registry keeps model AND effort NULL until the tailer sees BOTH halves, and Claude records the
  // model in its transcript while frequently never recording the launch effort. So the real-world
  // "Opus, no effort" thread is a row with NO persisted profile at all, whose model the board resolves
  // from telemetry. Reading the raw row for the rollback target rejected every one of those threads
  // with an empty pair, while the composer — reading the board — offered the control as enabled.
  const h = harness({ tele: telemetry({ model: "claude-opus-4-8", profileAt: "2026-07-13T11:30:00.000Z" }) })
  h.storage.upsertSession(session("observed-only", { model: null, effort: null }))
  const calls: unknown[][] = []
  const controller = createProfileController({
    ...h,
    reattach: async (slug, current, requested, onGeneration, onCheckpoint) => {
      calls.push([slug, current, requested])
      const row = h.storage.getSession(slug)!
      const generation = h.storage.beginRuntimeGeneration(slug, {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        permissionPending: null,
        runtimeControl: "profile",
      }, "2026-07-13T11:00:00.000Z")!
      onGeneration?.(generation)
      const handoffToken = randomUUID()
      onCheckpoint?.({ phase: "target-ready", generation, handoffToken, identity: PANE })
      return { generation, outcome: "target-ready" }
    },
  })
  assert.deepEqual(await controller.request("observed-only", { model: "opus", effort: "xhigh" }), { effect: "applied" })
  // The rollback pair is the NORMALIZED observed model plus that model's default effort — launchable
  // argv for the relaunch, rather than the row's two empty strings.
  assert.deepEqual(calls, [["observed-only", { model: "opus", effort: "medium" }, { model: "opus", effort: "xhigh" }]])
  const saved = h.storage.getSession("observed-only")!
  assert.equal(saved.model, "opus")
  assert.equal(saved.effort, "xhigh")
  h.storage.close()

  // With NOTHING persisted and NOTHING observed there is still no runtime to relabel, and the failure
  // now names the absent halves instead of rendering an empty "pair:  / ". The composer fails closed on
  // exactly this state too (an unknown model disables the control), so the two agree.
  const blank = harness()
  blank.storage.upsertSession(session("blank", { model: null, effort: null }))
  await assert.rejects(
    createProfileController(blank).request("blank", { model: "opus", effort: "high" }),
    /Unsupported claude model\/effort pair: \(unknown model\) \/ \(unrecorded effort\)/,
  )
  blank.storage.close()
})

test("active work queues durably and a restarted controller applies it at the first safe idle boundary", async () => {
  const active = harness({ tele: telemetry({ turn: "in-flight" }) })
  active.storage.upsertSession(session("active"))
  const activeController = createProfileController(active)
  assert.deepEqual(
    await activeController.request("active", { model: "sonnet", effort: "high" }),
    { effect: "queued" },
  )
  assert.equal(active.storage.getSession("active")?.model, "opus")
  assert.equal(active.storage.getSession("active")?.profile_pending_model, null)
  assert.equal(active.storage.getSession("active")?.profile_queued_model, "sonnet")
  assert.equal(active.storage.getSession("active")?.profile_queued_effort, "high")
  assert.equal(active.storage.getSession("active")?.runtime_control, "profile-queued")

  // A new controller instance models a Fray restart while the request is queued. The durable row,
  // not an in-memory callback, owns the eventual handoff.
  active.currentTelemetry.value = telemetry({ turn: "idle" })
  const restarted = createProfileController({
    ...active,
    reattach: async (slug, current, requested, onGeneration, onCheckpoint) => {
      assert.deepEqual([slug, current, requested], [
        "active",
        { model: "opus", effort: "high" },
        { model: "sonnet", effort: "high" },
      ])
      const row = active.storage.getSession(slug)!
      const generation = active.storage.beginRuntimeGeneration(slug, {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        permissionPending: null,
        runtimeControl: "profile",
      }, "2026-07-13T11:00:00.000Z")!
      onGeneration?.(generation)
      const handoffToken = randomUUID()
      onCheckpoint?.({ phase: "target-ready", generation, handoffToken, identity: PANE })
      return { generation, outcome: "target-ready" }
    },
  })
  restarted.tick()
  await settle()
  await settle()
  const applied = active.storage.getSession("active")!
  assert.equal(applied.model, "sonnet")
  assert.equal(applied.effort, "high")
  assert.equal(applied.profile_queued_model, null)
  assert.equal(applied.profile_pending_model, null)
  assert.equal(applied.runtime_control, null)
  active.storage.close()
})

test("a rested parent keeps its queued profile behind a live sub-agent", async () => {
  const h = harness({
    tele: telemetry({
      turn: "idle",
      subAgents: [{
        id: "child",
        label: "still working",
        startedAt: "2026-07-24T18:00:00.000Z",
        state: "running",
      }],
    }),
  })
  h.storage.upsertSession(session("background-parent"))
  const controller = createProfileController(h)
  assert.deepEqual(
    await controller.request("background-parent", { model: "fable", effort: "medium" }),
    { effect: "queued" },
  )
  controller.tick()
  await settle()
  assert.equal(h.storage.getSession("background-parent")?.runtime_control, "profile-queued")
  assert.equal(h.storage.getSession("background-parent")?.model, "opus")
  h.storage.close()
})

test("an unproven provider failure stays durably locked", async () => {
  const failed = harness()
  failed.storage.upsertSession(session("failed"))
  const failedController = createProfileController({
    ...failed,
    reattach: async (_slug, _current, _requested, onGeneration) => {
      const row = failed.storage.getSession("failed")!
      const generation = failed.storage.beginRuntimeGeneration("failed", {
        sessionId: row.session_id,
        generation: row.runtime_generation ?? 0,
        permissionPending: null,
        runtimeControl: "profile",
      }, "2026-07-13T11:00:00.000Z")!
      onGeneration?.(generation)
      throw new Error("target and rollback failed")
    },
  })
  await assert.rejects(failedController.request("failed", { model: "sonnet", effort: "max" }), /target and rollback failed/)
  assert.equal(failed.storage.getSession("failed")?.model, "opus")
  assert.equal(failed.storage.getSession("failed")?.runtime_control, "profile")
  assert.equal(failed.storage.getSession("failed")?.profile_pending_model, "sonnet")
  assert.ok(failed.storage.getSession("failed")?.profile_handoff)
  assert.match(failed.storage.getSession("failed")?.control_error ?? "", /target and rollback failed/)
  failed.storage.close()
})

test("restart recovery commits only after the exact recovery seam journals target readiness", async () => {
  const good = harness({ now: Date.parse("2026-07-13T12:00:00.000Z"), tele: telemetry() })
  good.storage.upsertSession(session("recover-good"))
  const armed = good.storage.armProfileChange("recover-good", {
    sessionId: "session-recover-good",
    nativeSessionId: null,
    generation: 0,
  }, { model: "sonnet", effort: "max" }, journal("recover-good"))!
  assert.equal(good.storage.beginRuntimeGeneration("recover-good", {
    sessionId: "session-recover-good",
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-13T11:00:00.000Z"), 1)
  const targetToken = randomUUID()
  createProfileController({
    ...good,
    recover: async (row, recovered, observation) => {
      assert.equal(observation.currentTargetObservation, false, "absent telemetry is not proof and does not prevent exact recovery")
      const checkpoint: ProfileHandoffJournal = {
        ...recovered,
        phase: "target-ready",
        target: { generation: 1, handoffToken: targetToken, binding: { kind: "standalone", ...PANE, handoffToken: targetToken } },
      }
      const serialized = good.storage.checkpointProfileChange(row.slug, {
        sessionId: row.session_id,
        nativeSessionId: null,
        generation: 1,
        profileRevision: armed.profileRevision,
        controlRevision: armed.controlRevision,
        model: "sonnet",
        effort: "max",
        profileHandoff: row.profile_handoff!,
      }, checkpoint)
      assert.ok(serialized)
      return { outcome: "target-ready" }
    },
  }).tick()
  await settle()
  assert.equal(good.storage.getSession("recover-good")?.model, "sonnet")
  assert.equal(good.storage.getSession("recover-good")?.runtime_control, null)
  assert.ok(armed.profileRevision > 0)
  good.storage.close()

  const stale = harness({ now: Date.parse("2026-07-13T12:00:00.000Z"), tele: telemetry({ model: "sonnet", effort: "max", profileAt: "2026-07-13T10:59:59.000Z" }) })
  stale.storage.upsertSession(session("recover-stale"))
  const staleArmed = stale.storage.armProfileChange("recover-stale", {
    sessionId: "session-recover-stale",
    nativeSessionId: null,
    generation: 0,
  }, { model: "sonnet", effort: "max" }, journal("recover-stale"))!
  stale.storage.beginRuntimeGeneration("recover-stale", {
    sessionId: "session-recover-stale",
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-13T11:00:00.000Z")
  createProfileController({
    ...stale,
    recover: async (row, recovered, observation) => {
      assert.equal(observation.currentTargetObservation, false)
      const rollbackToken = randomUUID()
      const checkpoint: ProfileHandoffJournal = {
        ...recovered,
        phase: "rollback-ready",
        rollback: { generation: 1, handoffToken: rollbackToken, binding: { ...recovered.previous.binding, handoffToken: rollbackToken } },
      }
      const serialized = stale.storage.checkpointProfileChange(row.slug, {
        sessionId: row.session_id,
        nativeSessionId: null,
        generation: 1,
        profileRevision: staleArmed.profileRevision,
        controlRevision: staleArmed.controlRevision,
        model: "sonnet",
        effort: "max",
        profileHandoff: row.profile_handoff!,
      }, checkpoint)
      assert.ok(serialized)
      return { outcome: "rollback-ready", error: "exact prior runtime restored" }
    },
  }).tick()
  await settle()
  assert.equal(stale.storage.getSession("recover-stale")?.model, "opus")
  assert.equal(stale.storage.getSession("recover-stale")?.runtime_control, null)
  assert.match(stale.storage.getSession("recover-stale")?.control_error ?? "", /exact prior runtime restored/)
  stale.storage.close()
})

test("fresh matching telemetry cannot release a handoff when exact recovery is blocked", async () => {
  const h = harness({ now: Date.parse("2026-07-13T12:00:00.000Z"), tele: telemetry({ model: "sonnet", effort: "max", profileAt: "2026-07-13T11:00:01.000Z" }) })
  h.storage.upsertSession(session("recover-blocked"))
  h.storage.armProfileChange("recover-blocked", {
    sessionId: "session-recover-blocked",
    nativeSessionId: null,
    generation: 0,
  }, { model: "sonnet", effort: "max" }, journal("recover-blocked"))
  h.storage.beginRuntimeGeneration("recover-blocked", {
    sessionId: "session-recover-blocked",
    generation: 0,
    permissionPending: null,
    runtimeControl: "profile",
  }, "2026-07-13T11:00:00.000Z")
  createProfileController({
    ...h,
    recover: async (_row, _journal, observation) => {
      assert.equal(observation.currentTargetObservation, true)
      return { outcome: "blocked", error: "exact target pane was replaced" }
    },
  }).tick()
  await settle()
  const row = h.storage.getSession("recover-blocked")!
  assert.equal(row.model, "opus")
  assert.equal(row.runtime_control, "profile")
  assert.equal(row.profile_pending_model, "sonnet")
  assert.match(row.control_error ?? "", /exact target pane was replaced/)
  h.storage.close()
})
