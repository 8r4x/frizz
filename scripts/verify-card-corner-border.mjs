// THE QUEUE CARD'S BORDER MUST SURVIVE ITS OWN BOTTOM CORNERS.
//
// A card shell rounds at `--block-radius` and draws a 1px border, so what its children meet is the
// PADDING box — one pixel tighter than the shell's own arc. A child laid flush against that edge with
// a SQUARER corner juts out through it, and because an in-flow child's background paints after its
// parent's border (CSS 2.1 painting order: the parent's border is step 2, descendant backgrounds are
// step 4), it erases the border precisely where the corner turns.
//
// That is what the lifecycle footer did. It carried a literal `rounded-b-[7px]` from when the shell
// was 8px; at 12px the left border ran down, dissolved through the bottom-left arc and picked back up
// along the bottom edge, leaving a soft notch on the corner of every cue card (maintainer 2026-08-01).
// Its `backdrop-blur` widened the damage by smearing the border it was already covering.
//
// It has to be a PIXEL measurement. Every DOM number was innocent: the root reported a 12px radius, a
// 1px border and the right color, the footer reported its own box inset by exactly 1px on three sides.
// Nothing in the geometry says one shape is painting over the other's border. Only the rendered pixels
// on the arc do.
//
// Method: sample the border's CENTERLINE arc (radius = R - borderWidth/2, centred R in from the
// corner) at every few degrees across each quadrant, and read how far each sample's color sits from
// the card's own fill. A drawn border is ~100 channel-sum away from the panel behind it; an erased one
// collapses to the fill and reads ~0. The TOP corners are measured in the same run as a live control —
// they were never broken, so a run where they fail is an instrument fault, not a regression.
//
// The negative control is the point of the whole script: it re-runs the identical probe with the
// footer forced back to 7px and REQUIRES the bottom corners to fail. A corner probe that cannot fail
// on the actual bug is not evidence, and this one caught its own tolerance being too loose.
//
// Usage (serve the fixtures first: `cd packages/web && nubx vite --port 5412 --strictPort`):
//   nub scripts/verify-card-corner-border.mjs --url=http://localhost:5412/queue-ops-spacing-fixture.html
const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url", "http://localhost:5412/queue-ops-spacing-fixture.html")
// High enough that a 1px border is 8 device px, so a centreline sample lands well inside it and no
// reading is antialiasing noise.
const DSF = Number(opt("dsf", "8"))
// A drawn border sits ~100 channel-sum off the panel fill it covers. Half of that is comfortably
// above antialiasing on the arc and far above the ~0 an erased corner reports.
const MIN_CONTRAST = Number(opt("min-contrast", "50"))

const CORNERS = [
  { name: "top-left", cx: (r, R) => r.left + R, cy: (r, R) => r.top + R, from: 180, to: 270 },
  { name: "top-right", cx: (r, R) => r.right - R, cy: (r, R) => r.top + R, from: 270, to: 360 },
  { name: "bottom-right", cx: (r, R) => r.right - R, cy: (r, R) => r.bottom - R, from: 0, to: 90 },
  { name: "bottom-left", cx: (r, R) => r.left + R, cy: (r, R) => r.bottom - R, from: 90, to: 180 },
]

const { default: puppeteer } = await import("puppeteer")
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
const failures = []
try {
  const page = await browser.newPage()
  const pageErrors = []
  const isFaviconNoise = (t) => /favicon\.ico/.test(t) || /404 \(Not Found\)/.test(t)
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error" && !isFaviconNoise(m.text())) pageErrors.push(m.text()) })
  // Tall enough for the whole card, so nothing scrolls: a clip is taken in viewport coordinates and an
  // element that is not fully in view screenshots unreliably.
  await page.setViewport({ width: 1100, height: 1600, deviceScaleFactor: DSF })
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 })
  await page.waitForSelector("[data-thread-lifecycle-footer]", { timeout: 20_000 })

  // One probe run = "measure all four corners at the footer's current radius". Called twice: once as
  // shipped, once with the pre-fix radius forced back on.
  async function probe() {
    const shell = await page.evaluate(() => {
      const root = document.querySelector("[data-queue-card-root]")
      const footer = document.querySelector("[data-thread-lifecycle-footer]")
      const cs = getComputedStyle(root)
      const r = root.getBoundingClientRect()
      return {
        radius: parseFloat(cs.borderBottomLeftRadius),
        border: parseFloat(cs.borderBottomWidth),
        fill: cs.backgroundColor,
        footerRadius: parseFloat(getComputedStyle(footer).borderBottomLeftRadius),
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      }
    })
    const rows = []
    for (const corner of CORNERS) {
      const R = shell.radius
      const cx = corner.cx(shell.rect, R)
      const cy = corner.cy(shell.rect, R)
      // Clip the arc's WHOLE circle plus a margin — one square that contains every quadrant, so the
      // same math serves all four corners and no sample can fall outside the image and be skipped.
      const pad = 6
      const x0 = cx - R - pad
      const y0 = cy - R - pad
      const size = R * 2 + pad * 2
      const b64 = await page.screenshot({
        clip: { x: x0, y: y0, width: size, height: size },
        encoding: "base64",
      })
      const read = await page.evaluate(async (data, args) => {
        const img = new Image()
        img.src = "data:image/png;base64," + data
        await img.decode()
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext("2d", { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]] }
        // The card's own fill, READ rather than assumed: the arc's centre is R in from both edges, so
        // it is always interior, and it picks up whatever tint the header or footer lays over the
        // panel there — which is exactly the color an erased border collapses into.
        const fillPx = at(Math.round((args.cx - args.x0) * args.dsf), Math.round((args.cy - args.y0) * args.dsf))
        const dist = (p) => Math.abs(p[0] - fillPx[0]) + Math.abs(p[1] - fillPx[1]) + Math.abs(p[2] - fillPx[2])
        // The border's CENTRELINE, not its outer edge: half a border in from the shell's arc.
        const rr = args.R - args.border / 2
        const out = []
        for (let deg = args.from; deg <= args.to; deg += 3) {
          const rad = (deg * Math.PI) / 180
          const px = Math.round((args.cx + rr * Math.cos(rad) - args.x0) * args.dsf)
          const py = Math.round((args.cy + rr * Math.sin(rad) - args.y0) * args.dsf)
          if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue
          out.push({ deg, contrast: dist(at(px, py)) })
        }
        return out
      }, b64, { R, border: shell.border, cx, cy, x0, y0, dsf: DSF, from: corner.from, to: corner.to })
      if (!read.length) throw new Error(`${corner.name}: no samples landed inside the clip`)
      const worst = read.reduce((a, b) => (b.contrast < a.contrast ? b : a))
      rows.push({ corner: corner.name, samples: read.length, minContrast: worst.contrast, atDeg: worst.deg })
    }
    return { shell, rows }
  }

  const shipped = await probe()
  console.log(`shell radius ${shipped.shell.radius}px / border ${shipped.shell.border}px → inner ${shipped.shell.radius - shipped.shell.border}px`)
  console.log(`footer bottom radius: ${shipped.shell.footerRadius}px`)
  for (const row of shipped.rows) {
    const ok = row.minContrast >= MIN_CONTRAST
    console.log(`${ok ? "PASS" : "FAIL"} ${row.corner}: border visible at every one of ${row.samples} samples (weakest ${row.minContrast} at ${row.atDeg}°)`)
    if (!ok) failures.push(`${row.corner}: border vanishes on the arc (contrast ${row.minContrast} at ${row.atDeg}°, need ≥ ${MIN_CONTRAST})`)
  }
  if (shipped.shell.footerRadius !== shipped.shell.radius - shipped.shell.border) {
    failures.push(`footer bottom radius is ${shipped.shell.footerRadius}px; the shell's padding box is ${shipped.shell.radius - shipped.shell.border}px`)
    console.log(`FAIL footer radius ${shipped.shell.footerRadius}px ≠ shell inner ${shipped.shell.radius - shipped.shell.border}px`)
  } else {
    console.log(`PASS footer bottom radius matches the shell's padding box`)
  }

  // NEGATIVE CONTROL — put the bug back and require the probe to catch it. Without this the run above
  // proves only that the script does not crash.
  const revert = await page.addStyleTag({ content: "[data-thread-lifecycle-footer]{border-bottom-left-radius:7px;border-bottom-right-radius:7px}" })
  const broken = await probe()
  // Hold the HANDLE and remove that: sweeping <style> tags by content would take out Vite's injected
  // app stylesheet and every measurement after it.
  await revert.evaluate((el) => el.remove())
  for (const row of broken.rows) {
    const isBottom = row.corner.startsWith("bottom")
    const caught = row.minContrast < MIN_CONTRAST
    if (isBottom && !caught) {
      failures.push(`negative control: ${row.corner} still reads clean at the pre-fix 7px radius (contrast ${row.minContrast}) — the probe cannot see the bug it exists to catch`)
      console.log(`FAIL control ${row.corner}: probe blind to the 7px regression (weakest ${row.minContrast})`)
    } else if (!isBottom && caught) {
      failures.push(`negative control: ${row.corner} broke when only the footer changed — the probe is reading the wrong thing`)
      console.log(`FAIL control ${row.corner}: unrelated corner moved (weakest ${row.minContrast})`)
    } else {
      console.log(`PASS control ${row.corner}: ${isBottom ? `regression caught (weakest ${row.minContrast})` : `unaffected (weakest ${row.minContrast})`}`)
    }
  }

  if (pageErrors.length) {
    failures.push(`page errors: ${pageErrors.join(" | ")}`)
    console.log("FAIL page errors:\n" + pageErrors.join("\n"))
  }
} finally {
  await browser.close()
}

if (failures.length) {
  console.error("\n" + failures.map((f) => `✗ ${f}`).join("\n"))
  process.exit(1)
}
console.log("\nall corner-border checks passed")
