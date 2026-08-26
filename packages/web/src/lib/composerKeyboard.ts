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

// ONE submit convention, everywhere (maintainer 2026-08-26): ⌘/Ctrl-Enter is THE send key in every
// box, and a plain Enter is always a newline. The composers used to send on a bare Enter while the
// staged-answer box reserved ⌘-Enter — that split is gone; every prompt box now reads as a form
// field. Alt and Shift are excluded so Option/Shift-Enter stay newlines and so the interrupt chord
// below stays disjoint.
function isSendChord(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter"
    && (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
}

/**
 * Submit only a non-IME ⌘/Ctrl-Enter when the composer can actually send. Every other Enter —
 * plain, Shift, Option — falls through to the textarea's browser default and inserts a newline.
 */
export function shouldSubmitComposerEnter(event: ComposerKeyboardEvent, canSubmit: boolean): boolean {
  return canSubmit && isSendChord(event)
}

/**
 * The staged-answer counterpart, for the free-text box inside a ```question card. Same chord as the
 * composer send — the two surfaces converged when ⌘-Enter became the app-wide send key — but kept as
 * its own named predicate because its gate is different: the card sends whatever answers are staged
 * (chips included), not this box's own content, so the caller owns the "anything to send" check.
 */
export function shouldSubmitStagedEnter(event: ComposerKeyboardEvent): boolean {
  return isSendChord(event)
}

/**
 * INTERRUPT AND SEND — ⌘/Ctrl-SHIFT-Enter in a thread composer, offered only while the worker is
 * mid-turn.
 *
 * It lived on ⌘/Ctrl-Enter while a plain Enter was the ordinary send; when ⌘-Enter became the
 * app-wide send key (2026-08-26) the interrupt escalated to the shifted chord. Shift-Enter alone
 * keeps its newline (no meta/ctrl), and Option-Enter is untouched.
 *
 * `canInterrupt` is the caller's whole policy — no worker running, no affordance, and then this is a
 * no-op rather than a second way to send.
 */
export function shouldInterruptSubmitComposerEnter(event: ComposerKeyboardEvent, canInterrupt: boolean): boolean {
  return canInterrupt
    && event.key === "Enter"
    && (event.metaKey || event.ctrlKey)
    && event.shiftKey
    && !event.altKey
    && !event.isComposing
    && event.keyCode !== 229
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
