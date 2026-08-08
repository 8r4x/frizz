import { closeSync, openSync, readSync, statSync } from "node:fs"
import { extname } from "node:path"

// HOW BIG IS THIS IMAGE, from its header alone.
//
// The icon scan (project-icon.ts) has to compare a 16×16 `favicon.ico` against a 512×512
// `apple-touch-icon.png` and against a `logo.svg` that might be a square mark or a wide wordmark, and
// it may look at a few hundred files across forty projects. Decoding them is out of the question, and
// so — for one number per file — is a dependency: the server package has five runtime deps and no
// image code at all, while every format below states its dimensions in the first few dozen bytes.
//
// Deliberately NOT a general image library. It reads exactly what a size comparison needs, returns
// undefined for anything it does not recognise, and never throws: a malformed file is simply a
// candidate the scan cannot rank, not an error the operator should see.

/** As much of the head as any format here needs. JPEG walks segments, so it gets a bigger budget. */
const HEAD_BYTES = 4096
const JPEG_SCAN_BYTES = 128 * 1024

export interface ImageDimensions {
  width: number
  height: number
  /** True for SVG, whose dimensions are a nominal box rather than a pixel count. */
  scalable: boolean
}

function readHead(path: string, budget: number): Buffer | undefined {
  let fd: number | undefined
  try {
    const size = statSync(path).size
    if (size === 0) return undefined
    const buffer = Buffer.alloc(Math.min(size, budget))
    fd = openSync(path, "r")
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return read === buffer.length ? buffer : buffer.subarray(0, read)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
  }
}

function png(head: Buffer): ImageDimensions | undefined {
  // \x89PNG\r\n\x1a\n, then an IHDR chunk whose payload opens with two big-endian uint32s.
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a) return undefined
  if (head.toString("ascii", 12, 16) !== "IHDR") return undefined
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), scalable: false }
}

function gif(head: Buffer): ImageDimensions | undefined {
  if (head.length < 10) return undefined
  const magic = head.toString("ascii", 0, 6)
  if (magic !== "GIF87a" && magic !== "GIF89a") return undefined
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8), scalable: false }
}

/**
 * WebP is three formats behind one RIFF wrapper, and each states its size differently.
 *
 * `VP8 ` is lossy (14-bit fields after a 3-byte start code), `VP8L` is lossless (two 14-bit fields
 * packed into one little-endian uint32, both stored one less than the real value), and `VP8X` is the
 * extended container used whenever there is an alpha channel or animation — which is most icons — and
 * stores 24-bit minus-one values. Reading only the first would silently miss the common case.
 */
function webp(head: Buffer): ImageDimensions | undefined {
  if (head.length < 30) return undefined
  if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WEBP") return undefined
  const chunk = head.toString("ascii", 12, 16)
  if (chunk === "VP8 ") {
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff, scalable: false }
  }
  if (chunk === "VP8L") {
    const bits = head.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, scalable: false }
  }
  if (chunk === "VP8X") {
    const read24 = (at: number) => head[at]! | (head[at + 1]! << 8) | (head[at + 2]! << 16)
    return { width: read24(24) + 1, height: read24(27) + 1, scalable: false }
  }
  return undefined
}

/**
 * An ICO is a CONTAINER, and the entry that matters is the largest one.
 *
 * `favicon.ico` is routinely 16/32/48 in one file, so reading the first entry would rank every
 * multi-resolution favicon at 16px and throw away the 48px image the scan actually wants. A zero in
 * the width or height byte means 256 — the field is one byte and 256 does not fit.
 */
function ico(head: Buffer): ImageDimensions | undefined {
  if (head.length < 22 || head.readUInt16LE(0) !== 0 || head.readUInt16LE(2) !== 1) return undefined
  const count = head.readUInt16LE(4)
  if (count === 0) return undefined
  let best: ImageDimensions | undefined
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    if (at + 16 > head.length) break
    const width = head[at] === 0 ? 256 : head[at]!
    const height = head[at + 1] === 0 ? 256 : head[at + 1]!
    if (!best || width * height > best.width * best.height) best = { width, height, scalable: false }
  }
  return best
}

/** Walk JPEG segments to the first start-of-frame, which is the only place the size is stated. */
function jpeg(head: Buffer): ImageDimensions | undefined {
  if (head.length < 4 || head.readUInt16BE(0) !== 0xffd8) return undefined
  let at = 2
  while (at + 1 < head.length) {
    if (head[at] !== 0xff) { at++; continue }
    const marker = head[at + 1]!
    // Standalone markers carry no length; skip them rather than reading the next two bytes as one.
    if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { at += 2; continue }
    if (at + 3 >= head.length) return undefined
    // SOF0..SOF15, minus the three that are not frame headers (DHT, JPG, DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // The frame header's last byte is at+8, so the segment must be fully present. `< length` here
      // rather than `<=` cost a real miss: a JPEG whose start-of-frame landed exactly at the end of
      // the read budget measured as undefined.
      if (at + 9 > head.length) return undefined
      return { width: head.readUInt16BE(at + 7), height: head.readUInt16BE(at + 5), scalable: false }
    }
    const length = head.readUInt16BE(at + 2)
    if (length < 2) return undefined
    at += 2 + length
  }
  return undefined
}

const SVG_TAG = /<svg\b[^>]*>/iu
const SVG_ATTRIBUTE = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "iu")

/** A length with a CSS unit, as an SVG attribute writes it. `%` is refused — it sizes nothing. */
function svgLength(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|mm|cm|in|em|rem)?\s*$/iu.exec(raw)
  const value = match ? Number(match[1]) : NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * An SVG's nominal box, from `width`/`height` if it states them and `viewBox` otherwise.
 *
 * The viewBox fallback is not a nicety: an SVG written for inline use routinely omits width/height
 * (or sets them to 100%) so it inherits its container, and every one of those would otherwise be
 * unrankable — which in this scan means a project's best possible icon, a scalable mark, losing to a
 * 32px PNG. The box is what tells a square logomark from a wide wordmark, and that is the whole
 * reason the scan measures SVGs at all.
 */
function svg(head: Buffer): ImageDimensions | undefined {
  const tag = SVG_TAG.exec(head.toString("utf8"))?.[0]
  if (!tag) return undefined
  const width = svgLength(SVG_ATTRIBUTE("width").exec(tag)?.[1])
  const height = svgLength(SVG_ATTRIBUTE("height").exec(tag)?.[1])
  if (width !== undefined && height !== undefined) return { width, height, scalable: true }
  const box = SVG_ATTRIBUTE("viewBox").exec(tag)?.[1]?.trim().split(/[\s,]+/u)
  if (box?.length === 4) {
    const w = Number(box[2])
    const h = Number(box[3])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h, scalable: true }
  }
  return undefined
}

/**
 * Colour keywords that carry no colour: an SVG painted only in these is monochrome by construction.
 *
 * `currentColor` is the giveaway — it means "whatever the surrounding text colour is", which through
 * an `<img>` (no CSS inheritance) resolves to plain black.
 */
const COLOURLESS = /^(none|transparent|currentcolor|inherit|#000|#000000|black|#fff|#ffffff|white)$/iu

const PAINT_ATTRIBUTE = /(?:\bfill|\bstroke|\bstop-color|\bflood-color|\blighting-color)\s*[=:]\s*["']?\s*([^"';>\s]+)/giu

/**
 * Does this SVG paint a colour OF ITS OWN?
 *
 * The question separates a BRAND LOGO from a GLYPH, and the two want opposite treatment on an icon
 * rail. A glyph — the Simple Icons shape, `role="img"` with a 24×24 viewBox and a single `<path>`
 * carrying no `fill` at all — is designed to inherit its colour from CSS. Rendered through an `<img>`
 * there is nothing to inherit, so it paints SOLID BLACK, which on a dark rail is a black square.
 *
 * Measured on bun (2026-08-08): `site/public/icon.svg` declares no colour anywhere and drew as a
 * black tile, while `logo.svg` beside it carries the six brand colours and is the logo a person means.
 * Both scored 76 and the tie went alphabetically to the glyph.
 *
 * Deliberately conservative: ANY single genuine colour anywhere — a fill, a stroke, a gradient stop —
 * counts. A one-colour brand mark is still a brand mark; what this catches is the file that specifies
 * no colour at all, or only black and white.
 *
 * Undefined for anything that is not an SVG, and for an SVG we could not read: absence of evidence,
 * not evidence of absence, so the caller must not treat it as monochrome.
 */
export function svgDeclaresColour(path: string): boolean | undefined {
  if (extname(path).toLowerCase() !== ".svg") return undefined
  // The whole file, not just a header: a gradient definition can sit anywhere, and an SVG small
  // enough to be an icon is small enough to read. Capped so a pathological one cannot hurt.
  const head = readHead(path, 512 * 1024)
  if (!head) return undefined
  const source = head.toString("utf8")
  if (!/<svg\b/iu.test(source)) return undefined
  for (const match of source.matchAll(PAINT_ATTRIBUTE)) {
    const value = match[1]!.trim().replace(/[,)]+$/u, "")
    if (!COLOURLESS.test(value) && !value.startsWith("url(")) return true
  }
  // A gradient referenced by url(#…) is only colour if one of its stops is; those stops are
  // `stop-color` attributes and were already covered by the loop above.
  return false
}

/** Every extension `imageDimensions` can measure. */
export const MEASURABLE_IMAGE_EXTENSIONS = new Set([".png", ".svg", ".ico", ".webp", ".jpg", ".jpeg", ".gif"])

/**
 * The image's dimensions, read from its header — or undefined if the file is not one we can measure.
 *
 * Dispatches on the MAGIC BYTES, not the extension: `.ico` files that are really PNGs are common
 * enough (every "convert my png to ico" site produces them) that trusting the name would misreport
 * them. The extension only chooses how much of the file to read.
 */
export function imageDimensions(path: string): ImageDimensions | undefined {
  const extension = extname(path).toLowerCase()
  const budget = extension === ".jpg" || extension === ".jpeg" ? JPEG_SCAN_BYTES : HEAD_BYTES
  const head = readHead(path, budget)
  if (!head) return undefined
  return png(head) ?? gif(head) ?? webp(head) ?? ico(head) ?? jpeg(head) ?? svg(head)
}
