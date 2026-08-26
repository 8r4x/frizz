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

// THREE ENTER KEYS (maintainer 2026-08-26): Enter = the ordinary send, Shift/Option-Enter = a
// newline, ⌘/Ctrl-Enter = the forced send. These pin that the three stay disjoint in every box.

test("composer submits only a plain Enter when sending is allowed", () => {
  assert.equal(shouldSubmitComposerEnter(key(), true), true)
  assert.equal(shouldSubmitComposerEnter(key(), false), false, "empty, disabled, or busy composers leave Enter untouched")
})

test("composer Shift/Option-Enter preserve the textarea newline default", () => {
  assert.equal(shouldSubmitComposerEnter(key({ shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true }), true), false, "macOS Option-Enter reports altKey")
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true, shiftKey: true }), true), false)
})

test("composer plain send never takes the forced chord", () => {
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ ctrlKey: true }), true), false)
})

test("composer never submits an IME composition confirmation", () => {
  assert.equal(shouldSubmitComposerEnter(key({ isComposing: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ key: "Process", isComposing: true }), true), false)
  // WebKit/Safari can confirm an IME candidate with isComposing=false but keyCode=229.
  assert.equal(shouldSubmitComposerEnter(key({ isComposing: false, keyCode: 229 }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ keyCode: 13 }), true), true, "a real Enter keyCode still submits")
})

test("Option-Enter fallback is eligible only without Ctrl or Command", () => {
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true })), true)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, shiftKey: true })), true)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, ctrlKey: true })), false)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, metaKey: true })), false)
  assert.equal(shouldRestoreOptionEnterNewline(key({ altKey: true, isComposing: true })), false)
})

// ---- shouldInterruptSubmitComposerEnter — ⌘/Ctrl-Enter, the FORCED send ----
// Ctrl is ⌘'s Windows/Linux twin throughout the app, so both are the forced chord and neither is
// ever a newline. The caller turns it into interrupt-and-send or a plain send; the predicate only
// keeps it disjoint from the plain Enter and from the Shift/Option newlines.

test("forced send fires on Command- or Ctrl-Enter, gated like the ordinary send", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true }), true), true)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ ctrlKey: true }), true), true)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true }), false), false, "nothing sendable, nothing forced")
})

test("forced send never takes a keystroke the composer already owns", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key(), true), false, "a plain Enter is the ordinary send")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ shiftKey: true }), true), false, "Shift-Enter stays a newline")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ altKey: true }), true), false, "Option-Enter stays a newline")
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, altKey: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ key: "a", metaKey: true }), true), false)
})

test("forced send never fires on an IME confirmation", () => {
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, isComposing: true }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, keyCode: 229 }), true), false)
  assert.equal(shouldInterruptSubmitComposerEnter(key({ metaKey: true, keyCode: 13 }), true), true)
})

// ---- shouldSubmitStagedEnter — the ```question card's inputs and the typed interaction form ----
// Enter AND the forced chord both send (a waiting worker has nothing to interrupt, so "send now"
// and "send" are one act); Shift/Option-Enter stay newlines. The caller owns the staged gate.

test("a staged answer box submits on Enter and on Command- or Ctrl-Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key()), true)
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true })), true)
  assert.equal(shouldSubmitStagedEnter(key({ ctrlKey: true })), true)
})

test("a staged answer box takes a NEWLINE on Shift- or Option-Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key({ shiftKey: true })), false)
  assert.equal(shouldSubmitStagedEnter(key({ altKey: true })), false, "macOS Option-Enter reports altKey")
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, shiftKey: true })), false)
})

test("a staged answer box never submits a non-Enter key or an IME confirmation", () => {
  assert.equal(shouldSubmitStagedEnter(key({ key: "a" })), false)
  assert.equal(shouldSubmitStagedEnter(key({ isComposing: true })), false)
  // WebKit/Safari can confirm an IME candidate with isComposing=false but keyCode=229.
  assert.equal(shouldSubmitStagedEnter(key({ keyCode: 229 })), false)
  assert.equal(shouldSubmitStagedEnter(key({ keyCode: 13 })), true)
})
