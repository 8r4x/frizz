import { useEffect, useRef, useState } from "react"
import { HeartPulse } from "lucide-react"
import {
  RECURRING_PROMPT_MAX,
  ALLDONE_SENTINEL,
  type ThreadView,
} from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { formatAgo } from "../lib/durationLabels.ts"
import { showToast } from "../store.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// THE RECURRING-PROMPT PANEL: one glyph in the thread footer opening fray's way to re-prompt a thread
// without the operator typing it again. ONE piece of text, and up to two independent reasons to send it:
//
//   WHEN IT STOPS   (scheduler SOURCE 5) — every time the thread comes to REST. No clock, nothing to
//     tune: if it stopped, it is prompted. This is the one that drives an effort forward.
//   ON A SCHEDULE   (scheduler SOURCE 4) — every N minutes, consulting nothing about what the thread is
//     doing, and DELIVERED MID-TURN. This is the one that reaches a thread that never stops.
//
// NEITHER TRIGGER ON IS THE OFF STATE, and that is why this panel has no third master switch. It used to
// be two separate features with two prompts and two enable toggles; the argument for keeping them apart
// rested on a delivery rule that no longer holds (while a beat waited for rest, a schedule could only
// ever fire AT a rest, where the rest trigger had already fired — same words, same instant). Once
// mid-turn delivery pulled them apart, "nudge this whenever it stops, and at least every N minutes even
// if it doesn't" became one intent costing two prompts to express. Maintainer 2026-08-03, on the master
// switch: "we can delete the top-level toggle since you can now achieve that by just disabling both of
// the other two toggles."
//
// The trigger renders ALWAYS, muted when nothing is armed — a control that only appears once its own
// feature is on cannot be used to turn the feature on. That makes it the one permanent child of the
// footer's left cluster, where everything else is a reading that hides itself when it has nothing to say.
export function RecurringPromptControl({ thread }: { thread: ThreadView }) {
  const [open, setOpen] = useState(false)
  const armed = thread.recurringPrompt
  // COLOURED IF EITHER TRIGGER IS LIVE. The glyph answers one question — "is fray going to re-prompt
  // this thread on its own?" — and either trigger is a yes.
  const live = armed?.onRest === true || armed?.onSchedule === true

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* No tooltip. This trigger used to carry one that printed the WHOLE armed prompt on hover — a
          second, uninvited panel covering the footer every time the pointer crossed a 12px glyph
          (maintainer 2026-08-02: "the hover-based popover is silly"). The prompt has one home now, and
          you get there by clicking. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          data-recurring-prompt
          data-recurring-prompt-on={live ? "true" : "false"}
          aria-label={live ? "Recurring prompt (on)" : "Recurring prompt"}
          className="flex items-center rounded-md px-0.5 py-0.5 outline-none"
        >
          {/* A HEART WITH A PULSE THROUGH IT, and the ONLY surface that says this exists (the rail
              deliberately carries no mark — see groups.ts).

              It was a square-in-a-circle (`CircleStop`) and that was the wrong mark for a reason no
              amount of tooltip could fix: in a strip whose other children are live verbs, a stop
              button reads as one — "it seems like clicking it would cause the entire session to stop"
              (maintainer 2026-08-03). A glyph that looks destructive on the way to a settings panel is
              worse than no glyph. A heartbeat says the opposite thing, which is also the true thing:
              something is keeping this thread beating.

              The HEART, not the bare pulse line (`Activity`) this shipped as for an afternoon: the line
              on its own reads as a metrics sparkline, and it is the enclosing heart that names the mark
              a HEARTBEAT — this thread has one, which is the entire state the glyph reports (maintainer
              2026-08-03: "I want it to be the heart icon with the pulse inside").

              GREY by default and coloured only while something is actually armed: the footer's left
              cluster is a status strip first, so a control with nothing to report has to read as quiet
              as the empty slot it would otherwise leave. Amber, not the app's accent yellow, so it
              reads as a state rather than the focus motif. */}
          <HeartPulse size={12} className={live ? "text-amber-400/90" : "text-muted/45 hover:text-muted"} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        // WIDE, and it takes the whole viewport when the viewport is small. A 21rem cap made this a
        // narrow column for prose that can run to 4000 characters, and on a phone-width screen it was
        // narrower than the space actually available. The panel is a writing surface, so it is sized
        // like one: ~110 columns where there is room, everything-minus-a-margin where there is not.
        className="w-[min(46rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg"
        // Radix otherwise autofocuses the first focusable child, which is a toggle segment — and a focus
        // ring sitting on "Off" reads as the toggle being SET to off by the act of opening the panel.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PromptPanel thread={thread} armed={armed} />
      </PopoverContent>
    </Popover>
  )
}

// The schedule is a NUMBER OF MINUTES, typed. It began as a dropdown of round presets and that was
// wrong twice over: it decided for the operator which cadences were reasonable (the whole point of
// making the schedule modifiable was that they know and we do not), and it read the interval back in
// mixed units — "Every 2 hr" for a thing whose every other surface counts minutes. Minutes are the unit
// now, everywhere, and any number in range is allowed.
//
// The bounds are the schema's, restated here only so the input can enforce them at the point of typing:
// a 1 minute floor (a delivery is read at the agent's next tool boundary, so faster buys no promptness)
// and 24 hours.
const MIN_MINUTES = 1
const MAX_MINUTES = 24 * 60
const DEFAULT_INTERVAL_SECONDS = 600

interface Draft { text: string; onRest: boolean; onSchedule: boolean; seconds: number }

function PromptPanel({ thread, armed }: { thread: ThreadView; armed: ThreadView["recurringPrompt"] }) {
  const [busy, setBusy] = useState(false)
  // The panel's own draft. Seeded from the server row when this MOUNTS (the popover unmounts its content
  // on close, so that is once per open) rather than tracked live, so a board refresh mid-sentence cannot
  // rewrite what the operator is typing or dictating.
  const [text, setText] = useState(armed?.prompt ?? "")
  const [onRest, setOnRest] = useState(armed?.onRest ?? false)
  const [onSchedule, setOnSchedule] = useState(armed?.onSchedule ?? false)
  const [seconds, setSeconds] = useState(armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
  // The minutes field is a STRING while it is being typed, so a half-typed value ("", "1" on the way to
  // "120") is not immediately clamped out from under the caret. It becomes a number on commit.
  const [minutes, setMinutes] = useState(String(Math.round((armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) / 60)))
  const textarea = useRef<HTMLTextAreaElement>(null)
  // What was last SENT, so a blur or a close can skip a round-trip when nothing actually changed —
  // otherwise every stray click through the panel re-arms the row and mints a new generation.
  const sent = useRef({
    prompt: armed?.prompt ?? "",
    onRest: armed?.onRest ?? false,
    onSchedule: armed?.onSchedule ?? false,
    seconds: armed?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  })

  // Persist on unmount too: closing the popover destroys this subtree, and without this a prompt typed
  // and then dismissed with Escape would be silently lost.
  const latest = useRef<Draft>({ text, onRest, onSchedule, seconds })
  latest.current = { text, onRest, onSchedule, seconds }
  useEffect(() => () => { void persistNow(latest.current) }, [])

  async function persistNow(next: Draft): Promise<void> {
    const prompt = next.text.trim() || null
    const unchanged = prompt === (sent.current.prompt || null)
      && next.onRest === sent.current.onRest
      && next.onSchedule === sent.current.onSchedule
      && next.seconds === sent.current.seconds
    if (unchanged) return
    // Nothing armed and nothing typed — flipping a trigger before writing anything has nothing to
    // persist yet. Keep the local flip and let the first real text carry it up.
    if (prompt === null && !armed) {
      sent.current = { prompt: "", onRest: next.onRest, onSchedule: next.onSchedule, seconds: next.seconds }
      return
    }
    setBusy(true)
    try {
      await rpc.setThreadRecurringPrompt({
        slug: thread.id,
        sessionId: thread.sessionId ?? "",
        prompt,
        onRest: next.onRest,
        onSchedule: next.onSchedule,
        // ALWAYS sent alongside a prompt, even while the schedule trigger is OFF. Gating this on
        // `onSchedule` looked right and silently destroyed data: switching the schedule off sent no
        // cadence, storage cleared the column, and reopening the panel showed the 10-minute default —
        // so an operator who parked a 30-minute schedule got 10 back when they switched it on again,
        // with nothing to indicate their number had been discarded. Caught in the browser, not by a
        // test: every unit here asserted on rows that still had a cadence.
        ...(prompt === null ? {} : { intervalSeconds: next.seconds }),
      })
      sent.current = { prompt: prompt ?? "", onRest: next.onRest, onSchedule: next.onSchedule, seconds: next.seconds }
      // The toast names WHAT WILL HAPPEN, not which switch moved. "On"/"off" was legible when there was
      // one toggle per feature and is ambiguous the moment two triggers share a row.
      showToast(
        prompt === null ? "Recurring prompt cleared"
          : next.onRest && next.onSchedule ? `Recurring prompt: at every rest, and every ${Math.round(next.seconds / 60)} min`
          : next.onRest ? "Recurring prompt: at every rest"
          : next.onSchedule ? `Recurring prompt: every ${Math.round(next.seconds / 60)} min`
          : "Recurring prompt off — no trigger is on",
      )
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Could not save the recurring prompt").slice(0, 100))
    } finally {
      setBusy(false)
    }
  }
  const persist = () => void persistNow({ text, onRest, onSchedule, seconds })
  // Clamp on COMMIT, not on keystroke. An out-of-range or empty field snaps back to something legal and
  // the field is rewritten to match, so what the operator sees is always what was actually stored.
  function commitMinutes(): void {
    const parsed = Math.round(Number(minutes))
    const clamped = Number.isFinite(parsed) && parsed > 0
      ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, parsed))
      : Math.round(seconds / 60)
    setMinutes(String(clamped))
    setSeconds(clamped * 60)
    void persistNow({ text, onRest, onSchedule, seconds: clamped * 60 })
  }
  // Is there anything to save? Compared against what was last SENT, so the button is live exactly when
  // a click would change something on the server — the alternative (always enabled) makes "Save" a
  // button you cannot tell the effect of, which is the complaint it exists to answer.
  const dirty = (text.trim() || null) !== (sent.current.prompt || null)
    || onRest !== sent.current.onRest
    || onSchedule !== sent.current.onSchedule
    || seconds !== sent.current.seconds

  // The far end of the header belongs to the reading, not to a control. With two triggers there are two
  // clocks, so it names WHICH one last fired rather than implying the pair share a stamp.
  const lastRest = armed?.lastRestFiredAt
  const lastSchedule = armed?.lastScheduleFiredAt
  const lastFired = !lastRest ? lastSchedule
    : !lastSchedule ? lastRest
    : Date.parse(lastRest) >= Date.parse(lastSchedule) ? lastRest : lastSchedule
  const lastLabel = lastFired === undefined ? null
    : lastRest && lastSchedule ? `Last sent ${formatAgo(lastFired)}`
    : lastRest ? `Last sent at rest ${formatAgo(lastFired)}`
    : `Last sent on schedule ${formatAgo(lastFired)}`

  return (
    <section data-recurring-panel>
      <div className="mb-2 flex items-center gap-3">
        <span className="font-medium">Recurring prompt</span>
        {lastLabel && <span className="ml-auto truncate text-muted/55">{lastLabel}</span>}
      </div>
      {/* ALWAYS EDITABLE. It used to be `readOnly` until a master toggle was on, which made sense while
          that toggle was the feature's on switch. With the switch gone, gating the textarea on "some
          trigger is on" would mean an operator has to decide WHEN to send a prompt before they are
          allowed to write it — backwards. Write first, then pick the triggers. */}
      <textarea
        ref={textarea}
        data-recurring-text
        value={text}
        maxLength={RECURRING_PROMPT_MAX}
        onChange={(e) => setText(e.target.value)}
        onBlur={persist}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            persist()
          }
        }}
        placeholder="What should this thread be told, again and again?"
        // `field-sizing: content` — the browser sizes the box from what is in it. It replaced a flat
        // `rows={4}`, which made a prompt that can run to 4000 chars a four-line peephole you scrolled
        // your own writing through. `min-h`/`max-h` are the only bounds it needs.
        //
        // Deliberately NOT a JS auto-grow (maintainer 2026-08-02: "this should be a browser-native
        // style, you shouldn't need to write JavaScript auto-grow logic"). The measure-and-set version
        // is also the one that broke: driven from an effect it ran with a null ref, because the panel
        // mounts behind a Radix portal a render later, and never ran again. Chromium ≥123.
        className="field-sizing-content max-h-[28vh] min-h-[4rem] w-full resize-none overflow-y-auto rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] leading-snug text-fg outline-none placeholder:text-muted/50 focus:border-border-strong"
      />
      {/* THE TRIGGERS, on one row under the text they govern, because that is their relationship: the
          text is the message and these are the two reasons to send it. `flex-wrap` so the pair drops to
          a second line on a phone-width panel rather than crushing the minutes field.

          THE GAP BETWEEN THE TWO GROUPS IS DOUBLE THE GAP INSIDE ONE, and that is the whole reason the
          row is readable. At an even 1rem throughout, the eye grouped "…it stops [Off|On] every 30 min"
          — the first toggle read as a separator BETWEEN the two phrases rather than the end of the
          first, so it was impossible to tell which switch owned which trigger. Measured on the rendered
          panel, not guessed. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-8 gap-y-2">
        <span className="text-muted">Send it:</span>
        <span className="flex items-center gap-2">
          <span className={onRest ? "text-fg" : "text-muted"}>when it stops</span>
          <OnOffToggle
            kind="rest"
            value={onRest}
            disabled={busy}
            onChange={(next) => {
              setOnRest(next)
              void persistNow({ text, onRest: next, onSchedule, seconds })
              if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
            }}
          />
        </span>
        <span className="flex items-center gap-2">
          <span className={onSchedule ? "text-fg" : "text-muted"}>every</span>
          {/* "every [N] min" reads as one phrase, so the words sit in the same row as the field rather
              than becoming a label above it. The input is sized to its content (4ch fits 1440) and its
              digits are tabular, so the box does not twitch as the number changes. */}
          <input
            type="number"
            data-recurring-minutes
            inputMode="numeric"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            disabled={busy}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            onBlur={commitMinutes}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitMinutes() } }}
            aria-label="Schedule in minutes"
            className={`w-[4.5ch] rounded-md border border-border bg-bg px-1 py-[3px] text-center text-[11px] leading-none tabular-nums outline-none focus:border-border-strong disabled:opacity-45 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${onSchedule ? "text-fg" : "text-muted"}`}
          />
          <span className={onSchedule ? "text-fg" : "text-muted"}>min</span>
          <OnOffToggle
            kind="schedule"
            value={onSchedule}
            disabled={busy}
            onChange={(next) => {
              setOnSchedule(next)
              void persistNow({ text, onRest, onSchedule: next, seconds })
              if (next && !text.trim()) requestAnimationFrame(() => textarea.current?.focus())
            }}
          />
        </span>
      </div>
      {/* The explanation and the Save share one row, which is what puts the button at the panel's
          bottom-right without a bar of its own. `items-end` rather than `items-center`: the explainer is
          two lines of prose and the button is one control, so centring them would float the button in
          the middle of the paragraph — aligning their BASE edges reads as the paragraph and its action.
          The button keeps its own line-height so its label sits optically centred in its box.

          What the operator needs from this text is WHEN IT FIRES AND WHEN IT WILL NOT, because a prompt
          they armed sitting silent on a still thread is what looks broken from the outside. */}
      <div className="mt-2 flex items-end gap-3">
        <p className="min-w-0 flex-1 text-muted/70">
          {/* TWO LINES, not three. The merged explainer originally ran long enough to wrap a third
              time, and `items-end` then parked Save beside a line holding the word "it." — an orphan
              next to the panel's only button. Kept short enough that the button lands on a full line. */}
          {!onRest && !onSchedule
            ? <>No trigger is on, so nothing is sent — the text stays here for when you want it back.</>
            : <>
                A scheduled send reaches the agent mid-turn, without cutting off work in progress.
                Switch both off to stop it, or the agent can reply{" "}
                <code className="font-mono font-medium text-fg/85">{ALLDONE_SENTINEL}</code> — which
                stalls the run until you move it.
              </>}
        </p>
        <button
          type="button"
          data-recurring-save
          disabled={busy || !dirty}
          onMouseDown={(e) => e.preventDefault()}
          onClick={persist}
          // Small, quiet, and INERT until there is something to save — the disabled state is the whole
          // signal. `shrink-0` so a long explainer can never squeeze the label; `leading-none` + the
          // symmetric py keeps the word optically centred rather than riding high on the default
          // line-box. Same radius and 11px scale as the toggle it answers to.
          className="shrink-0 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-[5px] text-[11px] leading-none font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-40 disabled:hover:bg-panel-2/60 disabled:hover:text-fg/80"
        >
          {/* MEASURED, not guessed: the label's ink sat 0.62px BELOW its box's interior centre, against
              0.08–0.19px for the Off/On segments in the same panel — a word with no descender in a
              symmetrically padded box. Corrected in `em` so it tracks the font size rather than pinning
              to 11px, and re-measured to a 0.02px residual. */}
          <span className="inline-block translate-y-[-0.056em]">{busy ? "Saving…" : "Save"}</span>
        </button>
      </div>
    </section>
  )
}

// The same segmented Off|On the settings form uses — Off on the LEFT (switch convention, right = on),
// active segment inverted. Deliberately NOT a second switch idiom invented for this panel: the app
// already has exactly one shape for a boolean. Sized down from the settings copy because it shares a
// row with 11px prose, not a form label.
function OnOffToggle({ kind, value, disabled, onChange }: {
  kind: string
  value: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="inline-flex w-fit shrink-0 rounded-md border border-border bg-bg p-0.5" role="group" aria-label={`${kind} trigger`}>
      {[{ v: false, label: "Off" }, { v: true, label: "On" }].map((o) => (
        <button
          key={o.label}
          type="button"
          disabled={disabled}
          aria-pressed={value === o.v}
          data-recurring-toggle={`${kind}-${o.label.toLowerCase()}`}
          onClick={() => onChange(o.v)}
          className={`rounded px-2 py-0.5 text-[11px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/60 disabled:opacity-45 ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
