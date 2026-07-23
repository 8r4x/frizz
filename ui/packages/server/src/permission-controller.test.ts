import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionController, detectClaudePermissionMode, inspectClaudeComposer, type PermissionTerminal } from "./permission-controller.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import type { BoardManager } from "./board.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-12T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    permission_mode: "default",
    permission_pending: null,
    backend: "codex",
    ...over,
  }
}

function harness(storageOverride?: Storage) {
  const storage = storageOverride ?? createStorage(join(mkdtempSync(join(tmpdir(), "fray-permission-controller-")), "ui.db"))
  let telemetry: SessionTelemetry | undefined = {
    turn: "in-flight",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
  }
  let pane = ""
  let escaped = ""
  let live = true
  let atomicSendSucceeds = true
  let clock = 1_000
  let onTailerTick = () => {}
  const sent: string[] = []
  const reattached: string[] = []
  const terminal: PermissionTerminal = {
    isLive: () => live,
    capturePane: () => pane,
    capturePaneEscaped: () => escaped,
    sendLiteral: (_slug, text) => sent.push(`literal:${text}`),
    sendTextWithKey: (_slug, text, key) => {
      sent.push(`atomic:${key}:${text}`)
      return atomicSendSucceeds
    },
    sendKey: (_slug, key) => {
      sent.push(`key:${key}`)
    },
  }
  let refreshes = 0
  const board = { refresh: () => void refreshes++ } as unknown as BoardManager
  const tailer = { get: () => telemetry, tick: () => onTailerTick() } as unknown as Tailer
  const controller = createPermissionController({
    storage,
    tailer,
    board,
    terminal,
    reattach: async (slug, current, requested) => {
      reattached.push(`${slug}:${current}->${requested}`)
      if (storage.getSession(slug)?.backend === "claude") {
        const footer = requested === "bypassPermissions"
          ? "bypass permissions on"
          : requested === "acceptEdits"
            ? "accept edits on"
            : requested === "auto"
              ? "auto mode on"
              : "manual mode on"
        pane = `history\n❯\u00a0\n────────\n  ${footer}`
      }
    },
    now: () => clock,
  })
  return {
    storage,
    controller,
    sent,
    reattached,
    setPane(plain: string, withEscapes = plain) {
      pane = plain
      escaped = withEscapes
    },
    setTelemetry(next: SessionTelemetry | undefined) {
      telemetry = next
    },
    setLive(next: boolean) {
      live = next
    },
    setAtomicSendSucceeds(next: boolean) {
      atomicSendSucceeds = next
    },
    setNow(next: number) {
      clock = next
    },
    setTailerTick(next: () => void) {
      onTailerTick = next
    },
    refreshes: () => refreshes,
    terminal,
    tailer,
    board,
  }
}

test("Claude composer inspection distinguishes the idle prompt from an unsent draft or modal", () => {
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0\n────────\n  ⏵⏵ auto mode on"), { kind: "empty" })
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0UNSENT_DRAFT_PROBE\n────────"), { kind: "typed", text: "UNSENT_DRAFT_PROBE" })
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0\n  unsent second line\n────────\n  project · main"), { kind: "typed", text: "unsent second line" })
  assert.deepEqual(inspectClaudeComposer("history\n❯\u00a0\n────────\n  project · main\nUnrecognized confirmation modal"), { kind: "unavailable" })
  assert.deepEqual(inspectClaudeComposer("Accessing workspace\n ❯ 1. Yes, I trust this folder"), { kind: "unavailable" })
})

test("Claude permission footer reports the active new-pane mode without reading transcript history", () => {
  assert.equal(detectClaudePermissionMode("old text: auto mode on\n…\n❯\u00a0\n────\n  bypass permissions on"), "bypassPermissions")
  assert.equal(detectClaudePermissionMode("history\n❯\u00a0\n────\n  accept edits mode on"), "acceptEdits")
  assert.equal(detectClaudePermissionMode("history\n❯\u00a0\n────\n  ⏵⏵ auto mode on"), "auto")
  assert.equal(detectClaudePermissionMode("history\n❯\u00a0\n────\n  ⏸ manual mode on"), "default")
  assert.equal(detectClaudePermissionMode(`${"auto mode on\n".repeat(15)}❯\u00a0\n────\n  no status footer`), undefined)
})

test("an idle Claude permission change uses the same controlled reattach path", async () => {
  const h = harness()
  h.storage.upsertSession(row("claude", { backend: "claude", permission_mode: "auto" }))
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "auto" })
  h.setPane("history\n❯\u00a0\n────────\n  ⏵⏵ auto mode on")
  assert.deepEqual(await h.controller.request("claude", "bypassPermissions"), { effect: "applied" })
  assert.deepEqual(h.reattached, ["claude:auto->bypassPermissions"])
  assert.equal(h.storage.getSession("claude")?.permission_mode, "bypassPermissions")
  assert.equal(h.storage.getSession("claude")?.permission_pending, null)
})

test("a live change folds pending backend sidecars before choosing its rollback mode", async () => {
  const h = harness()
  h.storage.upsertSession(row("fresh-current", { backend: "claude", permission_mode: "default" }))
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("history\n❯\u00a0\n────────")
  h.setTailerTick(() => {
    h.storage.setPermissionMode("fresh-current", "auto")
    h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "auto" })
  })
  await h.controller.request("fresh-current", "bypassPermissions")
  assert.deepEqual(h.reattached, ["fresh-current:auto->bypassPermissions"])
})

test("a fresh backend profile that rejects the requested mode wins over the launch flag", async () => {
  const h = harness()
  const slug = "backend-coercion"
  h.storage.upsertSession(row(slug, { backend: "claude", permission_mode: "default" }))
  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    permissionMode: "default",
    permissionModeRevision: 1,
  })
  h.setPane("history\n❯\u00a0\n────────")
  let ticks = 0
  h.setTailerTick(() => {
    ticks++
    if (ticks === 2) {
      h.setPane("history\n❯\u00a0\n────────\n  manual mode on")
      h.setTelemetry({
        turn: "idle",
        permPrompt: false,
        subAgents: [],
        bgShells: [],
        pendingQuestion: false,
        permissionMode: "default",
        permissionModeRevision: 2,
      })
    }
  })

  await assert.rejects(h.controller.request(slug, "bypassPermissions"), /Backend did not apply bypassPermissions; it reported default/)
  assert.deepEqual(h.reattached, [`${slug}:default->bypassPermissions`])
  assert.equal(h.storage.getSession(slug)?.permission_mode, "default")
  assert.equal(h.storage.getSession(slug)?.permission_pending, null)
  assert.match(h.storage.getSession(slug)?.control_error ?? "", /Backend did not apply/)
  assert.ok(h.refreshes() >= 2, "the terminal coercion state is emitted after the earlier pending snapshot")
})

test("a new Claude pane footer wins over the replaced pane's delayed shutdown sidecar", async () => {
  const h = harness()
  const slug = "old-shutdown-sidecar"
  h.storage.upsertSession(row(slug, { backend: "claude", permission_mode: "acceptEdits" }))
  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [],
    bgShells: [],
    pendingQuestion: false,
    permissionMode: "acceptEdits",
    permissionModeRevision: 1,
  })
  h.setPane("history\n❯\u00a0\n────────\n  ⏵⏵ accept edits on")
  let ticks = 0
  h.setTailerTick(() => {
    ticks++
    if (ticks === 2) {
      h.setTelemetry({
        turn: "idle",
        permPrompt: false,
        subAgents: [],
        bgShells: [],
        pendingQuestion: false,
        permissionMode: "acceptEdits",
        permissionModeRevision: 2,
      })
    }
  })

  assert.deepEqual(await h.controller.request(slug, "bypassPermissions"), { effect: "applied" })
  assert.equal(h.storage.getSession(slug)?.permission_mode, "bypassPermissions")
  assert.equal(h.storage.getSession(slug)?.permission_pending, null)
  assert.equal(h.storage.getSession(slug)?.control_error, null)
})

test("the cleanup timer cannot invalidate a readiness-checked permission handoff in progress", async () => {
  const h = harness()
  h.storage.upsertSession(row("slow-handoff"))
  h.storage.setBackend("slow-handoff", "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("history\n❯ \n────────")
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const controller = createPermissionController({
    storage: h.storage,
    tailer: h.tailer,
    board: h.board,
    terminal: h.terminal,
    reattach: async () => ready,
  })

  const changing = controller.request("slow-handoff", "bypassPermissions")
  controller.tick()
  assert.equal(h.storage.getSession("slow-handoff")?.permission_pending, "bypassPermissions")
  assert.equal(h.storage.getSession("slow-handoff")?.control_error, null)
  h.setLive(false)
  await assert.rejects(controller.request("slow-handoff", "plan"), /already in progress/)
  assert.equal(h.storage.getSession("slow-handoff")?.permission_pending, "bypassPermissions")
  h.setLive(true)

  release()
  assert.deepEqual(await changing, { effect: "applied" })
  assert.equal(h.storage.getSession("slow-handoff")?.permission_pending, null)
})

test("an old permission request cannot clear or relabel a replacement session", async () => {
  const h = harness()
  const slug = "replace-flight"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("history\n❯ \n────────")
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const controller = createPermissionController({
    storage: h.storage,
    tailer: h.tailer,
    board: h.board,
    terminal: h.terminal,
    reattach: async () => ready,
  })

  const changing = controller.request(slug, "bypassPermissions")
  assert.equal(h.storage.getSession(slug)?.permission_pending, "bypassPermissions")
  h.storage.upsertSession(row(slug, {
    session_id: "sid-replacement",
    permission_mode: "plan",
    permission_pending: "plan",
    control_error: "replacement-owned state",
  }))
  release()

  await assert.rejects(changing, /deleted or replaced/)
  const replacement = h.storage.getSession(slug)!
  assert.equal(replacement.session_id, "sid-replacement")
  assert.equal(replacement.permission_mode, "plan")
  assert.equal(replacement.permission_pending, "plan")
  assert.equal(replacement.control_error, "replacement-owned state")
})

test("quiet stale background work still blocks a live permission reattach", async () => {
  const h = harness()
  h.storage.upsertSession(row("stale-child"))
  h.setTelemetry({
    turn: "idle",
    permPrompt: false,
    subAgents: [{ id: "child", label: "quiet long-running child", startedAt: "2026-07-12T00:00:00.000Z", state: "stale" }],
    bgShells: [],
    pendingQuestion: false,
    permissionMode: "default",
  })
  h.setPane("history\n❯ \n────────")

  await assert.rejects(h.controller.request("stale-child", "bypassPermissions"), /no unresolved background work/)
  assert.deepEqual(h.reattached, [])
  assert.equal(h.storage.getSession("stale-child")?.permission_pending, null)
})

test("a stale pending permission is failed closed on controller restart instead of spinning forever", () => {
  const h = harness()
  h.storage.upsertSession(row("restart"))
  h.storage.setBackend("restart", "codex")
  h.storage.setPermissionPending("restart", "bypassPermissions")
  const restarted = createPermissionController({ storage: h.storage, tailer: h.tailer, board: h.board, terminal: h.terminal })
  restarted.tick()
  assert.equal(h.storage.getSession("restart")?.permission_pending, null)
  assert.match(h.storage.getSession("restart")?.control_error ?? "", /prior permission change was not observed/)
  assert.deepEqual(h.sent, [])
})

test("restart reconciliation never treats historical or dead telemetry as a completed handoff", () => {
  for (const config of [
    { slug: "dead-claude-history", backend: "claude", live: false, permissionModeAt: undefined },
    { slug: "old-codex-history", backend: "codex", live: true, permissionModeAt: "2026-07-12T00:00:00.000Z" },
  ] as const) {
    const h = harness()
    h.storage.upsertSession(row(config.slug, {
      backend: config.backend,
      spawned_at: "2026-07-13T00:00:00.000Z",
      permission_mode: "default",
      permission_pending: "bypassPermissions",
    }))
    h.storage.setBackend(config.slug, config.backend)
    h.setLive(config.live)
    h.setTelemetry({
      turn: "idle",
      permPrompt: false,
      subAgents: [],
      bgShells: [],
      pendingQuestion: false,
      permissionMode: "bypassPermissions",
      permissionModeAt: config.permissionModeAt,
    })
    h.controller.tick()
    const saved = h.storage.getSession(config.slug)!
    assert.equal(saved.permission_mode, "default")
    assert.equal(saved.permission_pending, null)
    assert.match(saved.control_error ?? "", /not observed|retry/i)
  }
})

test("an old permission completion cannot clear a newer same-session process generation", async () => {
  const h = harness()
  const slug = "generation-flight"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("history\n❯ \n────────")
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const controller = createPermissionController({
    storage: h.storage,
    tailer: h.tailer,
    board: h.board,
    terminal: h.terminal,
    reattach: async () => ready,
  })
  const changing = controller.request(slug, "bypassPermissions")
  const current = h.storage.getSession(slug)!
  const newer = h.storage.beginRuntimeGeneration(
    slug,
    { sessionId: current.session_id, generation: current.runtime_generation ?? 0, permissionPending: "bypassPermissions", runtimeControl: "permission" },
    "2026-07-13T12:00:00.000Z",
  )
  assert.equal(newer, 1)
  h.storage.setPermissionStateIfCurrent(
    slug,
    { sessionId: current.session_id, generation: newer!, permissionPending: "bypassPermissions", runtimeControl: "permission" },
    { permissionMode: "plan", permissionPending: "bypassPermissions", controlError: "new generation owns state", exited: false },
  )
  release()
  await assert.rejects(changing, /canceled|generation|replaced/i)
  const saved = h.storage.getSession(slug)!
  assert.equal(saved.runtime_generation, 1)
  assert.equal(saved.permission_mode, "plan")
  assert.equal(saved.permission_pending, "bypassPermissions")
  assert.equal(saved.control_error, "new generation owns state")
})

test("an exited mode saves for native resume while a live read-only request reattaches", async () => {
  const h = harness()
  h.storage.upsertSession(row("exited", { exited: 1 }))
  h.storage.setBackend("exited", "codex")
  h.setLive(false)
  assert.deepEqual(await h.controller.request("exited", "plan"), { effect: "next-resume" })
  assert.equal(h.storage.getSession("exited")?.permission_mode, "plan")
  assert.equal(h.storage.getSession("exited")?.permission_pending, null)
  assert.deepEqual(h.sent, [])

  h.storage.upsertSession(row("live-read"))
  h.storage.setBackend("live-read", "codex")
  h.setLive(true)
  h.setTelemetry({ turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, permissionMode: "default" })
  h.setPane("history\n❯ \n────────")
  assert.deepEqual(await h.controller.request("live-read", "plan"), { effect: "applied" })
  assert.equal(h.storage.getSession("live-read")?.permission_mode, "plan")
  assert.equal(h.storage.getSession("live-read")?.permission_pending, null)
  assert.deepEqual(h.reattached, ["live-read:default->plan"])
  assert.deepEqual(h.sent, [])
})
