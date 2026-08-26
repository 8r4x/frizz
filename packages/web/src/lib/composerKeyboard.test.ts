import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldRestoreOptionEnterNewline, shouldSubmitComposerEnter, shouldSubmitStagedEnter, type ComposerKeyboardEvent } from "./composerKeyboard.ts"

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

// TWO ENTER KEYS (maintainer 2026-08-26): Enter and ⌘/Ctrl-Enter are the SAME queued send;
// Shift/Option-Enter are a newline. There is no forced-send chord — these pin that ⌘-Enter never
// diverges from Enter and that the newline keys never send.

test("composer submits a plain Enter when sending is allowed", () => {
  assert.equal(shouldSubmitComposerEnter(key(), true), true)
  assert.equal(shouldSubmitComposerEnter(key(), false), false, "empty, disabled, or busy composers leave Enter untouched")
})

test("composer treats Command- or Ctrl-Enter as the same ordinary send", () => {
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true }), true), true)
  assert.equal(shouldSubmitComposerEnter(key({ ctrlKey: true }), true), true)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true }), false), false, "same gate as Enter")
})

test("composer Shift/Option-Enter preserve the textarea newline default", () => {
  assert.equal(shouldSubmitComposerEnter(key({ shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true }), true), false, "macOS Option-Enter reports altKey")
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true, shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, shiftKey: true }), true), false, "a held Shift keeps the newline even beside the accelerator")
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true, altKey: true }), true), false)
})

test("composer never submits a non-Enter key or an IME composition confirmation", () => {
  assert.equal(shouldSubmitComposerEnter(key({ key: "a", metaKey: true }), true), false)
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

// ---- shouldSubmitStagedEnter — the ```question card's inputs and the typed interaction form ----
// The same keys as the composer; the caller owns the staged gate.

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
