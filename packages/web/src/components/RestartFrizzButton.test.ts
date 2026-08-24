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

// The registry launcher is the only one that can name versions, so the version line and the specific
// "newer version" sentence appear exactly when it does — frizz-dev and legacy supervisors render the
// same popover they always have (the versionless assertions above and below pin that).
test("a registry launcher's update popover names both versions and says a newer one exists", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true, version: "0.4.2", updateVersion: "0.5.0" }))
  assert.match(html, /Update Frizz/)
  // Identifiers, not prose: the line stays mono whatever the board font is set to.
  assert.match(html, /font-mono[^"]*"[^>]*>0\.4\.2 → 0\.5\.0</)
  assert.match(html, /A newer version of Frizz is available\. Your running threads will not be affected\./)
  assert.doesNotMatch(html, /Install the latest version of Frizz/)
  // Still a single body paragraph — the version line rides in the header, not as a second <p>.
  assert.equal((html.match(/<p /g) ?? []).length, 1)
})

test("an up-to-date registry install still shows what version it is running", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: false, version: "0.4.2" }))
  assert.match(html, /Restart Frizz\. Your running threads will not be affected\./)
  assert.match(html, />0\.4\.2</)
  assert.doesNotMatch(html, /→/)
})

test("a registry probe that has not answered keeps the generic update copy", () => {
  // The launcher starts update-optimistic but versionless; claiming a number here would be a lie.
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true, version: "0.4.2" }))
  assert.match(html, /Install the latest version of Frizz\. Your running threads will not be affected\./)
  assert.match(html, />0\.4\.2</)
  assert.doesNotMatch(html, /→/)
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

// The popover only opens on hover, so the button itself is the one passive surface that can say "an
// update exists". The dot is gated on a CONFIRMED newer version: frizz-dev is permanently in update
// mode (a source rebuild is always meaningful), and a badge that never goes out is no badge.
test("the button wears an update dot only for a confirmed newer registry version", () => {
  const badged = renderToStaticMarkup(createElement(RestartActionButton, { update: true, busy: false, updateVersion: "0.5.0", onClick: () => undefined }))
  assert.match(badged, /bg-accent/)
  for (const [name, props] of [
    ["frizz-dev's version-less update mode", { update: true, busy: false }],
    ["an up-to-date registry install", { update: false, busy: false }],
    ["an update already in flight", { update: true, busy: true, updateVersion: "0.5.0" }],
  ] as [string, { update: boolean; busy: boolean; updateVersion?: string }][]) {
    const html = renderToStaticMarkup(createElement(RestartActionButton, { ...props, onClick: () => undefined }))
    assert.doesNotMatch(html, /bg-accent/, name)
  }
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
