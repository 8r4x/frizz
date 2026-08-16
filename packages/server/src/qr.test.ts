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
  assert.match(rendered, /\x1b\[38;5;0m/, "some cell paints a dark top module")
  assert.match(rendered, /\x1b\[48;5;15m/, "some cell paints a light bottom module")
  assert.ok(rendered.endsWith("\x1b[0m"), "the last row resets, or the terminal keeps the QR's colours")
  for (const line of rendered.split("\n")) assert.ok(line.endsWith("\x1b[0m"), "every row resets")
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
