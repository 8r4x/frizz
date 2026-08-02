export type ComposerKeyboardEvent = {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  // React's synthetic KeyboardEvent omits this DOM field from its type, though its native event
  // exposes it. Undefined is safely treated as not composing.
  isComposing?: boolean
  // Deprecated DOM field, but it is the only reliable IME signal on WebKit: Safari can deliver the
  // Enter that CONFIRMS an IME candidate with isComposing=false and keyCode=229, which would submit
  // the message mid-composition without this guard. Chromium/Firefox set isComposing correctly.
  keyCode?: number
}

/**
 * Submit only an unmodified, non-IME Enter when the composer can actually send. Every modifier
 * path falls through to the textarea's browser default, preserving newline behavior.
 */
export function shouldSubmitComposerEnter(event: ComposerKeyboardEvent, canSubmit: boolean): boolean {
  return canSubmit
    && event.key === "Enter"
    && !event.isComposing
    && event.keyCode !== 229
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
}

/**
 * The STAGED-answer counterpart, for the free-text box inside a ```question card. That box is a FIELD
 * IN A FORM, not a composer: its blocks are staged and then sent together by "Send answers". So a bare
 * Enter must do what Enter does in any other textarea — insert a newline — and ONLY ⌘/Ctrl-Enter sends
 * (maintainer 2026-07-26: "I want to be able to do new lines inside of multiple-choice free text
 * boxes"). Every other key path falls through to the browser default.
 */
export function shouldSubmitStagedEnter(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter"
    && (event.metaKey || event.ctrlKey)
    && !event.isComposing
    && event.keyCode !== 229
}

/**
 * INTERRUPT AND SEND — ⌘/Ctrl-Enter in a thread composer, offered only while the worker is mid-turn.
 *
 * The gesture is free to take: in this composer ⌘/Ctrl-Enter has always fallen through to the browser
 * default, which in a textarea inserts nothing. It is also the gesture that already means "send" in
 * the staged-answer box above, so the two agree rather than compete. Option-Enter and Shift-Enter keep
 * their newline, and a plain Enter keeps the ordinary send.
 *
 * `canInterrupt` is the caller's whole policy — no worker running, no affordance, and then this is a
 * no-op rather than a second way to send.
 */
export function shouldInterruptSubmitComposerEnter(event: ComposerKeyboardEvent, canInterrupt: boolean): boolean {
  return canInterrupt
    && event.key === "Enter"
    && (event.metaKey || event.ctrlKey)
    && !event.isComposing
    && event.keyCode !== 229
    && !event.altKey
    && !event.shiftKey
}

/**
 * Chromium on macOS can report Option-Enter without applying textarea's usual line break. Let the
 * keydown default run first, then restore the newline only if the DOM value stayed unchanged.
 */
export function shouldRestoreOptionEnterNewline(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter"
    && event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.isComposing
}
