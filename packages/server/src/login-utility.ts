import { spawn as spawnChild, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import type { Backend } from "@frizz/shared"
import { resolveClaudeExecutableAbsolute } from "./backend/claude-broker-host.ts"
import { resolveCodexExecutable } from "./backend/codex-executable.ts"
import { endDaemonTree } from "./backend/daemon-tree.ts"

// A restricted, short-lived provider ACCOUNT utility — the terminal behind the sign-in modal's
// primary "Sign in" action. This is NOT the agent-thread terminal: it never resumes or mutates a
// worker, inherits no project prompt, and accepts no arbitrary shell command — the child runs exactly
// the provider's own login argv (`claude auth login`) and nothing else, spawned WITHOUT an
// intervening shell.
//
// Runs over plain PIPES, like every agent transport (the broker, the app-server, ACP). It ran on
// node-pty until 2026-09-24, and on a tmux pane before that; the pty was the last native addon the
// server shipped, and node-pty publishes no Linux prebuild, so every Linux and WSL install failed at
// boot on `import "node-pty"` for the sake of this one modal (#42). Neither CLI needs a terminal to
// sign in: over pipes `claude auth login` prints its URL and reads the pasted code from stdin, and
// `codex login` prints its URL and waits on its own localhost callback. What the pty's line
// discipline did for free — echo, Backspace, Enter, CRLF output — is `lineDiscipline` below.
//
// tmux also gave multi-viewer attach for free, so that is rebuilt here deliberately and minimally:
// ONE child per attempt, a bounded replay buffer, and a subscriber set. Two browser tabs on the sign-in
// modal must see the SAME OAuth flow — spawning a child per viewer would start a second one and race
// them against a single credential store.
//
// Addressing: each attempt gets an opaque, server-issued, slug-SHAPED id ("login-<16 hex>", 64 random
// bits). Being slug-shaped lets the attempt ride the existing hardened /term/<slug> transport (same
// input/output/viewer bounds) — index.ts resolves an attempt id BEFORE consulting the session
// registry, and no registry row ever exists for one, so the board/tailer/adoption never see it.
//
// Ephemerality: login output (OAuth URLs, pasted codes) lives only in this process's memory — the
// replay buffer and the bounded WS byte stream — never in a transcript, SQLite, scratchpads, or
// server logs. Teardown kills the child AND drops the buffer on cancel, success, timeout or shutdown.

const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000 // a browser-OAuth round trip, generously bounded

// Enough to carry an OAuth URL plus the surrounding prompt to a tab that opens late, and small enough
// that a chatty CLI cannot grow the process. Trimmed from the FRONT so the newest output always
// survives — a viewer needs the current prompt, not the banner.
const REPLAY_CAP_BYTES = 256 * 1024

// CSI (arrow keys, bracketed-paste markers, focus reports), SS3 (application-mode arrows) and any
// other two-byte escape. A pipe has no cursor to move, so none of them means anything to the CLI.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|[\s\S])/g

/**
 * The cooked-mode editing a pty's line discipline used to do, reduced to what a sign-in needs:
 * printable input is echoed and buffered, Backspace erases, Enter hands the line to the CLI, Ctrl-C
 * ends the attempt. xterm sends Enter as `\r`; a pasted `\r\n` is one Enter, not two.
 */
export function lineDiscipline(io: { echo(text: string): void; submit(line: string): void; interrupt(): void }): (data: string) => void {
  let line = ""
  let afterCarriageReturn = false
  return (data) => {
    for (const char of data.replace(ESCAPE_SEQUENCE, "")) {
      const pairedNewline = char === "\n" && afterCarriageReturn
      afterCarriageReturn = char === "\r"
      if (pairedNewline) continue
      if (char === "\r" || char === "\n") {
        io.echo("\r\n")
        io.submit(line)
        line = ""
      } else if (char === "\x7f" || char === "\b") {
        if (!line) continue
        line = [...line].slice(0, -1).join("")
        io.echo("\b \b")
      } else if (char === "\x03") {
        io.echo("^C\r\n")
        io.interrupt()
      } else if (char >= " ") {
        line += char
        io.echo(char)
      }
    }
  }
}

export interface LoginAttemptStatus {
  // "running" = the login CLI is still interactive; "exited" = it finished (either way — the caller
  // re-reads the credential state for the verdict).
  state: "running" | "exited"
  // The provider this attempt signs into; undefined once the attempt is gone/never existed.
  backend?: Backend
  // Set when the CLI never started: the name did not resolve to an executable, or the OS refused to
  // spawn it. The attempt is "exited" and the same text is its whole replay, so the pane shows WHY
  // instead of a blank terminal (Windows audit 2026-09-11, finding 7).
  error?: string
}

/** A live viewer of one attempt's CLI. Returned by `attach`; `close()` detaches only this viewer. */
export interface LoginAttachment {
  /** Everything the CLI has emitted so far, so a tab that opens late still sees the OAuth URL. */
  replay(): string
  /** Live output. Returns an unsubscribe. */
  onData(listener: (chunk: string) => void): () => void
  /** Keystrokes from this viewer (the pasted OAuth code). */
  write(data: string): void
  /** The CLI exited — it finished, either way. */
  onExit(listener: () => void): () => void
  close(): void
}

export interface LoginUtility {
  // Starts (or returns the existing) login attempt for a provider. At most ONE live attempt per
  // provider per frizz server — a second Sign in click attaches to the same terminal rather than
  // racing two OAuth flows against one credential store.
  start(backend: Backend): { attemptId: string }
  /** Non-null iff this slug-shaped id addresses a live attempt (the /term transport's gate). */
  attach(slug: string): LoginAttachment | null
  status(attemptId: string): LoginAttemptStatus
  cancel(attemptId: string): void
  stop(): void
}

interface LiveAttempt {
  id: string
  backend: Backend
  /** Absent when the CLI never started — see LoginAttemptStatus.error. */
  child?: ChildProcess
  /** The pasted-code editor in front of the child's stdin. */
  input?: (data: string) => void
  timer: NodeJS.Timeout
  /** Bounded, memory-only replay so a late viewer sees the OAuth URL. Dropped on teardown. */
  buffer: string
  bufferBytes: number
  exited: boolean
  error?: string
  dataListeners: Set<(chunk: string) => void>
  exitListeners: Set<() => void>
}

export function createLoginUtility(deps: {
  claudeBin?: string
  codexBin?: string
  // The cwd for the spawned CLI. Login is account-global, but the CLI still wants a valid cwd.
  cwd: string
  lifetimeMs?: number
  /** Injectable so tests can stand a script of their own in for the provider CLI. */
  spawn?: typeof spawnChild
  /** The environment the CLI runs in AND the PATH a bare name is resolved against. Defaults to this
   *  process's; injectable so a test can point the resolvers at a directory of its own. */
  env?: NodeJS.ProcessEnv
}): LoginUtility {
  const spawn = deps.spawn ?? spawnChild
  const env = deps.env ?? process.env
  const lifetimeMs = deps.lifetimeMs ?? ATTEMPT_LIFETIME_MS
  const attempts = new Map<string, LiveAttempt>()

  // No boot-time orphan sweep, unlike the tmux implementation this replaced. The CLI is a CHILD of
  // this process, so there is no equivalent of a `remain-on-exit` pane surviving in a detached tmux
  // server with OAuth bytes in its scrollback. That whole class of leak is gone.

  // RESOLVED to an absolute executable before it is spawned, never handed over as a bare name. Without
  // a shell, Windows' CreateProcessW finds `claude.exe`/`codex.exe` on PATH but never the
  // `.cmd`/`.ps1`/sh shims an npm install writes — so with the runtime pin fallen back to PATH
  // (`source: "path"`: an offline first boot, FRIZZ_RUNTIMES=path, a degraded sweep) the pane spawned
  // nothing and showed a dead terminal. Every other reader of the bare name moved to the resolvers in
  // 517e9c8e; this one had not (Windows audit 2026-09-11, finding 7). Both resolvers THROW on a miss,
  // and start() turns that into the attempt's status.
  function loginArgv(backend: Backend): { file: string; args: string[] } {
    if (backend === "codex") {
      const codex = resolveCodexExecutable(deps.codexBin, { env })
      return { file: codex.file, args: [...codex.args, "login"] }
    }
    return { file: resolveClaudeExecutableAbsolute(deps.claudeBin, env), args: ["auth", "login"] }
  }

  function startError(backend: Backend, cause: unknown): string {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return `Could not start the ${backend === "codex" ? "Codex" : "Claude"} sign-in: ${reason}`
  }

  function emit(attempt: LiveAttempt, chunk: string): void {
    attempt.buffer += chunk
    attempt.bufferBytes += Buffer.byteLength(chunk)
    // Trim from the FRONT — the newest output is what a late viewer needs.
    while (attempt.bufferBytes > REPLAY_CAP_BYTES && attempt.buffer.length > 0) {
      const drop = attempt.buffer.slice(0, Math.ceil(attempt.buffer.length / 4))
      attempt.buffer = attempt.buffer.slice(drop.length)
      attempt.bufferBytes -= Buffer.byteLength(drop)
    }
    for (const listener of attempt.dataListeners) { try { listener(chunk) } catch { /* one bad viewer must not stall the others */ } }
  }

  function finish(attempt: LiveAttempt): void {
    if (attempt.exited) return
    attempt.exited = true
    for (const listener of attempt.exitListeners) { try { listener() } catch { /* ignore */ } }
  }

  /** End the CLI and whatever it started — `codex` is a JS launcher in front of a native binary. */
  function kill(child: ChildProcess | undefined): void {
    if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    endDaemonTree(child.pid, "SIGTERM")
  }

  function teardown(id: string): void {
    const attempt = attempts.get(id)
    if (!attempt) return
    clearTimeout(attempt.timer)
    attempts.delete(id)
    // Drop the OAuth bytes before anything else can read them, then kill.
    attempt.buffer = ""
    attempt.bufferBytes = 0
    attempt.dataListeners.clear()
    for (const listener of attempt.exitListeners) { try { listener() } catch { /* a viewer's teardown must not block ours */ } }
    attempt.exitListeners.clear()
    kill(attempt.child)
  }

  return {
    start(backend) {
      for (const attempt of attempts.values()) {
        if (attempt.backend !== backend) continue
        // Reuse only a still-running attempt; a finished one is replaced so a second Sign in click
        // after a failed flow starts fresh rather than attaching to a dead CLI.
        if (!attempt.exited) return { attemptId: attempt.id }
        teardown(attempt.id)
      }
      const id = `login-${randomBytes(8).toString("hex")}`
      const attempt: LiveAttempt = {
        id, backend,
        timer: setTimeout(() => teardown(id), lifetimeMs),
        buffer: "", bufferBytes: 0, exited: false,
        dataListeners: new Set(), exitListeners: new Set(),
      }
      attempt.timer.unref?.()
      attempts.set(id, attempt)
      // The CLI never started. The attempt still exists so the modal's status poll reads a definite
      // "exited" with the reason, and a viewer that attaches sees it in the pane rather than nothing.
      const failed = (cause: unknown) => {
        if (attempt.error || attempt.exited) return
        attempt.error = startError(backend, cause)
        emit(attempt, `${attempt.error}\r\n`)
        finish(attempt)
      }
      let child: ChildProcess
      try {
        const { file, args } = loginArgv(backend)
        child = spawn(file, args, { cwd: deps.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      } catch (cause) {
        failed(cause)
        return { attemptId: id }
      }
      attempt.child = child
      // A spawn the OS refuses (ENOENT, EACCES) arrives here, asynchronously, and no `exit` follows.
      child.once("error", (cause) => { if (child.pid === undefined) failed(cause) })
      // `close`, not `exit`: it waits for stdout to drain, so a viewer is not detached before the
      // CLI's last line ("Login successful") reaches it.
      child.once("close", () => finish(attempt))
      child.stdin?.on("error", () => { /* the CLI exited with a line in flight */ })
      // A pipe carries bare LF; the xterm on the other end of /term needs CRLF to return the cursor.
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8")
        stream?.on("data", (chunk: string) => emit(attempt, chunk.replace(/\r?\n/g, "\r\n")))
      }
      attempt.input = lineDiscipline({
        echo: (text) => emit(attempt, text),
        submit: (line) => { if (!attempt.exited) child.stdin?.write(`${line}\n`) },
        interrupt: () => kill(child),
      })
      return { attemptId: id }
    },
    attach(slug) {
      const attempt = attempts.get(slug)
      if (!attempt) return null
      return {
        replay: () => attempt.buffer,
        onData: (listener) => {
          attempt.dataListeners.add(listener)
          return () => attempt.dataListeners.delete(listener)
        },
        write: (data) => { if (!attempt.exited) attempt.input?.(data) },
        onExit: (listener) => {
          if (attempt.exited) { listener(); return () => {} }
          attempt.exitListeners.add(listener)
          return () => attempt.exitListeners.delete(listener)
        },
        close: () => { /* detaching a viewer never touches the CLI — another tab may still be watching */ },
      }
    },
    status(attemptId) {
      const attempt = attempts.get(attemptId)
      if (!attempt) return { state: "exited" }
      return { state: attempt.exited ? "exited" : "running", backend: attempt.backend, ...(attempt.error ? { error: attempt.error } : {}) }
    },
    cancel(attemptId) {
      teardown(attemptId)
    },
    stop() {
      for (const id of [...attempts.keys()]) teardown(id)
    },
  }
}
