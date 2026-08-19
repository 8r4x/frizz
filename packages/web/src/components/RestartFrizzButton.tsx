import React, { useEffect, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { AlertTriangle, RefreshCw, X } from "lucide-react"
import { canRestart, canUpdateRestart, FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT, getFrizzSupervisorStatus, requestFrizzRestart, requestFrizzUpdateRestart } from "../api/restart.ts"
import { showToast, store } from "../store.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"

// RefreshCw's arrowheads advance clockwise, matching Tailwind's clockwise animate-spin keyframes.
// Keep this exported contract covered by the focused component test when either icon or animation changes.
export const UPDATE_RESTART_ICON_ROTATION = "clockwise"

const updateCopy = "Install the latest version of Frizz. Your running threads will not be affected."
const restartCopy = "Restart Frizz. Your running threads will not be affected."

// The one anchor both panels that hang off this button use. Narrow: a full-width strip pinned under
// the status bar. Desktop: anchored to the button's LEFT edge and opening rightward — this control
// lives in the top-left status bar now, so the old right-0 anchor pushed a 23rem panel straight off
// the left of the viewport. z-50 rides inside the bar's own z-20 stacking context, which is what
// puts either panel over the sidebar and the composer.
//
// `-left-1.5` (not `left-0`) because this wrapper is no longer the width of the 24px button: the ink
// trim on STATUS_ROW_ACTION (lib/statusRow.ts) collapses that square onto its 12px glyph, so the
// wrapper's own left edge now sits 6px INSIDE the target. Backing the panel out by that same 6px puts
// it exactly where it was before the trim, which is what keeps both panels' `left-1.5` arrows centred
// on the mark. Moving the arrows instead would have hung their rotated corner outside the panel.
const ANCHORED_PANEL =
  "fixed left-3 right-3 top-12 z-50 w-auto text-left font-sans sm:absolute sm:right-auto sm:-left-1.5 sm:top-[calc(100%+0.65rem)]"

// Width is per-panel and each panel applies EXACTLY ONE of these — never both. Tailwind resolves a
// same-property collision by CSS source order, not class order, so stacking two `sm:w-*` utilities on
// one element is a coin flip (the same trap lib/overlaySurface.ts documents for `z-*`).
//
// 23rem holds the popover's one sentence. The failure card is wider because its content is BUILD
// OUTPUT: at 23rem, ~45 mono characters fit per line, so each ~110-character snapshot path wrapped
// across three lines and a routine typecheck failure became 20 wrapped lines — which pushed the one
// `error TS…` line that says what actually broke below the scroll fold. At 34rem the same failure
// reads in about half that, so the actionable line is visible without scrolling.
const POPOVER_WIDTH = "sm:w-[min(23rem,calc(100vw-1.5rem))]"
const NOTICE_WIDTH = "sm:w-[min(34rem,calc(100vw-1.5rem))]"

// Both panels are OPAQUE. Anything anchored here hangs over the sidebar list and the dispatch
// composer, and a tinted-but-transparent fill let every one of those lines read straight through the
// text on top of it — the failure message became unreadable exactly when it mattered most
// (maintainer, 2026-08-01, on a wall of build log over the board: "these translucent error messages
// look insane"). Same contract as lib/overlaySurface.ts states for portal menus: opaque from the
// first painted frame.
const PANEL_SURFACE = "rounded-xl bg-elevated p-3.5 shadow-xl shadow-black/45"

export function UpdateRestartPopover({
  open,
  update,
}: {
  open: boolean
  update: boolean
}) {
  if (!open) return null
  const action = update ? "Update Frizz" : "Restart Frizz"
  return (
    <div
      id="update-restart-popover"
      role="tooltip"
      aria-label={action}
      // The arrow tracks the anchored edge, centred on the 24px target.
      className={`${ANCHORED_PANEL} ${POPOVER_WIDTH} ${PANEL_SURFACE} border border-border-strong`}
    >
      <span aria-hidden="true" className="absolute -top-1.5 left-1.5 h-3 w-3 rotate-45 border-l border-t border-border-strong bg-elevated" />
      <div className="relative flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg/10 text-fg">
          <RefreshCw aria-hidden="true" size={14} strokeWidth={2.25} />
        </span>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">{action}</span>
      </div>
      <p className="relative mt-2.5 text-[12px] leading-relaxed text-muted">{update ? updateCopy : restartCopy}</p>
    </div>
  )
}

const failureCopy = "Frizz kept running the previous version, and your threads are unaffected."

/**
 * The failure panel, built on the SAME opaque card as the popover it replaces — an error is the one
 * message that has to stay readable, so it is the last thing that should be see-through.
 *
 * The supervisor's `message` is raw build output: a `nub run typecheck` failure arrives as several
 * hundred characters of absolute snapshot paths wrapped around the one `error TS…` line that actually
 * says what broke. Dumped into a paragraph it filled a 23rem column with ~15 lines of prose-set path
 * fragments. It reads as what it is — a terminal excerpt — inside a scrolling mono block, and the card
 * keeps a fixed height whatever the supervisor hands it.
 */
export function RestartFailureNotice({
  update,
  message,
  onDismiss,
}: {
  update: boolean
  message: string
  onDismiss: () => void
}) {
  return (
    <div role="alert" className={`${ANCHORED_PANEL} ${NOTICE_WIDTH} ${PANEL_SURFACE} border border-red-500/45`}>
      <span aria-hidden="true" className="absolute -top-1.5 left-1.5 h-3 w-3 rotate-45 border-l border-t border-red-500/45 bg-elevated" />
      <div className="relative flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-300">
          <AlertTriangle aria-hidden="true" size={14} strokeWidth={2.25} />
        </span>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">{update ? "Update failed" : "Restart failed"}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-mr-1 ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
        >
          <X aria-hidden="true" size={14} strokeWidth={2.25} />
        </button>
      </div>
      <p className="relative mt-2.5 text-[12px] leading-relaxed text-muted">{failureCopy}</p>
      {/* The cap comes from the CARD's ceiling, not from any one log: ~360px is as tall as a transient
          notice hanging off a status-bar button should ever get, and the chrome above takes ~100px of
          that. Chrome reserves this block's scrollbar gutter but paints no thumb at rest, so a fold
          that lands mid-glyph reads as broken rather than as "scroll me" — at 256px an ordinary build
          failure lands inside the box entirely and only genuinely huge output ever meets the fold. */}
      <pre className="relative mt-2.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-panel px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg/70">{message}</pre>
    </div>
  )
}

export function RestartActionButton({
  update,
  busy,
  onFocus,
  onBlur,
  onClick,
}: {
  update: boolean
  busy: boolean
  onFocus?: () => void
  onBlur?: () => void
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-describedby="update-restart-popover"
      aria-label={update ? "Update Frizz" : "Restart Frizz"}
      disabled={busy}
      aria-busy={busy || undefined}
      className={STATUS_ROW_ACTION}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
    >
      <RefreshCw size={STATUS_ROW_ICON} aria-hidden="true" className={busy ? "animate-spin" : undefined} />
    </button>
  )
}

/** Global recovery action. It stays mounted in App chrome even when the app child is unhealthy. */
export function RestartFrizzButton() {
  const snap = useSnapshot(store)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // The dismissed message, not a boolean: the supervisor keeps reporting "failed" on every poll, so a
  // boolean would either re-open the panel one poll after the close or swallow the NEXT, different
  // failure. Keyed on the text, a repeat of the same reason stays closed and a new reason re-opens.
  const [dismissed, setDismissed] = useState<string | undefined>()
  const [available, setAvailable] = useState<boolean | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const requested = useRef(false)
  const controlRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    void getFrizzSupervisorStatus().then((status) => {
      if (!active) return
      setAvailable(canRestart(status))
      setUpdateAvailable(canUpdateRestart(status))
    })
    return () => { active = false }
  }, [])

  if (available !== true) return null

  // A failure the SUPERVISOR reports (a build that won't compile, an artifact that won't promote)
  // never reaches the click handler's catch — the POST was accepted, and the overlay simply drops
  // when a poll observes "failed". Its only trace was a 7-second toast, which is why a broken update
  // read as "the modal flashed and nothing happened". Once this session has asked for an update,
  // keep the supervisor's own reason on screen. It clears itself when the state leaves "failed".
  const reportedFailure = requested.current && snap.controlPlaneState === "failed"
    ? snap.controlPlaneMessage ?? "Frizz did not become ready"
    : undefined
  const failure = error ?? reportedFailure
  const shownError = failure && failure !== dismissed ? failure : undefined

  const updateAndRestart = async () => {
    if (busy) return
    requested.current = true
    setOpen(false)
    setBusy(true)
    setError(undefined)
    setDismissed(undefined)
    const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (updateAvailable) {
      // Raise the blocking overlay the instant the click lands — the update-restart POST can round-trip
      // slowly while the supervisor spins up the candidate build, and the user must see the block now,
      // not a second later. `restartPending` holds it across the pre-ack window and withholds the reload
      // destination until the supervisor has actually accepted the transition (armed below), so a stray
      // status poll can neither drop the overlay nor reload onto the still-live old child.
      store.controlPlaneState = "restarting"
      store.controlPlaneMessage = null
      store.controlPlaneRestartPending = true
    }
    try {
      if (updateAvailable) await requestFrizzUpdateRestart()
      else await requestFrizzRestart()
      // Do not reload onto the same old child while an immutable candidate is still building. App's
      // supervisor monitor reloads this exact route only after the durable owner reports readiness.
      if (updateAvailable) {
        // Arm the reload destination now that the supervisor owns the transition, and ramp the poll.
        // `restartPending` is deliberately NOT cleared here: it must outlive the ack until a poll
        // OBSERVES the server-confirmed transition (a non-"ready" status), so a stale in-flight poll
        // that captured the pre-flip "ready" can't slip past the guard and reload onto the old child.
        sessionStorage.setItem("frizz:reload-after-update-restart", destination)
        window.dispatchEvent(new Event(FRIZZ_SUPERVISOR_STATUS_WAKE_EVENT))
        setBusy(false)
      } else {
        window.location.replace(destination)
      }
    } catch (caught) {
      if (updateAvailable) {
        store.controlPlaneRestartPending = false
        store.controlPlaneState = "ready"
        store.controlPlaneMessage = null
      }
      const message = (caught as Error).message.slice(0, 140)
      setBusy(false)
      setError(message)
      // The reason goes in the failure panel, not the toast — see the same call in App.tsx.
      showToast(`${updateAvailable ? "Update & Restart" : "Restart Frizz"} failed`)
    }
  }

  return (
    <div ref={controlRef} className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <RestartActionButton
        update={updateAvailable}
        busy={busy}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => void updateAndRestart()}
      />
      {shownError && <RestartFailureNotice update={updateAvailable} message={shownError} onDismiss={() => setDismissed(shownError)} />}
      <UpdateRestartPopover open={open && !shownError} update={updateAvailable} />
    </div>
  )
}
