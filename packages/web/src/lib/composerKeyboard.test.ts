import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldInterruptSubmitComposerEnter, shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter, shouldSubmitStagedEnter, type ComposerKeyboardEvent } from "./composerKeyboard.ts"

function key(overrides: Partial<ComposerKeyboardEvent> = {}): ComposerKeyboardEvent {
  return {
    key: "Enter",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  }
}

// ONE submit convention (maintainer 2026-08-26): ⌘/Ctrl-Enter sends in every box, a plain Enter is
// always a newline. These pin that the composer no longer sends on a bare Enter.

test("composer submits only Command- or Ctrl-Enter when sending is allowed", () => {
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true }), true), true)
  assert.equal(shouldSubmitComposerEnter(key({ ctrlKey: true }), true), true)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true }), false), false, "empty, disabled, or busy composers leave the chord untouched")
})

test("composer plain Enter is a NEWLINE, never a send", () => {
  assert.equal(shouldSubmitComposerEnter(key(), true), false)
})

test("composer Shift/Option variants preserve the textarea newline default", () => {
  assert.equal(shouldSubmitComposerEnter(key({ shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true }), true), false, "macOS Option-Enter reports altKey")
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true, shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, altKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), true), false, "⌘-Shift-Enter belongs to interrupt-and-send")
})

test("composer never submits an IME composition confirmation", () => {
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, isComposing: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ key: "Process", metaKey: true, isComposing: true }), true), false)
  // WebKit/Safari can confirm an IME candidate with isComposing=false but keyCode=229.
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, isComposing: false, keyCode: 229 }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, keyCode: 13 }), true), true, "a real Enter keyCode still submits")
})

test("Option-Enter fallback is eligible only without Ctrl or Command", () => {
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true })), true)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, shiftKey: true })), true)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, ctrlKey: true })), false)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, metaKey: true })), false)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, isComposing: true })), false)
})

// ---- shouldInterruptSubmitComposerEnter — ⌘/Ctrl-SHIFT-Enter, "this can't wait" ----
// The unshifted chord became the ordinary send when ⌘-Enter became the app-wide send key, so the
// interrupt escalated to the shifted chord. These pin that it stays disjoint from BOTH the ⌘-Enter
// send and the Option/Shift-Enter newline, so neither can accidentally preempt a running turn.

test("interrupt-send fires on Command- or Ctrl-Shift-Enter, and only when it is offered", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), true), true)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ ctrlKey: true, shiftKey: true }), true), true)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), false), false,
    "no running worker, no affordance — and then no second way to send either")
})

test("interrupt-send never takes a keystroke the composer already owns", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key(), true), false, "a plain Enter is a newline")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true }), true), false, "unshifted ⌘-Enter is the ordinary send")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ ctrlKey: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ shiftKey: true }), true), false, "Shift-Enter stays a newline")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ altKey: true }), true), false, "Option-Enter stays a newline")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true, altKey: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ key: "a", metaKey: true, shiftKey: true }), true), false)
})

test("interrupt-send never fires on an IME confirmation", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true, isComposing: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true, keyCode: 229 }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true, keyCode: 13 }), true), true)
})

// ---- shouldSubmitStagedEnter — the ```question card's free-text box (and the card around it) ----
// Same chord as the composer send; the caller owns the "anything staged to send" gate.

test("a staged answer box takes a NEWLINE on every unmodified Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key()), false, "plain Enter must fall through to the textarea default")
  assert.equal(shouldSubmitStagedEnter(key({ shiftKey: true })), false)
  assert.equal(shouldSubmitStagedEnter(key({ altKey: true })), false, "macOS Option-Enter reports altKey")
})

test("a staged answer box submits on Command- or Ctrl-Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true })), true)
  assert.equal(shouldSubmitStagedEnter(key({ ctrlKey: true })), true)
  // The shifted chord is interrupt-and-send in the composer; a staged box treats it as a newline so
  // the same physical chord can never mean two different sends.
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, shiftKey: true })), false)
})

test("a staged answer box never submits a non-Enter key or an IME confirmation", () => {
  assert.equal(shouldSubmitStagedEnter(key({ key: "a", metaKey: true })), false)
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, isComposing: true })), false)
  // WebKit/Safari can confirm an IME candidate with isComposing=false but keyCode=229.
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, keyCode: 229 })), false)
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, keyCode: 13 })), true)
})
