#!/usr/bin/env node
// Count how many times an open path crosses ITSELF.
//
// The mark should have exactly two: one per loop. A loop in a single stroke is
// made by the path passing over its own earlier course, so two loops means two
// crossings. A third is a tail clipping the body, and only one means a loop has
// opened up into a bend.

/** Dense polyline from a chain of G1 cubic anchors. */
export function sampleAnchors(anchors, per = 140) {
  const out = []
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i]
    const b = anchors[i + 1]
    const p0 = [a.x, a.y]
    const p1 = [a.x + Math.cos(a.th) * a.out, a.y + Math.sin(a.th) * a.out]
    const p2 = [b.x - Math.cos(b.th) * b.in, b.y - Math.sin(b.th) * b.in]
    const p3 = [b.x, b.y]
    for (let s = 0; s < per; s += 1) {
      const t = s / per
      const m = 1 - t
      out.push([
        m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0],
        m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1],
      ])
    }
  }
  out.push([anchors[anchors.length - 1].x, anchors[anchors.length - 1].y])
  return out
}

function segIntersect(p, p2, q, q2) {
  const r = [p2[0] - p[0], p2[1] - p[1]]
  const s = [q2[0] - q[0], q2[1] - q[1]]
  const denom = r[0] * s[1] - r[1] * s[0]
  if (Math.abs(denom) < 1e-12) return null
  const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom
  const u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / denom
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null
  return [p[0] + t * r[0], p[1] + t * r[1]]
}

/**
 * Distinct self-crossing points, clustered so one crossing counts once.
 *
 * `gapFraction` skips neighbours as a FRACTION of the path, not as a fixed
 * number of samples. A fixed count silently changes meaning with sampling
 * density: at 176 samples a gap of 40 skips a quarter of the curve and hides
 * real crossings, while at 1540 it skips almost nothing. That mismatch let an
 * optimiser satisfy a "two crossings" constraint checked coarsely and hand back
 * a shape with five.
 */
export function selfCrossings(points, gapFraction = 0.02, cluster = 6) {
  const minGap = Math.max(6, Math.round(points.length * gapFraction))
  const hits = []
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = i + minGap; j < points.length - 1; j += 1) {
      const x = segIntersect(points[i], points[i + 1], points[j], points[j + 1])
      if (x) hits.push(x)
    }
  }
  const groups = []
  for (const h of hits) {
    const g = groups.find((c) => Math.hypot(c[0] - h[0], c[1] - h[1]) < cluster)
    if (g) continue
    groups.push(h)
  }
  return groups
}
