import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import qrcode from "qrcode-generator"
import { qrWidth, renderQr, renderQrLines } from "./qr.ts"

const QUIET_ZONE = 4
const SAMPLE = "https://colin.frizz.sh/?frizz_code=pW58RJTeG4IMkc6ojgC"

/** What the encoder itself says, so the test compares the RENDERING against ground truth, not itself. */
function truth(value: string) {
  const code = qrcode(0, "M")
  code.addData(value)
  code.make()
  const modules = code.getModuleCount()
  return {
    modules,
    size: modules + QUIET_ZONE * 2,
    dark: (x: number, y: number) => {
      const mx = x - QUIET_ZONE
      const my = y - QUIET_ZONE
      if (mx < 0 || my < 0 || mx >= modules || my >= modules) return false
      return code.isDark(my, mx)
    },
  }
}

test("the half-block rendering round-trips back to the exact module matrix", () => {
  // The bug this exists for: pairing two module ROWS into one terminal cell is easy to get off by one,
  // and the result still LOOKS like a QR while scanning as garbage or not at all. So reconstruct the
  // matrix from the rendered glyphs and compare every cell against the encoder.
  const { size, dark } = truth(SAMPLE)
  const lines = renderQrLines(SAMPLE, { plain: true })
  assert.equal(lines.length, Math.ceil(size / 2), "one terminal row per two module rows")
  for (const line of lines) assert.equal(line.length, size, "every row is the full width incl. quiet zone")

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const glyph = lines[Math.floor(y / 2)]![x]!
      const isTop = y % 2 === 0
      const rendered = isTop ? glyph === "#" || glyph === "^" : glyph === "#" || glyph === "v"
      assert.equal(rendered, dark(x, y), `module (${x},${y}) rendered wrong`)
    }
  }
})

test("the quiet zone is drawn on all four sides, not assumed", () => {
  // A QR flush against surrounding terminal text does not scan, however correct the code itself is.
  const { size } = truth(SAMPLE)
  const lines = renderQrLines(SAMPLE, { plain: true })
  const blankRow = " ".repeat(size)
  for (let i = 0; i < QUIET_ZONE / 2; i++) {
    assert.equal(lines[i], blankRow, `top quiet-zone row ${i} is not blank`)
    assert.equal(lines[lines.length - 1 - i], blankRow, `bottom quiet-zone row ${i} is not blank`)
  }
  for (const line of lines) {
    assert.equal(line.slice(0, QUIET_ZONE), " ".repeat(QUIET_ZONE), "left quiet zone")
    assert.equal(line.slice(-QUIET_ZONE), " ".repeat(QUIET_ZONE), "right quiet zone")
  }
})

test("colour polarity is explicit, so a dark terminal theme cannot invert the code", () => {
  // An inverted QR does not scan on iOS. Dark modules must be painted dark REGARDLESS of theme, which
  // means every cell carries its own fg+bg rather than inheriting the terminal's.
  const rendered = renderQr(SAMPLE)
  assert.match(rendered, /\x1b\[48;5;0m/, "some cell paints a dark pair as background")
  assert.match(rendered, /\x1b\[48;5;15m/, "some cell paints a light module as background")
  assert.ok(rendered.endsWith("\x1b[0m"), "the last row resets, or the terminal keeps the QR's colours")
  for (const line of rendered.split("\n")) assert.ok(line.endsWith("\x1b[0m"), "every row resets")
})

/** Each terminal cell of a coloured row: the SGR sequences that precede its one character, and it. */
function cells(line: string): Array<{ sgr: string[]; glyph: string }> {
  const out: Array<{ sgr: string[]; glyph: string }> = []
  const re = /((?:\x1b\[[0-9;]*m)*)(.)/gu
  for (const [, codes, glyph] of line.replace(/\x1b\[0m$/u, "").matchAll(re)) {
    out.push({ sgr: codes!.match(/\x1b\[[0-9;]*m/gu) ?? [], glyph: glyph! })
  }
  return out
}

test("a uniform cell is background only, and a half block is always dark ink on a light field", () => {
  // The artifact this pins (2026-09-23): a dark-over-dark `▀` is a glyph the same colour as its own
  // background, which minimum-contrast terminals lighten and short half-block fonts leave a seam
  // through — every solid dark run came out striped and the phone would not read the finders. So no
  // uniform cell may carry a glyph, and no glyph may share a colour with the field it sits on.
  const { size, dark } = truth(SAMPLE)
  const lines = renderQrLines(SAMPLE)
  assert.equal(lines.length, Math.ceil(size / 2))
  for (let row = 0; row < lines.length; row++) {
    const rowCells = cells(lines[row]!)
    assert.equal(rowCells.length, size, `row ${row} has one cell per column`)
    for (let x = 0; x < size; x++) {
      const top = dark(x, row * 2)
      const bottom = row * 2 + 1 < size ? dark(x, row * 2 + 1) : false
      const { sgr, glyph } = rowCells[x]!
      const where = `cell (${x},${row})`
      if (top === bottom) {
        assert.equal(glyph, " ", `${where}: a uniform pair is a bare space`)
        assert.deepEqual(sgr, [top ? "\x1b[48;5;0m" : "\x1b[48;5;15m"], `${where}: painted as background alone`)
      } else {
        assert.equal(glyph, top ? "▀" : "▄", `${where}: the half block names the dark module`)
        assert.deepEqual(sgr, ["\x1b[38;5;0m", "\x1b[48;5;15m"], `${where}: dark ink on a light field`)
      }
    }
  }
})

test("a launch-sized code fits an 80x24 terminal", () => {
  // The whole reason for half blocks. If this regresses, the QR silently stops being scannable because
  // the terminal wraps it — which looks like a rendering bug and is actually a sizing one.
  const width = qrWidth(SAMPLE)
  assert.ok(width <= 80, `QR is ${width} columns, wider than an 80-column terminal`)
  assert.ok(renderQrLines(SAMPLE).length <= 24, "QR is taller than a 24-row terminal")
})

test("rendering refuses an empty value rather than emitting an unscannable box", () => {
  assert.throws(() => renderQr(""), /requires a value/)
})

test("the rendered code decodes back to its URL through a real QR decoder", () => {
  // Every other test here checks the matrix against the encoder that produced it, which cannot catch a
  // whole-code mistake both sides agree on. This one rebuilds pixels from the RENDERED GLYPHS and hands
  // them to an independent decoder — the closest thing to pointing a phone at the terminal.
  const require_ = createRequire(import.meta.url)
  const jsQR = require_("jsqr") as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null

  const lines = renderQrLines(SAMPLE, { plain: true })
  const size = lines[0]!.length
  const scale = 4
  const width = size * scale
  const height = size * scale
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const glyph = lines[Math.floor(y / 2)]![x]!
      const dark = y % 2 === 0 ? glyph === "#" || glyph === "^" : glyph === "#" || glyph === "v"
      const value = dark ? 0 : 255
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = ((y * scale + dy) * width + (x * scale + dx)) * 4
          pixels[at] = pixels[at + 1] = pixels[at + 2] = value
          pixels[at + 3] = 255
        }
      }
    }
  }
  assert.equal(jsQR(pixels, width, height)?.data, SAMPLE)
})
