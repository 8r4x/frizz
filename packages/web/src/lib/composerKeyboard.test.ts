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

test("composer submits only a plain Enter when sending is allowed", () => {
  assert.equal(shouldSubmitComposerEnter(key(), true), true)
  assert.equal(shouldSubmitComposerEnter(key(), false), false, "empty, disabled, or busy composers leave Enter untouched")
})

test("composer modifier Enter paths preserve the textarea newline default", () => {
  assert.equal(shouldSubmitComposerEnter(key({ shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true }), true), false, "macOS Option-Enter reports altKey")
  assert.equal(shouldSubmitComposerEnter(key({ altKey: true, shiftKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ ctrlKey: true }), true), false)
  assert.equal(shouldSubmitComposerEnter(key({ metaKey: true }), true), false)
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

// ---- shouldSubmitStagedEnter — the ```question card's free-text box ----
// The inverse contract to the composer's: a staged form field keeps Enter as a NEWLINE and reserves
// ⌘/Ctrl-Enter for the send, so a multi-line answer can be typed without firing a reply mid-sentence.

test("a staged answer box takes a NEWLINE on every unmodified Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key()), false, "plain Enter must fall through to the textarea default")
  assert.equal(shouldSubmitStagedEnter(key({ shiftKey: true })), false)
  assert.equal(shouldSubmitStagedEnter(key({ altKey: true })), false, "macOS Option-Enter reports altKey")
})

test("a staged answer box submits on Command- or Ctrl-Enter", () => {
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true })), true)
  assert.equal(shouldSubmitStagedEnter(key({ ctrlKey: true })), true)
  // A held Shift alongside the accelerator is still a send, not a newline.
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, shiftKey: true })), true)
})

test("a staged answer box never submits a non-Enter key or an IME confirmation", () => {
  assert.equal(shouldSubmitStagedEnter(key({ key: "a", metaKey: true })), false)
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, isComposing: true })), false)
  // WebKit/Safari can confirm an IME candidate with isComposing=false but keyCode=229.
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, keyCode: 229 })), false)
  assert.equal(shouldSubmitStagedEnter(key({ metaKey: true, keyCode: 13 })), true)
})
