import qrcode from "qrcode-generator"

/**
 * Render a string as a QR code sized for a terminal.
 *
 * Two decisions worth stating, because both are the difference between "scans instantly" and "does not
 * scan at all":
 *
 * HALF BLOCKS. Terminal cells are about twice as tall as they are wide, so one module per cell yields a
 * QR stretched 2:1 that many phone cameras refuse. Packing two module ROWS into one cell with `▀`
 * (upper half block) makes the code square AND halves its height — a 33-module code is 41 columns with
 * its quiet zone, which is 21 rows instead of 41 and therefore fits an 80x24 terminal.
 *
 * EXPLICIT COLOUR, NOT BARE GLYPHS. A QR needs dark modules on a light field. Drawing glyphs in the
 * terminal's default colours inverts that on a dark theme, which is most of them, and an inverted QR
 * does not scan on iOS. So each half block sets an explicit foreground (top module) and background
 * (bottom module) instead of trusting the theme. The quiet zone is drawn, not assumed — a QR flush
 * against surrounding text is unreadable even when the code itself is perfect.
 */

const LIGHT = "\x1b[38;5;15m"
const LIGHT_BG = "\x1b[48;5;15m"
const DARK = "\x1b[38;5;0m"
const DARK_BG = "\x1b[48;5;0m"
const RESET = "\x1b[0m"
const UPPER_HALF = "▀"
/** Four modules is the spec's minimum quiet zone; less and the finder patterns stop being findable. */
const QUIET_ZONE = 4

export interface QrRenderOptions {
  /** Error correction. "M" tolerates ~15% damage, which covers a slightly out-of-focus phone camera. */
  errorCorrection?: "L" | "M" | "Q" | "H"
  /** Emit plain `#`/space instead of ANSI colour, for tests and non-TTY sinks. */
  plain?: boolean
}

/** True when the module at (x, y) is dark; anything outside the code is quiet zone, hence light. */
type ModuleAt = (x: number, y: number) => boolean

function encode(value: string, errorCorrection: "L" | "M" | "Q" | "H"): { size: number; at: ModuleAt } {
  // Type 0 asks the encoder to pick the smallest version that fits.
  const code = qrcode(0, errorCorrection)
  code.addData(value)
  code.make()
  const modules = code.getModuleCount()
  const size = modules + QUIET_ZONE * 2
  return {
    size,
    at: (x, y) => {
      const mx = x - QUIET_ZONE
      const my = y - QUIET_ZONE
      if (mx < 0 || my < 0 || mx >= modules || my >= modules) return false
      return code.isDark(my, mx)
    },
  }
}

/**
 * The code as terminal lines, quiet zone included. Returns lines rather than a blob so a caller can
 * centre it, box it, or repaint a region without re-encoding.
 */
export function renderQrLines(value: string, options: QrRenderOptions = {}): string[] {
  if (!value) throw new Error("renderQr requires a value")
  const { size, at } = encode(value, options.errorCorrection ?? "M")
  const lines: string[] = []
  // Two module rows per terminal row. An odd final row pairs with quiet zone, which is light anyway.
  for (let y = 0; y < size; y += 2) {
    let line = ""
    for (let x = 0; x < size; x++) {
      const top = at(x, y)
      const bottom = y + 1 < size ? at(x, y + 1) : false
      if (options.plain) {
        line += top && bottom ? "#" : top ? "^" : bottom ? "v" : " "
        continue
      }
      line += `${top ? DARK : LIGHT}${bottom ? DARK_BG : LIGHT_BG}${UPPER_HALF}`
    }
    lines.push(options.plain ? line : `${line}${RESET}`)
  }
  return lines
}

/** Convenience for printing straight to a terminal. */
export function renderQr(value: string, options: QrRenderOptions = {}): string {
  return renderQrLines(value, options).join("\n")
}

/** Width in terminal columns, so a caller can centre or box the code without rendering it first. */
export function qrWidth(value: string, errorCorrection: "L" | "M" | "Q" | "H" = "M"): number {
  return encode(value, errorCorrection).size
}
