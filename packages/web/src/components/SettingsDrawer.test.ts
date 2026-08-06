import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./SettingsDrawer.tsx", import.meta.url), "utf8")
const tooltipSource = readFileSync(new URL("./Tooltip.tsx", import.meta.url), "utf8")

test("settings maps each contextual explanation to a help control", () => {
  // `subagentInstructions` is gone: the settings preamble was retired in favour of FRIZZ.md, so there
  // is exactly one operator-authored surface for project conventions.
  for (const key of ["permissionMode", "font", "compact", "notifications"]) {
    assert.match(source, new RegExp(`\\b${key}:`), `missing settings help mapping: ${key}`)
  }
  assert.match(source, /label="Claude permissions" help=\{SETTINGS_HELP\.permissionMode\}/)
  assert.match(source, /label="Compact mode" help=\{SETTINGS_HELP\.compact\}/)
  assert.match(source, /label="Desktop notifications" help=\{SETTINGS_HELP\.notifications\}/)
  // The redundant "GitHub picker prompts" group label is gone; each field carries its own label.
  assert.doesNotMatch(source, /label="GitHub picker prompts"/)
})

test("the drawer no longer duplicates the composer's controls or offers vestigial toggles", () => {
  // Model and effort are chosen per-dispatch in the prompt box (DispatchPreferences), so a second,
  // divergent copy of them here was only ever a way to confuse which one applied.
  assert.doesNotMatch(source, /label="Model"/)
  assert.doesNotMatch(source, /label="Effort"/)
  // The Runtime QA gate setting is gone entirely — browser-QA policy is a project's own FRIZZ.md
  // concern, not a global Frizz switch.
  assert.doesNotMatch(source, /Runtime QA gate/)
  assert.doesNotMatch(source, /runtimeGate/)
  // Auto-resume after a usage limit is unconditional now: nothing to turn off.
  assert.doesNotMatch(source, /autoResumeOnLimit/)
  assert.doesNotMatch(source, /Auto-resume after usage limits/)
})

test("the Claude permission control offers only the two headless-safe modes and warns while bypassing", () => {
  // The select is fed the shared two-option set, not the full PermissionMode enum, and an out-of-range
  // stored value displays as the "auto" floor the server would actually dispatch with.
  assert.match(source, /options=\{CLAUDE_DISPATCH_PERMISSION_OPTIONS\}/)
  assert.match(source, /value=\{draft\.permissionMode === "bypassPermissions" \? "bypassPermissions" : "auto"\}/)
  // Choosing bypass says what it costs, in the same quiet register as the notification hint.
  assert.match(source, /\{draft\.permissionMode === "bypassPermissions" && <BypassHint \/>\}/)
  const hint = source.slice(source.indexOf("function BypassHint"), source.indexOf("function PermHint"))
  assert.match(hint, /without asking you first/)
  // The old "Permission is NOT a setting" note described the world before this control existed.
  assert.doesNotMatch(source, /Permission is NOT a setting/)
})

test("notification recovery aligns with its control and keeps recovery instructions visible", () => {
  const denied = source.slice(source.indexOf("function NotifDeniedHelp"), source.indexOf("function hostOf"))
  assert.match(denied, /className="flex flex-col gap-1 text-\[11px\] text-muted\/70"/)
  assert.doesNotMatch(denied, /pl-6/)
  assert.match(denied, /Notifications are blocked for this site/)
  assert.match(denied, /Paste this into a new tab, set Notifications/)
})

test("Prompts uses one centered divider without a duplicate section rule", () => {
  const prompts = source.slice(source.indexOf("function PromptsSection"), source.indexOf("function DividerLabel"))
  assert.match(prompts, /<DividerLabel label="Prompts"/)
  assert.doesNotMatch(prompts, /border-t border-border/)
})

test("help tooltip uses custom accessible, touch-capable paragraph layout", () => {
  // `&& !disabled` is the project rail's drag suppression: the pointer is necessarily inside the
  // square it is dragging, so a delayDuration-0 tooltip would open on grab and chase it down the
  // rail. It forces the tooltip SHUT without unmounting the trigger, which mid-drag would destroy
  // the element holding pointer capture. Hover behaviour is unchanged whenever nothing is dragging.
  assert.match(tooltipSource, /<RT\.Root open=\{open && !disabled\} onOpenChange=\{setOpen\}>/)
  assert.match(tooltipSource, /clickable = false/)
  assert.match(tooltipSource, /cloneElement\(clickableChild, \{ "aria-describedby": contentId \}\)/)
  assert.match(tooltipSource, /onClick=\{\(\) => setOpen\(\(wasOpen\) => !wasOpen\)\}/)
  assert.match(tooltipSource, /onKeyDown=\{onKeyDown\}/)
  assert.match(tooltipSource, /createPortal\(/)
  assert.match(tooltipSource, /collisionPadding=\{12\}/)
  assert.match(tooltipSource, /max-w-\[min\(22rem,calc\(100vw-1\.5rem\)\)\]/)
  assert.match(tooltipSource, /leading-relaxed/)
  // Wrapping and whitespace behavior are composed independently, so keep this
  // contract resilient to Tailwind class ordering and the computed mode value.
  assert.match(tooltipSource, /\bbreak-words\b/)
  assert.match(tooltipSource, /\$\{whitespace\}/)
  assert.match(tooltipSource, /\bwhitespace-normal\b/)
  assert.match(tooltipSource, /\bwhitespace-pre-line\b/)
  assert.doesNotMatch(tooltipSource, /title=/)
  assert.match(source, /<Tooltip label=\{help\} side="right" clickable>/)
  assert.match(source, /inline-flex size-4 items-center justify-center/)
  assert.doesNotMatch(source.slice(source.indexOf("function CopyableAddress")), /title="Copy address"/)
})
