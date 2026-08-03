import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { mountRouter } from "@fray-ui/rpc/server"
import type { BoardSnapshot, Settings, ThreadView } from "@fray-ui/shared"
import type { BoardManager } from "./board.ts"
import { appendDelivery, parseDeliveryLedger } from "./delivery-ledger.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import {
  createRouter,
  completeRegisteredThread,
  completionConfirmationHold,
  completionNeedsConfirmation,
  githubDispatcherRequest,
  hasPendingPermissionChange,
  hasUnresolvedBackgroundOps,
  isAppServerCodexRow,
  stopAndForgetRegisteredRuntime,
  stopRegisteredRuntime,
  stopRuntimeBySlug,
  stopThreadRuntime,
  validateGithubDispatchProfile,
} from "./router.ts"
import { projectTranscriptPageAgentLifecycles } from "./transcript.ts"
import { createStorage, type AdoptionClaimRow, type SessionRow } from "./storage.ts"
import type { AdoptionPaneLookup, PaneIdentity, PaneSnapshot } from "./tmux.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import { createPermissionController } from "./permission-controller.ts"
import { writeScratchpad } from "./dispatch.ts"
import { providerResumeCommand, shellQuote, tmuxAttachCommand } from "./external-terminal.ts"
import * as tmuxModule from "./tmux.ts"

test("provider resume command is shell-safe", () => {
  assert.equal(shellQuote("fray's socket"), "'fray'\"'\"'s socket'")
  assert.equal(providerResumeCommand("codex", "/work/it's fray", "session-id"), "cd '/work/it'\"'\"'s fray' && codex resume 'session-id' --dangerously-bypass-approvals-and-sandbox")
  assert.equal(providerResumeCommand("claude", "/work/fray", "session-id"), "cd '/work/fray' && claude --resume 'session-id' --dangerously-skip-permissions")
})

const noopTailer: Tailer = {
  get: () => undefined,
  foreignIds: () => [],
  subAgent: () => undefined,
  forget: () => {},
  start: () => {},
  stop: () => {},
  tick: () => {},
}

test("agent lifecycle overlay replaces spawn latency with the retained child runtime", () => {
  const dispatch = {
    name: "Spawn agent",
    detail: "review-runtime",
    agentId: "call_child",
    status: "completed" as const,
    durationMs: 533,
  }
  const page = {
    messages: [{ role: "assistant" as const, text: "", tools: [dispatch], parts: [{ kind: "tools" as const, tools: [dispatch] }] }],
    beforeCursor: null,
    hasEarlier: false,
    reachedTurnBoundary: true,
    transcriptKey: "test-key",
  }
  const projected = projectTranscriptPageAgentLifecycles(page, (id) => id === "call_child" ? {
    startedAt: "2026-07-31T14:50:00.000Z",
    finishedAt: "2026-07-31T15:03:00.000Z",
    outcome: "completed",
  } : undefined)
  const expected = { ...dispatch, agentStatus: "completed" as const, agentElapsedMs: 13 * 60_000 }
  assert.deepEqual(projected.messages[0].tools[0], expected)
  assert.deepEqual(projected.messages[0].parts[0], { kind: "tools", tools: [expected] }, "ordered parts receive the same overlay")
  assert.equal("agentStatus" in page.messages[0].tools[0], false, "the transcript cache projection is not mutated")
})

test("GitHub dispatch payload preserves the exact captured backend profile (no permission passthrough)", () => {
  const batch = {
    items: [{ kind: "pr" as const, number: 91 }],
    backend: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "ultra" as const,
  }
  assert.deepEqual(
    githubDispatcherRequest(batch, { prompt: "review", title: "Review owner/repo#91", slug: "review-owner-repo-91" }),
    {
      payload: {
        prompt: "review",
        title: "Review owner/repo#91",
        slug: "review-owner-repo-91",
        backend: "codex",
        model: "gpt-5.6-sol",
        effort: "ultra",
      },
      options: { backend: "codex" },
    },
  )
})

test("GitHub dispatch validation rejects invalid pairs visibly and ignores permission entirely", () => {
  const base = {
    items: [{ kind: "issue" as const, number: 1 }],
    backend: "claude" as const,
    model: "opus",
    effort: "high" as const,
  }
  assert.doesNotThrow(() => validateGithubDispatchProfile(base))
  assert.throws(
    () => validateGithubDispatchProfile({ ...base, effort: "ultra" }),
    /Unsupported claude model\/effort pair: opus \/ ultra/,
  )
  // Permission is not part of the captured tuple: dispatch stamps the fixed non-interactive mode
  // server-side, so even a stale client-sent value passes validation untouched.
  assert.doesNotThrow(() => validateGithubDispatchProfile({ ...base, permissionMode: "plan" }))
})

function row(slug: string): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    tmux_name: `fray-${slug}`,
    spawned_at: "2026-07-12T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 1,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    plan_path: null,
    transcript_id: null,
    permission_mode: null,
  }
}

function harness(tailer: Tailer = noopTailer) {
  const dir = mkdtempSync(join(tmpdir(), "fray-router-permission-"))
  const project: Project = { dir, id: "router-permission", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"))
  const snapshot: BoardSnapshot = {
    projectDir: dir,
    projectName: "test",
    projectLabel: "test",
    threads: [],
    errors: [],
    warnings: [],
  }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => {
      refreshes++
      return snapshot
    },
    start: async () => {},
    stop: async () => {},
  }
  const backend = createClaudeBackend({ logDir: join(dir, "logs") })
  const settings = { permissionMode: "auto" } as unknown as Settings
  const permissionController = createPermissionController({
    storage,
    tailer,
    board,
    terminal: {
      isLive: () => false,
      capturePane: () => "",
    },
  })
  let adoptCalls = 0
  // createRouter is lazy: unrelated procedures do not read the omitted context fields. Keep this
  // focused on the permission route's real storage/board/backend dependencies.
  const ctx = {
    project,
    storage,
    board,
    tailer,
    backendFor: () => backend,
    getSettings: () => settings,
    permissionController,
    dispatcher: {
      dispatch: async () => ({ slug: "dispatched", sessionId: "sid-dispatched" }),
      adopt: async (slug: string) => {
        adoptCalls++
        return { slug, sessionId: `sid-${slug}` }
      },
    },
  } as unknown as AppContext
  const addExitedThread = (slug: string) =>
    snapshot.threads.push({
      id: slug,
      title: slug,
      status: "active",
      hasPlan: false,
      mechanism: null,
      humanBlocked: false,
      ready: false,
      dependsOn: [],
      externalDeps: [],
      agents: [],
      errors: [],
      warnings: [],
      runtime: "exited",
      unread: false,
      archived: false,
      subAgents: [],
      bgShells: [],
      pendingQuestion: false,
      kind: "session",
      foreign: false,
    } satisfies ThreadView)
  // `ctx` is exposed so a test can install an optional collaborator (e.g. codexAppServer) after
  // construction; createRouter closes over the object and reads those fields per-call, not at build time.
  return { dir, ctx, storage, board, snapshot, router: createRouter(ctx), addExitedThread, refreshes: () => refreshes, adoptCalls: () => adoptCalls }
}

test("threadTerminalCommand offers the verified provider resume command in every runtime state", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("codex-resume"))
    h.storage.setBackend("codex-resume", "codex")
    h.storage.setAgentSession("codex-resume", "codex-rollout-id")
    h.addExitedThread("codex-resume")
    h.snapshot.threads.at(-1)!.backend = "codex"

    const expected = { command: `cd '${h.dir}' && codex resume 'codex-rollout-id' --dangerously-bypass-approvals-and-sandbox`, mode: "resume", reason: null }

    h.board.snapshot = async () => {
      throw new Error("the copy path must not rebuild the board")
    }
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-resume" } }),
      expected,
      "Codex resumes its provider rollout ID directly from the owned registry row",
    )

    // The row is exited (no pane left to attach to), so a resume is the honest offer regardless of what
    // the board snapshot says the runtime is — the command is still offered, never gated on "wait for
    // it to exit". The live-pane case gets an ATTACH instead; see the real-tmux test below.
    h.snapshot.threads.at(-1)!.runtime = "turn-idle"
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-resume" } }),
      expected,
      "an exited row yields the resume command",
    )

    // Codex before its rollout id is discovered has no resumable native id — the Fray UUID would not
    // resume it, so fail closed with an explanatory reason rather than a broken command.
    h.storage.upsertSession(row("codex-pending"))
    h.storage.setBackend("codex-pending", "codex")
    h.addExitedThread("codex-pending")
    h.snapshot.threads.at(-1)!.backend = "codex"
    assert.deepEqual(
      await h.router.threadTerminalCommand.handler({ input: { slug: "codex-pending" } }),
      {
        command: null,
        mode: "unavailable",
        reason: "Codex hasn't reported its resumable session id yet — it appears once the first turn begins.",
      },
    )

    await assert.rejects(
      h.router.threadTerminalCommand.handler({ input: { slug: "foreign-or-legacy" } }),
      /No Fray-owned terminal session is available/,
    )
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

// A LIVE pane must yield an ATTACH, never a resume. Driven against a REAL tmux server, because the
// whole point is the tmux liveness answer — a stubbed one would prove nothing about the branch that
// matters. `<cli> resume` starts a SEPARATE process off the transcript, so handing it back for a live
// worker sends the human to a terminal that cannot show the in-flight turn or the permission prompt
// the worker is parked on (that prompt is never written to the transcript at all).
test("threadTerminalCommand attaches to a LIVE pane instead of resuming a second process", () => {
  const socket = `fray-test-attach-${process.pid}`
  const previousSocket = tmuxModule.socketName()
  const h = harness()
  const slug = "live-worker"
  try {
    tmuxModule.setSocket(socket)
    // A real session whose command is still running — the exact precondition the branch keys on.
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", `fray-${slug}`, "sleep 120"])
    h.storage.upsertSession({ ...row(slug), exited: 0 })

    assert.equal(tmuxModule.isLive(slug), true, "precondition: the harness really did create a live pane")
    const result = h.router.threadTerminalCommand.handler({ input: { slug } }) as unknown as Promise<{ command: string; mode: string }>
    return result.then((r) => {
      assert.equal(r.mode, "attach")
      assert.equal(r.command, tmuxAttachCommand(socket, `fray-${slug}`))
      // The `=` is load-bearing: without it tmux resolves by PREFIX and a human can land in a
      // neighbouring `<slug>-2` worker's terminal.
      assert.match(r.command, /attach -t '=fray-live-worker'/)
      assert.ok(!r.command.includes("--resume"), "a live pane must never hand back a resume")
    })
  } finally {
    try { execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" }) } catch { /* already gone */ }
    // kill-server stops the server but LEAVES the socket file, so a test that runs on every suite
    // invocation would silently litter one dead socket per run into the shared tmux dir. Unlink ours.
    try { rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true }) } catch { /* best effort */ }
    tmuxModule.setSocket(previousSocket)
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

// The Doc tab is gated on the scratchpad file existing and filled by this RPC, so the reader must read
// exactly what the writer wrote. It once read a path of its own (.fray/scratch/<id>.md) that dispatch
// never wrote, so every thread's Doc tab rendered "No scratchpad yet." Round-trip the real writer.
test("threadScratchpad reads the scratchpad the dispatcher actually writes", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("scratch-thread"))
    const rel = writeScratchpad(h.dir, "sid-scratch-thread", "Scratch thread")
    assert.equal(rel, ".fray/threads/sid-scratch-thread/scratch.md")
    writeFileSync(join(h.dir, rel), "# Scratchpad\n\nreal worker notes\n")

    assert.deepEqual(await h.router.threadScratchpad.handler({ input: { slug: "scratch-thread" } }), {
      markdown: "# Scratchpad\n\nreal worker notes\n",
    })

    // Unowned slug and never-provisioned session both fail closed to the empty doc, never throw.
    assert.deepEqual(await h.router.threadScratchpad.handler({ input: { slug: "no-such-thread" } }), { markdown: "" })
    h.storage.upsertSession(row("padless-thread"))
    assert.deepEqual(await h.router.threadScratchpad.handler({ input: { slug: "padless-thread" } }), { markdown: "" })
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("planBody RPC returns only a securely resolved direct plan file", async () => {
  const h = harness()
  const plans = join(h.dir, ".fray", "plans")
  const outside = join(h.dir, "outside.md")
  try {
    mkdirSync(plans, { recursive: true })
    writeFileSync(join(plans, "safe.md"), "# Safe plan\n")
    writeFileSync(outside, "outside\n")
    symlinkSync(outside, join(plans, "linked.md"))

    assert.deepEqual(
      await h.router.planBody.handler({ input: { path: ".fray/plans/safe.md" } }),
      { markdown: "# Safe plan\n" },
    )
    for (const path of [
      ".fray/plans/linked.md",
      ".fray/plans/../../outside.md",
      ".fray/plans/nested/safe.md",
      "/absolute.md",
    ]) {
      assert.deepEqual(await h.router.planBody.handler({ input: { path } }), { markdown: "" }, path)
    }
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("auto-titled sessions never read or mutate a same-slug legacy file through RPCs", async () => {
  const h = harness()
  const fray = join(h.dir, ".fray")
  const regular = join(fray, "auto-file.md")
  const repair = join(fray, "auto-repair.md")
  const external = join(h.dir, "outside.md")
  const linked = join(fray, "auto-link.md")
  const regularBody = "---\ntitle: Planted\nstatus: active\n---\nregular sentinel\n"
  try {
    mkdirSync(fray)
    writeFileSync(regular, regularBody)
    writeFileSync(repair, "repair sentinel\n")
    writeFileSync(external, "external sentinel\n")
    symlinkSync(external, linked)
    for (const slug of ["auto-file", "auto-repair", "auto-link"]) {
      h.storage.upsertSession({ ...row(slug), title_auto: 1 })
    }
    h.addExitedThread("auto-file")

    assert.deepEqual(await h.router.threadBody.handler({ input: { slug: "auto-file" } }), { markdown: "" })
    assert.deepEqual(await h.router.threadBody.handler({ input: { slug: "auto-link" } }), { markdown: "" })

    await h.router.archiveThread.handler({ input: { slug: "auto-file" } })
    for (const mutation of [
      () => h.router.markComplete.handler({ input: { slug: "auto-file" } }),
      () => h.router.setThreadStatus.handler({ input: { slug: "auto-file", status: "done" } }),
      () => h.router.dismissThread.handler({ input: { slug: "auto-file" } }),
      () => h.router.repairThread.handler({ input: { file: "auto-repair.md" } }),
    ]) {
      await assert.rejects(mutation, /session-first auto-titled threads do not own a legacy thread file/)
    }

    assert.equal(readFileSync(regular, "utf8"), regularBody)
    assert.equal(readFileSync(repair, "utf8"), "repair sentinel\n")
    assert.equal(readFileSync(external, "utf8"), "external sentinel\n")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("renameThread RPC: commits a trimmed human title for Codex without touching the running agent", async () => {
  const h = harness()
  h.storage.upsertSession({ ...row("generated-slug"), title: "generated-slug", title_auto: 1, exited: 0 })
  h.storage.setBackend("generated-slug", "codex")
  const proc = h.router.renameThread
  const input = proc.input.parse({ slug: "generated-slug", title: "  Human-readable thread title  " })

  await proc.handler({ input })

  const saved = h.storage.getSession("generated-slug")!
  assert.equal(saved.title, "Human-readable thread title")
  assert.equal(saved.title_auto, 0)
  assert.equal(saved.exited, 0, "renaming metadata must not stop or reattach the live process")
  assert.equal(saved.backend, "codex")
  assert.equal(h.refreshes(), 1, "the saved title is published immediately through a board delta")
  h.storage.close()
})

test("adoptThread RPC rejects malformed or extended identities before handler dispatch", () => {
  const h = harness()
  const proc = h.router.adoptThread
  assert.equal(proc.input.safeParse({ slug: "valid-thread", message: "continue" }).success, true)
  for (const slug of ["../escape", "/absolute", ".", "%2e%2e", "Ünicode", "line\nbreak", "-option", "a".repeat(201)]) {
    assert.equal(proc.input.safeParse({ slug }).success, false, JSON.stringify(slug))
  }
  assert.equal(proc.input.safeParse({ slug: "valid-thread", unexpected: true }).success, false)
  h.storage.close()
})

test("mounted adoptThread HTTP RPC returns 400 with zero dispatcher calls for hostile input", async () => {
  const h = harness()
  const app = new Hono()
  mountRouter(app, "/rpc", h.router)
  for (const input of [{ slug: "../escape" }, { slug: "safe", extra: true }, { slug: "a".repeat(201) }]) {
    const response = await app.request("http://localhost/rpc/adoptThread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    assert.equal(response.status, 400, JSON.stringify(input))
  }
  assert.equal(h.adoptCalls(), 0)
  h.storage.close()
})

test("renameThread RPC: empty titles are rejected and rowless/foreign threads remain read-only", async () => {
  const h = harness()
  const proc = h.router.renameThread
  assert.equal(proc.input.safeParse({ slug: "t", title: "   " }).success, false)
  assert.equal(proc.input.safeParse({ slug: "t", title: "x".repeat(201) }).success, false)
  await assert.rejects(proc.handler({ input: { slug: "external", title: "No row" } }), /not editable/)
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

// Provider rename now goes through the Claude broker's typed control channel (the SDK's
// `generateSessionTitle`) rather than typing `/rename` into a tmux pane, so the refusal a non-Claude
// or non-broker thread gets names the transport rather than the backend.
test("aiRenameThread RPC: only a running broker-backed Claude thread can be renamed by the provider", async () => {
  const h = harness()
  h.storage.upsertSession({ ...row("codex-title"), exited: 0 })
  h.storage.setBackend("codex-title", "codex")
  await assert.rejects(h.router.aiRenameThread.handler({ input: { slug: "codex-title" } }), /broker-backed Claude thread/)
  assert.equal(h.storage.getSession("codex-title")?.title, "codex-title")
  assert.equal(h.refreshes(), 0)
  h.storage.close()
})

test("setThreadPermission RPC: validates input and persists an exited thread override for next resume", async () => {
  const h = harness()
  h.storage.upsertSession(row("rpc-permission"))
  h.addExitedThread("rpc-permission")
  const proc = h.router.setThreadPermission
  assert.equal(proc.input.safeParse({ slug: "rpc-permission", permissionMode: "bogus" }).success, false)
  const result = await proc.handler({ input: { slug: "rpc-permission", permissionMode: "bypassPermissions" } })
  assert.deepEqual(result, { effect: "next-resume" })
  assert.equal(h.storage.getSession("rpc-permission")?.permission_mode, "bypassPermissions")
  h.storage.close()
})

// The permission/profile controllers are CLAUDE-only since the codex tmux composer was removed (they
// parse the pane with inspectClaudeComposer). A LEGACY codex row — dispatched before the app-server
// cutover, so codex_runtime is still NULL — must therefore persist like any other codex row instead of
// being handed to them, which is what gating on `codex_runtime === "app-server"` used to do.
test("setThreadPermission/setThreadProfile RPC: a legacy codex row persists and never reaches the tmux controllers", async () => {
  const h = harness()
  const slug = "legacy-codex-row"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex") // codex_runtime deliberately left NULL
  h.addExitedThread(slug)

  let controllerCalls = 0
  const spy = { request: async () => { controllerCalls++; return { effect: "applied" as const } } }
  ;(h.ctx as { permissionController?: unknown }).permissionController = { ...spy, tick: () => {}, start: () => {}, stop: () => {} }
  ;(h.ctx as { profileController?: unknown }).profileController = spy

  assert.deepEqual(
    await h.router.setThreadPermission.handler({ input: { slug, permissionMode: "bypassPermissions" } }),
    { effect: "next-resume" },
  )
  assert.deepEqual(
    await h.router.setThreadProfile.handler({ input: { slug, model: "gpt-5.6-sol", effort: "high" } }),
    { effect: "next-resume" },
  )
  assert.equal(controllerCalls, 0, "a codex row never reaches the Claude-only permission/profile controllers")
  const saved = h.storage.getSession(slug)!
  assert.equal(saved.permission_mode, "bypassPermissions")
  assert.equal(saved.model, "gpt-5.6-sol")
  assert.equal(saved.effort, "high")
  assert.equal(saved.runtime_control ?? null, null, "no durable tmux runtime control was armed")
  h.storage.close()
})

test("setThreadPermission RPC: rowless/foreign-style threads are read-only", async () => {
  const h = harness()
  await assert.rejects(
    h.router.setThreadPermission.handler({ input: { slug: "external", permissionMode: "bypassPermissions" } }),
    /not editable/,
  )
  h.storage.close()
})

test("setThreadSnooze RPC validates canonical future UTC and persists any owned open queue card", async () => {
  const h = harness()
  const slug = "rpc-snooze"
  h.storage.upsertSession(row(slug))
  h.addExitedThread(slug)
  const thread = h.snapshot.threads.at(-1)!
  thread.needsYou = true // ordinary clean rest is queue-worthy but still snoozable
  thread.crashed = false
  const proc = h.router.setThreadSnooze
  for (const until of ["tomorrow", "2026-07-14T08:45:00Z", "2026-07-14 08:45:00.000Z", "2026-07-14T08:45:00.000+00:00", "2099-02-31T08:45:00.000Z"]) {
    assert.equal(proc.input.safeParse({ slug, sessionId: `sid-${slug}`, until }).success, false, until)
  }
  assert.equal(proc.input.safeParse({ slug, sessionId: `sid-${slug}`, until: "2099-07-14T08:45:00.000Z", extra: true }).success, false)
  await assert.rejects(
    proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: "2000-01-01T00:00:00.000Z" } }),
    /future/,
  )

  const exact = "2099-07-14T08:45:00.000Z"
  await proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: exact } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, exact)
  assert.equal(h.refreshes(), 1)

  thread.pendingQuestion = true
  const replacement = "2099-07-15T08:45:00.000Z"
  await proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: replacement } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, replacement, "an unresolved question remains explicitly snoozable")

  await proc.handler({ input: { slug, sessionId: `sid-${slug}`, until: null } })
  assert.equal(h.storage.getSession(slug)?.snoozed_until, null, "wake-now remains available with the same validation contract")
  h.storage.close()
})

// The writer-yield guard exists to avoid racing an operator driving the thread from their own
// terminal. A rollout FROZEN by a dead app-server looks identical from the rollout alone, and yielding
// to it left the operator unable to answer their own stalled thread at all — the second half of the
// 2026-07-22 stall (the first was the board showing it as forever-running).
test("followUp yields to a live external writer but still answers a thread whose turn died", async () => {
  const h = harness()
  const ownedSince = "2026-07-09T10:00:00.000Z"
  const install = (liveness: { bridgeTurn: boolean; ownedSince: string } | undefined, sent: string[]) => {
    ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
      binding: () => ({ state: "active", currentTurnId: null }),
      turnLiveness: () => liveness,
      resumeOwnedSession: async () => {},
      followUp: async ({ text }: { text: string }) => void sent.push(text),
    }
  }
  // Both threads read in-flight off their rollout; only the timestamps differ.
  const external = "external-writer"
  const stalled = "stalled-writer"
  for (const slug of [external, stalled]) {
    h.storage.upsertSession(row(slug))
    h.storage.setBackend(slug, "codex")
    h.storage.setCodexRuntime(slug, "app-server")
  }
  h.ctx.tailer = {
    ...noopTailer,
    get: (slug: string) => ({
      turn: "in-flight" as const,
      permPrompt: false,
      subAgents: [],
      bgShells: [],
      pendingQuestion: false,
      // The external writer is still appending; the stalled one froze before fray took the thread.
      lastActivityAt: slug === external ? new Date().toISOString() : "2026-07-09T09:59:00.000Z",
    }),
  }

  const yielded: string[] = []
  install({ bridgeTurn: false, ownedSince: new Date().toISOString() }, yielded)
  await assert.rejects(
    h.router.followUp.handler({ input: { slug: external, sessionId: `sid-${external}`, message: "hello" } }),
    /running in your terminal/,
  )
  assert.deepEqual(yielded, [], "fray must not race a second writer onto a live external turn")

  const delivered: string[] = []
  install({ bridgeTurn: false, ownedSince }, delivered)
  await h.router.followUp.handler({ input: { slug: stalled, sessionId: `sid-${stalled}`, message: "still there?" } })
  assert.deepEqual(delivered, ["still there?"], "a stalled thread stays answerable")
  h.storage.close()
})

// A park says WHEN the operator wants the card back, not that the thread is untouchable. Adding context
// to a thread you shelved until Friday must not drag it out of Held, and must not silently disarm a bump
// it was promised — Wake now is the explicit un-park. Driven through the codex app-server branch because
// it is the one followUp path that reaches a stubbable bridge instead of real tmux; the invariant is
// branch-independent (the handler no longer writes the snooze row at all).
test("followUp leaves a snooze — and its armed bump — intact", async () => {
  const h = harness()
  const slug = "snoozed-followup"
  const until = "2099-07-14T08:45:00.000Z"
  const bump = "Check whether CI went green and land it if so."
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  h.storage.setSnoozedUntil(slug, until, bump)

  const sent: string[] = []
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async ({ text }: { text: string }) => void sent.push(text),
  }

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "also use a squash merge" } })

  assert.deepEqual(sent, ["also use a squash merge"], "the message still reaches the worker")
  assert.equal(h.storage.getSession(slug)?.snoozed_until, until, "the park survives the follow-up")
  assert.equal(h.storage.getSession(slug)?.snooze_prompt, bump, "and so does the bump it owes at that deadline")
  h.storage.close()
})

// ── confirmAwaiting (ported from origin/main during the 2026-07-23 reconcile) ───────────────────────
// A fence is a PROPOSAL; the operator confirms one exact generation. The RPC binds the tail's
// lastActivityAt as the fence instant (local main's FenceView carries hints[] and no `.at`) and
// canonicalizes the timer before it reaches the durable snooze column.
function awaitingTailer(over: {
  turn?: "idle" | "in-flight"
  fence?: { kind: "done" | "awaiting"; hints: { kind: string; value: string }[] } | undefined
  lastActivityAt?: string
} = {}): Tailer {
  const tele = {
    turn: over.turn ?? "idle",
    lastFence: "fence" in over ? over.fence : { kind: "awaiting", body: "", hints: [{ kind: "timer", value: "2099-07-14T08:45:00Z" }] },
    lastActivityAt: over.lastActivityAt ?? "2026-07-23T19:30:00.000Z",
  }
  return { ...noopTailer, get: () => tele as never }
}

test("confirmAwaiting binds the current fence and writes a canonical snooze target", async () => {
  const h = harness(awaitingTailer())
  h.storage.upsertSession(row("aw-ok"))
  h.storage.setState("aw-ok", "open")
  await h.router.confirmAwaiting.handler({
    input: {
      slug: "aw-ok",
      sessionId: "sid-aw-ok",
      fenceAt: "2026-07-23T19:30:00.000Z",
      hint: { kind: "timer", value: "2099-07-14T08:45:00Z" },
    },
  })
  const saved = h.storage.getSession("aw-ok")!
  assert.ok(saved.awaiting_fence_id, "a fence identity is written")
  assert.ok(saved.awaiting_confirmed_at, "the confirmation instant is stamped")
  // The fence hint's no-millis instant is canonicalized to the durable snooze grammar.
  assert.equal(saved.snoozed_until, "2099-07-14T08:45:00.000Z")
  h.storage.close()
})

test("confirmAwaiting fails closed on a stale session id", async () => {
  const h = harness(awaitingTailer())
  h.storage.upsertSession(row("aw-stale"))
  h.storage.setState("aw-stale", "open")
  await assert.rejects(
    h.router.confirmAwaiting.handler({
      input: { slug: "aw-stale", sessionId: "wrong-sid", fenceAt: "2026-07-23T19:30:00.000Z", hint: { kind: "timer", value: "2099-07-14T08:45:00Z" } },
    }),
    /replaced/,
  )
  h.storage.close()
})

test("confirmAwaiting rejects a fenceAt that no longer matches the tail", async () => {
  const h = harness(awaitingTailer())
  h.storage.upsertSession(row("aw-drift"))
  h.storage.setState("aw-drift", "open")
  await assert.rejects(
    h.router.confirmAwaiting.handler({
      input: { slug: "aw-drift", sessionId: "sid-aw-drift", fenceAt: "2020-01-01T00:00:00.000Z", hint: { kind: "timer", value: "2099-07-14T08:45:00Z" } },
    }),
    /changed before it could be confirmed/,
  )
  h.storage.close()
})

test("confirmAwaiting refuses a non-actionable hint (a human gate arms nothing)", async () => {
  const h = harness(awaitingTailer({ fence: { kind: "awaiting", hints: [{ kind: "human", value: "Alice to approve" }] } }))
  h.storage.upsertSession(row("aw-human"))
  h.storage.setState("aw-human", "open")
  await assert.rejects(
    h.router.confirmAwaiting.handler({
      input: { slug: "aw-human", sessionId: "sid-aw-human", fenceAt: "2026-07-23T19:30:00.000Z", hint: { kind: "human", value: "Alice to approve" } },
    }),
    /no longer current/,
  )
  h.storage.close()
})

test("confirmAwaiting refuses while the worker is mid-turn", async () => {
  const h = harness(awaitingTailer({ turn: "in-flight" }))
  h.storage.upsertSession(row("aw-busy"))
  h.storage.setState("aw-busy", "open")
  await assert.rejects(
    h.router.confirmAwaiting.handler({
      input: { slug: "aw-busy", sessionId: "sid-aw-busy", fenceAt: "2026-07-23T19:30:00.000Z", hint: { kind: "timer", value: "2099-07-14T08:45:00Z" } },
    }),
    /no longer current/,
  )
  h.storage.close()
})

test("setThreadPermission RPC safety: running and stale background entries are unresolved", () => {
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [{ state: "stale" }], bgShells: [{ state: "stale" }] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [{ state: "running" }], bgShells: [] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [], bgShells: [{ state: "running" }] }), true)
  assert.equal(hasUnresolvedBackgroundOps({ subAgents: [], bgShells: [] }), false)
})

test("follow-up safety: a durable permission handoff blocks every composer surface", () => {
  assert.equal(hasPendingPermissionChange({ permission_pending: "bypassPermissions" }), true)
  assert.equal(hasPendingPermissionChange({ permission_pending: null }), false)
  assert.equal(hasPendingPermissionChange({ permission_pending: "future-mode" }), true, "unknown durable state fails closed")
})

function finalizedClaim(slug: string): AdoptionClaimRow {
  return {
    slug,
    attempt_token: "11111111-1111-4111-8111-111111111111",
    session_id: `sid-${slug}`,
    state: "finalized",
    reserved_at_ms: 1,
    lease_expires_at_ms: 2,
    recovery_token: null,
    pane_id: "%41",
    pane_pid: 4241,
    session_created: 741,
    finalized_at_ms: 3,
  }
}

function terminatorHarness(initial: AdoptionPaneLookup) {
  let pane = initial
  const killedPanes: PaneIdentity[] = []
  const killedSessions: string[] = []
  return {
    runtime: {
      findExpectedAdoptionPane: () => pane,
      killExpectedAdoptionPane: (expected: AdoptionClaimRow) => {
        if (
          pane.kind !== "found" || pane.pane.adoptionAttemptToken !== expected.attempt_token ||
          pane.pane.paneId !== expected.pane_id || pane.pane.panePid !== expected.pane_pid ||
          pane.pane.sessionCreated !== expected.session_created
        ) return false
        killedPanes.push({
          paneId: pane.pane.paneId,
          panePid: pane.pane.panePid,
          sessionCreated: pane.pane.sessionCreated,
        })
        pane = { kind: "absent" }
        return true
      },
      killPane: (identity: PaneIdentity) => {
        killedPanes.push(identity)
        pane = { kind: "absent" }
      },
      killSession: (slug: string) => killedSessions.push(slug),
      isLive: () => pane.kind === "found" && !pane.pane.dead,
    },
    killedPanes,
    killedSessions,
  }
}

test("completeRegisteredThread asks before ending a live session, then stops and archives only after confirmation", async () => {
  const h = harness()
  const slug = "live-complete"
  const saved = { ...row(slug), exited: 0 }
  let live = true
  const kills: string[] = []
  try {
    h.storage.upsertSession(saved)
    const runtime = {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: (target: string) => { kills.push(target); live = false },
      isLive: () => live,
    }
    assert.deepEqual(await completeRegisteredThread(h.storage, saved, false, runtime), {
      needsConfirmation: true,
      // No telemetry at all: the dialog must say "unreadable", not invent an executing turn.
      hold: { turnInFlight: false, unobservable: true, subAgents: [], subAgentCount: 0, bgShells: [], bgShellCount: 0 },
    })
    assert.equal(h.storage.getSession(slug)?.state, "open", "cancel/initial click leaves the live session open")
    assert.deepEqual(kills, [])

    assert.deepEqual(await completeRegisteredThread(h.storage, saved, true, runtime), { needsConfirmation: false })
    assert.deepEqual(kills, [slug])
    assert.equal(h.storage.getSession(slug)?.state, "archived")
    assert.equal(h.storage.getSession(slug)?.exited, 1)
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("completeRegisteredThread ends an idle live provider shell without confirmation and archives it", async () => {
  const h = harness()
  const slug = "idle-live-complete"
  const saved = { ...row(slug), exited: 0 }
  let live = true
  const kills: string[] = []
  try {
    h.storage.upsertSession(saved)
    const telemetry = {
      turn: "idle" as const,
      permPrompt: false,
      pendingQuestion: false,
      subAgents: [],
      bgShells: [],
    }
    assert.equal(completionNeedsConfirmation(telemetry), false)
    assert.deepEqual(await completeRegisteredThread(h.storage, saved, false, {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: (target: string) => { kills.push(target); live = false },
      isLive: () => live,
    }, telemetry), { needsConfirmation: false })
    assert.deepEqual(kills, [slug], "Done terminates the resting shell rather than orphaning it")
    assert.equal(h.storage.getSession(slug)?.state, "archived")
    assert.equal(h.storage.getSession(slug)?.exited, 1)
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("completeRegisteredThread requires confirmation for an executing turn or live background work", async () => {
  const h = harness()
  try {
    const executing = {
      turn: "in-flight" as const,
      permPrompt: false,
      pendingQuestion: false,
      subAgents: [],
      bgShells: [],
    }
    const childWorking = {
      ...executing,
      turn: "idle" as const,
      subAgents: [{ id: "child-1", label: "Child", startedAt: "2026-07-15T00:00:00.000Z", state: "running" as const }],
    }
    // A stale-only parent reads as at-rest — hasLiveBackgroundWork keeps it IN the queue, so Done must
    // NOT contradict that with a "still running" warning. Only ACTIVELY-running work forces confirmation.
    const staleChildOnly = {
      ...executing,
      turn: "idle" as const,
      subAgents: [{ id: "stale-1", label: "Silent past the staleness ceiling", startedAt: "2026-07-15T00:00:00.000Z", state: "stale" as const }],
    }
    assert.equal(completionNeedsConfirmation(executing), true)
    assert.equal(completionNeedsConfirmation(childWorking), true)
    assert.equal(completionNeedsConfirmation(staleChildOnly), false, "a stale-only parent is at rest — Done proceeds, matching the queue rule")

    for (const [slug, telemetry] of [["executing-complete", executing], ["child-complete", childWorking]] as const) {
      const saved = { ...row(slug), exited: 0 }
      h.storage.upsertSession(saved)
      let kills = 0
      assert.equal((await completeRegisteredThread(h.storage, saved, false, {
        findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
        killExpectedAdoptionPane: () => false,
        killSession: () => { kills++ },
        isLive: () => true,
      }, telemetry)).needsConfirmation, true)
      assert.equal(kills, 0)
      assert.equal(h.storage.getSession(slug)?.state, "open")
    }
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

// The verdict alone left the dialog saying "this thread is still running", which answers nothing the
// human can act on — they clicked Done because they believed it was finished. The hold carries the
// server's actual evidence so the confirmation can name the executing turn and every child it is
// about to kill, by count and by label.
test("completionConfirmationHold names WHY it declined: the executing turn plus every live child", () => {
  const base = { turn: "idle" as const, permPrompt: false, pendingQuestion: false, subAgents: [], bgShells: [] }
  assert.equal(completionConfirmationHold({ ...base }), undefined, "a resting session with no children holds nothing")
  assert.equal(
    completionConfirmationHold({ ...base, turn: "in-flight", permPrompt: true }),
    undefined,
    "a verified permission pause is a human wait, not executing work",
  )

  const at = "2026-07-15T00:00:00.000Z"
  const hold = completionConfirmationHold({
    ...base,
    turn: "in-flight",
    subAgents: [
      { id: "a1", label: "Audit the resolver", startedAt: at, state: "running" as const },
      // A STALE child: its completion signal was lost AND its transcript has been silent past the
      // 15-min ceiling. That reads as finished/dead, not working — and hasLiveBackgroundWork already
      // keeps such a parent IN the queue as at-rest, so the Done dialog must not contradict it.
      { id: "a2", label: "Silent past the staleness ceiling", startedAt: at, state: "stale" as const },
    ],
    bgShells: [
      { label: "Watch CI", startedAt: at, state: "running" as const },
    ],
  })
  // Mid-turn AND owning RUNNING children is one honest reading, not two competing ones — both travel.
  // The stale sub-agent is NOT named: it is not something Done meaningfully still has to kill.
  assert.deepEqual(hold, {
    turnInFlight: true,
    unobservable: false,
    subAgents: [{ label: "Audit the resolver", state: "running" }],
    subAgentCount: 1,
    bgShells: [{ label: "Watch CI", state: "running" }],
    bgShellCount: 1,
  }, "only ACTIVELY-running ops are named; a stale child no longer holds Done, matching the queue rule")
})

test("completionConfirmationHold caps worker-authored labels but reports the untruncated count", () => {
  const at = "2026-07-15T00:00:00.000Z"
  const hold = completionConfirmationHold({
    turn: "idle",
    permPrompt: false,
    pendingQuestion: false,
    subAgents: Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, label: `child ${i}`, startedAt: at, state: "running" as const })),
    bgShells: [{ label: "x".repeat(500), startedAt: at, state: "running" as const }],
  })
  assert.equal(hold?.turnInFlight, false, "an idle parent with live children is held by the children alone")
  assert.equal(hold?.subAgents.length, 8, "the named list is capped")
  assert.equal(hold?.subAgentCount, 11, "the count is NOT capped — the dialog says '+3 more', never a silent truncation")
  assert.equal(hold?.bgShells[0].label.length, 100, "a runaway label cannot blow out the dialog")
})

test("completion only trusts known resting telemetry; a live unobservable runtime remains protected", () => {
  assert.equal(completionNeedsConfirmation(undefined), true)
  assert.equal(completionNeedsConfirmation({
    turn: "in-flight",
    permPrompt: true,
    pendingQuestion: false,
    subAgents: [],
    bgShells: [],
  }), false, "a verified native permission pause is not executing work")
})

test("completeRegisteredThread archives an inactive session without a confirmation or termination", async () => {
  const h = harness()
  const slug = "inactive-complete"
  const saved = row(slug)
  let kills = 0
  try {
    h.storage.upsertSession(saved)
    assert.deepEqual(await completeRegisteredThread(h.storage, saved, false, {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: () => { kills++ },
      isLive: () => false,
    }), { needsConfirmation: false })
    assert.equal(kills, 0)
    assert.equal(h.storage.getSession(slug)?.state, "archived")
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("completeRegisteredThread never archives when a live provider shell survives termination", async () => {
  const h = harness()
  const slug = "termination-failed"
  const saved = { ...row(slug), exited: 0 }
  try {
    h.storage.upsertSession(saved)
    await assert.rejects(() => completeRegisteredThread(h.storage, saved, true, {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: () => {},
      isLive: () => true,
    }), /could not be confirmed stopped/)
    assert.equal(h.storage.getSession(slug)?.state, "open")
    assert.equal(h.storage.getSession(slug)?.exited, 0)
  } finally {
    h.storage.close()
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test("adoption teardown: forget/dismiss/stop kill only the finalized token + exact tuple", () => {
  const slug = "adopted-owner"
  const claim = finalizedClaim(slug)
  const pane: PaneSnapshot = {
    paneId: claim.pane_id!,
    panePid: claim.pane_pid!,
    sessionCreated: claim.session_created!,
    adoptionAttemptToken: claim.attempt_token,
    dead: true,
  }
  const h = terminatorHarness({ kind: "found", pane })

  assert.equal(stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), h.runtime), "stopped")
  assert.deepEqual(h.killedPanes, [{ paneId: "%41", panePid: 4241, sessionCreated: 741 }])
  assert.deepEqual(h.killedSessions, [], "a finalized adoption never falls back to reusable slug teardown")
})

test("adoption teardown: a same-tuple token mismatch or competing claim is never killed", () => {
  const slug = "adopted-competitor"
  const claim = finalizedClaim(slug)
  const h = terminatorHarness({
    kind: "found",
    pane: {
      paneId: claim.pane_id!,
      panePid: claim.pane_pid!,
      sessionCreated: claim.session_created!,
      adoptionAttemptToken: "22222222-2222-4222-8222-222222222222",
      dead: false,
    },
  })
  assert.throws(
    () => stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), h.runtime),
    /exact runtime identity is unavailable/,
  )
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedSessions, [])

  const reserved = { ...claim, state: "reserved" as const, finalized_at_ms: null }
  assert.throws(
    () => stopRegisteredRuntime({ getAdoptionClaim: () => reserved }, row(slug), h.runtime),
    /competing adoption attempt/,
  )
  assert.deepEqual(h.killedPanes, [])
  assert.deepEqual(h.killedSessions, [])
})

test("adoption teardown cannot kill a pane retokened between proof and the atomic action", () => {
  const slug = "adopted-retoken-race"
  const claim = finalizedClaim(slug)
  const competitorToken = "55555555-5555-4555-8555-555555555555"
  let pane: PaneSnapshot = {
    paneId: claim.pane_id!, panePid: claim.pane_pid!, sessionCreated: claim.session_created!,
    adoptionAttemptToken: claim.attempt_token, dead: false,
  }
  let kills = 0
  const runtime = {
    findExpectedAdoptionPane: (expected: AdoptionClaimRow): AdoptionPaneLookup =>
      pane.adoptionAttemptToken === expected.attempt_token
        ? { kind: "found", pane }
        : { kind: "unknown" },
    killExpectedAdoptionPane: (expected: AdoptionClaimRow) => {
      // Deterministically inject the ABA at the exact proof→action boundary. The atomic helper sees
      // the new token and must decline even though pane id/pid/session-created are unchanged.
      pane = { ...pane, adoptionAttemptToken: competitorToken }
      if (pane.adoptionAttemptToken !== expected.attempt_token) return false
      kills++
      return true
    },
    killSession: () => { throw new Error("must not name-kill") },
    isLive: () => true,
  }
  assert.throws(
    () => stopRegisteredRuntime({ getAdoptionClaim: () => claim }, row(slug), runtime),
    /changed before it could be stopped/,
  )
  assert.equal(kills, 0)
  assert.equal(pane.adoptionAttemptToken, competitorToken)
})

test("legacy teardown retains name behavior while an absent finalized owner is a safe no-op", () => {
  const slug = "legacy-owner"
  const legacy = terminatorHarness({ kind: "absent" })
  assert.equal(stopRegisteredRuntime({ getAdoptionClaim: () => undefined }, row(slug), legacy.runtime), "stopped")
  assert.deepEqual(legacy.killedSessions, [slug])

  const adopted = terminatorHarness({ kind: "absent" })
  assert.equal(
    stopRegisteredRuntime({ getAdoptionClaim: () => finalizedClaim(slug) }, row(slug), adopted.runtime),
    "absent",
  )
  assert.deepEqual(adopted.killedSessions, [])
  assert.deepEqual(adopted.killedPanes, [])
})

test("router teardown never downgrades a stale replaced row to reusable-name control", () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-router-aba-")), "ui.db"))
  const slug = "router-stale-row"
  const stale = row(slug)
  storage.upsertSession(stale)
  storage.upsertSession({ ...stale, session_id: "replacement", runtime_generation: 0 })
  const h = terminatorHarness({ kind: "absent" })
  assert.throws(() => stopRegisteredRuntime(storage, stale, h.runtime), /competing adoption attempt/)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless reserved/spawned adoption claims fail closed without a name or exact kill", async () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-rowless-adopt-")), "ui.db"))
  const slug = "rowless-adoption"
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken: "33333333-3333-4333-8333-333333333333",
    sessionId: "reserved-owner",
    reservedAtMs: 1,
    leaseExpiresAtMs: 100,
  }), true)
  const h = terminatorHarness({ kind: "absent" })
  await assert.rejects(() => stopRuntimeBySlug(storage, slug, h.runtime), /adoption attempt is in progress/i)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless name teardown is fenced against a claim appearing after the optimistic read", async () => {
  const h = terminatorHarness({ kind: "absent" })
  const storage = {
    getSession: () => undefined,
    getAdoptionClaim: () => undefined,
    withUnclaimedRuntimeFence: () => ({ acquired: false as const }),
  }
  await assert.rejects(() => stopRuntimeBySlug(storage, "rowless-race", h.runtime), /nothing was stopped/)
  assert.deepEqual(h.killedSessions, [])
  assert.deepEqual(h.killedPanes, [])
})

test("rowless adoption claim blocks kill, dismiss-status, and forget RPC handlers before tmux", async () => {
  const h = harness()
  const slug = "rowless-rpc-adoption"
  assert.equal(h.storage.reserveAdoptionClaim({
    slug,
    attemptToken: "66666666-6666-4666-8666-666666666666",
    sessionId: "rowless-rpc-owner",
    reservedAtMs: 1,
    leaseExpiresAtMs: 100,
  }), true)
  await assert.rejects(h.router.killAgent.handler({ input: { slug } }), /adoption attempt is in progress/i)
  await assert.rejects(
    h.router.setThreadStatus.handler({ input: { slug, status: "dismissed" } }),
    /adoption attempt is in progress/i,
  )
  await assert.rejects(h.router.forgetThread.handler({ input: { slug } }), /adoption attempt is in progress/i)
  assert.equal(h.storage.getAdoptionClaim(slug)?.state, "reserved")
})

test("stale forget loses to a finalized successor token and preserves its row and pane binding", async () => {
  const storage = createStorage(join(mkdtempSync(join(tmpdir(), "fray-forget-rotation-")), "ui.db"))
  const slug = "forget-successor"
  const original = finalizedClaim(slug)
  const saved = row(slug)
  assert.equal(storage.reserveAdoptionClaim({
    slug,
    attemptToken: original.attempt_token,
    sessionId: saved.session_id,
    reservedAtMs: 1,
    leaseExpiresAtMs: 2,
  }), true)
  assert.equal(storage.recordAdoptionPane(slug, original.attempt_token, {
    paneId: original.pane_id!, panePid: original.pane_pid!, sessionCreated: original.session_created!,
  }, 2), true)
  assert.equal(storage.finalizeAdoptionClaim(slug, original.attempt_token, saved, 2), true)

  const successorToken = "44444444-4444-4444-8444-444444444444"
  let rotated = false
  const originalPane: PaneSnapshot = {
    paneId: original.pane_id!, panePid: original.pane_pid!, sessionCreated: original.session_created!,
    adoptionAttemptToken: original.attempt_token, dead: true,
  }
  const runtime = {
    findExpectedAdoptionPane: (expected: AdoptionClaimRow): AdoptionPaneLookup => {
      if (!rotated && expected.attempt_token === original.attempt_token) return { kind: "found", pane: originalPane }
      if (rotated && expected.attempt_token === successorToken) return { kind: "found", pane: {
        paneId: "%99", panePid: 9900, sessionCreated: 99000,
        adoptionAttemptToken: successorToken, dead: false,
      } }
      return { kind: "absent" }
    },
    killExpectedAdoptionPane: () => {
    assert.equal(storage.rearmFinalizedAdoptionClaim({
      slug,
      attemptToken: successorToken,
      sessionId: saved.session_id,
      reservedAtMs: 3,
      leaseExpiresAtMs: 4,
    }, original.attempt_token), true)
    assert.equal(storage.recordAdoptionPane(slug, successorToken, {
      paneId: "%99", panePid: 9900, sessionCreated: 99000,
    }, 4), true)
    assert.equal(storage.finalizeAdoptionRespawnClaim(slug, successorToken, saved.session_id, 4), true)
    rotated = true
    return true
    },
    killPane: () => {},
    killSession: () => {},
    isLive: () => false,
  }

  await assert.rejects(
    () => stopAndForgetRegisteredRuntime(storage, saved, runtime),
    /new worker was preserved/,
  )
  assert.equal(storage.getSession(slug)?.session_id, saved.session_id)
  assert.equal(storage.getAdoptionClaim(slug)?.attempt_token, successorToken)
})

// ── Stopping an app-server Codex thread (2026-07-23) ───────────────────────────────────────────────
// An app-server Codex thread has NO tmux pane: its worker is a turn inside the shared codex
// app-server, which now lives in a DETACHED daemon that outlives the fray runtime. Routed through the
// tmux terminator every stop verb took stopRegisteredRuntime's `unbound` branch, issued kill-session
// for a session that never existed, and reported "stopped" — while the turn kept running, burning
// tokens and touching the repo with no fray-side owner. Before the daemon worked this was masked,
// because the app-server died with the runtime.
function codexSessionRow(
  storage: ReturnType<typeof createStorage>,
  slug: string,
  runtime: "app-server" | "legacy-tmux",
): SessionRow {
  storage.upsertSession({ ...row(slug), exited: 0 })
  storage.setBackend(slug, "codex")
  if (runtime === "app-server") storage.setCodexRuntime(slug, "app-server")
  return storage.getSession(slug)!
}

function bridgeStub(options: { turnLive: boolean; interrupt?: () => Promise<{ interrupted: boolean }> }) {
  const interrupts: string[] = []
  return {
    interrupts,
    bridge: {
      turnLiveness: () => ({ bridgeTurn: options.turnLive, ownedSince: "2026-07-23T00:00:00.000Z" }),
      interruptTurn: async (slug: string, sessionId: string) => {
        interrupts.push(`${slug}/${sessionId}`)
        return options.interrupt ? options.interrupt() : { interrupted: true }
      },
    },
  }
}

test("killAgent interrupts a live app-server Codex turn instead of killing a tmux pane it never had", async () => {
  const h = harness()
  const slug = "codex-kill"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({ turnLive: true })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await h.router.killAgent.handler({ input: { slug } })

  assert.deepEqual(stub.interrupts, [`${slug}/sid-${slug}`], "the turn is stopped where it actually lives")
  assert.equal(h.storage.getSession(slug)?.exited, 1, "and only then is the row recorded as stopped")
  h.storage.close()
})

test("a Codex interrupt that could not be delivered never records the worker as stopped", async () => {
  const h = harness()
  const slug = "codex-kill-fails"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({
    turnLive: true,
    interrupt: async () => { throw new Error("Codex app-server session detached; cannot interrupt") },
  })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await assert.rejects(h.router.killAgent.handler({ input: { slug } }), /cannot interrupt/)
  assert.equal(h.storage.getSession(slug)?.exited, 0, "the row must not claim a stop that did not happen")
  assert.equal(h.storage.getSession(slug)?.state, "open")
  h.storage.close()
})

test("stopping a Codex thread with no active turn is a no-op, not an error", async () => {
  const h = harness()
  const slug = "codex-kill-idle"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({
    turnLive: false,
    // Reaching the bridge at all here would spawn/attach an app-server just to be told there is
    // nothing to stop; turnLiveness is a pure read and already answers that.
    interrupt: async () => { throw new Error("interruptTurn must not be reached for a resting thread") },
  })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await h.router.killAgent.handler({ input: { slug } })
  assert.deepEqual(stub.interrupts, [])
  assert.equal(h.storage.getSession(slug)?.exited, 1, "a resting thread still settles as stopped")
  h.storage.close()
})

test("a LEGACY tmux Codex row keeps the tmux terminator and never reaches the bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fray-legacy-codex-stop-"))
  const storage = createStorage(join(dir, "ui.db"))
  const slug = "legacy-codex"
  // Dispatched pre-cutover: backend=codex but codex_runtime is NULL, so it really does own a pane and
  // is migrated only when a follow-up first touches it. followUp/setThreadPermission branch on the
  // BACKEND because the controller they avoid is Claude-only; termination is the opposite case.
  const saved = codexSessionRow(storage, slug, "legacy-tmux")
  assert.equal(isAppServerCodexRow(saved), false)
  const killed: string[] = []
  const outcome = await stopThreadRuntime(
    storage,
    saved,
    {
      findExpectedAdoptionPane: () => ({ kind: "absent" as const }),
      killExpectedAdoptionPane: () => false,
      killSession: (target: string) => killed.push(target),
      isLive: () => false,
    },
    {
      turnLiveness: () => { throw new Error("a legacy tmux row must not consult the bridge") },
      interruptTurn: async () => { throw new Error("a legacy tmux row must not be interrupted") },
    },
  )
  assert.equal(outcome, "stopped")
  assert.deepEqual(killed, [slug])
  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

test("Mark as done asks before ending a running Codex turn, then actually interrupts it", async () => {
  const h = harness()
  const slug = "codex-done"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({ turnLive: true })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  // Before this change the tmux terminator answered "not live" for every app-server codex row, so the
  // hold was never computed: a running codex thread archived silently, unasked and uninterrupted.
  const asked = await h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: false } })
  assert.equal(asked.needsConfirmation, true)
  assert.deepEqual(stub.interrupts, [])
  assert.equal(h.storage.getSession(slug)?.state, "open")

  const done = await h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: true } })
  assert.equal(done.needsConfirmation, false)
  assert.deepEqual(stub.interrupts, [`${slug}/sid-${slug}`])
  assert.equal(h.storage.getSession(slug)?.state, "archived")
  assert.equal(h.storage.getSession(slug)?.exited, 1)
  h.storage.close()
})

test("Mark as done on a Codex thread whose interrupt fails leaves it open, not archived", async () => {
  const h = harness()
  const slug = "codex-done-fails"
  codexSessionRow(h.storage, slug, "app-server")
  const stub = bridgeStub({
    turnLive: true,
    interrupt: async () => { throw new Error("Codex accepted the interrupt but the turn has not ended; nothing was stopped") },
  })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await assert.rejects(
    h.router.completeThread.handler({ input: { slug, sessionId: `sid-${slug}`, terminateLive: true } }),
    /nothing was stopped/,
  )
  assert.equal(h.storage.getSession(slug)?.state, "open", "an archived row whose turn still runs has no card left to act on")
  h.storage.close()
})

test("dismissing a Codex thread stops its turn through the bridge", async () => {
  const h = harness()
  const slug = "codex-dismiss"
  codexSessionRow(h.storage, slug, "app-server")
  mkdirSync(join(h.dir, ".fray"), { recursive: true })
  writeFileSync(join(h.dir, ".fray", `${slug}.md`), `---\nstatus: active\n---\n\n# ${slug}\n`)
  const stub = bridgeStub({ turnLive: true })
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = stub.bridge

  await h.router.setThreadStatus.handler({ input: { slug, status: "dismissed" } })
  assert.deepEqual(stub.interrupts, [`${slug}/sid-${slug}`])
  assert.equal(h.storage.getSession(slug)?.exited, 1)
  h.storage.close()
})

// ── Restart worker (the operator-driven freshProcess) ────────────────────────────────────────────
// A worker reads its plugin (hooks) and system prompt ONCE, at process start, so the only way to move a
// running one onto a newer fray build is to replace the process. `freshProcess` is how the operator
// asks; these pin the two refusals, because a restart that quietly degrades to an ordinary follow-up is
// worse than an error — the operator would believe their worker came back on the new build when it is
// still the old process.
function restartHarness(subAgents: { state: string }[] = []) {
  const tailer = { ...noopTailer, get: () => ({ turn: "idle", subAgents }) as never }
  const h = harness(tailer)
  const slug = "restart-me"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  const calls: { text: string; freshProcess?: boolean }[] = []
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async (input: { text: string; freshProcess?: boolean }) => void calls.push(input),
  }
  return { h, slug, calls }
}

test("Restart worker retires the live process, carrying the continuation into the fresh one", async () => {
  const { h, slug, calls } = restartHarness()
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "come back on current tooling", freshProcess: true },
  })
  assert.equal(calls.length, 1, "the message still reaches the worker")
  assert.equal(calls[0].freshProcess, true, "and it lands in a process that has just started")
  h.storage.close()
})

// A restart RETIRES the sends the dead process was still holding. Reported 2026-08-01 by the
// maintainer, who restarted a worker whose follow-ups had stopped arriving and found them still on
// screen afterwards: "the old messages are still showing up as ghost bubbles". They are unreachable
// by hand too — the unqueue click asks the NEW daemon about a uuid it never heard of and answers
// "Too late — that message has already left the queue", the exact opposite of what happened — so
// without this they sit there for the rest of the hour. `cancelled` tombstones are left ALONE: they
// suppress a real JSONL bubble and retiring one would un-hide a message the operator retracted.
test("Restart worker clears the sends the retired process was still holding", async () => {
  const { h, slug, calls } = restartHarness()
  appendDelivery(h.storage, slug, { id: "d-stuck-1", text: "never arrived", state: "enqueued" })
  appendDelivery(h.storage, slug, { id: "d-stuck-2", text: "also never arrived", state: "pending" })
  appendDelivery(h.storage, slug, { id: "d-taken-back", text: "retracted on purpose", state: "cancelled" })

  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "restarted, carry on", deliveryId: "d-restart", freshProcess: true },
  })

  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.deepEqual(
    after.map((i) => i.id).sort(),
    ["d-restart", "d-taken-back"],
    "both stranded sends are gone; the restart's own entry and the tombstone remain",
  )
  assert.equal(calls.length, 1, "and the restart itself still went through")
  h.storage.close()
})

// An ORDINARY follow-up must not clear them: the process holding those sends is still alive, so they
// may yet be read. Only the restart is evidence of death.
test("an ordinary follow-up leaves earlier outstanding sends queued", async () => {
  const { h, slug } = restartHarness()
  appendDelivery(h.storage, slug, { id: "d-waiting", text: "still in flight", state: "enqueued" })

  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "one more thing", deliveryId: "d-next" },
  })

  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.ok(after.some((i) => i.id === "d-waiting" && i.state === "enqueued"), "the in-flight send is untouched")
  h.storage.close()
})

// Running sub-agents do NOT refuse the operator's restart. This asserted the OPPOSITE until
// 2026-08-01: the completion invariant (an agent runs to its terminal return) was read as covering an
// explicit human instruction, so the verb threw whenever a child was live — which fenced off the one
// recovery affordance in exactly the state that motivates reaching for it, a worker stuck behind
// background work that will not finish. The invariant governs fray's own initiative
// (needsFreshProcessForLimit still spares a live child when FRAY chooses the restart); an operator
// asking outright is not that.
test("Restart worker proceeds even while sub-agents are still running", async () => {
  const { h, slug, calls } = restartHarness([{ state: "running" }])
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "restart please", freshProcess: true },
  })
  assert.equal(calls.length, 1, "the restart is delivered, not refused")
  assert.equal(calls[0].freshProcess, true, "and it retires the live process as asked")
  h.storage.close()
})

// An ordinary follow-up on that same thread does NOT restart anything: only the explicit verb does.
test("a plain follow-up still reaches a worker whose sub-agents are running", async () => {
  const { h, slug, calls } = restartHarness([{ state: "running" }])
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "extra context" } })
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0].freshProcess, true, "and it does NOT restart the process behind their backs")
  h.storage.close()
})

// ── Interrupt and send ──────────────────────────────────────────────────────────────────────────
// The operator's "this can't wait" verb. Claude Code already dequeues at the first sampling boundary
// that exists, so the wait is the remaining time of whatever was in flight — measured over 14 days of
// this repo's transcripts, mid-turn operator prose waited p50 13.8s / p90 49s / p99 2.5m. Preempting
// is the only lever, and ORDER is the entire mechanism: the SDK's interrupt aborts the turn WITHOUT
// discarding queued inputs, so the message must already be queued when the interrupt lands. Reversed,
// the interrupt would abort into an empty queue and the message would merely open an ordinary turn —
// i.e. exactly the latency this verb exists to remove, with the in-flight work destroyed for nothing.
function interruptHarness() {
  const tailer = { ...noopTailer, get: () => ({ turn: "in-flight", subAgents: [] }) as never }
  const h = harness(tailer)
  const slug = "interrupt-me"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "claude")
  h.storage.setClaudeRuntime(slug, "broker")
  const order: string[] = []
  ;(h.ctx as { claudeBroker?: unknown }).claudeBroker = {
    followUp: async () => void order.push("followUp"),
    interruptTurn: () => { order.push("interruptTurn"); return true },
  }
  return { h, slug, order }
}

test("interrupt and send preempts the turn, and only AFTER the message is queued", async () => {
  const { h, slug, order } = interruptHarness()
  await h.router.followUp.handler({
    input: { slug, sessionId: `sid-${slug}`, message: "stop, read this", deliveryId: "d-int", interrupt: true },
  })
  assert.deepEqual(order, ["followUp", "interruptTurn"], "queued first, preempted second")
  const after = parseDeliveryLedger(h.storage.getSession(slug)!.delivery_ledger)
  assert.ok(after.some((i) => i.id === "d-int" && i.state === "enqueued"), "and it is ledgered like any other send")
  h.storage.close()
})

test("an ordinary follow-up never preempts the turn", async () => {
  const { h, slug, order } = interruptHarness()
  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "whenever you get to it" } })
  assert.deepEqual(order, ["followUp"], "the running command is left alone unless the operator asked")
  h.storage.close()
})

// ── Reopening an archived thread by messaging it (every runtime) ─────────────────────────────────
// There is no Reopen verb in fray: an archived thread's footer states "Done" and the composer under it
// IS the reopen affordance ("Marked done — send a message to reopen it"). The un-archive that backs that
// promise lived inside resumeThread, which ONLY the tmux path reaches — so a broker-backed Claude row
// and an app-server Codex row resumed their WORKER and left their ROW archived. The thread then executed
// away while the board rendered it Done, and an archived thread has no lifecycle verbs, so there was no
// Mark-as-done button left to stop it with. Observed 2026-07-31 on a live broker thread: a `--resume`
// process running for minutes against a row still reading `exited=1, state='archived'`.
test("a follow-up reopens an archived BROKER-backed Claude thread, not just its worker", async () => {
  const { h, slug, calls } = restartHarness()
  h.storage.setState(slug, "archived")
  assert.equal(h.storage.getSession(slug)?.state, "archived")

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "continue" } })

  assert.equal(calls.length, 1, "the message still reaches the worker")
  const reopened = h.storage.getSession(slug)
  assert.equal(reopened?.state, "open", "and the row it woke is Active again, not stranded in Done")
  assert.equal(reopened?.archived, 0, "including the legacy flag the board also honors")
  h.storage.close()
})

test("a follow-up reopens an archived app-server CODEX thread, not just its worker", async () => {
  const h = harness()
  const slug = "archived-codex"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  h.storage.setState(slug, "archived")

  const sent: string[] = []
  ;(h.ctx as { codexAppServer?: unknown }).codexAppServer = {
    binding: () => ({ state: "active", currentTurnId: null }),
    turnLiveness: () => undefined,
    resumeOwnedSession: async () => {},
    followUp: async ({ text }: { text: string }) => void sent.push(text),
  }

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "continue" } })

  assert.deepEqual(sent, ["continue"], "the message still reaches the worker")
  const reopened = h.storage.getSession(slug)
  assert.equal(reopened?.state, "open")
  assert.equal(reopened?.archived, 0)
  h.storage.close()
})

// The reopen is session-guarded, so it cannot resurrect a row that was re-dispatched under a stale tab —
// and it is a NO-OP on an open thread, so an ordinary live steer writes nothing per keystroke.
test("a follow-up to an already-open thread writes no lifecycle change", async () => {
  const { h, slug, calls } = restartHarness()
  const before = h.storage.getSession(slug)

  await h.router.followUp.handler({ input: { slug, sessionId: `sid-${slug}`, message: "more context" } })

  assert.equal(calls.length, 1)
  const after = h.storage.getSession(slug)
  assert.equal(after?.state, before?.state, "the lifecycle column is untouched")
  assert.equal(after?.archived, before?.archived)
  h.storage.close()
})

test("Restart worker is refused on a thread that is not a broker-backed Claude worker", async () => {
  const h = harness()
  const slug = "codex-restart"
  h.storage.upsertSession(row(slug))
  h.storage.setBackend(slug, "codex")
  h.storage.setCodexRuntime(slug, "app-server")
  await assert.rejects(
    h.router.followUp.handler({
      input: { slug, sessionId: `sid-${slug}`, message: "restart please", freshProcess: true },
    }),
    /broker-backed Claude worker/,
  )
  h.storage.close()
})
