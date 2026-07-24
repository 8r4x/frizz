import { execFileSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import { isAbsolute, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { tmuxSessionName } from "@fray-ui/shared"
import {
  TMUX_MARKER_PROJECT_ID,
  TMUX_MARKER_PROJECT_ROOT,
  deriveLegacySocket,
  deriveSocket,
  tmuxProjectRootHash,
  validateTmuxSocketName,
} from "./tmux-socket.ts"

const execFileAsync = promisify(execFile)

export { deriveLegacySocket, deriveProjectSocket, deriveSocket, deriveWorktreeSocket } from "./tmux-socket.ts"

// All tmux goes through a PRIVATE socket `tmux -L <socket>` so fray's detached agent sessions
// never collide with (or show up in) the user's default tmux server. One session per thread,
// named fray-<slug>. `remain-on-exit on` keeps the pane after the command exits so we can read
// the exit state (pane_dead) instead of the session just vanishing.

// ---- Per-project socket -----------------------------------------------------------------------
// The socket name is PER-PROJECT, not the literal "fray": two fray-ui instances (e.g. :4917 nub and
// :4918 scratch) sharing one `tmux -L fray` server would collide on session NAMES (both spawn
// fray-<slug>), so one instance could attach/kill the other's agent. Deriving the socket from the
// stable project id isolates each instance's tmux server. Set ONCE at server init via setSocket(),
// before any tmux call; defaults to the bare "fray" until then (and for any caller that never inits).
let socket = "fray"
let pinnedSocket: string | null = null
let socketMarker: { projectId: string; projectRootHash: string } | null = null

// Install the active socket (call ONCE at server init, before any tmux call). Idempotent.
export function setSocket(name: string): void {
  socket = name ? validateTmuxSocketName(name) : "fray"
  socketMarker = null
}

/** Production pins one pre-resolved migration choice before any tmux read or write. */
export function pinSocket(
  name: string,
  owner: { projectId: string; projectDir: string },
  managed = true,
): void {
  const selected = validateTmuxSocketName(name)
  const marker = managed
    ? { projectId: owner.projectId, projectRootHash: tmuxProjectRootHash(owner.projectDir) }
    : null
  if (pinnedSocket && (
    pinnedSocket !== selected || socketMarker?.projectId !== marker?.projectId ||
    socketMarker?.projectRootHash !== marker?.projectRootHash
  )) {
    throw new Error("tmux socket choice is already pinned for another project")
  }
  socket = selected
  pinnedSocket = selected
  socketMarker = marker
}

// The active socket name — exported so the terminal PTY attach hits the SAME server as spawn().
export function socketName(): string {
  return socket
}

// EVERY `-t <session>` target must go through this, never a bare `tmuxSessionName(slug)`.
//
// tmux resolves a bare name target by EXACT match, then by PREFIX, then by fnmatch. Fray's slug
// allocator mints `<slug>-2` when the same prompt is dispatched twice, so `fray-X` and `fray-X-2`
// routinely coexist — and the moment `fray-X` is gone, every bare `-t fray-X` call silently
// retargets its NEIGHBOUR. Observed 2026-07-22: archiving a thread after its pane had already gone
// ran `kill-session -t fray-inside-of-codex-i-was-trying`, which prefix-matched and KILLED the
// freshly-dispatched `…-trying-2` worker 1.2s into its first turn (the board then showed it as a
// stalled yellow "!"). The same hazard reads a dead thread as LIVE through has-session/list-panes,
// and delivers a follow-up into a DIFFERENT worker's composer through send-keys/paste-buffer.
//
// A leading `=` forces exact-name resolution. The trailing `:` makes the string parse as a SESSION
// for the window/pane-target verbs (list-panes, send-keys, capture-pane, paste-buffer) — without it
// they reject `=fray-X` outright ("can't find pane"). This one form is accepted by both target
// classes, so it is the only target spelling fray uses. All verified empirically against tmux here.
export function exactSessionTarget(slug: string): string {
  return `=${tmuxSessionName(slug)}:`
}

export type CrossSocketOwner = "live" | "absent" | "unknown"

// ---- Absence evidence -------------------------------------------------------------------------
// Every tri-state lookup below must distinguish "tmux PROVED nothing is there" from "tmux could not
// answer". Only the first authorizes destructive recovery (retiring a durable adoption claim and
// deleting the attempt's files); the second must stay `unknown` so a transient failure never trades
// a possibly-live orphan for a clean toast.
//
// tmux has several dialects for "there is no server on this socket", and which one you get depends
// on how the socket died: a socket that was never created fails at connect() with ENOENT, a stale
// socket file left behind by a crashed server fails with ECONNREFUSED, a server that shut down
// cleanly answers "no server running", and a live server with nothing in it answers "no sessions".
// All four are equally positive evidence of absence. Reading the connect-level dialects as `unknown`
// is not cosmetic: on any machine whose fray socket has not been created yet (a fresh boot, a
// `tmux kill-server`), no pane can ever be proven gone, so adoption rollback and boot recovery
// retain every abandoned claim and its scratchpad forever.
const NO_TMUX_SERVER_RE =
  /(?:no server running|no sessions|failed to connect|error connecting to .*\((?:no such file or directory|connection refused)\))/i
// `-t <target>` lookups additionally get a target-scoped miss. `list-panes -a` never can.
const NO_TMUX_TARGET_RE = /can't find (?:session|window|pane)/i

function stderrOf(error: unknown): string {
  return error && typeof error === "object" && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "")
    : ""
}

/** tmux's own diagnostic proves no server is reachable on this socket. */
function tmuxServerAbsent(error: unknown): boolean {
  return NO_TMUX_SERVER_RE.test(stderrOf(error))
}

/** As above, plus the `-t <target>` miss that a name/id-targeted command reports. */
function tmuxTargetAbsent(error: unknown): boolean {
  const stderr = stderrOf(error)
  return NO_TMUX_SERVER_RE.test(stderr) || NO_TMUX_TARGET_RE.test(stderr)
}

// A pre-project-socket Fray worker can be recovered without starting a duplicate only when its
// pane still proves both the project directory and the native provider conversation it belongs to.
// The full pane tuple is kept so the eventual paste is authorized by tmux itself, rather than by a
// racy name lookup.
export interface CompatibleLegacyWorker extends PaneIdentity {
  socket: string
}

export type CompatibleLegacyWorkerLookup =
  | { kind: "found"; worker: CompatibleLegacyWorker }
  | { kind: "absent" }
  | { kind: "unknown" }

// A legacy server may still be the literal `tmux -L fray`; the first project-scoped migration used
// the short UUID socket; current servers use the full project socket. Before reusing a dead local
// name, inspect all compatible locations. We intentionally do not contact the discovered process:
// a live matching pane is an ownership conflict, and uncertainty is also closed rather than spawning
// a second worker merely because the selected socket changed.
export function crossSocketLiveOwner(slug: string, project: { id: string; dir: string }): CrossSocketOwner {
  const candidates = [...new Set([socket, "fray", deriveLegacySocket(project.id), deriveSocket(project.id)])]
  const name = exactSessionTarget(slug)
  const belongs = (cwd: string) => {
    if (!isAbsolute(cwd)) return false
    const rel = relative(resolve(project.dir), resolve(cwd))
    return rel === "" || (rel !== ".." && !rel.startsWith("../"))
  }
  for (const candidate of candidates) {
    if (candidate === socket) continue // caller already proved this socket's slug dead
    try {
      const out = execFileSync("tmux", ["-L", candidate, "list-panes", "-t", name, "-F", "#{pane_dead}\t#{pane_current_path}"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim()
      if (!out) return "unknown"
      for (const line of out.split("\n")) {
        const [dead, cwd] = line.split("\t")
        if ((dead !== "0" && dead !== "1") || !cwd) return "unknown"
        // A same-name session outside this project is not ours, but it still makes a name-based
        // fallback unsafe. Treat it as unknown rather than guessing an owner.
        if (!belongs(cwd)) return "unknown"
        if (dead === "0") return "live"
      }
    } catch (error) {
      if (!tmuxTargetAbsent(error)) return "unknown"
    }
  }
  return "absent"
}

function sessionCommandMatches(command: string, nativeSessionId: string): boolean {
  // Claude's historical launch forms used both --session-id and -r.  Match the exact argument
  // boundary, never a substring, so a similarly-prefixed conversation cannot be adopted.
  const escaped = nativeSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|\\s)(?:--session-id|-r)\\s+${escaped}(?=\\s|$)`).test(command)
}

function codexCommandMatches(command: string, sessionId: string): boolean {
  // Codex has NO --session-id flag: `codex resume [--cd cwd] … -s <sandbox> <rolloutId> [message]`
  // carries the rollout id as a bare positional.  Match it as an exact whitespace-bounded token — a
  // full codex rollout id is unique enough that this is as precise as Claude's flagged form — and
  // additionally require the `resume` subcommand so an id that merely appears inside a trailing prompt
  // message can never masquerade as the launch identity.
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return /(?:^|\s)resume(?:\s|$)/.test(command) && new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(command)
}

// Identity match for a legacy pane's start command, per backend.  Codex and Claude pin the native
// conversation id in entirely different argv shapes; a wrong matcher silently degrades a live codex
// worker to "unknown", stranding every timer/CI wake (see crossSocketLiveOwner's terminal throw).
function commandMatchesIdentity(command: string, nativeSessionId: string, backend: string | undefined): boolean {
  return backend === "codex"
    ? codexCommandMatches(command, nativeSessionId)
    : sessionCommandMatches(command, nativeSessionId)
}

function compatibleLegacyCondition(worker: CompatibleLegacyWorker): string {
  return `#{&&:#{==:#{pane_dead},0},#{&&:#{==:#{pane_id},${worker.paneId}},#{&&:#{==:#{pane_pid},${worker.panePid}},#{==:#{session_created},${worker.sessionCreated}}}}}`
}

/**
 * Find a legacy-socket worker that is conclusively this persisted provider conversation.  A live
 * same-name pane with a different/opaque command remains unsafe and is deliberately "unknown".
 */
export function findCompatibleLegacyWorker(
  slug: string,
  project: { id: string; dir: string },
  nativeSessionId: string,
  backend?: string,
): CompatibleLegacyWorkerLookup {
  // Cover EVERY socket crossSocketLiveOwner can flag as live, minus the caller-proved-dead active one
  // (skipped below).  Historically this list omitted deriveSocket(project.id) on the assumption it always
  // equals the active socket — but when the runtime boots on a different socket (a FRAY_TMUX_SOCKET
  // override, a linked-worktree socket, or a cross-version derivation change) a live worker stranded on
  // the full project socket was DETECTED as live yet never reachable here, so every wake threw
  // "A live matching worker exists …" and retried to silent exhaustion.  Scanning it closes that gap.
  const candidates = [...new Set(["fray", deriveLegacySocket(project.id), deriveSocket(project.id)])]
  const name = exactSessionTarget(slug)
  const belongs = (cwd: string) => {
    if (!isAbsolute(cwd)) return false
    const rel = relative(resolve(project.dir), resolve(cwd))
    return rel === "" || (rel !== ".." && !rel.startsWith("../"))
  }
  let found: CompatibleLegacyWorker | undefined
  for (const candidate of candidates) {
    if (candidate === socket) continue
    try {
      const out = execFileSync("tmux", ["-L", candidate, "list-panes", "-t", name,
        "-F", "#{pane_dead}\t#{pane_id}\t#{pane_pid}\t#{session_created}\t#{pane_current_path}\t#{pane_start_command}"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim()
      if (!out) return { kind: "unknown" }
      // pane_start_command is arbitrary user text and can itself contain literal newlines.  The
      // identifying fields precede it on the first record; treating its continuation as another
      // pane would turn every multiline worker prompt into a false ambiguity.
      const [dead, paneId, pidRaw, createdRaw, cwd, command] = out.split("\n", 1)[0]!.split("\t")
      const identity = parsePaneIdentity(`${paneId}\t${pidRaw}\t${createdRaw}`)
      if ((dead !== "0" && dead !== "1") || !identity || !cwd || command === undefined) return { kind: "unknown" }
      if (!belongs(cwd)) return { kind: "unknown" }
      if (dead === "1") continue
      if (!commandMatchesIdentity(command, nativeSessionId, backend)) return { kind: "unknown" }
      const worker = { socket: candidate, ...identity }
      if (found) return { kind: "unknown" } // more than one exact claimant is still ambiguous
      found = worker
    } catch (error) {
      if (!tmuxTargetAbsent(error)) return { kind: "unknown" }
    }
  }
  return found ? { kind: "found", worker: found } : { kind: "absent" }
}

// Capture and submit use a single server-side condition over the immutable pane tuple.  If the
// command returns an error after tmux accepted it, callers must treat delivery as ambiguous and
// never replay it.
export function captureCompatibleLegacyWorker(worker: CompatibleLegacyWorker, escaped = false): ExactPaneCapture {
  try {
    const out = execFileSync("tmux", ["-L", worker.socket, "if-shell", "-t", worker.paneId, "-F", compatibleLegacyCondition(worker),
      `display-message -p ${EXACT_ACTION_OK} ; capture-pane -p${escaped ? " -e" : ""} -t ${worker.paneId}`,
      `display-message -p ${EXACT_ACTION_MISS}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const prefix = `${EXACT_ACTION_OK}\n`
    return out.startsWith(prefix) ? { kind: "captured", text: out.slice(prefix.length) } : { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

export function sendTextToCompatibleLegacyWorker(worker: CompatibleLegacyWorker, text: string): boolean {
  const buffer = `fray-legacy-${randomUUID()}`
  try {
    const out = execFileSync("tmux", ["-L", worker.socket,
      "load-buffer", "-b", buffer, "-", ";",
      "if-shell", "-t", worker.paneId, "-F", compatibleLegacyCondition(worker),
      `paste-buffer -p -b ${buffer} -t ${worker.paneId} ; send-keys -t ${worker.paneId} Enter ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`, ";", "delete-buffer", "-b", buffer],
    { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] })
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    return false
  }
}

// stderr is ignored: has-session / list-panes on a gone session and start-server races all write
// EXPECTED diagnostics ("no server running", "can't find window") that callers already handle via
// the thrown exception — leaking them would spam the log now that the tailer polls liveness every 1s.
function tmux(...args: string[]): string {
  return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

// Idempotent: start-server is a no-op if the socket's server is already up.
export function ensureServer(): void {
  try {
    tmux("start-server")
  } catch {
    // already running / race — harmless
  }
  try {
    // Size windows to the MOST RECENT client, not the smallest: with the default, any second
    // attach (another browser tab, a screenshot run, a manual `tmux attach`) shrinks the pane for
    // every viewer and forces a full redraw — the embedded terminal visibly reflowed each time.
    tmux("set-option", "-g", "window-size", "latest")
  } catch {
    // best-effort; older tmux without the option just keeps default behavior
  }
  if (socketMarker) {
    try {
      tmux(
        "set-option", "-gq", TMUX_MARKER_PROJECT_ID, socketMarker.projectId,
        ";", "set-option", "-gq", TMUX_MARKER_PROJECT_ROOT, socketMarker.projectRootHash,
      )
    } catch {
      // A marker is also queued atomically with every new-session below. An empty server may exit
      // before this best-effort label; no worker can exist in that gap.
    }
  }
}

export function hasSession(slug: string): boolean {
  try {
    tmux("has-session", "-t", exactSessionTarget(slug))
    return true
  } catch {
    return false
  }
}

export function listSessions(): string[] {
  try {
    return tmux("list-sessions", "-F", "#{session_name}").split("\n").map((s) => s.trim()).filter(Boolean)
  } catch {
    // no server / no sessions
    return []
  }
}

export function killSession(slug: string): void {
  try {
    tmux("kill-session", "-t", exactSessionTarget(slug))
  } catch {
    // already gone
  }
  invalidateLiveness()
}

export const ADOPTION_ATTEMPT_ENV = "FRAY_ADOPTION_ATTEMPT"
export const PROFILE_HANDOFF_ENV = "FRAY_PROFILE_HANDOFF"

export type TmuxSpawnStage =
  | "new-session"
  | "read-identity"
  | "record-identity"
  | "remain-on-exit"
  | "status"

export interface TmuxSpawnOptions {
  adoptionAttemptToken?: string
  // Called synchronously immediately after new-session returns its exact tuple and before either
  // setup command. Adoption uses this hook for the durable SQLite bind.
  onCreated?: (identity: PaneIdentity) => void
  // Narrow deterministic seam used by crash-window tests; production does not provide it.
  onStage?: (stage: "created" | "remain-on-exit" | "status", identity: PaneIdentity) => void
}

export class TmuxSpawnError extends Error {
  readonly stage: TmuxSpawnStage
  readonly identity?: PaneIdentity

  constructor(stage: TmuxSpawnStage, identity?: PaneIdentity) {
    super(stage === "new-session" ? "worker spawn failed" : "worker spawn setup failed")
    this.name = "TmuxSpawnError"
    this.stage = stage
    this.identity = identity
  }
}

export type TmuxSpawnRunner = (args: readonly string[]) => string

const runSpawnCommand: TmuxSpawnRunner = (args) => execFileSync(
  "tmux",
  [...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
)

function validAdoptionAttemptToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
}

function parsePaneIdentity(raw: string): PaneIdentity | null {
  const [paneId, pidRaw, createdRaw] = raw.trim().split("\t")
  const panePid = Number.parseInt(pidRaw ?? "", 10)
  const sessionCreated = Number.parseInt(createdRaw ?? "", 10)
  if (!/^%\d+$/.test(paneId ?? "") || !Number.isSafeInteger(panePid) || !Number.isSafeInteger(sessionCreated)) {
    return null
  }
  return { paneId, panePid, sessionCreated }
}

// Kept separate from spawn() so deterministic tests can stop after any tmux command without touching
// a live server. The runner receives the complete argv, but failures never log the runner error: Node's
// exec error embeds that argv (including prompts and environment credentials).
export function spawnWithRunner(
  slug: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string> | undefined,
  options: TmuxSpawnOptions,
  runner: TmuxSpawnRunner,
): PaneIdentity {
  const name = tmuxSessionName(slug)
  if (options.adoptionAttemptToken && !validAdoptionAttemptToken(options.adoptionAttemptToken)) {
    throw new TmuxSpawnError("new-session")
  }
  const launchEnv = { ...(env ?? {}) }
  if (options.adoptionAttemptToken) launchEnv[ADOPTION_ATTEMPT_ENV] = options.adoptionAttemptToken
  const envFlags = Object.entries(launchEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  let stage: TmuxSpawnStage = "new-session"
  let identity: PaneIdentity | undefined
  try {
    const markerArgs = socketMarker ? [
      ";", "set-option", "-gq", TMUX_MARKER_PROJECT_ID, socketMarker.projectId,
      ";", "set-option", "-gq", TMUX_MARKER_PROJECT_ROOT, socketMarker.projectRootHash,
    ] : []
    const created = runner([
      "-L", socket, "new-session", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}\t#{session_created}",
      "-s", name, "-x", "220", "-y", "50", "-c", cwd, ...envFlags, "--", ...cmd,
      ...markerArgs,
    ])
    invalidateLiveness()
    stage = "read-identity"
    identity = parsePaneIdentity(created) ?? undefined
    if (!identity) throw new Error("missing tmux identity")
    stage = "record-identity"
    options.onCreated?.(identity)
    options.onStage?.("created", identity)

    stage = "remain-on-exit"
    runner(["-L", socket, "set-option", "-t", identity.paneId, "remain-on-exit", "on"])
    options.onStage?.("remain-on-exit", identity)

    stage = "status"
    runner(["-L", socket, "set-option", "-t", identity.paneId, "status", "off"])
    options.onStage?.("status", identity)
    invalidateLiveness()
    return identity
  } catch {
    // Intentionally exclude the original error, stderr, argv, cwd, and environment. Any one of them
    // can contain the full user prompt or credentials; stage + created-bit is enough to operate.
    console.error(`[fray-ui] tmux worker spawn failed (stage=${stage}, created=${identity ? "yes" : "no"})`)
    throw new TmuxSpawnError(stage, identity)
  }
}

// Spawn `cmd` (argv, run via execvp — NO shell) detached in a new session sized for the
// embedded xterm. `--` fences the command so a leading-dash arg is never eaten by tmux.
export function spawn(
  slug: string,
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
  options: TmuxSpawnOptions = {},
): PaneIdentity {
  return spawnWithRunner(slug, cmd, cwd, env, options, runSpawnCommand)
}

// Visible pane text (no history), for UI-state sniffing — e.g. detecting a pending permission
// prompt, which has no JSONL signal. Empty string if the session is gone.
export function capturePane(slug: string): string {
  try {
    return tmux("capture-pane", "-p", "-t", exactSessionTarget(slug))
  } catch {
    return ""
  }
}

// ---- Batched pane capture ------------------------------------------------------------------------
// The SAME lesson as the batched liveness cache above, for the other per-row subprocess: the tailer's
// 1s tick pane-sniffs every quiet in-flight thread, and `capturePane` is one `tmux` exec each. On the
// maintainer's machine a bare process spawn measures ~60ms and a `capture-pane` ~105ms, so a 25-thread
// board spent 2.6-6.2 SECONDS of synchronous, event-loop-blocking work per 1s tick (measured
// 2026-07-23: `[probe] tick 3950ms captures=25 captureMs=3369`). Every RPC reply, board delta and
// transcript push queues behind that — which is exactly what "mark as done and the sidebar doesn't
// update for seconds" is.
//
// tmux runs a `;`-separated command list in ONE invocation, so N captures cost ONE spawn. Outputs are
// concatenated with no framing, so each capture is BRACKETED by `display-message -p <sentinel>` open and
// close markers and stdout is split on the sentinel. Three failure modes are handled rather than assumed
// away — each found by verify-batched-pane-capture.mjs rather than reasoned about:
//   • a command list ABORTS at the first error (verified: a bad target prints its error and the
//     remaining commands never run), so a batch can be truncated at any point;
//   • the OPEN marker of the aborted slug has ALREADY been written when its capture fails, so an
//     open-only frame must be rejected. With a single marker per frame that slug was recorded with
//     EMPTY pane text — which reads as \"no permission prompt\" for a thread that may well have one, and
//     suppressed the retry that would have recovered the panes behind it;
//   • that abort makes tmux exit non-zero, and execFileSync throws — but the partial stdout survives on
//     the thrown error, so it is salvaged rather than discarded.
// The sentinel is a control character (never present in a rendered pane cell) plus a per-process
// random id, so captured pane text can never forge a frame boundary.
const CAPTURE_SENTINEL = `\u0001fray-capture-${randomUUID()}\u0001`
const CAPTURE_OPEN = "<"
const CAPTURE_CLOSE = ">"

// How many times a truncated batch is re-issued for the slugs it never reached. A pane that vanishes
// between the liveness listing and the capture aborts the list at that slug; dropping it and retrying
// the remainder keeps ONE dead pane from costing a full per-slug fallback for the whole board. Bounded
// so a pathological board can never spend more execs than the unbatched path it replaced.
const CAPTURE_BATCH_ROUNDS = 3

export function capturePanes(slugs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  let pending = [...slugs]
  for (let round = 0; round < CAPTURE_BATCH_ROUNDS && pending.length > 0; round++) {
    let text: string
    try {
      text = tmuxWithPartialOutput(...batchCaptureArgs(pending))
    } catch {
      break // nothing salvageable — the caller falls back to the per-slug capture
    }
    parseBatchFrames(text, pending, out)
    const next = pending.filter((slug) => !out.has(slug))
    if (next.length === pending.length) break // the very first slug failed — retrying it is pointless
    pending = next.slice(1) // drop the slug the list aborted on; the caller captures it individually
  }
  return out
}

// ASYNC sibling of capturePanes — byte-identical framing/salvage/retry, but the tmux subprocess runs
// off the event loop (execFile, not execFileSync). The tailer prefetches panes through this so a
// board's whole per-tick capture never blocks RPC replies and board pushes (measured 2026-07-23: the
// synchronous batch was 1-4s of loop-blocking work on a busy board). One awaited subprocess per round.
export async function capturePanesAsync(slugs: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let pending = [...slugs]
  for (let round = 0; round < CAPTURE_BATCH_ROUNDS && pending.length > 0; round++) {
    let text: string
    try {
      text = await tmuxWithPartialOutputAsync(batchCaptureArgs(pending))
    } catch {
      break
    }
    parseBatchFrames(text, pending, out)
    const next = pending.filter((slug) => !out.has(slug))
    if (next.length === pending.length) break
    pending = next.slice(1)
  }
  return out
}

function batchCaptureArgs(slugs: readonly string[]): string[] {
  const args: string[] = []
  for (const slug of slugs) {
    if (args.length > 0) args.push(";")
    // "<slug\n" + the pane bytes + a bare ">" frame. `display-message -p` appends its own newline, so the
    // open marker's newline terminates the header and the close marker proves the capture actually ran.
    args.push("display-message", "-p", `${CAPTURE_SENTINEL}${CAPTURE_OPEN}${slug}`)
    args.push(";", "capture-pane", "-p", "-t", exactSessionTarget(slug))
    args.push(";", "display-message", "-p", `${CAPTURE_SENTINEL}${CAPTURE_CLOSE}`)
  }
  return args
}

function parseBatchFrames(text: string, slugs: readonly string[], out: Map<string, string>): void {
  const wanted = new Set(slugs)
  const frames = text.split(CAPTURE_SENTINEL)
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    if (!frame.startsWith(CAPTURE_OPEN)) continue
    const brk = frame.indexOf("\n")
    if (brk === -1) continue
    // No close marker → this slug's capture is exactly where the list aborted. Leave it out so the
    // caller retries it per-slug instead of adopting an empty pane as its text.
    if (!frames[i + 1]?.startsWith(CAPTURE_CLOSE)) continue
    const slug = frame.slice(CAPTURE_OPEN.length, brk)
    if (!wanted.has(slug) || out.has(slug)) continue
    out.set(slug, frame.slice(brk + 1))
  }
}

// `tmux()` with stdout preserved across a non-zero exit: an aborted command list still wrote every
// command's output before the failure, and throwing that away would turn one dead pane into a full
// per-slug fallback for the whole board.
function tmuxWithPartialOutput(...args: string[]): string {
  try {
    return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const partial = (error as { stdout?: string | Buffer }).stdout
    if (typeof partial === "string") return partial
    if (partial) return partial.toString("utf8")
    throw error
  }
}

// Async sibling of tmuxWithPartialOutput: same aborted-command-list stdout salvage, off the event loop.
async function tmuxWithPartialOutputAsync(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", ["-L", socket, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (error) {
    const partial = (error as { stdout?: string | Buffer }).stdout
    if (typeof partial === "string") return partial
    if (partial) return partial.toString("utf8")
    throw error
  }
}

export interface PaneIdentity {
  paneId: string
  panePid: number
  sessionCreated: number
}

export interface PaneSnapshot extends PaneIdentity {
  dead: boolean
  adoptionAttemptToken: string | null
  profileHandoffToken?: string | null
}

export type AdoptionPaneLookup =
  | { kind: "found"; pane: PaneSnapshot }
  | { kind: "absent" }
  | { kind: "unknown" }

export interface ExpectedAdoptionPane {
  attempt_token: string
  pane_id: string | null
  pane_pid: number | null
  session_created: number | null
}

export interface ExpectedProfileHandoffPane extends PaneIdentity {
  handoffToken: string
}

const PANE_SNAPSHOT_FORMAT = `#{session_name}\t#{pane_dead}\t#{pane_id}\t#{pane_pid}\t#{session_created}\t#{E:${ADOPTION_ATTEMPT_ENV}}\t#{E:${PROFILE_HANDOFF_ENV}}`

function parsePaneSnapshot(line: string): { name: string; pane: PaneSnapshot } | null {
  const [name, deadRaw, paneId, pidRaw, createdRaw, tokenRaw = "", profileTokenRaw = ""] = line.trim().split("\t")
  const identity = parsePaneIdentity(`${paneId}\t${pidRaw}\t${createdRaw}`)
  if (!name || !identity || (deadRaw !== "0" && deadRaw !== "1")) return null
  return {
    name,
    pane: {
      ...identity,
      dead: deadRaw === "1",
      adoptionAttemptToken: validAdoptionAttemptToken(tokenRaw) ? tokenRaw : null,
      profileHandoffToken: validAdoptionAttemptToken(profileTokenRaw) ? profileTokenRaw : null,
    },
  }
}

function expectedProfileHandoffCondition(expected: ExpectedProfileHandoffPane, requireLive = true): string | null {
  if (!validAdoptionAttemptToken(expected.handoffToken) || !/^%\d+$/.test(expected.paneId) ||
      !Number.isSafeInteger(expected.panePid) || !Number.isSafeInteger(expected.sessionCreated)) return null
  const owner = `#{&&:#{==:#{pane_id},${expected.paneId}},#{&&:#{==:#{pane_pid},${expected.panePid}},#{&&:#{==:#{session_created},${expected.sessionCreated}},#{==:#{E:${PROFILE_HANDOFF_ENV}},${expected.handoffToken}}}}}`
  return requireLive ? `#{&&:#{==:#{pane_dead},0},${owner}}` : owner
}

function sameExpectedPane(expected: ExpectedAdoptionPane, pane: PaneSnapshot): boolean {
  return (
    expected.pane_id !== null &&
    expected.pane_pid !== null &&
    expected.session_created !== null &&
    pane.adoptionAttemptToken === expected.attempt_token &&
    pane.paneId === expected.pane_id &&
    pane.panePid === expected.pane_pid &&
    pane.sessionCreated === expected.session_created
  )
}

function expectedAdoptionCondition(expected: ExpectedAdoptionPane, requireLive = true): string | null {
  if (
    !validAdoptionAttemptToken(expected.attempt_token) ||
    expected.pane_id === null ||
    !/^%\d+$/.test(expected.pane_id) ||
    expected.pane_pid === null ||
    !Number.isSafeInteger(expected.pane_pid) ||
    expected.session_created === null ||
    !Number.isSafeInteger(expected.session_created)
  ) {
    return null
  }
  const owner = `#{&&:#{==:#{pane_id},${expected.pane_id}},#{&&:#{==:#{pane_pid},${expected.pane_pid}},#{&&:#{==:#{session_created},${expected.session_created}},#{==:#{E:${ADOPTION_ATTEMPT_ENV}},${expected.attempt_token}}}}}`
  return requireLive ? `#{&&:#{==:#{pane_dead},0},${owner}}` : owner
}

function expectedPaneIdentityCondition(expected: PaneIdentity, requireLive = true): string | null {
  if (!/^%\d+$/.test(expected.paneId) ||
      !Number.isSafeInteger(expected.panePid) ||
      !Number.isSafeInteger(expected.sessionCreated)) return null
  const owner = `#{&&:#{==:#{pane_id},${expected.paneId}},#{&&:#{==:#{pane_pid},${expected.panePid}},#{==:#{session_created},${expected.sessionCreated}}}}`
  return requireLive ? `#{&&:#{==:#{pane_dead},0},${owner}}` : owner
}

const EXACT_ACTION_OK = "FRAY_EXACT_ACTION_OK_9A74D2"
const EXACT_ACTION_MISS = "FRAY_EXACT_ACTION_MISS_9A74D2"
const DEFAULT_INPUT_SETTLE_SECONDS = 0.25
let inputSettleSeconds = DEFAULT_INPUT_SETTLE_SECONDS
const inputSettleCommand = (): string => `/bin/sleep ${inputSettleSeconds}`

// Test seam ONLY. The settle window is a real wall-clock race: a test that has to replace a pane
// *during* it must fit a kill plus a respawn — two tmux execs, ~60-100ms each on a loaded machine —
// inside 250ms, which is not reliably possible and made the settle test flaky in two different
// directions. Widening it in a test changes the timing, never the logic under test. Numeric and
// range-checked because this value is interpolated into a shell command.
export function setInputSettleSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("invalid input settle seconds")
  inputSettleSeconds = seconds
}

// Codex can read a pasted block and an immediately adjacent key as one input burst, leaving the
// text in its composer even though tmux accepted both commands. A blocking run-shell remains part
// of this one tmux server queue but gives the TUI one event-loop boundary to finish the paste. The
// immutable pane condition is checked before the paste and again before the delayed key, so a pane
// replacement during that boundary cannot receive either half under a reused name/id.
function sendTextWithKeyToPane(
  socketName: string,
  paneId: string,
  condition: string,
  bufferPrefix: string,
  text: string,
  key: "Enter" | "Tab",
): boolean {
  const buffer = `${bufferPrefix}-${randomUUID()}`
  const complete = `send-keys -t ${paneId} ${key} ; display-message -p ${EXACT_ACTION_OK}`
  const afterSettle = `if-shell -t ${paneId} -F '${condition}' '${complete}' 'display-message -p ${EXACT_ACTION_MISS}'`
  const authorized = `paste-buffer -p -b ${buffer} -t ${paneId} ; run-shell '${inputSettleCommand()}' ; ${afterSettle}`
  try {
    const out = execFileSync("tmux", [
      "-L", socketName,
      "load-buffer", "-b", buffer, "-",
      ";",
      "if-shell", "-t", paneId, "-F", condition,
      authorized,
      `display-message -p ${EXACT_ACTION_MISS}`,
      ";",
      "delete-buffer", "-b", buffer,
    ], {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    return false
  }
}

// A BARE key into an adopted worker's pane, authorized by the same immutable pane tuple every other
// exact action uses. Deliberately carries NO text: this is the submit-confirmer's re-press for a
// follow-up whose Enter the TUI swallowed (delivery-confirm.ts), and re-pasting the message is exactly
// the double-send that path must be incapable of.
export function sendKeyToExpectedAdoptionPane(expected: ExpectedAdoptionPane, key: "Enter"): boolean {
  return exactPaneAction(expected, `send-keys -t ${expected.pane_id} ${key}`)
}

function exactPaneAction(expected: ExpectedAdoptionPane, command: string, onMiss = ""): boolean {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return false
  try {
    const out = tmux(
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `${command} ; display-message -p ${EXACT_ACTION_OK}`,
      `${onMiss}${onMiss ? " ; " : ""}display-message -p ${EXACT_ACTION_MISS}`,
    )
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    return false
  }
}

export type ExactPaneCapture =
  | { kind: "captured"; text: string }
  | { kind: "unavailable" }

// Check token + full tuple and capture in one tmux server command. A pane replacement cannot slip
// between authorization and capture, and a renamed exact owner remains addressable by pane id.
export function captureExpectedAdoptionPane(
  expected: ExpectedAdoptionPane,
  escaped = false,
): ExactPaneCapture {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return { kind: "unavailable" }
  try {
    const out = tmux(
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `display-message -p ${EXACT_ACTION_OK} ; capture-pane -p${escaped ? " -e" : ""} -t ${expected.pane_id}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    const prefix = `${EXACT_ACTION_OK}\n`
    return out.startsWith(prefix)
      ? { kind: "captured", text: out.slice(prefix.length) }
      : { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

// The literal payload stays on stdin and the entire buffer lifecycle is one tmux client command
// queue: load, token+tuple authorization, paste/send, unconditional delete. There is no process-
// visible staging interval in which Fray can be killed while a secret-bearing tmux buffer remains.
export function sendTextToExpectedAdoptionPane(
  expected: ExpectedAdoptionPane,
  text: string,
  submit: boolean,
): boolean {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return false
  // A SUBMIT routes through the settle-safe key path (paste → blocking run-shell settle → RE-CHECK
  // the pane identity → Enter). Pasting the bracketed block and firing Enter back-to-back let a
  // mid-turn worker read them as one input burst and split a MULTILINE follow-up into one queued
  // message per line — the same "stuck enqueued" race fixed for the owned pasteText path. Reusing
  // sendTextWithKeyToPane also keeps the post-settle recheck, so a pane replaced during the settle
  // boundary never receives the delayed key (it just leaves the text unsubmitted → returns false).
  if (submit) return sendTextWithKeyToPane(socket, expected.pane_id, condition, "fray-exact", text, "Enter")
  // Draft paste (no submit): no key follows the paste, so there is no burst race to settle.
  const buffer = `fray-exact-${randomUUID()}`
  try {
    const out = execFileSync("tmux", [
      "-L", socket,
      "load-buffer", "-b", buffer, "-",
      ";",
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `paste-buffer -p -b ${buffer} -t ${expected.pane_id} ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
      ";",
      "delete-buffer", "-b", buffer,
    ], {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    // A single tmux client submitted the complete server-side queue. Never retry an ambiguous paste:
    // the server either rejected it before authorization or finishes the queued cleanup itself.
    return false
  }
}

// The PTY runs this exact conditional itself. Unlike a canAttach preflight followed by
// `attach-session -t <slug>`, no reusable-name race exists; false authorization simply exits.
export function expectedAdoptionAttachArgs(expected: ExpectedAdoptionPane): string[] | null {
  const condition = expectedAdoptionCondition(expected)
  if (!condition || expected.pane_id === null) return null
  return [
    "if-shell", "-t", expected.pane_id, "-F", condition,
    `attach-session -t ${expected.pane_id}`,
    "",
  ]
}

// Tri-state lookup for destructive recovery. "unknown" is deliberately distinct from absence: a
// transient tmux error must retain the durable claim instead of authorizing artifact/ownership loss.
export function lookupAdoptionPane(slug: string): AdoptionPaneLookup {
  const name = exactSessionTarget(slug)
  try {
    const out = runSpawnCommand([
      "-L", socket, "list-panes", "-t", name, "-F", PANE_SNAPSHOT_FORMAT,
    ])
    const parsed = parsePaneSnapshot(out.split("\n")[0] ?? "")
    return parsed ? { kind: "found", pane: parsed.pane } : { kind: "unknown" }
  } catch (error) {
    return tmuxTargetAbsent(error) ? { kind: "absent" } : { kind: "unknown" }
  }
}

// Find an orphan by its unguessable attempt token across the whole private tmux server. This is the
// recovery path for a process killed after new-session but before SQLite could record the returned
// tuple, and it remains correct even if an operator renamed the session before restart.
export function findAdoptionPane(attemptToken: string): AdoptionPaneLookup {
  return findAdoptionPanes([attemptToken]).get(attemptToken) ?? { kind: "unknown" }
}

// Profile handoffs tag every target/rollback spawn before tmux creates the pane. This closes the
// crash gap between new-session and SQLite's tuple checkpoint without borrowing a reusable slug.
export function findProfileHandoffPane(handoffToken: string): AdoptionPaneLookup {
  if (!validAdoptionAttemptToken(handoffToken)) return { kind: "unknown" }
  try {
    const matches = runSpawnCommand(["-L", socket, "list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT])
      .split("\n")
      .map(parsePaneSnapshot)
      .filter((entry): entry is { name: string; pane: PaneSnapshot } => entry?.pane.profileHandoffToken === handoffToken)
    return matches.length === 1 ? { kind: "found", pane: matches[0].pane }
      : matches.length === 0 ? { kind: "absent" } : { kind: "unknown" }
  } catch (error) {
    return tmuxServerAbsent(error) ? { kind: "absent" } : { kind: "unknown" }
  }
}

export function captureExpectedProfileHandoffPane(
  expected: ExpectedProfileHandoffPane,
  escaped = false,
): ExactPaneCapture {
  const condition = expectedProfileHandoffCondition(expected)
  if (!condition) return { kind: "unavailable" }
  try {
    const out = tmux(
      "if-shell", "-t", expected.paneId, "-F", condition,
      `display-message -p ${EXACT_ACTION_OK} ; capture-pane -p${escaped ? " -e" : ""} -t ${expected.paneId}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    const prefix = `${EXACT_ACTION_OK}\n`
    return out.startsWith(prefix) ? { kind: "captured", text: out.slice(prefix.length) } : { kind: "unavailable" }
  } catch {
    return { kind: "unavailable" }
  }
}

export function killExpectedProfileHandoffPane(expected: ExpectedProfileHandoffPane): boolean {
  const condition = expectedProfileHandoffCondition(expected, false)
  if (!condition) return false
  try {
    const out = tmux(
      "if-shell", "-t", expected.paneId, "-F", condition,
      `kill-pane -t ${expected.paneId} ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    invalidateLiveness()
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    invalidateLiveness()
    return false
  }
}

// Inventory the private server once for any number of permanent retired tokens. Recovery calls this
// on a level-triggered timer, so historical attempts add only in-memory lookups to every sweep.
export function findAdoptionPanes(attemptTokens: readonly string[]): Map<string, AdoptionPaneLookup> {
  const result = new Map<string, AdoptionPaneLookup>()
  const valid = [...new Set(attemptTokens)].filter((token) => {
    if (validAdoptionAttemptToken(token)) return true
    result.set(token, { kind: "unknown" })
    return false
  })
  if (valid.length === 0) return result
  try {
    const wanted = new Set(valid)
    const grouped = new Map(valid.map((token) => [token, [] as PaneSnapshot[]]))
    const entries = runSpawnCommand([
      "-L", socket, "list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT,
    ])
      .split("\n")
      .map(parsePaneSnapshot)
      .filter((entry): entry is { name: string; pane: PaneSnapshot } => Boolean(entry))
    for (const entry of entries) {
      const token = entry.pane.adoptionAttemptToken
      if (token && wanted.has(token)) grouped.get(token)!.push(entry.pane)
    }
    for (const token of valid) {
      const matches = grouped.get(token)!
      result.set(token, matches.length === 1
        ? { kind: "found", pane: matches[0] }
        : matches.length === 0 ? { kind: "absent" } : { kind: "unknown" })
    }
    return result
  } catch (error) {
    const lookup: AdoptionPaneLookup = tmuxServerAbsent(error) ? { kind: "absent" } : { kind: "unknown" }
    for (const token of valid) result.set(token, lookup)
    return result
  }
}

export function findPaneIdentity(identity: PaneIdentity): AdoptionPaneLookup {
  if (!/^%\d+$/.test(identity.paneId) || !Number.isSafeInteger(identity.panePid) || !Number.isSafeInteger(identity.sessionCreated)) {
    return { kind: "unknown" }
  }
  try {
    const matches = runSpawnCommand([
      "-L", socket, "list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT,
    ])
      .split("\n")
      .map(parsePaneSnapshot)
      .filter((entry): entry is { name: string; pane: PaneSnapshot } => Boolean(
        entry &&
        entry.pane.paneId === identity.paneId &&
        entry.pane.panePid === identity.panePid &&
        entry.pane.sessionCreated === identity.sessionCreated,
      ))
    return matches.length === 1 ? { kind: "found", pane: matches[0].pane } : matches.length === 0
      ? { kind: "absent" }
      : { kind: "unknown" }
  } catch (error) {
    return tmuxServerAbsent(error) ? { kind: "absent" } : { kind: "unknown" }
  }
}

// A finalized owner is absent only when BOTH independent durable locators are absent. This catches
// renamed sessions and token-preserving respawns without ever treating a reusable slug as proof.
export function findExpectedAdoptionPane(expected: ExpectedAdoptionPane): AdoptionPaneLookup {
  if (
    expected.pane_id === null ||
    expected.pane_pid === null ||
    expected.session_created === null
  ) {
    const tokenOnly = findAdoptionPane(expected.attempt_token)
    return tokenOnly.kind === "absent" ? { kind: "absent" } : { kind: "unknown" }
  }
  const identity = {
    paneId: expected.pane_id,
    panePid: expected.pane_pid,
    sessionCreated: expected.session_created,
  }
  const byToken = findAdoptionPane(expected.attempt_token)
  const byIdentity = findPaneIdentity(identity)
  if (
    byToken.kind === "found" &&
    byIdentity.kind === "found" &&
    sameExpectedPane(expected, byToken.pane) &&
    sameExpectedPane(expected, byIdentity.pane)
  ) {
    return { kind: "found", pane: byToken.pane }
  }
  if (byToken.kind === "absent" && byIdentity.kind === "absent") return { kind: "absent" }
  return { kind: "unknown" }
}

export function isExpectedAdoptionPane(expected: ExpectedAdoptionPane, pane: PaneSnapshot): boolean {
  return sameExpectedPane(expected, pane)
}

// Atomically authorize and kill using the unguessable attempt token plus the complete pane tuple.
// Dead remain-on-exit panes are valid teardown targets. Callers still verify global token+tuple
// absence after this action; false means no authorized target was touched.
export function killExpectedAdoptionPane(expected: ExpectedAdoptionPane): boolean {
  const condition = expectedAdoptionCondition(expected, false)
  if (!condition || expected.pane_id === null) return false
  try {
    const out = tmux(
      "if-shell", "-t", expected.pane_id, "-F", condition,
      `kill-pane -t ${expected.pane_id} ; display-message -p ${EXACT_ACTION_OK}`,
      `display-message -p ${EXACT_ACTION_MISS}`,
    )
    invalidateLiveness()
    return out.trimEnd().endsWith(EXACT_ACTION_OK)
  } catch {
    invalidateLiveness()
    return false
  }
}

// Kill the exact pane returned by new-session, never whichever process later happens to own a slug.
// Pane ids can be reused after a tmux-server restart, so validate the complete tuple and perform the
// conditional kill as one server-side command. There is deliberately no name-targeted fallback.
export function killPane(identity: PaneIdentity): void {
  if (!/^%\d+$/.test(identity.paneId) || !Number.isFinite(identity.panePid) || !Number.isFinite(identity.sessionCreated)) return
  try {
    const exactIdentity = `#{&&:#{==:#{pane_id},${identity.paneId}},#{&&:#{==:#{pane_pid},${identity.panePid}},#{==:#{session_created},${identity.sessionCreated}}}}`
    tmux("if-shell", "-t", identity.paneId, "-F", exactIdentity, `kill-pane -t ${identity.paneId}`, "")
  } catch {
    // The captured pane already exited/was replaced. Never fall back to a name-targeted kill.
  }
  invalidateLiveness()
}

// A PID alone is not a process-generation identity: it can be reused, and a same-name tmux session
// can be replaced while an async readiness probe is running. Bind all three values tmux owns.
export function paneIdentity(slug: string): PaneIdentity | null {
  try {
    const out = tmux(
      "list-panes",
      "-t",
      exactSessionTarget(slug),
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{session_created}",
    ).trim()
    const [paneId, pidRaw, createdRaw] = (out.split("\n")[0] ?? "").split("\t")
    const panePid = Number.parseInt(pidRaw ?? "", 10)
    const sessionCreated = Number.parseInt(createdRaw ?? "", 10)
    if (!paneId || !Number.isFinite(panePid) || !Number.isFinite(sessionCreated)) return null
    return { paneId, panePid, sessionCreated }
  } catch {
    return null
  }
}

// pane_pid of the (single) pane — the live child's pid, or null if the session is gone.
export function panePid(slug: string): number | null {
  try {
    const out = tmux("list-panes", "-t", exactSessionTarget(slug), "-F", "#{pane_pid}").trim()
    const pid = parseInt(out.split("\n")[0] ?? "", 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

// pane_dead is "1" once the command has exited (session still present thanks to
// remain-on-exit). A missing session reads as dead too.
export function paneDead(slug: string): boolean {
  try {
    const out = tmux("list-panes", "-t", exactSessionTarget(slug), "-F", "#{pane_dead}").trim()
    return (out.split("\n")[0] ?? "1") === "1"
  } catch {
    return true
  }
}

// Alive ⟺ the session exists AND its command has not exited.
//
// ONE subprocess, not two. This used to read `hasSession(slug) && !paneDead(slug)`, but paneDead
// already answers both questions: its `list-panes -t` throws for a session that does not exist, and
// the catch reports dead. So the has-session exec was pure duplicate work on the same target — worth
// ~85ms of measured wall time on every call, and this is the UNCACHED liveness that the follow-up
// injection path takes on every steer, synchronously, on the event loop. Truth table is unchanged:
// missing session → dead, present-but-exited → dead, present-and-running → live.
export function isLive(slug: string): boolean {
  return !paneDead(slug)
}

// ---- Batched liveness cache -------------------------------------------------------------------
// A per-slug liveness question is one subprocess, and the hot paths ask it per-thread: the board's
// deriveRuntime on every overlay refresh (one per thread) and the tailer's 1s tick (one per session
// row). Those sync execs stacked up and starved the event loop — RPC latency climbed to many seconds
// while any agent was streaming. One `list-panes -a` answers ALL sessions in a single subprocess.
//
// But even ONE subprocess is a synchronous fork/exec + tmux round-trip on the event loop, and the
// tailer refreshes it EVERY tick (the 900ms TTL sits just under the 1s poll). On a loaded box that
// single `list-panes -a` measured 60-270ms — and that time is a hard floor under every RPC reply and
// board push the tick owes a client, on a board with ZERO activity (measured 2026-07-23). So the
// refresh is ASYNC: the sync accessor serves the last snapshot immediately and, when it is stale,
// kicks a background `execFile` that updates the cache off the blocking path. A ≤~1s-stale liveness
// bit is already the contract (the TTL always allowed it); what changed is that acquiring the fresh
// one no longer blocks the loop. Cold start and post-mutation invalidations still refresh
// SYNCHRONOUSLY (see paneMap) so a spawn/kill caller that verifies liveness immediately reads truth.
const LIVENESS_TTL_MS = 900
let livenessAt = 0
let livenessMap = new Map<string, PaneSnapshot>() // session name -> exact pane generation + dead bit
// Bumped by invalidateLiveness so a background refresh that started against a now-stale reality (a
// spawn/kill landed mid-flight) discards its result instead of clobbering the fresh sync snapshot.
let livenessGen = 0
let livenessRefreshing = false

function parseLivenessOutput(text: string): Map<string, PaneSnapshot> {
  const map = new Map<string, PaneSnapshot>()
  for (const line of text.split("\n")) {
    const parsed = parsePaneSnapshot(line)
    if (!parsed) continue
    // Fray owns single-pane sessions. If a future/manual session adds panes, prefer a live pane;
    // an exact adoption binding still matches only its persisted tuple.
    const current = map.get(parsed.name)
    if (!current || (current.dead && !parsed.pane.dead)) map.set(parsed.name, parsed.pane)
  }
  return map
}

// Synchronous refresh — used ONLY on cold start (never-populated cache) and immediately after a
// mutation invalidates it, where a caller needs the new reality in the same turn.
function refreshLivenessSync(): void {
  const gen = livenessGen
  let map: Map<string, PaneSnapshot>
  try {
    map = parseLivenessOutput(tmux("list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT))
  } catch {
    map = new Map() // no tmux server → nothing live; the empty map reads as all-dead
  }
  if (gen === livenessGen) {
    livenessMap = map
    livenessAt = Date.now()
  }
}

// Background refresh — the steady-state path. Never blocks the event loop; the tick keeps serving the
// prior snapshot while this runs. Single-flight (livenessRefreshing) so a slow tmux can't stack execs.
async function refreshLivenessAsync(): Promise<void> {
  if (livenessRefreshing) return
  livenessRefreshing = true
  const gen = livenessGen
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["-L", socket, "list-panes", "-a", "-F", PANE_SNAPSHOT_FORMAT],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
    if (gen === livenessGen) {
      livenessMap = parseLivenessOutput(stdout)
      livenessAt = Date.now()
    }
  } catch {
    // no tmux server (or a transient failure) → treat as nothing live, but only if no mutation raced
    if (gen === livenessGen) {
      livenessMap = new Map()
      livenessAt = Date.now()
    }
  } finally {
    livenessRefreshing = false
  }
}

function paneMap(): Map<string, PaneSnapshot> {
  if (Date.now() - livenessAt > LIVENESS_TTL_MS) {
    // livenessAt===0 means the cache is cold OR a mutation just invalidated it (invalidateLiveness
    // resets it to 0): both demand the current truth in-hand, so refresh synchronously. Every other
    // staleness is the ordinary 1s tick, refreshed in the background so the loop never blocks.
    if (livenessAt === 0) refreshLivenessSync()
    else void refreshLivenessAsync()
  }
  return livenessMap
}

// Cached (≤900ms stale) equivalents for the hot paths. A session absent from the map is dead.
export function paneDeadCached(slug: string): boolean {
  return paneMap().get(tmuxSessionName(slug))?.dead !== false
}

export function isLiveCached(slug: string): boolean {
  return paneMap().get(tmuxSessionName(slug))?.dead === false
}

export function paneSnapshotCached(slug: string): PaneSnapshot | null {
  return paneMap().get(tmuxSessionName(slug)) ?? null
}

export function isExpectedAdoptionPaneLiveCached(slug: string, expected: ExpectedAdoptionPane): boolean {
  const pane = paneSnapshotCached(slug)
  return Boolean(pane && !pane.dead && sameExpectedPane(expected, pane))
}

export function isExpectedAdoptionPaneLiveAnywhereCached(expected: ExpectedAdoptionPane): boolean {
  for (const pane of paneMap().values()) {
    if (!pane.dead && sameExpectedPane(expected, pane)) return true
  }
  return false
}

// Test seam / post-mutation freshness: drop the cache so the next read re-lists (spawn/kill call
// this so a just-created or just-killed session is visible immediately, not TTL-later). Resetting
// livenessAt to 0 also routes that next read through the SYNCHRONOUS refresh (paneMap), and bumping
// the generation makes any in-flight BACKGROUND refresh — started against the pre-mutation server —
// discard its now-stale result instead of overwriting the fresh sync snapshot.
export function invalidateLiveness(): void {
  livenessAt = 0
  livenessGen++
}

// Inject a single-line follow-up: send the text literally (-l, so no key interpretation),
// then a separate Enter. For multiline use pasteText.
export function sendKeys(slug: string, text: string): void {
  const name = exactSessionTarget(slug)
  tmux("send-keys", "-t", name, "-l", text)
  tmux("send-keys", "-t", name, "Enter")
}

// Lower-level terminal controls for version-gated TUI automation. Callers must capture + validate the
// pane before using these; unlike sendKeys, these never guess that a literal string is a user prompt.
export function sendLiteral(slug: string, text: string): void {
  tmux("send-keys", "-t", exactSessionTarget(slug), "-l", text)
}

export function sendKey(slug: string, key: "Enter" | "Tab" | "Up" | "Down" | "Escape"): void {
  tmux("send-keys", "-t", exactSessionTarget(slug), key)
}

// Multiline-safe injection: stage the text in a tmux paste-buffer (load-buffer from stdin,
// so newlines/quotes survive untouched), request bracketed-paste framing, then send a distinct Enter.
// Without -p, an active Claude turn can treat the first embedded newline as submit and queue only the
// first line (for example, `Answers:`) while silently losing the rest of the logical follow-up.
//
// The Enter MUST be chained after the paste inside ONE tmux command with a blocking run-shell settle
// between them (matching the adoption path's sendTextWithKeyToPane). As two separate tmux invocations
// with no settle, the submit key raced the TUI's paste ingestion: a mid-turn worker read the bracketed
// block and the adjacent Enter as one input burst and split the follow-up into one QUEUED message per
// line (the exact "still shows enqueued" bug — the client's single optimistic bubble then never matches
// any server line and stays grayed forever). The run-shell blocks this one tmux server queue for one
// event-loop boundary so the TUI finishes the paste into its composer before the Enter submits it whole.
export function pasteText(slug: string, text: string): void {
  const name = exactSessionTarget(slug)
  execFileSync("tmux", ["-L", socket, "load-buffer", "-"], { input: text })
  tmux(
    "paste-buffer", "-p", "-t", name, "-d",
    ";",
    "run-shell", inputSettleCommand(),
    ";",
    "send-keys", "-t", name, "Enter",
  )
}
