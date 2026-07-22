import {
  PermissionMode,
  type PermissionMode as PermissionModeValue,
} from "@fray-ui/shared"
import type { BoardManager } from "./board.ts"
import type { RuntimeExpectation, SessionRow, Storage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import * as tmux from "./tmux.ts"
import { effectivePermissionMode } from "./dispatch.ts"
import { adoptionRuntimeBinding } from "./adoption-recovery.ts"

const POLL_MS = 750

export interface PermissionTerminal {
  isLive(slug: string): boolean
  paneIdentity?(slug: string): tmux.PaneIdentity | null
  capturePane(slug: string): string
  capturePaneEscaped(slug: string): string
  sendLiteral(slug: string, text: string): void
  sendTextWithKey?(slug: string, text: string, key: "Enter" | "Tab"): boolean
  sendKey(slug: string, key: "Enter" | "Tab" | "Up" | "Down" | "Escape"): void
  findExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane): tmux.AdoptionPaneLookup
  captureExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, escaped?: boolean): tmux.ExactPaneCapture
  sendTextToExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, text: string, submit: boolean): boolean
  sendTextWithKeyToExpectedAdoptionPane?(expected: tmux.ExpectedAdoptionPane, text: string, key: "Enter" | "Tab"): boolean
  sendKeyToExpectedAdoptionPane?(
    expected: tmux.ExpectedAdoptionPane,
    key: "Enter" | "Tab" | "Up" | "Down" | "Escape",
  ): boolean
}

export interface PermissionController {
  request(slug: string, requested: PermissionModeValue): Promise<{ effect: "applied" | "next-resume" }>
  tick(): void
  start(): void
  stop(): void
}

interface PermissionControllerDeps {
  storage: Storage
  tailer: Tailer
  board: BoardManager
  terminal?: PermissionTerminal
  reattach?: (
    slug: string,
    current: PermissionModeValue,
    requested: PermissionModeValue,
    onGeneration?: (generation: number) => void,
  ) => Promise<{ generation: number } | void>
  now?: () => number
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (text: string) => text.replace(ANSI_RE, "")

// Claude's resume sidecar can lag one process generation: the process being replaced appends its
// permission-mode record during shutdown, after the controller's pre-handoff transcript fold. The
// new TUI footer, however, renders the mode that is actually active in the newly created pane. Read
// only the footer tail (never transcript history) so that launch-time coercion such as unsupported
// Auto on Haiku is authoritative without mistaking the old process's shutdown record for the new one.
export function detectClaudePermissionMode(pane: string): PermissionModeValue | undefined {
  const lines = stripAnsi(pane).split("\n")
  let prompt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯(?:\u00a0|\s)*$/u.test(lines[i])) {
      prompt = i
      break
    }
  }
  if (prompt < 0) return undefined
  const footer = lines.slice(prompt + 1, prompt + 15).join("\n")
  if (/\bbypass permissions on\b/i.test(footer)) return "bypassPermissions"
  if (/\baccept edits(?: mode)? on\b/i.test(footer)) return "acceptEdits"
  if (/\bauto mode on\b/i.test(footer)) return "auto"
  if (/\bmanual mode on\b/i.test(footer)) return "default"
  return undefined
}

const normalizedInput = (value: string) => value.replace(/\s+/g, " ").trim()

export type ClaudeComposerState =
  | { kind: "empty" }
  | { kind: "typed"; text: string }
  | { kind: "unavailable" }

// Claude's idle composer is the last `❯` row immediately above its footer divider. A trust prompt,
// selector, or other modal may also use `❯`, but always carries text and therefore fails closed as a
// nonempty input. This check exists only to protect unsent drafts before a controlled idle reattach;
// it never drives menu navigation or submits terminal input.
export function inspectClaudeComposer(pane: string): ClaudeComposerState {
  const lines = stripAnsi(pane).split("\n")
  let prompt = -1
  let first = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^❯(?:\u00a0|\s)?(.*)$/u)
    if (!match) continue
    prompt = i
    first = match[1]
    break
  }
  if (prompt === -1) return { kind: "unavailable" }

  const divider = lines.findIndex((line, i) => i > prompt && /^\s*[─━]{8,}/u.test(line))
  if (divider === -1) return { kind: "unavailable" }
  // A draft can begin with a blank first line and continue below the `❯` row. Everything up to the
  // real footer divider belongs to the composer; never inspect only the marker row.
  const text = normalizedInput([first, ...lines.slice(prompt + 1, divider)].join(" "))
  if (text) return { kind: "typed", text }

  // Fail closed if the empty prompt is stale above later modal/output content. Real idle footer rows
  // are blank, the project/status line (`·`), the mode line (`⏵⏵`), or the standard shortcut/context
  // hint. Unknown content below the divider means this is not a provably current idle composer.
  const footer = lines.slice(divider + 1).map((line) => line.trim()).filter(Boolean)
  const idleFooter = (line: string) =>
    line.includes(" · ") || /^[⏵⏸?]/u.test(line) || /(?:for shortcuts|context left|tokens left|shift\+tab)/i.test(line)
  return footer.every(idleFooter) ? { kind: "empty" } : { kind: "unavailable" }
}

function pendingMode(value: unknown): PermissionModeValue | undefined {
  const parsed = PermissionMode.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function createPermissionController(deps: PermissionControllerDeps): PermissionController {
  const terminal: PermissionTerminal = deps.terminal ?? {
    isLive: tmux.isLive,
    capturePane: tmux.capturePane,
    capturePaneEscaped: tmux.capturePaneEscaped,
    sendLiteral: tmux.sendLiteral,
    sendTextWithKey: tmux.sendTextWithKey,
    sendKey: tmux.sendKey,
    findExpectedAdoptionPane: tmux.findExpectedAdoptionPane,
    captureExpectedAdoptionPane: tmux.captureExpectedAdoptionPane,
    sendTextToExpectedAdoptionPane: tmux.sendTextToExpectedAdoptionPane,
    sendTextWithKeyToExpectedAdoptionPane: tmux.sendTextWithKeyToExpectedAdoptionPane,
    sendKeyToExpectedAdoptionPane: tmux.sendKeyToExpectedAdoptionPane,
  }
  let timer: NodeJS.Timeout | null = null
  const activePermissionRequests = new Set<string>()

  type RuntimeState = "live" | "absent" | "conflict" | "unavailable"

  function runtimeState(row: SessionRow): RuntimeState {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return "conflict"
    if (binding.kind === "unbound") return terminal.isLive(row.slug) ? "live" : "absent"
    const current = terminal.findExpectedAdoptionPane?.(binding.claim)
    if (!current || current.kind === "unknown") return "unavailable"
    return current.kind === "found" && !current.pane.dead ? "live" : "absent"
  }

  function captureOwned(row: SessionRow, escaped: boolean): string | undefined {
    const binding = adoptionRuntimeBinding(deps.storage, row)
    if (binding.kind === "conflict") return undefined
    if (binding.kind === "unbound") {
      if (!terminal.isLive(row.slug)) return undefined
      return escaped ? terminal.capturePaneEscaped(row.slug) : terminal.capturePane(row.slug)
    }
    const captured = terminal.captureExpectedAdoptionPane?.(binding.claim, escaped)
    return captured?.kind === "captured" ? captured.text : undefined
  }


  function failRequest(slug: string, message: string, expected?: RuntimeExpectation): never {
    let row = deps.storage.getSession(slug)
    if (!row) throw new Error(message)
    if (expected) {
      const mode = pendingMode(row.permission_mode) ?? "default"
      if (!deps.storage.setPermissionStateIfCurrent(slug, expected, {
        exited: row.exited === 1,
        permissionMode: mode,
        permissionPending: null,
        controlError: message,
      })) {
        throw new Error(message)
      }
    } else {
      deps.storage.setControlErrorIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, message)
    }
    deps.board.refresh()
    throw new Error(message)
  }

  async function request(slug: string, requested: PermissionModeValue): Promise<{ effect: "applied" | "next-resume" }> {
    const initial = deps.storage.getSession(slug)
    if (!initial) throw new Error(`no session registered for ${slug}`)
    if (initial.runtime_control !== null && initial.runtime_control !== undefined) {
      throw new Error("Another runtime control is already in progress for this thread")
    }
    const controlRevision = deps.storage.beginRuntimeControl(slug, {
      sessionId: initial.session_id,
      nativeSessionId: initial.agent_session_id ?? null,
      generation: initial.runtime_generation ?? 0,
    }, "permission")
    if (controlRevision === null) {
      throw new Error("This thread changed or another runtime control started; permissions were not changed")
    }
    try {
      return await requestOwned(slug, requested)
    } finally {
      const current = deps.storage.getSession(slug)
      if (current?.session_id === initial.session_id) {
        deps.storage.releaseRuntimeControl(slug, {
          sessionId: initial.session_id,
          generation: current.runtime_generation ?? 0,
          kind: "permission",
          revision: controlRevision,
        })
      }
    }
  }

  async function requestOwned(slug: string, requested: PermissionModeValue): Promise<{ effect: "applied" | "next-resume" }> {
    let row = deps.storage.getSession(slug)
    if (!row) throw new Error(`no session registered for ${slug}`)
    const codex = row.backend === "codex"
    if (codex && requested !== "plan" && requested !== "default" && requested !== "bypassPermissions") {
      throw new Error("Choose Read-only, Workspace-write, or Full access for a Codex thread")
    }
    if (!codex && requested === "plan") throw new Error("Plan mode is not available for dashboard workers")
    if (activePermissionRequests.has(slug)) {
      throw new Error("A permission change is already in progress for this thread")
    }
    if (row.permission_pending !== null && row.permission_pending !== undefined) {
      throw new Error("A durable permission change is already in progress for this thread")
    }

    const initialRuntime = runtimeState(row)
    if (initialRuntime === "conflict" || initialRuntime === "unavailable") {
      throw new Error("This thread's exact runtime identity is unavailable; permissions were not changed")
    }
    if (initialRuntime === "absent") {
      const saved = deps.storage.setPermissionStateIfCurrent(
        slug,
        {
          sessionId: row.session_id,
          generation: row.runtime_generation ?? 0,
          permissionPending: null,
          runtimeControl: "permission",
        },
        {
          exited: row.exited === 1,
          permissionMode: requested,
          permissionPending: null,
          controlError: null,
        },
      )
      if (!saved) throw new Error("This thread changed while permissions were being saved; retry")
      deps.board.refresh()
      return { effect: "next-resume" }
    }

    // Fold every sidecar already written by the current process before choosing the rollback mode or
    // replacing that process. Without this barrier, a delayed Claude permission-mode record from the
    // prior generation can be consumed after reattach and overwrite the exact new launch value.
    deps.tailer.tick()
    row = deps.storage.getSession(slug)
    if (!row) throw new Error(`no session registered for ${slug}`)
    if (runtimeState(row) !== "live") {
      failRequest(slug, "The worker changed while permissions were being prepared; nothing was changed")
    }
    const sessionId = row.session_id
    const initialGeneration = row.runtime_generation ?? 0
    const tele = deps.tailer.get(slug)
    const permissionRevision = tele?.permissionModeRevision ?? 0
    const savedMode = pendingMode(row.permission_mode)
    const current = savedMode
      ? effectivePermissionMode(row.backend === "codex" ? "codex" : "claude", savedMode)
      : tele?.permissionMode
    if (!current) failRequest(slug, "Current permission mode is still loading; retry after the session metadata appears")
    if (current === requested) {
      const saved = deps.storage.setPermissionStateIfCurrent(
        slug,
        { sessionId, generation: initialGeneration, permissionPending: null, runtimeControl: "permission" },
        { exited: row.exited === 1, permissionMode: requested, permissionPending: null, controlError: null },
      )
      if (!saved) throw new Error("This thread changed while permissions were being confirmed; retry")
      deps.board.refresh()
      return { effect: "applied" }
    }
    if (!tele) failRequest(slug, "Runtime state is still loading; retry in a moment")
    if (tele.permPrompt || tele.pendingAsk || tele.nativeInputRequired) {
      failRequest(slug, "Resolve the current terminal approval or question before changing permissions")
    }
    if (tele.turn !== "idle") {
      failRequest(slug, "Permission changes require an idle thread; wait for the current turn to finish")
    }
    const unresolvedOps = [...tele.subAgents, ...tele.bgShells].filter((op) => op.state === "running" || op.state === "stale").length
    if (unresolvedOps > 0) {
      failRequest(slug, `Permission changes require no unresolved background work; wait for ${unresolvedOps} operation${unresolvedOps === 1 ? "" : "s"}`)
    }
    const composer = inspectClaudeComposer(captureOwned(row, false) ?? "")
    if (composer.kind === "typed") {
      failRequest(slug, "Permission change blocked: submit or clear the existing Claude terminal draft")
    }
    if (composer.kind !== "empty") {
      failRequest(slug, "Permission change blocked by the current Claude terminal screen; return it to the idle prompt")
    }
    if (!deps.reattach) failRequest(slug, "Live permission changes are unavailable in this Fray server; restart Fray and retry")

    // Standalone TUIs expose no typed live permission-control protocol. Reopen the already-saved idle
    // conversation with the backend's documented launch flag; never navigate an interactive menu or
    // inject control characters. The pending value exists only for this bounded, readiness-checked
    // process handoff.
    const armed = deps.storage.setPermissionStateIfCurrent(
      slug,
      { sessionId, generation: initialGeneration, permissionPending: null, runtimeControl: "permission" },
      { exited: false, permissionMode: current, permissionPending: requested, controlError: null },
    )
    if (!armed) throw new Error("This thread changed before the permission handoff could start; retry")
    deps.board.refresh()
    activePermissionRequests.add(slug)
    let ownedGeneration = initialGeneration
    try {
      const result = await deps.reattach(slug, current, requested, (generation) => {
        ownedGeneration = generation
      })
      const handoffRow = deps.storage.getSession(slug)
      const expectedGeneration = result?.generation ?? ownedGeneration
      if (
        !handoffRow ||
        handoffRow.session_id !== sessionId ||
        (handoffRow.runtime_generation ?? 0) !== expectedGeneration ||
        handoffRow.permission_pending !== requested
      ) {
        throw new Error("Permission change canceled because this thread or process generation was deleted or replaced during startup")
      }
      // Fold everything appended while the old pane exited and the new pane booted BEFORE installing
      // the launch fallback. A fresh backend record is authoritative: Claude can reject/coerce a mode
      // for a particular model/version, and presenting the requested flag as applied would be false.
      deps.tailer.tick()
      const observed = deps.tailer.get(slug)
      const paneMode = row.backend === "claude" ? detectClaudePermissionMode(captureOwned(handoffRow, false) ?? "") : undefined
      // The fresh pane is generation-scoped (reattach verified its PID before returning), while an
      // untimestamped Claude sidecar observed in this window may belong to the pane just killed. A
      // visible footer therefore wins. If the footer is unavailable (very narrow/partial capture), a
      // genuinely fresh backend record remains the fail-closed fallback.
      const observedAt = observed?.permissionModeAt ? Date.parse(observed.permissionModeAt) : NaN
      const handoffSpawnedAt = Date.parse(handoffRow.spawned_at)
      const codexObservationIsCurrent =
        (observed?.permissionModeRevision ?? 0) > permissionRevision &&
        Number.isFinite(observedAt) &&
        Number.isFinite(handoffSpawnedAt) &&
        observedAt >= handoffSpawnedAt
      const actualMode = row.backend === "claude"
        ? paneMode
        : codexObservationIsCurrent
          ? observed?.permissionMode
          : undefined
      if (row.backend === "claude" && !actualMode) {
        throw new Error("Backend mode could not be confirmed from the new Claude pane; the change was not reported as applied")
      }
      if (
        actualMode &&
        actualMode !== requested
      ) {
        const committed = deps.storage.setPermissionStateIfCurrent(
          slug,
          { sessionId, generation: expectedGeneration, permissionPending: requested, runtimeControl: "permission" },
          {
            exited: false,
            permissionMode: actualMode,
            permissionPending: null,
            controlError: `Backend did not apply ${requested}; it reported ${actualMode}`,
          },
        )
        if (committed) deps.board.refresh()
        throw new Error(`Backend did not apply ${requested}; it reported ${actualMode}`)
      }
      deps.tailer.notePermissionMode?.(slug, requested)
      // The reattach command carries the backend-native mode flag and returned only after the new
      // process was created. Transcript telemetry subsequently reconciles the persisted value, but
      // the UI must not pretend that observation is an indefinitely pending operation.
      if (!deps.storage.setPermissionStateIfCurrent(
        slug,
        { sessionId, generation: expectedGeneration, permissionPending: requested, runtimeControl: "permission" },
        { exited: false, permissionMode: requested, permissionPending: null, controlError: null },
      )) {
        throw new Error("Permission change canceled because this process generation no longer owns the thread")
      }
      deps.board.refresh()
      return { effect: "applied" }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failRequest(slug, message, {
        sessionId,
        generation: ownedGeneration,
        permissionPending: requested,
        runtimeControl: "permission",
      })
    } finally {
      activePermissionRequests.delete(slug)
    }
  }

  function tick(): void {
    for (const row of deps.storage.allSessions()) {
      if (row.permission_pending !== null && row.permission_pending !== undefined) {
        const requested = pendingMode(row.permission_pending)
        if (!requested) {
          const message = "Invalid durable permission state; restart or repair this thread before continuing"
          if ((row.control_error ?? null) !== message) {
            deps.storage.setControlErrorIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, message)
            deps.board.refresh()
          }
          continue
        }
        if (activePermissionRequests.has(row.slug)) continue
        const observed = deps.tailer.get(row.slug)
        const live = runtimeState(row) === "live"
        const observedIsCurrent = live && (
          row.backend === "codex"
            ? observed?.permissionMode === requested &&
              !!observed.permissionModeAt &&
              Number.isFinite(Date.parse(observed.permissionModeAt)) &&
              Number.isFinite(Date.parse(row.spawned_at)) &&
              Date.parse(observed.permissionModeAt) >= Date.parse(row.spawned_at)
            : detectClaudePermissionMode(captureOwned(row, false) ?? "") === requested
        )
        const next = observedIsCurrent
          ? { permissionMode: requested, controlError: null }
          : {
              permissionMode: pendingMode(row.permission_mode) ?? requested,
              controlError: "The prior permission change was not observed; retry from the idle thread",
            }
        if (deps.storage.setPermissionStateIfCurrent(
          row.slug,
          {
            sessionId: row.session_id,
            generation: row.runtime_generation ?? 0,
            permissionPending: requested,
            runtimeControl: row.runtime_control ?? null,
          },
          {
            exited: row.exited === 1,
            permissionMode: next.permissionMode,
            permissionPending: null,
            controlError: next.controlError,
          },
        )) {
          deps.board.refresh()
        }
      }
    }
  }

  return {
    request,
    tick,
    start() {
      if (timer) return
      tick()
      timer = setInterval(tick, POLL_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
