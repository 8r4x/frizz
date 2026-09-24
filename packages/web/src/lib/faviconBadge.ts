// THE TAB'S OWN REST MARK: a dot on the favicon of a /full tab whose thread is in the queue (maintainer
// 2026-09-19: "a little indicator should pop up in the favicon when a full-screen view tab is at
// rest"). Several /full tabs are usually open on one repo at once and a tab strip shows a favicon and
// a few characters of title, so the favicon is the only place a background tab can say "this one is
// waiting on you" without being opened.
//
// DRAWN, NOT SHIPPED. The badged icon is the real favicon rasterized onto a canvas with the dot
// composited over it, so there is no second copy of the art to regenerate when the logo changes (the
// index.html `?v=` bump is the whole procedure, and this reads the href that bump produced). An SVG
// that wraps the favicon in an <image> is not an option: an SVG loaded AS an image fetches no
// external resources.

// 64px is 4x a tab's 16 CSS px, so the raster survives a dsf-2 tab strip and the pinned-tab size
// without the browser upscaling it.
const SIZE = 64
// The dot's geometry in that 64px space. At a tab's 16px: a 6px dot inside a 1px clear ring, which is
// what separates it from the tile on ANY tab-strip colour — the ring is punched out to transparency
// rather than painted, because the strip behind it is the browser theme's and cannot be known.
const DOT_RADIUS = 12
const RING = 4
// TOP RIGHT (maintainer 2026-09-19: "I feel like it should be in the top right") — where a notification
// badge sits on every icon the eye already knows. The mark has 180-degree rotational symmetry, so no
// corner covers less ink than another and the choice is convention alone. Inset so the ring's outer
// edge lands exactly on the canvas edge instead of being clipped flat.
const DOT_X = SIZE - DOT_RADIUS - RING
const DOT_Y = DOT_RADIUS + RING
// NOT the accent, though the accent is what says "attention" everywhere else. The mark itself is drawn
// in the accent's gold, so at 16px a gold dot reads as one more loop of the logo; the badge has to
// differ from the art in HUE to register as a badge at all. Compared at tab size on Chrome's four
// stock strip colours (favicon-badge-fixture.html): gold merged into the mark, --color-fg vanished on
// the light strips, red read as an error. This is the palette's azure (--color-shell), borrowed for
// its hue alone — a canvas cannot resolve a CSS variable, and a tab strip has no shell vocabulary.
const DOT_COLOR = "#4a9eff"

type IconLink = { link: HTMLLinkElement; href: string; type: string | null; sizes: string | null }

// The document's own icon links as index.html declared them, captured once — restoring means putting
// these exact attributes back, including the `?v=` cache-buster.
let originals: IconLink[] | undefined
let badged: Promise<string> | undefined
// What the caller last asked for. The raster is async, so a rest→working flip inside that window must
// not be overwritten by the late-arriving badge.
let wanted = false

function iconLinks(): IconLink[] {
  // `~=` matches the `icon` TOKEN, so `apple-touch-icon` (a different token) is left alone: it is the
  // home-screen art, not the tab's.
  originals ??= [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map((link) => ({
    link,
    href: link.getAttribute("href") ?? "",
    type: link.getAttribute("type"),
    sizes: link.getAttribute("sizes"),
  }))
  return originals
}

export function drawBadgedIcon(base: CanvasImageSource): string {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = SIZE
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(base, 0, 0, SIZE, SIZE)
  ctx.globalCompositeOperation = "destination-out"
  ctx.beginPath()
  ctx.arc(DOT_X, DOT_Y, DOT_RADIUS + RING, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = "source-over"
  ctx.fillStyle = DOT_COLOR
  ctx.beginPath()
  ctx.arc(DOT_X, DOT_Y, DOT_RADIUS, 0, Math.PI * 2)
  ctx.fill()
  return canvas.toDataURL("image/png")
}

function badgedIcon(links: readonly IconLink[]): Promise<string> {
  badged ??= new Promise<string>((resolve, reject) => {
    // The SVG is the sharpest source at any raster size; the PNG fallbacks are 16/32px.
    const source = links.find((l) => l.type === "image/svg+xml") ?? links[0]
    if (!source) return reject(new Error("no favicon link"))
    const img = new Image()
    img.onload = () => resolve(drawBadgedIcon(img))
    img.onerror = () => reject(new Error("favicon did not load"))
    img.src = source.href
  })
  return badged
}

/**
 * Show or clear the rest dot on this tab's favicon. Idempotent, and safe to call before the icon has
 * loaded. EVERY icon link is repointed rather than just the preferred one: a browser picks among
 * several `rel="icon"` candidates by its own rules, and leaving the unbadged PNGs declared lets it
 * pick one of those.
 */
export function setFaviconBadge(on: boolean): void {
  wanted = on
  const links = iconLinks()
  if (!on) {
    for (const { link, href, type, sizes } of links) {
      link.href = href
      if (type === null) link.removeAttribute("type"); else link.type = type
      if (sizes === null) link.removeAttribute("sizes"); else link.setAttribute("sizes", sizes)
    }
    return
  }
  badgedIcon(links).then((url) => {
    if (!wanted) return
    for (const { link } of links) {
      link.type = "image/png"
      link.removeAttribute("sizes")
      link.href = url
    }
  }).catch(() => {
    // No icon to draw on (a bare fixture page, a blocked image): the tab keeps its plain favicon.
    badged = undefined
  })
}
