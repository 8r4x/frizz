// ── The launcher's terminal readout ────────────────────────────────────────────────────────────────
// What the operator sees while Fray starts, and the block that stays on screen once it has.
//
// This replaces a single animated line that had to switch itself off (`beginConcurrentLogs`) as soon
// as the forked control-plane child began writing to the same TTY — the launcher cannot clear another
// process' output, so the interesting half of every boot degraded into interleaved `[fray-ui] …` rows.
// The child is silent on the terminal now (its records go to the run log; `--debug` opens the tap
// again), which leaves exactly one writer here and makes a real repaint safe.
//
// Repainting is deliberately confined to the boot. Once the final block prints, this stops touching
// the cursor for good, so a stray write from a dependency — or a crash stack — can never land on top
// of a region we are still redrawing.

export interface ReadoutOutput {
  isTTY?: boolean
  columns?: number
  write(chunk: string): boolean
}

export type StepState = "pending" | "active" | "done" | "skipped" | "failed"

export interface Step {
  key: string
  label: string
  state: StepState
  /** The live sub-phase of an active step ("web UI", "waiting for health"). */
  detail?: string
  /** Wall time the step took, filled in when it settles. */
  ms?: number
}

export interface ReadoutOptions {
  output?: ReadoutOutput
  /** Full-feed mode: never repaint, print every record as its own line. */
  debug?: boolean
  /** Disable colour explicitly; otherwise inferred from the stream and NO_COLOR. */
  color?: boolean
  version?: string
  tickMs?: number
  now?: () => number
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// DEC private mode 2026 — "synchronized output". A terminal that understands it buffers everything
// between the two markers and presents the frame at once, so a multi-row repaint cannot be caught
// half-drawn. Terminals that do not understand it ignore an unknown private mode, so this is free.
const SYNC_BEGIN = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"

// Sentence case throughout, per the project's copy rule.
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms / 1_000)}s`
}

/** Shorten an absolute path under $HOME so the block stays narrow and scannable. */
export function tildePath(path: string, home: string | undefined): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  return rest === "" ? "~" : rest.startsWith("/") ? `~${rest}` : path
}

export class Readout {
  private readonly out: ReadoutOutput
  private readonly tty: boolean
  private readonly colorEnabled: boolean
  private readonly debug: boolean
  private readonly version: string | undefined
  private readonly now: () => number
  private readonly startedAt: number
  private readonly steps: Step[] = []
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined
  /** Rows currently occupied by the repainting region, so the next paint knows what to erase. */
  private painted = 0
  private stepStartedAt = new Map<string, number>()
  private settled = false
  /** Non-TTY only: suppress repeating an identical status row. */
  private lastPlainLine = ""

  constructor(options: ReadoutOptions = {}) {
    this.out = options.output ?? process.stdout
    this.tty = this.out.isTTY === true
    this.debug = options.debug === true
    this.colorEnabled =
      options.color ?? (this.tty && !process.env.NO_COLOR && process.env.TERM !== "dumb")
    this.version = options.version
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
    // Repainting is for an interactive terminal only. In debug mode the feed owns the screen, and in a
    // pipe there is no cursor to move.
    if (this.tty && !this.debug) {
      const timer = setInterval(() => this.paint(), options.tickMs ?? 80)
      timer.unref?.()
      this.timer = timer
    }
  }

  private c(code: string, text: string): string {
    return this.colorEnabled ? `${code}${text}${ANSI.reset}` : text
  }

  private get width(): number {
    return Math.max(40, this.out.columns ?? 80)
  }

  /** Truncate to the terminal width so a row can never wrap — wrapping desynchronizes the repaint. */
  private fit(line: string): string {
    const limit = this.width - 1
    if (visibleLength(line) <= limit) return line
    return `${sliceVisible(line, limit - 1)}…`
  }

  // ── Steps ────────────────────────────────────────────────────────────────────────────────────────

  /** Declare the boot's shape up front so the operator can see what is still ahead. */
  plan(steps: Array<{ key: string; label: string }>): void {
    for (const step of steps) {
      if (!this.steps.some((existing) => existing.key === step.key)) {
        this.steps.push({ ...step, state: "pending" })
      }
    }
    this.paint(true)
  }

  begin(key: string, detail?: string): void {
    const step = this.steps.find((candidate) => candidate.key === key)
    if (!step) return
    // A step that starts settles whatever came before it; boots do not run steps concurrently.
    for (const earlier of this.steps) {
      if (earlier === step) break
      if (earlier.state === "active") this.settle(earlier.key, "done")
    }
    step.state = "active"
    if (detail !== undefined) step.detail = detail
    this.stepStartedAt.set(key, this.now())
    this.emitPlain(step)
    this.paint(true)
  }

  /** Update the live sub-phase of the active step without changing which step is active. */
  detail(key: string, detail: string): void {
    const step = this.steps.find((candidate) => candidate.key === key)
    if (!step || step.state !== "active") return
    if (step.detail === detail) return
    step.detail = detail
    this.emitPlain(step)
    this.paint(true)
  }

  settle(key: string, state: "done" | "skipped" | "failed", detail?: string): void {
    const step = this.steps.find((candidate) => candidate.key === key)
    if (!step) return
    step.state = state
    if (detail !== undefined) step.detail = detail
    const startedAt = this.stepStartedAt.get(key)
    if (startedAt !== undefined) step.ms = this.now() - startedAt
    this.emitPlain(step)
    this.paint(true)
  }

  /** The step currently doing work, for a failure message that can name where the boot stopped. */
  activeStep(): Step | undefined {
    return this.steps.find((step) => step.state === "active")
  }

  // ── Painting ─────────────────────────────────────────────────────────────────────────────────────

  private glyph(step: Step): string {
    switch (step.state) {
      case "done":
        return this.c(ANSI.green, "✓")
      case "failed":
        return this.c(ANSI.red, "✗")
      case "skipped":
        return this.c(ANSI.dim, "−")
      case "active":
        return this.c(ANSI.cyan, SPINNER[this.frame % SPINNER.length]!)
      default:
        return this.c(ANSI.dim, "·")
    }
  }

  private stepRow(step: Step): string {
    const label =
      step.state === "pending" ? this.c(ANSI.dim, step.label.padEnd(18)) : step.label.padEnd(18)
    const detail = step.detail ? this.c(ANSI.dim, step.detail) : ""
    const elapsed =
      step.state === "active"
        ? this.c(ANSI.dim, ` ${formatDuration(this.now() - (this.stepStartedAt.get(step.key) ?? this.now()))}`)
        : step.ms !== undefined && step.ms >= 1_000
        ? this.c(ANSI.dim, ` ${formatDuration(step.ms)}`)
        : ""
    return this.fit(`  ${this.glyph(step)}  ${label}${detail}${elapsed}`)
  }

  private header(): string[] {
    const name = this.c(`${ANSI.bold}${ANSI.magenta}`, "FRAY")
    const version = this.version ? ` ${this.c(ANSI.dim, `v${this.version}`)}` : ""
    return ["", `  ${name}${version}`, ""]
  }

  /** Return the cursor to the top of the painted region and clear everything below it. */
  private rewind(): string {
    return this.painted > 0 ? `\x1b[${this.painted}A\r\x1b[0J` : "\r\x1b[0J"
  }

  private paint(force = false): void {
    if (this.settled) return
    if (!this.tty || this.debug) return
    if (!force) this.frame++
    const lines = [...this.header(), ...this.steps.map((step) => this.stepRow(step))]
    this.out.write(`${SYNC_BEGIN}${this.rewind()}${lines.join("\n")}\n${SYNC_END}`)
    this.painted = lines.length
  }

  /** Non-TTY (and debug) transcript: one settled, parseable row per state change. */
  private emitPlain(step: Step): void {
    if (this.tty && !this.debug) return
    const mark =
      step.state === "done" ? "done" : step.state === "failed" ? "failed" : step.state === "skipped" ? "skipped" : "···"
    const detail = step.detail ? ` — ${step.detail}` : ""
    const line = `fray: ${mark} ${step.label.toLowerCase()}${detail}`
    if (line === this.lastPlainLine) return
    this.lastPlainLine = line
    this.out.write(`${line}\n`)
  }

  /** Print a line without disturbing the repaint region (used for the debug feed and warnings). */
  note(line: string): void {
    if (this.settled || !this.tty || this.debug) {
      this.out.write(`${line}\n`)
      return
    }
    // Erase the region, print the line so it scrolls above, then repaint beneath it — the technique
    // ink uses, and the reason the repaint region is always the tail of the stream rather than a
    // fixed screen row (a fixed row needs DECSTBM, which survives an abnormal exit and wrecks the
    // operator's shell).
    this.out.write(`${SYNC_BEGIN}${this.rewind()}${this.fit(line)}\n${SYNC_END}`)
    this.painted = 0
    this.paint(true)
  }

  // ── The final block ──────────────────────────────────────────────────────────────────────────────

  /**
   * Replace the boot region with the block that stays on screen, then stop repainting for good.
   * `entries` are the label/value rows: the URL first, then project, source, log path.
   */
  ready(entries: Array<{ label: string; value: string; accent?: boolean }>, hint?: string): void {
    for (const step of this.steps) if (step.state === "active") this.settle(step.key, "done")
    const elapsed = formatDuration(this.now() - this.startedAt)
    this.stop()
    if (!this.tty || this.debug) {
      this.out.write(`fray: ready in ${elapsed}\n`)
      for (const entry of entries) this.out.write(`fray: ${entry.label.toLowerCase()}: ${entry.value}\n`)
      return
    }
    const width = entries.reduce((max, entry) => Math.max(max, entry.label.length), 0) + 1
    const lines = [
      "",
      `  ${this.c(`${ANSI.bold}${ANSI.magenta}`, "FRAY")}${
        this.version ? ` ${this.c(ANSI.dim, `v${this.version}`)}` : ""
      }  ${this.c(ANSI.dim, `ready in ${elapsed}`)}`,
      "",
      ...entries.map((entry) => {
        const arrow = this.c(ANSI.green, "➜")
        const label = this.c(ANSI.bold, `${entry.label}:`.padEnd(width + 1))
        const value = entry.accent ? this.c(ANSI.cyan, entry.value) : this.c(ANSI.dim, entry.value)
        return this.fit(`  ${arrow}  ${label} ${value}`)
      }),
      ...(hint ? ["", this.fit(`  ${this.c(ANSI.dim, hint)}`)] : []),
      "",
    ]
    // Erase the boot region and leave the final block in the scrollback.
    const rewind = this.painted > 0 ? `\x1b[${this.painted}A\r\x1b[0J` : "\r\x1b[0J"
    this.out.write(`${rewind}${lines.join("\n")}\n`)
    this.painted = 0
  }

  /** Terminal failure: settle the active step as failed, then print the reason and where to look. */
  fail(message: string, logPath?: string): void {
    const active = this.activeStep()
    if (active) this.settle(active.key, "failed")
    this.stop()
    if (!this.tty || this.debug) {
      this.out.write(`fray: failed: ${message}\n`)
      if (logPath) this.out.write(`fray: log: ${logPath}\n`)
      return
    }
    const lines = [
      "",
      `  ${this.c(ANSI.red, "✗")}  ${this.c(ANSI.bold, "Fray could not start")}`,
      "",
      ...message.split("\n").map((row) => this.fit(`     ${this.c(ANSI.red, row)}`)),
      ...(logPath ? ["", this.fit(`     ${this.c(ANSI.dim, `Full log: ${logPath}`)}`)] : []),
      "",
    ]
    const rewind = this.painted > 0 ? `\x1b[${this.painted}A\r\x1b[0J` : "\r\x1b[0J"
    this.out.write(`${rewind}${lines.join("\n")}\n`)
    this.painted = 0
  }

  /** Stop repainting without printing anything, e.g. before ordinary console output takes over. */
  stop(): void {
    if (this.settled) return
    this.settled = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

// ── Width helpers ──────────────────────────────────────────────────────────────────────────────────
// Only SGR sequences are ever embedded here, so a simple stripper is enough; a full grapheme-aware
// width would be over-engineering for rows we already keep well inside the terminal.

const SGR = /\x1b\[[0-9;]*m/g

export function visibleLength(line: string): number {
  return line.replace(SGR, "").length
}

/** Take `limit` visible characters, preserving whatever colour codes were already open. */
export function sliceVisible(line: string, limit: number): string {
  let visible = 0
  let out = ""
  for (let index = 0; index < line.length; ) {
    SGR.lastIndex = index
    const match = /^\x1b\[[0-9;]*m/.exec(line.slice(index))
    if (match) {
      out += match[0]
      index += match[0].length
      continue
    }
    if (visible >= limit) break
    out += line[index]
    visible++
    index++
  }
  return `${out}${ANSI.reset}`
}
