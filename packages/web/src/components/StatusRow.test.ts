import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot } from "@frizz/shared"
import { StatusRow } from "./StatusRow.tsx"
import { store, type ConnectionState } from "../store.ts"

// The row's SHAPE is a spec, not an accident: identity at the left edge, then settings → reload →
// Claude → Codex pushed to the right. It has been three separate pieces of chrome in three places
// (identity top-left, settings/reload top-right, quota floating over the sidebar composer) and then
// one fixed corner chip, so a regression here is a silent return to that scatter rather than a
// visible break.
function render(
  label: string | null = "colinhacks/frizz",
  options: { rail?: boolean; connection?: ConnectionState } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The rail's visibility is a SETTING, read through the same query the component reads, so seeding
  // the cache is how a static render reaches the shown state at all.
  if (options.rail !== undefined) client.setQueryData(["settingsGet"], { projectRail: options.rail })
  // StatusRow reads identity and connection off the store rather than taking them as props, so the
  // store IS the fixture here.
  store.board = (label === null ? null : { projectLabel: label, threads: [], plans: [] }) as unknown as BoardSnapshot
  store.connection = options.connection ?? "open"
  store.socketBoardFallback = null
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(StatusRow, null)),
  )
}

test("the row splits: identity at the left edge, actions and quota at the right", () => {
  const html = render()

  const identity = html.indexOf('data-project-identity-state="verified"')
  const settings = html.indexOf('aria-label="Settings"')
  const quota = html.indexOf("data-quota-bar")

  assert.ok(identity >= 0 && settings >= 0 && quota >= 0, "every segment renders")
  assert.ok(identity < settings, "the repo slug leads")
  assert.ok(settings < quota, "the quota chips are the tail of the row")
  // `ml-auto` on the trailing group IS the split. Without it every mark packs left and the right half
  // of a 490px column is dead space.
  assert.match(html, /class="ml-auto flex shrink-0 items-center gap-3"/)
})

test("the row is LOOSE on the page — no fill, no border, no shadow, nothing fixed", () => {
  const html = render()

  assert.match(html, /data-status-row/)
  // It was a fixed, opaque, shadowed chip in the page's top-left corner until 2026-08-19, because a
  // full sidebar or a scrolling narrow rail would paint through it. In the column there is nothing to
  // pass behind it, and a surface here would read as a second box stacked on the prompt box.
  assert.match(html, /class="mb-2\.5 flex min-w-0 items-center gap-3 text-\[12px\]"/)
  for (const gone of [/\bfixed\b/, /\bz-20\b/, /bg-panel/, /shadow-sm/, /rounded-lg border border-border/]) {
    assert.doesNotMatch(html, gone)
  }
})

test("a healthy connection paints NO indicator, and a degraded one still does", () => {
  // The green dot and the word "connected" said the same thing every second of every session
  // (maintainer 2026-08-19: "drop the connected indicator, certainly. It's pretty useless"). What is
  // NOT dropped is the degraded reading — a silently frozen board is the failure it exists to catch.
  const healthy = render("colinhacks/frizz", { connection: "open" })
  assert.doesNotMatch(healthy, />connected</)
  // The state still reaches assistive technology in every case.
  assert.match(healthy, /aria-label="Project: colinhacks\/frizz; connected"/)

  assert.match(render("colinhacks/frizz", { connection: "connecting" }), />connecting…</)
  assert.match(render("colinhacks/frizz", { connection: "closed" }), />disconnected</)
})

test("the row's gap is 12px of INK: one flex gap, and every icon square trimmed onto its glyph", () => {
  const html = render()

  // The pair is the whole point and neither half works alone. `gap-3` without the trims puts 20px of
  // ink between the gear and the reload icon and 8px beside the quota chips (measured 2026-08-14 with
  // scripts/ink-gaps.mjs — the readings are in StatusRow.tsx); the trims without a matching gap pull
  // the icons on top of each other. Both buttons take theirs from STATUS_ROW_ACTION, so a new row
  // action inherits the rhythm instead of re-deriving it — and a glyph that paints something other
  // than 12px needs a fresh measurement, not this class.
  assert.match(html, /class="-mx-1\.5 inline-flex h-6 w-6/)
  // The quota chips are IN this row, so they keep the row's distance rather than one of their own.
  assert.match(html, /data-quota-bar="true" class="flex shrink-0 items-center gap-3/)
})

test("the quota percentages read a size smaller than the row they sit in", () => {
  const html = render()

  // 9px, down from 11px (maintainer 2026-08-19: "the actual text of the percentage numbers should be
  // small"). It is on the chips' WRAPPER so the em dash and the loading placeholder inherit it too — a
  // size that reached only the percentage would resize the chip as its state changed.
  assert.match(html, /data-quota-bar="true" class="[^"]*text-\[9px\]/)
})

test("a cold identity still reserves its measure without collapsing the row", () => {
  const html = render(null, { connection: "connecting" })

  assert.match(html, /identity-placeholder/)
  assert.match(html, /aria-label="Settings"/)
  assert.match(html, /data-quota-bar/)
})
