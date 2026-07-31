import { closeSync, fstatSync, openSync, readSync } from "node:fs"

const OUTPUT_TAIL_BYTES = 512 * 1024
const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g

export interface BackgroundShellOutput {
  output: string
  truncated: boolean
}

// Background task files are an undifferentiated process stream: Claude does not preserve stdout vs
// stderr channel identity. Read only the newest bounded tail so a long-lived server cannot make one
// drawer allocate or render an unbounded log. ANSI/OSC controls are presentation noise in a plain DOM
// surface; carriage-return progress updates become readable lines instead of overprinting.
export function readBackgroundShellOutput(path: string, maxBytes = OUTPUT_TAIL_BYTES): BackgroundShellOutput {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const offset = Math.max(0, size - length)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read)
      if (count === 0) break
      read += count
    }
    const output = buffer.subarray(0, read).toString("utf8").replace(ANSI_ESCAPE_RE, "").replace(/\r(?!\n)/g, "\n")
    return { output, truncated: offset > 0 }
  } catch {
    return { output: "", truncated: false }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
