import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot } from "@frizz/shared"
import { StatusRow } from "./StatusRow.tsx"
import { store, type ConnectionState } from "../store.ts"

// The row's SHAPE is a spec, not an accident: home → settings → reload → quota, left to right and all
// of it left-justified, with the connection dot and the project name pinned to the right edge. It has
// been three separate pieces of chrome in three places (identity top-left, settings/reload top-right,
// quota floating over the sidebar composer), then one fixed corner chip, then the same row running the
// other way — so a regression here is a silent return to one of those rather than a visible break.
function render(
  label: string | null = "colinhacks/frizz",
  options: { connection?: ConnectionState; quota?: boolean } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The quota chips and the gate in front of them read these two cache entries; seeding them is how a
  // static render reaches the shown state at all.
  if (options.quota !== false) {
    client.setQueryData(["quota"], {
      claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
      codex: { status: "ok", planType: "pro", windows: [{ key: "5h", label: "5h", usedPercent: 41 }] },
    })
    client.setQueryData(["authStatus"], { claude: "authed", codex: "authed", emails: {} })
  }
  store.board = (label === null ? null : { projectLabel: label, threads: [] }) as unknown as BoardSnapshot
  store.connection = options.connection ?? "open"
  store.socketBoardFallback = null
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(StatusRow, null)),
  )
}

test("controls run along the left; the project anchors the right", () => {
  const html = render()

  const home = html.indexOf('aria-label="All projects"')
  const settings = html.indexOf('aria-label="Settings"')
  const quota = html.indexOf("data-quota-bar")
  const project = html.indexOf("data-project-identity-state")

  assert.ok(home >= 0 && settings >= 0 && quota >= 0 && project >= 0, "every segment renders")
  assert.ok(home < settings, "the way out of the project leads")
  assert.ok(settings < quota, "the buttons precede the readouts")
  assert.ok(quota < project, "the project is last, at the far edge")
  // `ml-auto` on the identity IS the split. Without it the name packs left with everything else.
  assert.match(html, /class="ml-auto flex min-w-0 items-center gap-1\.5"/)
})

test("TWO dividers: home is a door OUT, settings and reload act on the app you are in", () => {
  const html = render()
  // One divider would group all three as "buttons". The first one is the whole distinction.
  assert.equal(html.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 2)
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

test("the connection is a DOT and nothing else, and it keeps every state's colour", () => {
  // The word "connected" said the same thing every second of every session and is gone (maintainer
  // 2026-08-19: "drop the connected indicator, certainly. It's pretty useless"). The dot stays: it is
  // the entire reading now, so it carries the state in its label as well as its colour.
  const healthy = render("colinhacks/frizz", { connection: "open" })
  assert.doesNotMatch(healthy, />connected</)
  assert.match(healthy, /role="img" aria-label="connected" title="connected"/)
  assert.match(healthy, /bg-live/)

  assert.match(render("colinhacks/frizz", { connection: "connecting" }), /aria-label="connecting…"/)
  assert.match(render("colinhacks/frizz", { connection: "closed" }), /aria-label="disconnected"/)
  assert.match(render("colinhacks/frizz", { connection: "closed" }), /bg-red-500/)
})

test("a repo with no git remote shows its directory name, not the loading skeleton", () => {
  // The bug this fixes: `projectLabel` falls back to the directory basename with no origin remote, the
  // client folded that into "unavailable", and unavailable draws the cold placeholder — forever,
  // because nothing was ever going to resolve (maintainer 2026-08-19: "it just shows a skeleton
  // forever").
  const html = render("scratch-pad")

  assert.match(html, /data-project-identity-state="local"/)
  assert.match(html, />scratch-pad</)
  assert.doesNotMatch(html, /identity-placeholder/)
  assert.doesNotMatch(html, /aria-busy/)
  assert.match(html, /aria-label="Project: scratch-pad; local repository with no git remote"/)
})

test("a cold board still reserves the name's measure, and says it is loading", () => {
  const html = render(null)

  assert.match(html, /data-project-identity-state="loading"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /identity-placeholder/)
  // The controls do not wait on a board — they are reachable from the first paint.
  assert.match(html, /aria-label="Settings"/)
  assert.match(html, /aria-label="All projects"/)
})

test("the row's gap is 12px of INK: one flex gap, and every icon square trimmed onto its glyph", () => {
  const html = render()

  // The pair is the whole point and neither half works alone. `gap-3` without the trims puts 20px of
  // ink between two icon squares and 8px beside the quota chips (measured 2026-08-14 with
  // scripts/ink-gaps.mjs); the trims without a matching gap pull the icons on top of each other. Every
  // button takes its trim from STATUS_ROW_ACTION, so a new row action inherits the rhythm instead of
  // re-deriving it — and a glyph that paints something other than 12px needs a fresh measurement.
  assert.match(html, /class="-mx-1\.5 inline-flex h-6 w-6/)
  // The home square gets ONE more pixel back: its own `-mx-1.5` leaves the house glyph's ink a pixel
  // outside the composer's border, and the row's left edge is where that overhang shows.
  assert.match(html, /class="-mx-1\.5 inline-flex h-6 w-6[^"]*-ml-px"/)
  // The quota chips are IN this row, so they keep the row's distance rather than one of their own.
  assert.match(html, /data-quota-bar="true" class="flex shrink-0 items-center gap-3/)
})

test("the quota READING is small, but its provider mark is a full-sized, full-brightness icon", () => {
  const html = render()

  // "logos should be the same brightness and size as the other icons. The text should just be small"
  // (maintainer 2026-08-19). The size is per-mark because the two do not fill their viewBoxes alike.
  assert.match(html, /data-quota-bar="true" class="[^"]*text-\[9px\]/)
  assert.match(html, /text-fg\/75! size-\[14px\]!/)
  assert.match(html, /text-fg\/75! size-\[12\.75px\]!/)
  // ProviderMark's own `text-muted/65 size-[11px]` is still in the class list and MUST be — the `!`
  // is what outranks it, because Tailwind resolves a same-property collision by CSS source order and
  // not by class order. Asserting the default is absent would be asserting the wrong mechanism; the
  // browser-side check that these resolve to 14px/12.75px is in the handoff's measurements.
  assert.match(html, /text-muted\/65 size-\[11px\][^"]*size-\[14px\]!/)
})

test("a provider with NO DATA renders nothing at all — and takes the divider with it", () => {
  // "if there's no data available for a given agent, then it should just be entirely hidden instead of
  // showing an em dash" (maintainer 2026-08-19). An em dash spent a readout's worth of space saying a
  // readout was missing.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["quota"], {
    claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
    codex: { status: "unavailable", windows: [] },
  })
  client.setQueryData(["authStatus"], { claude: "authed", codex: "signed-out", emails: {} })
  store.board = { projectLabel: "colinhacks/frizz", threads: [] } as unknown as BoardSnapshot
  store.connection = "open"
  const one = renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(StatusRow, null)),
  )
  assert.doesNotMatch(one, /—/, "no em dash anywhere")
  assert.equal(one.split("Claude Code").length - 1, 1, "the Claude chip is still there")
  assert.equal(one.split("OpenAI Codex").length - 1, 0, "the Codex chip is gone entirely")
  // One provider still reporting keeps the group, and therefore its divider.
  assert.equal(one.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 2)

  // NEITHER reporting drops the whole group, and the divider that introduced it goes too — otherwise
  // the row ends on a hairline with nothing after it.
  const none = render("colinhacks/frizz", { quota: false })
  assert.doesNotMatch(none, /data-quota-bar/)
  assert.equal(none.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 1)
})
