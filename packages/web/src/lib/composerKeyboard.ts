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

// THREE ENTER KEYS, the same in every box (maintainer 2026-08-26: "an option for a new line, an
// option for a regular enqueued message, an option for a forced sent message"):
//
//   Enter               → the ordinary send (queued behind the worker's current turn if it has one)
//   Shift-Enter         → a newline (Option-Enter too — the browser default, repaired on macOS Chrome)
//   ⌘/Ctrl-Enter        → the FORCED send: interrupt-and-send where a worker is mid-turn, otherwise
//                         just a send
//
// Ctrl is ⌘'s Windows/Linux twin throughout the app (⌘K / Ctrl-K, ⌘I / Ctrl-I), so it is the forced
// chord there and never a newline. The staged-answer box and the typed interaction form send on both
// Enter and the forced chord — a question card exists while the worker waits, so there is nothing to
// interrupt and "send now" and "send" are the same act.
function isEnter(event: ComposerKeyboardEvent): boolean {
  return event.key === "Enter"
    && !event.altKey
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
}

/**
 * Submit only an unmodified, non-IME Enter when the composer can actually send. Shift-Enter and
 * Option-Enter fall through to the textarea's browser default and insert a newline; ⌘/Ctrl-Enter is
 * the forced send (see shouldInterruptSubmitComposerEnter).
 */
export function shouldSubmitComposerEnter(event: ComposerKeyboardEvent, canSubmit: boolean): boolean {
  return canSubmit && isEnter(event) && !event.metaKey && !event.ctrlKey
}

/**
 * FORCED SEND — ⌘/Ctrl-Enter in a thread composer. The caller decides what "forced" means: with a
 * worker mid-turn it is interrupt-and-send (the message is read now instead of when the current
 * command finishes); with nothing to interrupt it is an ordinary send, so the chord never goes dead.
 * `canSubmit` is the same gate as the ordinary send.
 */
export function shouldInterruptSubmitComposerEnter(event: ComposerKeyboardEvent, canSubmit: boolean): boolean {
  return canSubmit && isEnter(event) && (event.metaKey || event.ctrlKey)
}

/**
 * The staged-answer counterpart, for the free-text box inside a ```question card, the card around
 * it, and the typed interaction form. Enter AND ⌘/Ctrl-Enter send (nothing there can be
 * interrupted, so the two are one act); Shift/Option-Enter stay newlines. The caller owns the
 * "anything staged to send" gate.
 */
export function shouldSubmitStagedEnter(event: ComposerKeyboardEvent): boolean {
  return isEnter(event)
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
