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

// TWO ENTER KEYS, the same in every box (maintainer 2026-08-26, matching Claude Code's own input):
//
//   Enter, ⌘/Ctrl-Enter   → the send (queued behind the worker's current turn if it has one).
//                           ⌘-Enter is the SAME send, not a forced one — "Command Enter inside of
//                           Frizz should just be the regular queue send".
//   Shift/Option-Enter    → a newline (the browser default; Option-Enter is repaired on macOS Chrome)
//
// There is no keyboard interrupt-and-send. Preempting a running turn is offered where the waiting
// message actually is — the ↑ on the queued bubble (lib/deliverQueuedNow.ts) — exactly as Claude
// Code has Enter queue and Esc interrupt, and no chord that does both.
function isSendEnter(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter"
    && !event.altKey
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
}

/**
 * Submit a non-IME Enter or ⌘/Ctrl-Enter when the composer can actually send. Shift-Enter and
 * Option-Enter fall through to the textarea's browser default and insert a newline.
 */
export function shouldSubmitComposerEnter(event: ComposerKeyboardEvent, canSubmit: boolean): boolean {
  return canSubmit && isSendEnter(event)
}

/**
 * The staged-answer counterpart, for the free-text box inside a ```question card, the card around
 * it, and the typed interaction form: the same keys, with the caller owning the "anything staged
 * to send" gate instead of a composer's content gate.
 */
export function shouldSubmitStagedEnter(event: ComposerKeyboardEvent): boolean {
  return isSendEnter(event)
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
