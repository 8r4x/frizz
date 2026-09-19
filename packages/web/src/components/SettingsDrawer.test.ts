import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./SettingsDrawer.tsx", import.meta.url), "utf8")
const helpSource = readFileSync(new URL("../lib/settingsHelp.ts", import.meta.url), "utf8")
const autosaveSource = readFileSync(new URL("../hooks/useSettingsAutosave.tsx", import.meta.url), "utf8")
const fieldSource = readFileSync(new URL("./SettingsField.tsx", import.meta.url), "utf8")
const agentSource = readFileSync(new URL("./AgentSettingsPopover.tsx", import.meta.url), "utf8")
const promptFieldSource = readFileSync(new URL("./GithubPromptField.tsx", import.meta.url), "utf8")
const promptPopoverSource = readFileSync(new URL("./GithubPromptPopover.tsx", import.meta.url), "utf8")
const pickerSource = readFileSync(new URL("./GithubPickerModal.tsx", import.meta.url), "utf8")
const tooltipSource = readFileSync(new URL("./Tooltip.tsx", import.meta.url), "utf8")

test("settings maps each contextual explanation to a help control", () => {
  // `subagentInstructions` is gone: the settings preamble was retired in favour of FRIZZ.md, so there
  // is exactly one operator-authored surface for project conventions.
  for (const key of ["permissionMode", "promptCacheTtl", "font", "density", "notifications", "githubPrompt"]) {
    assert.match(helpSource, new RegExp(`\\b${key}:`), `missing settings help mapping: ${key}`)
  }
  assert.match(source, /label="Density" help=\{SETTINGS_HELP\.density\}/)
  assert.match(source, /label="Desktop notifications" help=\{SETTINGS_HELP\.notifications\}/)
  // The runtime fields read the same table from their own surface.
  assert.match(agentSource, /label="Permissions" help=\{SETTINGS_HELP\.permissionMode\}/)
  assert.match(agentSource, /label="Prompt cache tier" help=\{SETTINGS_HELP\.promptCacheTtl\}/)
  assert.match(promptFieldSource, /help=\{SETTINGS_HELP\.githubPrompt\}/)
  // The redundant "GitHub picker prompts" group label is gone; each field carries its own label.
  assert.doesNotMatch(source, /label="GitHub picker prompts"/)
})

// The BEHAVIOUR of the autosave — one write per click, one write per typing burst, and a flush on
// close — is pinned in a real browser by settingsAutosave.e2e.test.ts. This test guards the shape it
// depends on: nothing here may reintroduce a button that the operator has to press.
test("settings save themselves — no Save button, no Cancel, no unsaved marker", () => {
  assert.doesNotMatch(source, />\s*Save\s*</)
  assert.doesNotMatch(source, />\s*Cancel\s*</)
  assert.doesNotMatch(source, /● unsaved/)
  // The footer those two buttons lived in went with them; the sheet is header + tabs + scroll body.
  assert.doesNotMatch(source, /<footer/)
  // Every control routes through the one updater, and only free text debounces.
  assert.match(source, /const \{ draft, update, saveState, flush \} = useSettingsDraft\(\)/)
  assert.match(promptFieldSource, /onChange=\{\(e\) => onChange\(e\.target\.value === "" \? undefined : e\.target\.value, \{ debounce: true \}\)\}/)
  // Closing must not strand the keystrokes still sitting in the debounce.
  const close = source.slice(source.indexOf("function close()"), source.indexOf("async function toggleNotifications"))
  assert.match(close, /flush\(\)/)
  // Writes are serialized: a whole-object payload delivered out of order silently reverts settings.
  // And every write is a react-query mutation under one key, so a dispatch surface can wait on it.
  assert.match(autosaveSource, /chain\.current = chain\.current\s*\n\s*\.then\(\(\) => writeRef\.current\.mutateAsync\(next\)\)/)
  assert.match(autosaveSource, /export const SETTINGS_WRITE_KEY = \["settingsSet"\] as const/)
  assert.match(autosaveSource, /mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\], mutationFn: \(next: Settings\) => rpc\.settingsSet\(next\)/)
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

// The drawer is TWO tabs, full width, under the header — Frizz (the machine and this browser) and
// Project (what the server stores per project) — and the runtime settings are in neither: they open
// off the gear on their runtime's band in the model picker (maintainer 2026-09-19: "we want settings
// to appear in the context where they are relevant").
test("the drawer is a Frizz|Project tab strip, and carries no runtime settings", () => {
  const tabs = source.slice(source.indexOf("function SettingsTabs"), source.indexOf("function FontToggle"))
  assert.match(tabs, /role="tablist"/)
  assert.match(tabs, /grid shrink-0 grid-cols-2/)
  assert.match(tabs, /\{ id: "frizz", label: "Frizz settings" \},\s*\{ id: "project", label: "Project settings" \}/)
  // The strip sits between the header and the body, and the body switches on it.
  assert.ok(source.indexOf("<SettingsTabs") > source.indexOf('<SheetHeader title="Settings"'))
  assert.ok(source.indexOf("<SettingsTabs") < source.indexOf('tab === "frizz"'))
  // Frizz tab: the interface preferences, in this order, and nothing vendor-specific.
  const frizz = source.slice(source.indexOf('tab === "frizz"'), source.indexOf(") : ("))
  const fields = [...frizz.matchAll(/<SettingsField label="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(fields, ["Font", "Project sidebar", "Local file links", "Density", "Queue order", "Desktop notifications"])
  // Project tab: names the project and carries the triage prompt editor.
  const project = source.slice(source.indexOf(") : ("), source.indexOf("function SettingsTabs"))
  assert.match(project, /projectLabel/)
  assert.match(project, /<GithubPromptEditor draft=\{draft\} onChange=\{update\} \/>/)
  // Nothing Claude- or Codex-specific is left in the drawer.
  assert.doesNotMatch(source, /ClaudeSection|CodexSection|DividerLabel|permissionMode|promptCacheTtl|autoCompactWindow|codexContextWindow/)
  assert.doesNotMatch(source, /label="(?:Permissions|Prompt cache tier|Compaction|Context window)"/)
})

// The runtime settings live on the model picker's band header, behind a gear, in a MODAL popover.
// Its predecessor (a non-modal context dropdown) closed the moment the pointer left its trigger,
// because Radix Menu focuses its own content on item leave and a non-modal popover reads that as a
// focus-outside. The modal flag is what makes that structurally impossible; this pins it.
test("the agent settings panel is modal, keyboard-reachable, and holds exactly the runtime's fields", () => {
  assert.match(agentSource, /<Popover modal open=\{open\} onOpenChange=\{onOpenChange\}>/)
  assert.match(agentSource, /<RadixMenu\.Item asChild onSelect=\{\(event\) => event\.preventDefault\(\)\}>/)
  assert.match(agentSource, /useEscapeToClose\(open, \(\) => onOpenChange\(false\)\)/)
  assert.match(agentSource, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  // The Claude panel offers only the two headless-safe modes, and an out-of-range stored value
  // displays as the "auto" floor the server would actually dispatch with.
  assert.match(agentSource, /options=\{CLAUDE_DISPATCH_PERMISSION_OPTIONS\}/)
  assert.match(agentSource, /value=\{draft\.permissionMode === "bypassPermissions" \? "bypassPermissions" : "auto"\}/)
  assert.match(agentSource, /ariaLabel="Claude Code compaction window"/)
  assert.match(agentSource, /ariaLabel="Codex context window"/)
  // Every Select inside the panel portals ABOVE the panel, never at its own tier.
  const selects = agentSource.match(/<Select\b/g) ?? []
  const raised = agentSource.match(/menuZClass=\{OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z\}/g) ?? []
  assert.equal(raised.length, selects.length)
  // The dispatch surfaces carry the gear; a live thread's own picker does not.
  for (const file of ["NewThreadModal.tsx", "GithubPickerModal.tsx"]) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), /agentSettings/)
  }
  assert.doesNotMatch(readFileSync(new URL("../hooks/useThreadComposerControls.tsx", import.meta.url), "utf8"), /agentSettings|contextWindows/)
  // The retired control and its patch RPC are gone for good.
  assert.doesNotMatch(readFileSync(new URL("./ProfileGridSelector.tsx", import.meta.url), "utf8"), /ContextWindowControl|contextWindows|data-context-window-menu/)
  assert.doesNotMatch(readFileSync(new URL("../api/contract.ts", import.meta.url), "utf8"), /contextWindowSet/)
})

// The GitHub picker's header: the slug is a right-justified link out to the repo with the external
// arrow, and the gear beside it opens the triage prompt — the picker's settings, where they apply.
test("the GitHub picker carries the repo link and the prompt popover in its header, and waits on settings writes", () => {
  const header = pickerSource.slice(pickerSource.indexOf("{/* Header"), pickerSource.indexOf("{/* Controls"))
  // The row is baseline-aligned so its three glyphs can take the browser-computed cap-band
  // correction (half the glyph's box minus half the resolved cap height); the numbers behind it are
  // in the component's comments.
  assert.match(header, /<h2 className="mb-4 flex items-baseline gap-2/)
  assert.match(header, /className="ml-auto flex shrink-0 items-baseline gap-2"/)
  assert.match(header, /<Github size=\{15\} aria-hidden="true" className="shrink-0 self-baseline translate-y-\[calc\(7\.5px_-_0\.5cap\)\]/)
  assert.match(promptPopoverSource, /self-baseline translate-y-\[calc\(7\.5px_-_0\.5cap\)\]/)
  assert.match(agentSource, /self-baseline|items-baseline/)
  assert.match(agentSource, /-mr-3 inline-flex size-5 shrink-0 translate-y-\[calc\(7px_-_0\.5cap\)\]/)
  assert.match(header, /<RepoLink nameWithOwner=\{status\.data\.nameWithOwner\} \/>/)
  assert.match(header, /<GithubPromptPopover \/>/)
  // The slug is no longer an em-dashed suffix of the title (the dash must be gone from the MARKUP;
  // the comments above it are prose and may carry one).
  assert.doesNotMatch(header.slice(header.indexOf("<h2")), /—/)
  const link = pickerSource.slice(pickerSource.indexOf("function RepoLink"), pickerSource.indexOf("function PagerButton"))
  assert.match(link, /href=\{`https:\/\/github\.com\/\$\{nameWithOwner\}`\}/)
  assert.match(link, /target="_blank"/)
  assert.match(link, /<ArrowUpRight aria-hidden="true" className="-ml-\[0\.29em\] size-\[1em\] shrink-0 self-baseline translate-y-\[calc\(0\.5em_-_0\.5cap\)\]"/)
  assert.match(promptPopoverSource, /<Popover modal open=\{open\} onOpenChange=\{setOpen\}>/)
  assert.match(promptPopoverSource, /<GithubPromptEditor draft=\{draft\} onChange=\{update\} rows=\{14\} \/>/)
  // A prompt edit flushed by closing the popover is still in flight when the button is pressed.
  assert.match(pickerSource, /useIsMutating\(\{ mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\] \}\)/)
  assert.match(readFileSync(new URL("./NewThreadModal.tsx", import.meta.url), "utf8"), /useIsMutating\(\{ mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\] \}\)/)
})

test("notification recovery aligns with its control and keeps recovery instructions visible", () => {
  const denied = source.slice(source.indexOf("function NotifDeniedHelp"), source.indexOf("function hostOf"))
  assert.match(denied, /className="flex flex-col gap-1 text-\[11px\] text-muted\/70"/)
  assert.doesNotMatch(denied, /pl-6/)
  assert.match(denied, /Notifications are blocked for this site/)
  assert.match(denied, /Paste this into a new tab, set Notifications/)
})

// "Compact mode" Off|On told the operator what Off was NOT. A density pair names both states.
test("diff density is a Comfortable|Compact pair, densest on the right, compact by default", () => {
  const toggle = source.slice(source.indexOf("function DensityToggle"), source.indexOf("function QueueOrderControl"))
  assert.match(toggle, /\{ v: false, label: "Comfortable" \},\s*\{ v: true, label: "Compact" \}/)
  assert.match(toggle, /prefs\.compactDiffs = o\.v/)
  assert.doesNotMatch(source, /label="Compact mode"/)
  assert.doesNotMatch(source, /function CompactToggle/)
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
  assert.match(fieldSource, /<Tooltip label=\{help\} side="right" clickable>/)
  assert.match(fieldSource, /inline-flex size-4 items-center justify-center/)
  assert.doesNotMatch(source.slice(source.indexOf("function CopyableAddress")), /title="Copy address"/)
})
