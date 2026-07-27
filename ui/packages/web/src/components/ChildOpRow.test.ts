import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ChildOpRow, type ChildOpDensity, type ChildOpKind } from "./ChildOpRow.tsx"
import { CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_STALE_DOT_CLASS, CHILD_STALE_TITLE } from "../lib/childOps.ts"

// The whole point of this component is that four surfaces stopped drawing their own version of one row.
// So the tests that matter are the CROSS-DENSITY ones: the arrow markup, the stale dot and the id-less
// policy must be byte-identical everywhere, while the deliberate density differences stay put.

const DENSITIES: ChildOpDensity[] = ["rail", "card", "sheet"]
const TWELVE_MIN_AGO = new Date(Date.now() - 12 * 60_000).toISOString()

function render(props: {
  kind?: ChildOpKind
  label?: string
  state?: "running" | "stale"
  density: ChildOpDensity
  lastActivityAt?: string
  parentSlug?: string
  onOpen?: () => void
  onDismiss?: () => void
  title?: string
}): string {
  return renderToStaticMarkup(createElement(ChildOpRow, {
    kind: props.kind ?? "AGENT",
    label: props.label ?? "Audit the drawer ops strip",
    state: props.state ?? "running",
    lastActivityAt: props.lastActivityAt,
    ...props,
  }))
}

const ARROW_SPAN = `<span aria-hidden="true" class="${CHILD_ARROW_CLASS}">${CHILD_ARROW}</span>`

test("every density renders the identical arrow span — one glyph, one alpha, one size", () => {
  for (const density of DENSITIES) {
    for (const state of ["running", "stale"] as const) {
      const html = render({ density, state })
      assert.ok(html.includes(ARROW_SPAN), `${density}/${state} must render the shared arrow span verbatim`)
      assert.equal(html.split(CHILD_ARROW).length - 1, 1, `${density}/${state} must render exactly one arrow`)
    }
  }
})

test("every density renders the identical stale dot for a quiet sub-agent", () => {
  const dot = `<span class="${CHILD_STALE_DOT_CLASS}" title="${CHILD_STALE_TITLE}"></span>`
  for (const density of DENSITIES) {
    assert.ok(render({ density, state: "stale" }).includes(dot), `${density} must render the shared stale dot`)
  }
})

test("an id-less child is a NON-INTERACTIVE row on every density — never disabled, never dropped", () => {
  for (const density of DENSITIES) {
    const html = render({ density })
    assert.doesNotMatch(html, /<button/, `${density} without onOpen must not render a button`)
    assert.doesNotMatch(html, /disabled/, `${density} without onOpen must not render a disabled control`)
    assert.match(html, /Audit the drawer ops strip/, `${density} without onOpen must still render the row`)
  }
})

test("a child with a drill-in is a real button carrying the open title and label", () => {
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {} })
    assert.match(html, /<button/)
    assert.match(html, /aria-label="Open sub-agent transcript: Audit the drawer ops strip"/)
  }
  assert.match(render({ density: "sheet", kind: "SHELL", onOpen: () => {} }), /aria-label="Open background shell output: Audit the drawer ops strip"/)
})

test("the rail keeps its checkbox spinner, its indent and its tooltip override", () => {
  const running = render({ density: "rail", onOpen: () => {}, parentSlug: "parent-thread", title: "[fray:opus-high] Audit the drawer ops strip" })
  assert.match(running, /<svg /, "a running rail row uses the BoxSpinner, never the pulsing dot")
  assert.match(running, /pl-\[26px\]/)
  assert.match(running, /title="\[fray:opus-high\] Audit the drawer ops strip"/)
  assert.match(running, /data-subagent-parent="parent-thread"/)
  // The rail is not an operations surface: no kind tag, no drill-in arrow.
  assert.doesNotMatch(running, /petite-caps/)
})

test("the card keeps the pulsing queue indicator and stays free of ops chrome", () => {
  const html = render({ density: "card", onOpen: () => {}, parentSlug: "parent-thread", lastActivityAt: TWELVE_MIN_AGO })
  assert.match(html, /data-running-indicator="queue-subagent"/)
  assert.match(html, /fray-live-dot--agent/)
  assert.match(html, /data-subagent-parent="parent-thread"/)
  assert.doesNotMatch(html, /petite-caps/, "a queue card names the work, it is not a second ops toolbar")
  assert.doesNotMatch(html, /<svg /, "the card must not borrow the rail's checkbox spinner")
})

test("the sheet is the operations row: kind tag, and NO second drill-in glyph beside the title", () => {
  const html = render({ density: "sheet", onOpen: () => {}, lastActivityAt: TWELVE_MIN_AGO })
  assert.match(html, /data-running-indicator="operation"/)
  assert.match(html, /petite-caps[^"]*">AGENT</)
  // The ↗ hover glyph was deleted (maintainer 2026-07-27): the drill-in affordance is the TITLE, which
  // underlines on hover and IS the button, so the only icon a clickable ops row may draw is the ×.
  assert.doesNotMatch(html, /<svg /, "a clickable ops row draws no icon of its own")
  assert.match(render({ density: "sheet", onOpen: () => {}, onDismiss: () => {} }), /<svg /, "…the × is the one exception")
})

test("no density renders a model+effort tag — the profile lives on the prompt box's own control", () => {
  // Deleted 2026-07-27 (maintainer). ChildOpRow no longer even accepts `subagentType`; this pins that
  // no bracketed profile reading crept back in through the label or a tooltip.
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {}, onDismiss: density === "sheet" ? () => {} : undefined })
    assert.doesNotMatch(html, /data-agent-profile/, density)
    assert.doesNotMatch(html, /›/, `${density} must not render the model › effort separator`)
  }
})

test("the last-active reading is right-justified on every density", () => {
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {}, lastActivityAt: TWELVE_MIN_AGO })
    assert.match(html, /class="ml-auto[^"]*"[^>]*>12 min ago</, `${density} pushes the reading to the right edge`)
  }
})

test("the light-gray last-active reading renders on every density, and only when reported", () => {
  for (const density of DENSITIES) {
    const withReading = render({ density, lastActivityAt: TWELVE_MIN_AGO })
    // "12 min ago" — the recency the running/stale mark alone can't give — in the muted reading tone.
    assert.match(withReading, /12 min ago/, `${density} must render the last-active reading`)
    assert.match(withReading, /text-muted\/40[^>]*>12 min ago</, `${density} reading must be the light-gray tone`)
    assert.match(withReading, /title="Last active 12 min ago"/, `${density} reading carries the explicit tooltip`)
    // A child that reports no activity instant gets NO reading — never a fabricated "just now".
    assert.doesNotMatch(render({ density }), /min ago|just now/, `${density} must omit the reading when absent`)
  }
})

test("a quiet SHELL breathes instead of going flat, on the ops row", () => {
  const html = render({ density: "sheet", kind: "SHELL", state: "stale" })
  assert.match(html, /data-running-indicator="operation-quiet"/)
  assert.match(html, /title="running — no recent output"/)
  assert.doesNotMatch(html, new RegExp(CHILD_STALE_TITLE))
  assert.match(render({ density: "sheet", kind: "SHELL", state: "running" }), /fray-live-dot--shell/)
})

test("the dismiss × exists only when onDismiss is supplied, and sits directly after the title", () => {
  const withX = render({ density: "sheet", onOpen: () => {}, onDismiss: () => {}, lastActivityAt: TWELVE_MIN_AGO })
  assert.match(withX, /data-op-row/)
  assert.match(withX, /aria-label="Dismiss sub-agent: Audit the drawer ops strip"/)
  assert.match(withX, /title="Dismiss — stop tracking this finished operation"/)
  assert.match(render({ density: "sheet", kind: "SHELL", onDismiss: () => {} }), /aria-label="Dismiss background shell: Audit the drawer ops strip"/)
  // ORDER is the point of the 2026-07-27 move: title → × → recency. At the far right, past the
  // recency, the × read as too subtle to find.
  const order = ["Audit the drawer ops strip", "Dismiss sub-agent", "12 min ago"].map((needle) => withX.indexOf(needle))
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], `title → × → recency, got ${order}`)
  // …and it is visible at rest, not revealed by a hover the reader has to guess at.
  assert.doesNotMatch(withX, /opacity-0/)
  for (const density of DENSITIES) {
    assert.doesNotMatch(render({ density, onOpen: () => {} }), /data-op-row/, `${density} without onDismiss must not render the × wrapper`)
  }
})
