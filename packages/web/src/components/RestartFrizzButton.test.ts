import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RestartActionButton, RestartFailureNotice, UPDATE_RESTART_ICON_ROTATION, UpdateRestartPopover } from "./RestartFrizzButton.tsx"

test("Update Frizz presents one calm sentence whose highlight is that threads are untouched", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  assert.match(html, /Update Frizz/)
  assert.equal((html.match(/<button/g) ?? []).length, 0)
  assert.match(html, /Install the latest version of Frizz\. Your running threads will not be affected\./)
  // A single body paragraph — no divider, no second "stays in place" line, no stray emphasis block.
  assert.equal((html.match(/<p /g) ?? []).length, 1)
  assert.doesNotMatch(html, /stay in place/)
  assert.match(html, /font-sans/)
})

test("Update and restart keeps its clockwise arrow treatment", () => {
  assert.equal(UPDATE_RESTART_ICON_ROTATION, "clockwise")
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  assert.match(html, /lucide-refresh-cw/)
  assert.match(html, /role="tooltip"/)
})

test("Update and restart is one compact icon-only action with an accessible name", () => {
  const html = renderToStaticMarkup(createElement(RestartActionButton, { update: true, busy: false, onClick: () => undefined }))
  assert.match(html, /aria-label="Update Frizz"/)
  // Sized by STATUS_ROW_ACTION — it shares the prompt box's status row with the settings gear, and
  // the two must carry identical weight (this was a lone 32px corner button before the row existed).
  assert.match(html, /h-6 w-6/)
  assert.match(html, /lucide-refresh-cw/)
  assert.doesNotMatch(html, />\s*Update Frizz\s*</)
  assert.doesNotMatch(html, /cursor-wait/)
})

test("busy Update and restart keeps only the clockwise spinner inside the button", () => {
  const html = renderToStaticMarkup(createElement(RestartActionButton, { update: true, busy: true, onClick: () => undefined }))
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /animate-spin/)
  assert.equal((html.match(/<svg/g) ?? []).length, 1)
  assert.doesNotMatch(html, /Updating…|Restarting…/)
})

test("legacy supervisors present an ordinary restart action instead of hiding the control", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: false }))
  assert.match(html, /Restart Frizz/)
  assert.match(html, /Restart Frizz\. Your running threads will not be affected\./)
  assert.equal((html.match(/<p /g) ?? []).length, 1)
  assert.doesNotMatch(html, /latest version of Frizz/)
})

const supervisorLog =
  "Command failed: nub run typecheck from /Users/x/.frizz/builds/.source-snapshot-31038-bc7e214d\n" +
  "src/groups.ts(440,27): error TS2304: Cannot find name 'restedQueueHandoff'."

// The whole point of the panel: it hangs over the sidebar list and the composer, so anything
// see-through renders the one message the user needs illegible. Both panels ride the SAME opaque
// card, and neither may carry a tinted-transparent fill.
test("the failure panel is an opaque card, never a translucent tint over the board", () => {
  const html = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: true, message: supervisorLog, onDismiss: () => undefined }),
  )
  const surface = html.match(/role="alert" class="([^"]*)"/)?.[1] ?? ""
  assert.ok(surface.includes("bg-elevated"), `alert surface must be opaque, got: ${surface}`)
  assert.ok(!/\bbg-(?!elevated\b)/.test(surface), `alert surface carries a non-elevated fill: ${surface}`)
  // Same opaque treatment as the popover it replaces — one card, two states.
  const popover = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  for (const shared of ["bg-elevated", "shadow-xl", "rounded-xl"]) assert.ok(popover.includes(shared) && html.includes(shared), shared)
})

test("the supervisor's build log is contained, not spilled down the board", () => {
  const html = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: true, message: supervisorLog, onDismiss: () => undefined }),
  )
  assert.match(html, /Update failed/)
  assert.match(html, /Frizz kept running the previous version, and your threads are unaffected\./)
  // Raw build output reads as a terminal excerpt in a height-capped, scrolling mono block, so a
  // several-hundred-character stderr dump can't stretch the card down over the thread list.
  const pre = html.match(/<pre class="([^"]*)"/)?.[1] ?? ""
  assert.ok(pre.includes("font-mono"), pre)
  assert.ok(pre.includes("max-h-64") && pre.includes("overflow-y-auto"), pre)
  assert.ok(pre.includes("whitespace-pre-wrap") && pre.includes("break-words"), pre)
  assert.match(html, /error TS2304/)
})

test("a failure can be dismissed, and a legacy restart names itself correctly", () => {
  const html = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: false, message: "boom", onDismiss: () => undefined }),
  )
  assert.match(html, /Restart failed/)
  assert.doesNotMatch(html, /Update failed/)
  assert.match(html, /aria-label="Dismiss"/)
})
